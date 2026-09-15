import type { AgentDriver, DriverCapabilities, DriverContext } from '../supervisor.ts';
import type { Bundle } from '../types.ts';
import type { AppServerClient, RpcEvent } from './app-server.ts';
import { toolResult, type Handlers } from '../handlers.ts';
import { serveLocalMcp } from '../transports/mcp.ts';
import { bounded, boundedText, fail, object } from '../util.ts';
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
  readonly capabilities:DriverCapabilities={name:'codex-app-server',mode:'managed',parking:true,toolHoldMs:0,images:'unqualified',recovery:'events',usage:['tokens'],qualification:'Protocol fixture only; native images, parking and compaction not qualified.'};
  private options:CodexOptions;private context?:DriverContext;private unsubscribe?:()=>void;
  private tools?:{close?():Promise<void>};private threadId?:string;private turnId?:string;
  private active?:{resolve:(v:{status:'ended'|'interrupted'})=>void;reject:(e:unknown)=>void};
  private failure?:Error;
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
    if(event.method==='turn/started' && object(p.turn) && typeof p.turn.id==='string' && this.active)this.turnId=p.turn.id;
    if(event.method==='turn/completed' && object(p.turn) && this.active && (!this.turnId || p.turn.id===this.turnId)) {
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
    const input=toolResult(observation).content.map(c=>c.type==='text'?{type:'text',text:c.text,text_elements:[]}:{type:'image',url:`data:${c.mimeType};base64,${c.data}`});
    const abort=()=>{void this.interrupt().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    try {
      signal.throwIfAborted();
      const response=await this.options.client.request('turn/start',{threadId:this.threadId,input,model:this.options.model},signal);
      if(!object(response)||!object(response.turn)||typeof response.turn.id!=='string')fail('protocol','App Server returned no turn ID.');
      this.turnId=response.turn.id;if(signal.aborted)await this.interrupt();
      return await completed;
    } finally {signal.removeEventListener('abort',abort);this.active=undefined;this.turnId=undefined;}
  }
  async interrupt():Promise<void>{if(this.threadId&&this.turnId)await bounded(s=>this.options.client.request('turn/interrupt',{threadId:this.threadId,turnId:this.turnId},s),2000);}
  async close():Promise<void>{
    try{await this.interrupt();}finally{
      this.active?.reject(new Error('Codex driver closed.'));this.unsubscribe?.();
      try{await this.tools?.close?.();}finally{if(this.options.clientOwnership==='owned')await this.options.client.close?.();}
    }
  }
}
