import { Ajv } from 'ajv';
import type { AgentDriver, DriverCapabilities, DriverContext, Usage } from '../supervisor.ts';
import type { Bundle } from '../types.ts';
import { toolResult, type ToolContent } from '../handlers.ts';
import { bounded, boundedText, bytes, fail, message, object } from '../util.ts';

export interface ChatMessage { role:string; content?:unknown; [key:string]:unknown }
export interface ApiOptions {
  /** Exact chat-completions endpoint, provider identity and model; no discovery or fallback. */
  endpoint:string; provider:string; model:string; headers?:Record<string,string>;
  images?:boolean; encoding?:'tools'|'json-action'; constraints?:'json_schema'|'json_object';
  fetch?:typeof fetch; requestMs?:number; maxResponseBytes?:number; maxHistoryBytes?:number;
  maxRequestsPerTurn?:number; maxProtocolRetries?:number;
}
type Call={id:string;type:'function';function:{name:string;arguments:string}};
const actionSchema={type:'object',required:['op','args'],additionalProperties:false,properties:{op:{type:'string'},args:{type:'object'}}};
const validAction=new Ajv({strict:true}).compile<{op:string;args:Record<string,unknown>}>(actionSchema);
/** Minimal chat-completions driver for an explicitly configured API or local server. */
export class ApiDriver implements AgentDriver {
  readonly capabilities:DriverCapabilities;
  private options:ApiOptions;private context?:DriverContext;private history:ChatMessage[]=[];
  private active?:AbortController;private running=false;
  constructor(options:ApiOptions){
    boundedText(options.model,256,'Explicit API model');boundedText(options.provider,128,'Explicit provider');
    const url=new URL(options.endpoint);if(!['http:','https:'].includes(url.protocol))fail('invalid_config','HTTP endpoint required.');
    this.options=options;
    this.capabilities={name:`api:${options.provider}`,mode:'managed',parking:true,toolHoldMs:0,images:options.images?'supported':'unsupported',recovery:'events',usage:['modelCalls','tokens','cost'],qualification:'HTTP protocol fixtures only; provider-specific behavior must be qualified.'};
  }
  async open(context:DriverContext):Promise<void>{this.context=context;this.history=[{role:'system',content:context.handlers.instructions+(this.options.encoding==='json-action'?'\nReturn exactly one JSON object {op,args}. Allowed operations and schemas: '+JSON.stringify(context.handlers.tools):'')}];}
  private content(contents:ToolContent[]):unknown {
    if(contents.some(c=>c.type==='image')&&!this.options.images)fail('unsupported_images','This API configuration does not support images.');
    if(contents.every(c=>c.type==='text'))return contents.map(c=>(c as {text:string}).text).join('\n');
    return contents.map(c=>c.type==='text'?c:{type:'image_url',image_url:{url:`data:${c.mimeType};base64,${c.data}`}});
  }
  private observe(bundle:Bundle):void {this.history.push({role:'user',content:this.content(toolResult(bundle).content)});}
  private async rotate(signal:AbortSignal):Promise<void> {
    if(bytes(this.history)<=(this.options.maxHistoryBytes ?? 262144))return;
    this.context!.bridge.refresh('api_history_rotation');
    const recovery=await this.context!.bridge.step({schemaVersion:2},signal);
    this.history=this.history.slice(0,1);this.observe(recovery);
    if(bytes(this.history)>(this.options.maxHistoryBytes ?? 262144))fail('capacity','Required API recovery exceeds history capacity.');
  }
  private async request(signal:AbortSignal):Promise<Record<string,unknown>> {
    const tools=this.context!.handlers.tools;
    const body={model:this.options.model,messages:this.history,stream:false,
      ...(this.options.encoding==='json-action'?{
        ...(this.options.constraints ? {response_format:this.options.constraints==='json_object'?{type:'json_object'}:{type:'json_schema',json_schema:{name:'nervelet_action',schema:{oneOf:tools.map(t=>({type:'object',additionalProperties:false,required:['op','args'],properties:{op:{const:t.name},args:t.inputSchema}}))}}}} : {})
      }:{tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}})),tool_choice:'auto'})};
    this.context!.usage({modelCalls:1});
    return bounded(async s=>{
      const response=await (this.options.fetch ?? fetch)(this.options.endpoint,{method:'POST',headers:{'Content-Type':'application/json',...this.options.headers},body:JSON.stringify(body),signal:s});
      if(!response.ok){await response.body?.cancel();fail('provider_error',`${this.options.provider} HTTP ${response.status}; no automatic provider/model fallback.`);}
      const reader=response.body?.getReader();if(!reader)fail('protocol','Missing API response body.');
      let size=0;const chunks:Uint8Array[]=[];
      try {while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>(this.options.maxResponseBytes ?? 65536))fail('capacity','API response exceeds capacity.');chunks.push(next.value);}}
      finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('protocol','Malformed API response JSON.');}
      if(!object(value))fail('protocol','API response must be an object.');
      if(typeof value.model==='string' && value.model!==this.options.model)fail('model_changed',`Provider returned model ${value.model}, requested ${this.options.model}. Use an exact model ID.`);
      return value;
    },this.options.requestMs ?? 60000,signal);
  }
  private response(value:Record<string,unknown>):{assistant:ChatMessage;calls:Call[];action?:{op:string;args:Record<string,unknown>}} {
    if(!Array.isArray(value.choices)||value.choices.length!==1||!object(value.choices[0]))fail('protocol','Expected exactly one complete choice.');
    const choice=value.choices[0];if(!['stop','tool_calls'].includes(String(choice.finish_reason)))fail('protocol','Incomplete or unsupported finish reason; no actions executed.');
    if(!object(choice.message)||choice.message.role!=='assistant')fail('protocol','Missing assistant message.');
    const assistant=choice.message as ChatMessage;
    if(this.options.encoding==='json-action') {
      if(choice.finish_reason!=='stop'||assistant.tool_calls!==undefined||typeof assistant.content!=='string')fail('protocol','Expected one complete JSON action.');
      let action:unknown;try{action=JSON.parse(assistant.content);}catch{fail('protocol','Invalid JSON action.');}
      if(!validAction(action))fail('protocol','Invalid JSON action schema.');
      return {assistant,calls:[],action};
    }
    const calls=assistant.tool_calls;
    if(calls===undefined) {if(choice.finish_reason!=='stop')fail('protocol','Missing tool calls.');return {assistant,calls:[]};}
    if(choice.finish_reason!=='tool_calls'||!Array.isArray(calls)||!calls.length||calls.length>8)fail('protocol','Invalid tool-call batch.');
    const ids=new Set<string>();
    for(const call of calls) {
      if(!object(call)||call.type!=='function'||typeof call.id!=='string'||!call.id||call.id.length>128||ids.has(call.id)||!object(call.function)||typeof call.function.name!=='string'||typeof call.function.arguments!=='string')fail('protocol','Invalid or duplicate tool-call ID.');
      ids.add(call.id);
      // Reject malformed arguments before any effects from the response.
      try{if(!object(JSON.parse(call.function.arguments)))throw new Error();}catch{fail('protocol','Malformed tool arguments; no actions executed.');}
    }
    return {assistant,calls:calls as Call[]};
  }
  private usage(value:Record<string,unknown>):void {
    if(!object(value.usage))return;const u=value.usage;const usage:Usage={};
    const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:undefined;
    usage.inputTokens=number(u.prompt_tokens);usage.outputTokens=number(u.completion_tokens);usage.costUsd=number(u.cost);
    if(object(u.prompt_tokens_details))usage.cachedTokens=number(u.prompt_tokens_details.cached_tokens);
    this.context!.usage(usage);
  }
  async turn(observation:Bundle,signal:AbortSignal):Promise<{status:'ended'|'parked'|'interrupted'}> {
    if(!this.context)fail('inactive','Open the API driver first.');if(this.running)fail('busy','API turn already active.');this.running=true;
    this.active=new AbortController();const combined=AbortSignal.any([signal,this.active.signal]);let invalid=0;
    try {
      this.observe(observation);
      for(let request=0;request<(this.options.maxRequestsPerTurn ?? 32);request++) {
        combined.throwIfAborted();await this.rotate(combined);
        let decoded:ReturnType<ApiDriver['response']>;
        try {const response=await this.request(combined);this.usage(response);decoded=this.response(response);}
        catch(error) {
          if((error as {code?:string}).code!=='protocol'||++invalid>(this.options.maxProtocolRetries ?? 1))throw error;
          this.history.push({role:'user',content:JSON.stringify({protocolError:message(error),effects:'none',instruction:'Return a complete response matching the exposed schema.'})});continue;
        }
        invalid=0;this.history.push(decoded.assistant);
        if(decoded.action) {
          let result:unknown;try{result=await this.context.handlers.call(decoded.action.op,decoded.action.args,combined);}catch(error){result={error:message(error)};}
          this.history.push({role:'user',content:this.content(toolResult(result).content)});
        } else if(decoded.calls.length) {
          const results=await Promise.all(decoded.calls.map(async call=>{
            try{return toolResult(await this.context!.handlers.call(call.function.name,JSON.parse(call.function.arguments),combined));}
            catch(error){return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:message(error)})}]};}
          }));
          const images:ToolContent[]=[];
          // Append every paired tool result before any following multimodal observation.
          for(let i=0;i<decoded.calls.length;i++) {
            const result=results[i]!;
            const text=result.content.filter(c=>c.type==='text').map(c=>(c as {text:string}).text).join('\n');
            this.history.push({role:'tool',tool_call_id:decoded.calls[i]!.id,content:text});
            for(const c of result.content)if(c.type==='image')images.push(c);
          }
          if(images.length)this.history.push({role:'user',content:this.content([{type:'text',text:'Images accompanying the preceding tool results, in result order.'},...images])});
        } else return {status:'ended'};
        if(this.context.bridge.status().loop==='stopped')return {status:'ended'};
        if(this.context.bridge.parked())return {status:'parked'};
      }
      fail('budget','API request budget exhausted; no summary request was made.');
    } finally {this.running=false;this.active=undefined;}
  }
  async interrupt():Promise<void>{this.active?.abort(new Error('API inference interrupted.'));}
  async close():Promise<void>{await this.interrupt();this.history=[];}
}
