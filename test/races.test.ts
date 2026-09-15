import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, Supervisor, createHandlers } from '../src/index.ts';
import { DemoEnvironment } from '../src/adapters/demo.ts';
import { delay } from './helpers.ts';
import type { AgentDriver, DriverContext } from '../src/supervisor.ts';
import type { Bundle } from '../src/types.ts';
async function setup(t:test.TestContext,env=new DemoEnvironment()) {const bridge=new Bridge(env,'Goal');await bridge.start();t.after(()=>bridge.close());const b=await bridge.step({schemaVersion:2});await bridge.step({schemaVersion:2,seen:b.id});return {bridge,env};}
test('terminal-job wait wakes on actual completion and sample acquisition continues while parked',async t=>{
  const {bridge}=await setup(t);const b=await bridge.step({schemaVersion:2,goalVersion:1,commands:[{id:'c1',kind:'move',args:{durationMs:100}}],wait:{until:[{kind:'jobTerminal',id:'demo-c1'}],reviewMs:10000}},undefined,{waitMode:'park'});
  assert.equal(b.wait?.status,'parked');assert.equal(await bridge.parked()!.ready,'jobTerminal');const after=await bridge.step({schemaVersion:2});assert.equal(after.jobs?.[0]?.status,'completed');assert.ok(after.samples!.temperature!.receivedMs>b.samples!.temperature!.receivedMs);
});
test('event arriving inside wait snapshot cannot be lost; cancelled tokens cannot wake replacement waits',async t=>{
  class Racing extends DemoEnvironment {inject=false;override async snapshot(after:number){const snap=await super.snapshot(after);if(this.inject){this.inject=false;this.store.push('mail','raced');}return snap;}}
  const env=new Racing(),{bridge}=await setup(t,env);env.inject=true;
  const first=await bridge.step({schemaVersion:2,wait:{until:[{kind:'event',type:'mail'}],reviewMs:10000}},undefined,{waitMode:'park'});assert.equal(first.wait?.reason,'event');
  await bridge.step({schemaVersion:2,wait:{until:[{kind:'event',type:'old'}],reviewMs:10000}},undefined,{waitMode:'park'});const old=bridge.parked()!;
  await bridge.cancel('missing');await assert.rejects(old.ready,/cancelled/);
  await bridge.step({schemaVersion:2,wait:{until:[{kind:'event',type:'new'}],reviewMs:25}},undefined,{waitMode:'park'});const replacement=bridge.parked()!;env.store.push('old','late');assert.equal(await replacement.ready,'review');assert.notEqual(old.token,replacement.token);
});
test('v2 lost command results persist until acknowledgement and delivery metadata remains bounded',async t=>{
  const {bridge}=await setup(t);const issued=await bridge.step({schemaVersion:2,goalVersion:1,commands:[{id:'c1',kind:'sample',args:{}}]});
  assert.deepEqual((await bridge.step({schemaVersion:2})).results,issued.results);
  assert.equal((await bridge.step({schemaVersion:2,seen:issued.id})).results,undefined);
  for(let i=0;i<40;i++)await bridge.step({schemaVersion:2});await assert.rejects(bridge.step({schemaVersion:2,seen:issued.id}),/expired seen/);
});
test('supervisor stops on bounded unexpected finals and releases borrowed driver without closing it',async t=>{
  const bridge=new Bridge(new DemoEnvironment(),'Bounded');let turns=0,closes=0;
  const driver:AgentDriver={capabilities:{name:'fake',mode:'managed',parking:true,toolHoldMs:0,images:'unsupported',recovery:'repeat',usage:[],qualification:'fake'},async open(){},async turn(){turns++;return {status:'ended'};},async interrupt(){},async close(){closes++;}};
  const supervisor=new Supervisor(bridge,driver,{maxUnexpectedFinals:1,driverOwnership:'borrowed'});
  await assert.rejects(supervisor.run(),/Unexpected final/);assert.equal(turns,2);assert.equal(closes,0);assert.equal(bridge.status().loop,'stopped');assert.equal(supervisor.stats().modelCallsAvailable,false);
});
test('goal change interrupts one active turn, waits for its end, then delivers the authoritative goal',async()=>{
  const bridge=new Bridge(new DemoEnvironment(),'First');let context:DriverContext;let turns=0,active=0;let began:()=>void=()=>{};const started=new Promise<void>(r=>{began=r;});
  const driver:AgentDriver={capabilities:{name:'fake',mode:'managed',parking:true,toolHoldMs:0,images:'unsupported',recovery:'events',usage:[],qualification:'fake'},async open(c){context=c;},async interrupt(){},async close(){},async turn(b:Bundle,s:AbortSignal){assert.equal(++active,1);turns++;
    try {if(turns===1){began();await new Promise<void>(r=>{s.addEventListener('abort',()=>{void delay(15).then(r);},{once:true});});return {status:'interrupted'};}
      assert.equal(b.goal.text,'Second');await context.handlers.call('stop',{});return {status:'ended'};
    }finally{active--;}}};
  const running=new Supervisor(bridge,driver).run();await started;await bridge.updateGoal('Second');await running;assert.equal(turns,2);
});
test('withheld stop is absent from generated recovery instructions',async t=>{
  const {bridge}=await setup(t);bridge.refresh();const h=createHandlers(bridge,{stop:false});const b=await h.call('step',{}) as Bundle;
  assert.ok(!b.recovery!.instructions.includes('Explicit stop ends'));assert.ok(!h.tools.some(t=>t.name==='stop'));
});
test('conditional event matching searches bounded unread slices without consuming earlier mail',async t=>{
  const {bridge,env}=await setup(t);for(let i=0;i<70;i++)env.store.push('unrelated',i);env.store.push('wanted','last');
  const result=await bridge.step({schemaVersion:2,wait:{until:[{kind:'event',type:'wanted'}],reviewMs:10000}},undefined,{waitMode:'park'});
  assert.equal(result.wait?.reason,'event');assert.equal(result.events?.[0]?.data,0);assert.equal(result.hasMore,true);assert.equal(env.store.stats().events,71);
});
