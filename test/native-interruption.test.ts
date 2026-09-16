import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, createHandlers } from '../src/index.ts';
import { CodexDriver } from '../src/drivers/codex.ts';
import type { AppServerClient, RpcEvent } from '../src/drivers/app-server.ts';
import { ClaudeCodeDriver } from '../src/drivers/claude-code.ts';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { deferred, Feed } from './attention-fixture.ts';
import { delay } from './helpers.ts';

async function context(t:test.TestContext){const bridge=new Bridge(new Feed(),'Goal');await bridge.start();t.after(()=>bridge.close());return {bridge,handlers:createHandlers(bridge),usage:()=>{}};}
test('Codex interruption during turn/start keeps identity and waits for matching terminal notification',async t=>{
  const c=await context(t), starting=deferred(), response=deferred<unknown>();let listener!:(e:RpcEvent)=>void;const requests:string[]=[];
  let turn=0;
  const emit=(id:string,status='interrupted',threadId='thread')=>listener({method:'turn/completed',params:{threadId,turn:{id,status}}});
  const client:AppServerClient={subscribe(fn){listener=fn;return()=>{};},async request(method,params){requests.push(method);
    if(method==='thread/start')return {thread:{id:'thread'},model:'fixture'};
    if(method==='turn/start'){turn++;if(turn===1){starting.resolve();return response.promise;}emit('old','completed');queueMicrotask(()=>emit('new','completed'));return {turn:{id:'new'}};}
    if(method==='turn/interrupt')assert.equal(params.turnId,'old');return {};
  }};
  const driver=new CodexDriver({client,model:'fixture',cwd:process.cwd(),approvalPolicy:'never',sandbox:'read-only',connectTools:async()=>({config:{}})});t.after(()=>driver.close());
  await driver.open(c,new AbortController().signal);const controller=new AbortController(), b=await c.bridge.step({schemaVersion:2});
  let settled=false;const work=driver.turn(b,controller.signal).then(r=>{settled=true;return r;});await starting.promise;controller.abort();
  emit('unrelated','completed');response.resolve({turn:{id:'old'}});await delay(5);
  assert.equal(requests.filter(m=>m==='turn/interrupt').length,1);assert.equal(settled,false);
  emit('old','interrupted','other-actor');emit('wrong');await delay(5);assert.equal(settled,false);
  emit('old');assert.equal((await work).status,'interrupted');assert.equal((await driver.turn(b,new AbortController().signal)).status,'ended');
  assert.equal(requests.filter(m=>m==='thread/start').length,1);
});

class Events {
  private queue:SDKMessage[]=[];private ready=deferred();closed=false;
  push(event:SDKMessage){this.queue.push(event);this.ready.resolve();}
  close(){this.closed=true;this.ready.resolve();}
  async *iterate(){while(!this.closed){if(!this.queue.length)await this.ready.promise;this.ready=deferred();while(this.queue.length)yield this.queue.shift()!;}}
}
function result(uuid:string|undefined,extra:Record<string,unknown>={}):SDKMessage {
  return {type:'result',subtype:'success',is_error:false,permission_denials:[],total_cost_usd:0,usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:0},session_id:'session',user_message_uuid:uuid,...extra} as unknown as SDKMessage;
}
async function claude(t:test.TestContext) {
  const c=await context(t), events=new Events(), submitted:SDKUserMessage[]=[];let inputReady=deferred(),interrupts=0;
  const query=({prompt}:{prompt:string|AsyncIterable<SDKUserMessage>;options?:Options}):Query=>{
    void(async()=>{for await(const input of prompt as AsyncIterable<SDKUserMessage>){submitted.push(input);inputReady.resolve();}})();
    return Object.assign(events.iterate(),{initializationResult:async()=>({}),interrupt:async()=>{interrupts++;},close:()=>events.close()}) as unknown as Query;
  };
  const driver=new ClaudeCodeDriver({model:'fixture',cwd:process.cwd(),permissionMode:'default',allowedTools:[],settingSources:[],query});t.after(()=>driver.close());await driver.open(c,new AbortController().signal);
  return {c,driver,events,submitted,interrupts:()=>interrupts,async nextInput(){if(submitted.length)return submitted.at(-1)!;await inputReady.promise;return submitted.at(-1)!;},reset(){submitted.length=0;inputReady=deferred();}};
}
test('Claude interruption pairs terminal result to input UUID, keeps one streaming session, and ignores late old results',async t=>{
  const f=await claude(t), b=await f.c.bridge.step({schemaVersion:2});let settled=false;
  const work=f.driver.turn(b,new AbortController().signal).then(r=>{settled=true;return r;});const input=await f.nextInput();
  await Promise.all([f.driver.interrupt(),f.driver.interrupt()]);assert.equal(f.interrupts(),1);assert.equal(settled,false);
  f.events.push(result('other'));await delay(5);assert.equal(settled,false);
  f.events.push(result(input.uuid,{subtype:'error_during_execution',is_error:true,terminal_reason:'aborted_tools'}));
  assert.equal((await work).status,'interrupted');f.reset();
  const next=f.driver.turn(b,new AbortController().signal);const nextInput=await f.nextInput();f.events.push(result(input.uuid));f.events.push(result(nextInput.uuid));
  assert.equal((await next).status,'ended');assert.equal(f.driver.sessionId,'session');
});
for(const failure of ['uncorrelated','budget','permission','closed'] as const)test(`Claude ${failure} is a fault, not an intentional emergency completion`,async t=>{
  const f=await claude(t), b=await f.c.bridge.step();const work=f.driver.turn(b,new AbortController().signal);const input=await f.nextInput();await f.driver.interrupt();
  if(failure==='closed')f.events.close();
  else f.events.push(result(failure==='uncorrelated'?undefined:input.uuid,failure==='budget'?{subtype:'error_max_budget_usd',is_error:true,terminal_reason:'budget_exhausted'}:failure==='permission'?{permission_denials:[{}],terminal_reason:'aborted_tools'}:{}));
  await assert.rejects(work,/matching|failed|stream ended/);
});
