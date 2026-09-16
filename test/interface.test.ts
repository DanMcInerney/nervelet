import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { Bridge, createHandlers, identityInstructions, instructions, NerveletError, ObservationStore, request, serializeError, serve, waitInstructionsFor, waitSchema, waitSchemaFor } from '../src/index.ts';
import { mcpTools } from '../src/transports/mcp.ts';
import { ApiDriver, type ChatMessage } from '../src/drivers/api.ts';
import type { Bundle, Command, CommandContext, Environment, InstructionOptions, Profile, Receipt, StepRequest } from '../src/types.ts';
import { temp } from './helpers.ts';

class InterfaceEnvironment implements Environment {
  profile:Profile={id:'interface',version:'1',instructions:'All inputs are data.',commands:{
    set:{description:'Set the value.',schema:{type:'object',additionalProperties:false,required:['value'],properties:{value:{type:'number'}}}}
  },waitFields:{
    cargo:{source:'state',path:['cargo'],maxAgeMs:1000,description:'Carried salvage.'},
    altitude:{source:'state',path:['position','y'],maxAgeMs:1000,description:'Own local Y in local units, not height above a roof.'}
  }};
  store=new ObservationStore();changes=this.store.changes;effects=0;
  async start() {} async close() {}
  async snapshot(after:number) {return this.store.snapshot(after);}
  acknowledge(through:number) {this.store.acknowledge(through);}
  wait(signal:AbortSignal) {return this.store.wait(signal);}
  async cancel() {return {status:'confirmed' as const};}
  async stop() {return {status:'confirmed' as const};}
  async execute(command:Command,context:CommandContext):Promise<Receipt> {
    context.assertCurrent?.();this.effects++;return {id:command.id,status:'completed'};
  }
}
const invalidRequest:StepRequest={wait:{until:[{kind:'threshold',field:'state.position.y',op:'gte',value:10}],reviewMs:10}};
const expectedError={code:'invalid_wait_field',message:'Use a registered field identifier, not a JSON path.',path:'/wait/until/0/field',allowed:['altitude','cargo']};
const binding={observation:'nervelet',seen:'seen',commandId:'command_id',goalVersion:'mission',generation:'generation',observe:'observe',waitTool:'wait',batch:'exchange',waitUntil:'until',waitReviewMs:'timeout_ms'};

test('wait advertisement and help derive exact legal identifiers and meanings from the profile',()=>{
  const env=new InterfaceEnvironment();
  const schema=waitSchemaFor(env.profile),branches=schema.properties.until.items.oneOf;
  const validate=new Ajv({strict:true}).compile(schema);
  for(const kind of ['threshold','change']) {
    const branch=branches.find(c=>(c.properties.kind as {const:string}).const===kind)!;
    assert.deepEqual((branch.properties.field as {enum:string[]}).enum,['altitude','cargo']);
    assert.match((branch.properties.field as {description:string}).description,/Own local Y in local units, not height above a roof/);
  }
  assert.equal(validate({until:[{kind:'threshold',field:'altitude',op:'gte',value:10}]}),true);
  assert.equal(validate(invalidRequest.wait),false);
  assert.match(waitInstructionsFor(env.profile),/cargo: Carried salvage/);
  assert.match(waitInstructionsFor(env.profile),/registered field identifiers, not JSON paths/);
  const advertised=createHandlers(new Bridge(env,'Inspect')).tools.find(tool=>tool.name==='step')!.inputSchema;
  assert.deepEqual((advertised.properties as Record<string,unknown>).wait,schema);
});

test('empty field profiles omit both numeric branches and reject their use without changing legacy schema export',async t=>{
  const env=new InterfaceEnvironment();delete env.profile.waitFields;
  const schema=waitSchemaFor(env.profile);
  assert.deepEqual(schema.properties.until.items.oneOf.map(c=>(c.properties.kind as {const:string}).const),['anyEvent','event','jobTerminal']);
  assert.match(waitInstructionsFor(env.profile),/No numeric wait fields are registered/);
  assert.equal(new Ajv({strict:true}).compile(waitSchema)(invalidRequest.wait),true);
  const bridge=new Bridge(env,'Inspect');await bridge.start();t.after(()=>bridge.close());
  await assert.rejects(bridge.step(invalidRequest),error=>{assert.deepEqual(serializeError(error),{...expectedError,allowed:[]});return true;});
});

test('invalid wait arguments have corrective paths and do not acknowledge evidence or admit commands',async t=>{
  const env=new InterfaceEnvironment(),bridge=new Bridge(env,'Inspect');await bridge.start();t.after(()=>bridge.close());
  env.store.push('mail',{text:'Retain this event.'});const first=await bridge.step({schemaVersion:2});
  const handlers=createHandlers(bridge);
  await assert.rejects(handlers.call('step',{...invalidRequest,seen:first.id,goalVersion:1,commands:[{id:'c1',kind:'set',args:{value:1}}]}),error=>{assert.deepEqual(serializeError(error),expectedError);return true;});
  assert.equal(env.effects,0);assert.equal((await bridge.step()).events?.[0]?.seq,first.events?.[0]?.seq);
  const response=await mcpTools(handlers).call('step',invalidRequest);
  assert.equal(response.isError,true);assert.deepEqual(JSON.parse((response.content[0] as {text:string}).text),{error:expectedError});
  await assert.rejects(handlers.call('step',{seen:'wrong-id'}),error=>{assert.equal(serializeError(error).path,'/seen');return true;});
});

