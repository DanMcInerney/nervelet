import { Ajv } from 'ajv';
import type { Bridge } from './core.ts';
import { instructions } from './instructions.ts';
import { stepSchema, DIALECT } from './schemas.ts';
import type { Bundle, StepOptions, StepRequest } from './types.ts';
import { bytes, fail, object } from './util.ts';

export interface ToolDefinition { name: string; description: string; inputSchema: Record<string,unknown> }
export type ToolContent = { type:'text'; text:string } | { type:'image'; data:string; mimeType:string };
export interface ToolResult { content: ToolContent[]; isError?: boolean }
export interface Handlers {
  readonly tools: ToolDefinition[]; readonly instructions: string; readonly loopRef: string;
  call(name:string, args:unknown, signal?:AbortSignal): Promise<unknown>;
}
export interface HandlerOptions extends StepOptions {
  stop?: boolean; delegateGoal?: boolean; legacy?: boolean;
  /** The host authenticates before granting this bound handle; loopRef is never a credential. */
  authorize?: () => boolean;
}
export function createHandlers(bridge:Bridge, options:HandlerOptions = {}): Handlers {
  const base={schemaVersion:{const:2},loopRef:{type:'string',const:bridge.loopRef}};
  const schema=(properties:Record<string,unknown>,required:string[]=[]) => ({$schema:DIALECT,type:'object',additionalProperties:false,properties:{...base,...properties},required});
  const commands=Object.entries(bridge.environment.profile.commands).sort(([a],[b])=>a.localeCompare(b)).map(([kind,definition])=>({
    type:'object',additionalProperties:false,required:['id','kind','args'],description:definition.description,
    properties:{id:stepSchema.properties.commands.items.properties.id,kind:{const:kind},args:definition.schema}
  }));
  const tools:ToolDefinition[]=[
    {name:'step',description:'Acknowledge evidence, admit compatible commands, optionally wait, then observe. End this turn when parked.',inputSchema:{...stepSchema,properties:{...stepSchema.properties,commands:{type:'array',maxItems:commands.length?bridge.limits.maxBatch:0,...(commands.length?{items:{oneOf:commands}}:{})}}}},
    {name:'cancel',description:'Request domain job cancellation on the responsive control path.',inputSchema:schema({jobId:{type:'string',minLength:1,maxLength:128}},['jobId'])},
    {name:'describe',description:'Read bounded authoritative profile, command schemas or current status.',inputSchema:schema({topic:{enum:['profile','commands','status']}},['topic'])}
  ];
  if(options.stop !== false)tools.push({name:'stop',description:'End this loop and request domain stop; inspect confirmation.',inputSchema:schema({})});
  if(options.delegateGoal)tools.push({name:'setGoal',description:'Delegated, version-checked goal replacement.',inputSchema:schema({expectedVersion:{type:'integer',minimum:0},text:{type:'string',minLength:1}},['expectedVersion','text'])});
  tools.sort((a,b)=>a.name.localeCompare(b.name));
  // Validate command structure here; Bridge returns individual invalid-argument admissions.
  const ajv=new Ajv({strict:true}), validators=new Map(tools.map(t=>[t.name,ajv.compile(t.name==='step'?stepSchema:t.inputSchema)]));
  const operatingInstructions=instructions(bridge.environment.profile,{stop:options.stop,transport:options.legacy?'cli':'tools'});
  return {
    loopRef:bridge.loopRef, tools, instructions:operatingInstructions,
    async call(name,args,signal) {
      if(options.authorize && !options.authorize())fail('unauthorized','Caller is not authorized for this bound loop.');
      const validate=validators.get(name);
      if(!validate)fail('unauthorized','Tool is not exposed to this caller.');
      if(!object(args) || bytes(args)>16384 || !validate(args))fail('invalid_input','Tool arguments do not match the exposed schema.');
      if(args.loopRef !== undefined && args.loopRef !== bridge.loopRef)fail('unauthorized','Forged loop reference.');
      signal?.throwIfAborted();
      switch(name) {
        case 'step': {
          const bundle=await bridge.step({...args,...(options.legacy ? {} : {schemaVersion:2})} as StepRequest,signal,options);
          if(options.legacy && bundle.attachments?.length)fail('unsupported_images','The CLI compatibility path is text-only. Use MCP or a multimodal driver for images.');
          if(bundle.recovery && !options.legacy)bundle.recovery.instructions=operatingInstructions;
          return bundle;
        }
        case 'cancel':return bridge.cancel(args.jobId as string);
        case 'stop':return bridge.stop();
        case 'setGoal':return bridge.updateGoal(args.text as string,args.expectedVersion as number);
        case 'describe': {
          const result=args.topic==='profile' ? operatingInstructions : args.topic==='commands' ? bridge.environment.profile.commands : bridge.status();
          if(bytes(result)>bridge.limits.maxRecoveryBytes)fail('capacity','Description exceeds capacity.');return result;
        }
        default:fail('invalid_method','Unknown operation.');
      }
    }
  };
}
/** All transports use real image content, never base64 prose or a path in lieu of pixels. */
export function toolResult(value:unknown):ToolResult {
  if(object(value) && Array.isArray(value.attachments)) {
    const bundle=value as unknown as Bundle;
    const {attachments,...rest}=bundle;
    return {content:[{type:'text',text:JSON.stringify({...rest,attachments:attachments!.map(({data:_data,...metadata})=>metadata)})},...attachments!.map(i=>({type:'image' as const,data:i.data,mimeType:i.mimeType}))]};
  }
  return {content:[{type:'text',text:JSON.stringify(value)}]};
}
