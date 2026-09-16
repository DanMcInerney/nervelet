import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { AgentDriver, DriverContext, DriverCapabilities } from '../supervisor.ts';
import type { Bundle } from '../types.ts';
import { toolResult } from '../handlers.ts';
import { createMcpServer } from '../transports/mcp.ts';
import { boundedText, fail } from '../util.ts';
import { checkTransportInput } from '../presentation.ts';

export interface ClaudeCodeOptions {
  model:string; cwd:string; permissionMode:NonNullable<Options['permissionMode']>;
  allowedTools:string[]; settingSources:NonNullable<Options['settingSources']>;
  canUseTool?:Options['canUseTool']; resume?:string; maxTurns?:number; maxBudgetUsd?:number;
  pathToClaudeCodeExecutable?:string;
  /** Injectable official query surface for protocol tests; never an alternate model. */
  query?:typeof import('@anthropic-ai/claude-agent-sdk')['query'];
}
class Input implements AsyncIterable<SDKUserMessage> {
  private queued?:SDKUserMessage;private wake?:()=>void;private ended=false;
  push(value:SDKUserMessage){if(this.queued)fail('busy','Only one pending native input is allowed.');this.queued=value;this.wake?.();}
  close(){this.ended=true;this.wake?.();}
  async *[Symbol.asyncIterator](){while(!this.ended){if(!this.queued)await new Promise<void>(r=>{this.wake=r;});this.wake=undefined;if(this.queued){const value=this.queued;this.queued=undefined;yield value;}}}
}
export class ClaudeCodeDriver implements AgentDriver {
  readonly capabilities:DriverCapabilities={name:'claude-code-sdk',mode:'managed',parking:true,toolHoldMs:0,images:'unqualified',recovery:'events',usage:['tokens','cost'],interruption:'terminal-event',qualification:'SDK protocol fixtures only; native interruption, images, parking and actual compaction unqualified. Emergency settlement requires matching user_message_uuid.'};
  private options:ClaudeCodeOptions;private context?:DriverContext;private input=new Input();private query?:Query;
  private server?:Awaited<ReturnType<typeof createMcpServer>>;private pump?:Promise<void>;private failure?:unknown;
  private active?:{resolve:(v:{status:'ended'|'interrupted'})=>void;reject:(e:unknown)=>void};
  private cost=0;sessionId?:string;
  private inputId?:string;private interrupted?:Promise<void>;
  private terminal=false;
  constructor(options:ClaudeCodeOptions){boundedText(options.model,256,'Explicit Claude model');this.options=options;}
  async open(context:DriverContext,signal:AbortSignal):Promise<void> {
    this.context=context;this.server=await createMcpServer(context.handlers);
    let query=this.options.query;
    if(!query){try{query=(await import('@anthropic-ai/claude-agent-sdk')).query;}catch{fail('missing_dependency','Install @anthropic-ai/claude-agent-sdk@0.3.273 for the Claude Code driver.');}}
    const {model,cwd,permissionMode,settingSources,allowedTools,canUseTool,resume,maxTurns,maxBudgetUsd,pathToClaudeCodeExecutable}=this.options;
    this.query=query({prompt:this.input,options:{model,cwd,permissionMode,settingSources,allowedTools,canUseTool,resume,maxTurns:maxTurns ?? 64,maxBudgetUsd,pathToClaudeCodeExecutable,
      systemPrompt:{type:'preset',preset:'claude_code',append:context.handlers.instructions},
      mcpServers:{nervelet:{type:'sdk',name:'nervelet',instance:this.server}},
      hooks:{PreCompact:[{hooks:[async()=>{context.bridge.refresh('native_precompact');return {};}]}]}
    }});
    this.pump=this.consume();void this.pump.catch(error=>{this.failure=error;this.active?.reject(error);});
    signal.throwIfAborted();await this.query.initializationResult();context.bridge.refresh(resume?'native_resume':'native_start');
  }
  private async consume():Promise<void> {
    for await(const event of this.query!) {
      if('session_id' in event) {
        if(this.sessionId && event.session_id!==this.sessionId)throw new Error('Claude session changed unexpectedly.');
        this.sessionId=event.session_id;
      }
      if(event.type==='system'&&event.subtype==='compact_boundary')this.context!.bridge.refresh('native_compact_boundary');
      if(event.type==='system'&&event.subtype==='model_refusal_fallback')throw new Error('Native model fallback is not authorized by this driver.');
      if(event.type==='result') {
        if(!this.active)continue;
        if(event.user_message_uuid && event.user_message_uuid!==this.inputId)continue;
        if((this.interrupted || this.context!.bridge.attentionOptions) && event.user_message_uuid!==this.inputId)throw new Error('Unsupported interruption settlement: Claude result has no matching user_message_uuid.');
        this.terminal=true;
        this.context!.bridge.emit({type:'turn_ended',turnId:this.inputId,reason:event.terminal_reason ?? event.subtype,attentionId:this.context!.bridge.attention()?.id});
        const cost=Math.max(0,event.total_cost_usd-this.cost);this.cost=event.total_cost_usd;
        this.context!.usage({costUsd:cost,inputTokens:event.usage.input_tokens,outputTokens:event.usage.output_tokens,cachedTokens:event.usage.cache_read_input_tokens});
        const intentional=this.interrupted && event.user_message_uuid===this.inputId && ['aborted_streaming','aborted_tools'].includes(event.terminal_reason ?? '') && (event.subtype==='success' || event.subtype==='error_during_execution');
        if(intentional && !event.permission_denials.length)this.active?.resolve({status:'interrupted'});
        else if(event.permission_denials.length || event.is_error || event.subtype!=='success')this.active?.reject(new Error(`Claude turn failed (${event.subtype}); permission denials: ${event.permission_denials.length}.`));
        else this.active?.resolve({status:'ended'});
      }
    }
    throw new Error('Claude SDK stream ended; this session cannot accept another turn.');
  }
  async turn(observation:Bundle,signal:AbortSignal):Promise<{status:'ended'|'interrupted'}> {
    if(!this.query)fail('inactive','Open the Claude Code driver first.');if(this.active)fail('busy','Native turn already active.');if(this.failure)throw this.failure;
    signal.throwIfAborted();
    this.inputId=randomUUID();this.interrupted=undefined;this.terminal=false;
    const content=toolResult(observation).content.map(c=>c.type==='text'?c:{type:'image' as const,source:{type:'base64' as const,media_type:c.mimeType as 'image/png'|'image/jpeg'|'image/webp',data:c.data}});
    const input:SDKUserMessage={type:'user',uuid:this.inputId as `${string}-${string}-${string}-${string}-${string}`,message:{role:'user',content},parent_tool_use_id:null};
    checkTransportInput(this.context!.bridge,observation,input);
    const result=new Promise<{status:'ended'|'interrupted'}>((resolve,reject)=>{this.active={resolve,reject};});
    const abort=()=>{void this.interrupt().catch(e=>this.active?.reject(e));};signal.addEventListener('abort',abort,{once:true});
    this.input.push(input);
    this.context!.bridge.emit({type:'submission',id:observation.id,turnId:this.inputId,reason:'sdk_input_queued',attentionId:observation.attention?.id});
    try{return await result;}finally{signal.removeEventListener('abort',abort);this.active=undefined;}
  }
  async interrupt():Promise<void>{
    if(this.terminal && this.active)return;
    if(!this.active){await this.query?.interrupt();return;}
    if(!this.interrupted)this.interrupted=Promise.resolve().then(async()=>{await this.query?.interrupt();});
    await this.interrupted;
  }
  async close():Promise<void>{this.input.close();this.query?.close();await this.pump?.catch(()=>{});await this.server?.close();}
}
