import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Bridge, createHandlers } from '../src/index.ts';
import { ApiDriver, type ApiOptions } from '../src/drivers/api.ts';
import { DemoEnvironment } from '../src/adapters/demo.ts';
import type { Bundle } from '../src/types.ts';
const signal=()=>new AbortController().signal;
const call=(id:string,name:string,args:unknown)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const response=(calls?:unknown[],content:unknown=null,reason=calls?'tool_calls':'stop')=>({model:'fixture-model',choices:[{finish_reason:reason,message:{role:'assistant',content,...(calls?{tool_calls:calls,reasoning_details:[{id:'opaque-provider-field'}]}:{})}}],usage:{prompt_tokens:10,completion_tokens:5,prompt_tokens_details:{cached_tokens:2}}});
async function setup(t:test.TestContext,options:Partial<ApiOptions>,handler:(body:Record<string,unknown>,n:number)=>unknown){
  const bridge=new Bridge(new DemoEnvironment(),'Exact API goal');await bridge.start();t.after(()=>bridge.close());const requests:Record<string,unknown>[]=[];
  const server=createServer((req,res)=>{void(async()=>{let body='';for await(const chunk of req)body+=chunk;const value=JSON.parse(body);requests.push(value);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(handler(value,requests.length)));})().catch(e=>{res.statusCode=500;res.end(String(e));});});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number};t.after(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
  const driver=new ApiDriver({endpoint:`http://127.0.0.1:${address.port}/v1/chat/completions`,provider:'mock-http',model:'fixture-model',...options});
  await driver.open({bridge,handlers:createHandlers(bridge,{waitMode:'park'}),usage:()=>{}});t.after(()=>driver.close());
  return {bridge,driver,requests};
}
test('API pairs every call ID including busy/unknown calls and preserves provider message fields',async t=>{
  let initial:Bundle;
  const {bridge,driver,requests}=await setup(t,{},(_body,n)=>n===1?response([call('a','step',{seen:initial.id}),call('b','step',{}),call('c','missing',{})]):response(undefined,'done'));
  initial=await bridge.step({schemaVersion:2});await driver.turn(initial,signal());
  const messages=requests[1]!.messages as Record<string,unknown>[];const tools=messages.filter(m=>m.role==='tool');assert.deepEqual(tools.map(t=>t.tool_call_id),['a','b','c']);assert.match(String(tools[1]!.content),/one step/i);assert.match(String(tools[2]!.content),/not exposed/);
  assert.deepEqual(messages.find(m=>m.role==='assistant')!.reasoning_details,[{id:'opaque-provider-field'}]);assert.equal(requests[0]!.model,'fixture-model');
});
test('API parks between HTTP requests with no closing model request',async t=>{
  let initial:Bundle;
  const {bridge,driver,requests}=await setup(t,{},()=>response([call('p','step',{seen:initial.id,wait:{until:[{kind:'event',type:'mail'}],reviewMs:600000}})]));
  initial=await bridge.step({schemaVersion:2});assert.equal((await driver.turn(initial,signal())).status,'parked');assert.equal(requests.length,1);assert.ok(bridge.parked());
});
test('incomplete output and malformed arguments execute nothing and retries are bounded',async t=>{
  let initial:Bundle;
  const {bridge,driver,requests}=await setup(t,{maxProtocolRetries:1},(_body,n)=>n===1?response([call('x','step',{seen:initial.id,goalVersion:1,commands:[{id:'c1',kind:'set_led',args:{on:true}}]})],null,'length'):response([{id:'x',type:'function',function:{name:'step',arguments:'{"commands":['}}]));
  initial=await bridge.step({schemaVersion:2});await assert.rejects(driver.turn(initial,signal()),/Malformed/);assert.equal(requests.length,2);assert.equal((await bridge.step()).nextCommandId,'c1');
});
test('JSON action rejects extra properties and applies a valid operation through shared handlers',async t=>{
  const {bridge,driver,requests}=await setup(t,{encoding:'json-action',constraints:'json_schema'},(_body,n)=>n===1?response(undefined,'{"op":"stop","args":{},"extra":true}'):response(undefined,'{"op":"stop","args":{}}'));
  await driver.turn(await bridge.step(),signal());assert.equal(bridge.status().loop,'stopped');assert.equal(requests.length,2);assert.ok(requests[0]!.response_format);
});
test('history rotates only complete exchanges and supplies authoritative recovery',async t=>{
  // Size against real generated recovery, leaving room for metadata but not a full description exchange.
  const sizing=new Bridge(new DemoEnvironment(),'Exact API goal');await sizing.start();t.after(()=>sizing.close());
  const baseline=[{role:'system',content:createHandlers(sizing,{waitMode:'park'}).instructions},
    {role:'user',content:JSON.stringify(await sizing.step({schemaVersion:2}))}];
  const maxHistoryBytes=Buffer.byteLength(JSON.stringify(baseline))+256;
  const {bridge,driver,requests}=await setup(t,{maxHistoryBytes},(_body,n)=>n===1?response([call('d','describe',{topic:'profile'})]):response(undefined,'done'));
  await driver.turn(await bridge.step({schemaVersion:2}),signal());assert.equal(requests.length,2);
  const second=requests[1]!.messages as Record<string,unknown>[];assert.equal(second.length,2);const recovery=JSON.parse(second[1]!.content as string);assert.equal(recovery.recovery.reason,'api_history_rotation');assert.equal(recovery.goal.text,'Exact API goal');assert.equal(second.some(m=>m.role==='tool'),false);
  assert.ok(requests.every(request=>Buffer.byteLength(JSON.stringify(request.messages))<=maxHistoryBytes));
});
test('unsupported image and changed model fail explicitly without fallback',async t=>{
  const {bridge,driver,requests}=await setup(t,{},()=>({...response(undefined,'done'),model:'substituted'}));
  const image=await bridge.step();image.attachments=[{type:'image',id:'x',mimeType:'image/png',data:'eA==',receivedMs:0,valid:true,reused:false}];
  await assert.rejects(driver.turn(image,signal()),/does not support images/);assert.equal(requests.length,0);
  await assert.rejects(driver.turn(await bridge.step(),signal()),/requested fixture-model/);assert.equal(requests.length,1);
});
test('HTTP authentication failure stops without repeated requests',async t=>{
  const {bridge,driver,requests}=await setup(t,{fetch:async()=>new Response('',{status:401})},()=>response());
  await assert.rejects(driver.turn(await bridge.step(),signal()),/HTTP 401/);assert.equal(requests.length,0);
});