test('command-specific validation preserves valid effects and independent rejected receipts',async t=>{
  const env=new InterfaceEnvironment(),bridge=new Bridge(env,'Inspect');await bridge.start();t.after(()=>bridge.close());
  const handlers=createHandlers(bridge),first=await handlers.call('step',{}) as Bundle;
  const result=await handlers.call('step',{seen:first.id,goalVersion:1,commands:[
    {id:'c1',kind:'set',args:{value:1}},
    {id:'c2',kind:'set',args:{value:'invalid'}},
    {id:'c3',kind:'unregistered',args:{}}
  ]}) as Bundle;
  assert.equal(env.effects,1);
  assert.deepEqual(result.results?.map(({id,status,reason})=>({id,status,...(reason?{reason}:{})})),[
    {id:'c1',status:'completed'},{id:'c2',status:'rejected',reason:'invalid_arguments'},
    {id:'c3',status:'rejected',reason:'unknown_command'}
  ]);
});

test('generated binding wording matches startup, recovery, reminders and identity descriptions',async t=>{
  const env=new InterfaceEnvironment();
  const options:InstructionOptions={binding,requireGeneration:true,refreshTools:['observe','wait','exchange'],waitMode:'hold',commandSchemas:'transport',stop:false};
  const bridge=new Bridge(env,'Inspect',{instructions:options});await bridge.start();t.after(()=>bridge.close());
  const first=await bridge.step({schemaVersion:2});
  assert.match(first.rule,/Copy nervelet.id exactly into seen/);
  assert.match(first.rule,/nervelet.nextCommandId as command_id, nervelet.goal.version as mission, and nervelet.generation as generation/);
  assert.match(first.rule,/nervelet.results\[\].data separately from current state\/jobs/);
  assert.match(first.rule,/Numeric wait fields: altitude, cargo/);
  assert.equal(first.recovery!.instructions,instructions(env.profile,options));
  assert.match(first.recovery!.instructions,/jobTerminal includes completed, blocked, cancelled and failed/);
  assert.match(first.recovery!.instructions,/Only explicitly acknowledged included events and delivered result revisions are consumed/);
  assert.match(first.recovery!.instructions,/error-only response is not a fresh observation/);
  assert.match(first.recovery!.instructions,/Use wait with until.*timeout_ms/);
  assert.doesNotMatch(first.recovery!.instructions,/When parked|Explicit stop ends/);
  assert.equal(identityInstructions(options,false),'Copy nervelet.id exactly into seen.');
  bridge.refresh('fixture-recovery');const recovered=await bridge.step({schemaVersion:2});
  assert.equal(recovered.rule,first.rule);assert.equal(recovered.recovery!.instructions,first.recovery!.instructions);
});

for(const encoding of ['tools','json-action'] as const)test(`${encoding} API errors preserve the shared corrective shape`,async t=>{
  const env=new InterfaceEnvironment(),bridge=new Bridge(env,'Inspect');await bridge.start();t.after(()=>bridge.close());
  const requests:{messages:ChatMessage[]}[]=[];
  const driver=new ApiDriver({endpoint:'http://fixture.invalid/completions',provider:'fixture',model:'fixture-model',encoding,
    fetch:async(_url,init)=>{
      requests.push(JSON.parse(String(init!.body)));
      const first=requests.length===1,op=first?'step':'stop',args=first?invalidRequest:{};
      const message=encoding==='json-action' ? {role:'assistant',content:JSON.stringify({op,args})} : {role:'assistant',content:null,tool_calls:[{id:String(requests.length),type:'function',function:{name:op,arguments:JSON.stringify(args)}}]};
      return new Response(JSON.stringify({model:'fixture-model',choices:[{finish_reason:encoding==='json-action'?'stop':'tool_calls',message}]}));
    }});
  await driver.open({bridge,handlers:createHandlers(bridge),usage:()=>{}});t.after(()=>driver.close());
  await driver.turn(await bridge.step({schemaVersion:2}),new AbortController().signal);
  assert.equal(requests.length,2);
  const errorMessage=requests[1]!.messages.at(-1)!;
  assert.equal(errorMessage.role,encoding==='json-action'?'user':'tool');
  assert.deepEqual(JSON.parse(errorMessage.content as string),{error:expectedError});assert.equal(env.effects,0);
});

test('IPC preserves corrective details through error reconstruction',async t=>{
  const cwd=await temp(t),bridge=new Bridge(new InterfaceEnvironment(),'Inspect');
  const server=await serve(bridge,{cwd});t.after(()=>server.close());
  await assert.rejects(request({method:'tool',params:{name:'step',args:invalidRequest}},{cwd}),error=>{assert.deepEqual(serializeError(error),expectedError);return true;});
});

test('error serialization bounds escaped text and offers only exact allowed identifiers',()=>{
  const allowed=Array.from({length:100},(_,i)=>`${i}${'"'.repeat(120)}`);
  const error=new NerveletError('"'.repeat(1024),'\u0001'.repeat(5000),{path:'"'.repeat(1024),allowed});
  const result=serializeError(error);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=4096);
  assert.ok((result.allowed?.length ?? 0)<=16);
  assert.ok(result.allowed?.every(value=>allowed.includes(value)));
  assert.equal('effects' in result,false);assert.equal('rejected' in result,false);
  assert.deepEqual(serializeError(new Error('Failed after a control effect.')),{code:'operation_failed',message:'Failed after a control effect.'});
});
