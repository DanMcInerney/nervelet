import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentDriver, DriverContext, DriverCapabilities } from '../supervisor.ts';
import type { Bundle } from '../types.ts';
import { toolResult } from '../handlers.ts';
import { createMcpServer } from '../transports/mcp.ts';
import { boundedText, fail } from '../util.ts';

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
  readonly capabilities:DriverCapabilities={name:'claude-code-sdk',mode:'managed',parking:true,toolHoldMs:0,images:'unqualified',recovery:'events',usage:['tokens','cost'],qualification:'SDK protocol fixtures only; native images, parking and actual compaction unqualified.'};
  private options:ClaudeCodeOptions;private context?:DriverContext;private input=new Input();private query?:Query;
  private server?:Awaited<ReturnType<typeof createMcpServer>>;private pump?:Promise<void>;private failure?:unknown;
  private active?:{resolve:(v:{status:'ended'|'interrupted'})=>void;reject:(e:unknown)=>void};
  private cost=0;sessionId?:string;
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
      if('session_id' in event)this.sessionId=event.session_id;
      if(event.type==='system'&&event.subtype==='compact_boundary')this.context!.bridge.refresh('native_compact_boundary');
      if(event.type==='system'&&event.subtype==='model_refusal_fallback')throw new Error('Native model fallback is not authorized by this driver.');
      if(event.type==='result') {
        const cost=Math.max(0,event.total_cost_usd-this.cost);this.cost=event.total_cost_usd;
        this.context!.usage({costUsd:cost,inputTokens:event.usage.input_tokens,outputTokens:event.usage.output_tokens,cachedTokens:event.usage.cache_read_input_tokens});
        if(event.permission_denials.length || event.is_error || event.subtype!=='success')this.active?.reject(new Error(`Claude turn failed (${event.subtype}); permission denials: ${event.permission_denials.length}.`));
        else this.active?.resolve({status:'ended'});
      }
    }
    if(this.active)throw new Error('Claude SDK stream ended during a turn.');
  }
  async turn(observation:Bundle,signal:AbortSignal):Promise<{status:'ended'|'interrupted'}> {
    if(!this.query)fail('inactive','Open the Claude Code driver first.');if(this.active)fail('busy','Native turn already active.');if(this.failure)throw this.failure;
    signal.throwIfAborted();
    const content=toolResult(observation).content.map(c=>c.type==='text'?c:{type:'image' as const,source:{type:'base64' as const,media_type:c.mimeType as 'image/png'|'image/jpeg'|'image/webp',data:c.data}});
    const result=new Promise<{status:'ended'|'interrupted'}>((resolve,reject)=>{this.active={resolve,reject};});
    const abort=()=>{void this.interrupt().catch(e=>this.active?.reject(e));};signal.addEventListener('abort',abort,{once:true});
    this.input.push({type:'user',message:{role:'user',content},parent_tool_use_id:null});
    try{return await result;}finally{signal.removeEventListener('abort',abort);this.active=undefined;}
  }
  async interrupt():Promise<void>{await this.query?.interrupt();}
  async close():Promise<void>{this.input.close();this.query?.close();await this.pump?.catch(()=>{});await this.server?.close();}
}
