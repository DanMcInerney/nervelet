import type { AgentDriver, DriverCapabilities, DriverContext } from '../supervisor.ts';
import type { Bundle } from '../types.ts';
import type { AppServerClient, RpcEvent } from './app-server.ts';
import { toolResult, type Handlers } from '../handlers.ts';
import { serveLocalMcp } from '../transports/mcp.ts';
import { bounded, boundedText, fail, object } from '../util.ts';
import { checkTransportInput } from '../presentation.ts';
export { connectAppServer } from './app-server.ts';
export type { AppServerClient } from './app-server.ts';

export interface CodexOptions {
  client:AppServerClient; clientOwnership?:'owned'|'borrowed'; threadId?:string;
  model:string; cwd:string; approvalPolicy:'untrusted'|'on-request'|'never';
  sandbox:'read-only'|'workspace-write'|'danger-full-access';
  /** A host can expose handlers using its existing role-bound MCP server. */
  connectTools?:(handlers:Handlers)=>Promise<{config:Record<string,unknown>;close?():Promise<void>}>;
}
export class CodexDriver implements AgentDriver {
  readonly capabilities:DriverCapabilities={name:'codex-app-server',mode:'managed',parking:true,toolHoldMs:0,images:'unqualified',recovery:'events',usage:['tokens'],interruption:'terminal-event',qualification:'Protocol fixture only; native interruption, images, parking and compaction not qualified.'};
  private options:CodexOptions;private context?:DriverContext;private unsubscribe?:()=>void;
  private tools?:{close?():Promise<void>};private threadId?:string;private turnId?:string;
  private active?:{resolve:(v:{status:'ended'|'interrupted'})=>void;reject:(e:unknown)=>void};
  private failure?:Error;
  private earlyEnds=new Map<string,RpcEvent>();
  private starting?:Promise<void>;
  private interrupted?:Promise<void>;
  private terminal=false;
  private tokens={inputTokens:0,outputTokens:0,cachedInputTokens:0};
  constructor(options:CodexOptions){boundedText(options.model,256,'Explicit Codex model');this.options=options;}
  async open(context:DriverContext,signal:AbortSignal):Promise<void> {
    this.context=context;
    this.unsubscribe=this.options.client.subscribe(event=>{
      try{this.event(event);}catch(error){this.failure=error instanceof Error?error:new Error(String(error));this.active?.reject(this.failure);void this.interrupt().catch(()=>{});}
    });
    const connection=this.options.connectTools ? await this.options.connectTools(context.handlers) : await (async()=>{
      const endpoint=await serveLocalMcp(context.handlers);
      return {config:{mcp_servers:{nervelet:{url:endpoint.url,http_headers:{Authorization:`Bearer ${endpoint.token}`},required:true}}},close:()=>endpoint.close()};
    })();
    this.tools=connection;
    const response=await this.options.client.request(this.options.threadId?'thread/resume':'thread/start',{
      ...(this.options.threadId?{threadId:this.options.threadId}:{}),model:this.options.model,cwd:this.options.cwd,
      approvalPolicy:this.options.approvalPolicy,sandbox:this.options.sandbox,config:connection.config,developerInstructions:context.handlers.instructions
    },signal);
    if(!object(response)||!object(response.thread)||typeof response.thread.id!=='string')fail('protocol','App Server returned no thread ID.');
    if(typeof response.model==='string' && response.model!==this.options.model)fail('model_changed','App Server selected a different model.');
    this.threadId=response.thread.id;context.bridge.refresh(this.options.threadId?'native_resume':'native_start');
  }
  private event(event:RpcEvent):void {
    if(event.method==='transport/closed'){this.failure=new Error('App Server disconnected; resume/reconciliation required.');this.active?.reject(this.failure);return;}
    const p=event.params;if(p.threadId!==this.threadId)return;
    if(event.method==='model/rerouted'){this.failure=new Error('Native model rerouted; no fallback is authorized by this driver.');this.active?.reject(this.failure);void this.interrupt().catch(()=>{});}
    if(event.method==='thread/compacted' || event.method==='item/started' && object(p.item) && p.item.type==='contextCompaction')this.context?.bridge.refresh('native_compaction');
    if(event.method==='turn/completed' && object(p.turn) && this.active && typeof p.turn.id==='string') {
      if(!this.turnId) {
        if(this.earlyEnds.size>=8)fail('protocol','Too many unmatched terminal events while starting a turn.');
        this.earlyEnds.set(p.turn.id,event);return;
      }
      if(p.turn.id!==this.turnId)return;
      this.terminal=true;
      this.context?.bridge.emit({type:'turn_ended',turnId:this.turnId,reason:String(p.turn.status),attentionId:this.context.bridge.attention()?.id});
      if(p.turn.status==='completed')this.active.resolve({status:'ended'});
      else if(p.turn.status==='interrupted')this.active.resolve({status:'interrupted'});
      else this.active.reject(new Error('Native turn failed: '+JSON.stringify(p.turn.error ?? p.turn.status)));
    }
    if(event.method==='error' && p.willRetry===false)this.active?.reject(new Error('Native error: '+JSON.stringify(p.error)));
    if(event.method==='thread/tokenUsage/updated' && object(p.tokenUsage) && object(p.tokenUsage.total)) {
      const total=p.tokenUsage.total;
      if(['inputTokens','outputTokens','cachedInputTokens'].every(k=>typeof total[k]==='number' && Number.isFinite(total[k]) && (total[k] as number)>=0)) {
        this.context?.usage({inputTokens:Math.max(0,(total.inputTokens as number)-this.tokens.inputTokens),outputTokens:Math.max(0,(total.outputTokens as number)-this.tokens.outputTokens),cachedTokens:Math.max(0,(total.cachedInputTokens as number)-this.tokens.cachedInputTokens)});
        this.tokens={inputTokens:total.inputTokens as number,outputTokens:total.outputTokens as number,cachedInputTokens:total.cachedInputTokens as number};
      }
    }
  }
  async turn(observation:Bundle,signal:AbortSignal):Promise<{status:'ended'|'interrupted'}> {
    if(!this.threadId || !this.context)fail('inactive','Open the Codex driver first.');if(this.active)fail('busy','Native turn already active.');if(this.failure)throw this.failure;
    const completed=new Promise<{status:'ended'|'interrupted'}>((resolve,reject)=>{this.active={resolve,reject};});void completed.catch(()=>{});
    this.terminal=false;this.interrupted=undefined;this.earlyEnds.clear();
    const input=toolResult(observation).content.map(c=>c.type==='text'?{type:'text',text:c.text,text_elements:[]}:{type:'image',url:`data:${c.mimeType};base64,${c.data}`});
    const abort=()=>{void this.interrupt().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    try {
      signal.throwIfAborted();
      checkTransportInput(this.context.bridge,observation,{threadId:this.threadId,input,model:this.options.model});
      // Cancelling the local RPC wait would lose an accepted native turn's identity.
      this.starting=bounded(async s=>{
        const response=await this.options.client.request('turn/start',{threadId:this.threadId,input,model:this.options.model},s);
        if(!object(response)||!object(response.turn)||typeof response.turn.id!=='string')fail('protocol','App Server returned no turn ID.');
        this.turnId=response.turn.id;
        this.context!.bridge.emit({type:'submission',id:observation.id,turnId:this.turnId,reason:'native_turn_start_accepted',attentionId:observation.attention?.id});
        const early=this.earlyEnds.get(this.turnId);this.earlyEnds.clear();if(early)this.event(early);
      },this.context.bridge.limits.startupMs);
      await this.starting;if(signal.aborted)await this.interrupt();
      return await completed;
    } catch(error) {this.failure=error instanceof Error?error:new Error(String(error));throw error;}
    finally {signal.removeEventListener('abort',abort);this.active=undefined;this.turnId=undefined;this.starting=undefined;this.earlyEnds.clear();}
  }
  async interrupt():Promise<void>{
    if(!this.active || this.terminal)return;
    if(!this.interrupted)this.interrupted=(async()=>{
      await Promise.resolve();
      await this.starting;
      if(this.active && !this.terminal && this.threadId && this.turnId)await bounded(s=>this.options.client.request('turn/interrupt',{threadId:this.threadId,turnId:this.turnId},s),2000);
    })();
    await this.interrupted;
  }
  async close():Promise<void>{
    try{await this.interrupt();}finally{
      this.active?.reject(new Error('Codex driver closed.'));this.unsubscribe?.();
      try{await this.tools?.close?.();}finally{if(this.options.clientOwnership==='owned')await this.options.client.close?.();}
    }
  }
}
