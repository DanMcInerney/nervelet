import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, createHandlers, settleEmergency, Supervisor } from '../src/index.ts';
import type { AgentDriver, BridgeOptions, Bundle, Command, CommandContext, DriverContext, Receipt, Trace } from '../src/index.ts';
import { attention, deferred, evidence, Feed } from './attention-fixture.ts';
import { delay } from './helpers.ts';

async function setup(t:test.TestContext,env=new Feed(),options:BridgeOptions={}) {
  const bridge=new Bridge(env,'Exact\ngoal',{attention,...options});await bridge.start();t.after(()=>bridge.close());
  const initial=await bridge.step({schemaVersion:2});await bridge.step({seen:initial.id});return {bridge,env,initial};
}
const capabilities:AgentDriver['capabilities']={name:'fixture',mode:'managed',parking:true,toolHoldMs:0,images:'unsupported',recovery:'events',usage:[],interruption:'terminal-event',qualification:'deterministic only'};

test('attention is opt-in, host-only, bounded and dated; rejected evidence does not change generation',async t=>{
  const disabled=new Bridge(new Feed(),'Goal');assert.throws(()=>disabled.requestAttention(evidence()),/disabled/);
  const {bridge}=await setup(t);const gen=bridge.status().generation;
  assert.throws(()=>bridge.requestAttention({...evidence(),data:'x'.repeat(2048)}),/budget/);
  assert.throws(()=>bridge.requestAttention({...evidence(),receivedMs:-1}),/receipt time/);
  assert.equal(bridge.status().generation,gen);assert.ok(!createHandlers(bridge).tools.some(t=>t.name.includes('attention')));
});

test('streaming never interrupts reasoning; one coalesced emergency resumes same goal without overlapping turns',async()=>{
  const env=new Feed(), traces:Trace[]=[], bridge=new Bridge(env,'Exact\ngoal',{attention,trace:e=>traces.push(e)});
  const started=deferred(), interrupted=deferred(), ended=deferred();let context!:DriverContext, turns=0, active=0, interrupts=0;
  const driver:AgentDriver={capabilities,async open(c){context=c;},async close(){},async interrupt(){interrupts++;interrupted.resolve();},async turn(b,s){
    assert.equal(++active,1);turns++;
    try {
      if(turns===1){started.resolve();await ended.promise;return {status:'interrupted'};}
      assert.equal(b.goal.text,'Exact\ngoal');assert.equal(b.goal.version,1);assert.ok(b.attention);
      const next=await context.handlers.call('step',{seen:b.id,generation:b.generation,goalVersion:1,commands:[{id:'c1',kind:'publish',args:{}}]}) as Bundle;
      assert.equal(next.results?.[0]?.status,'completed');await context.handlers.call('stop',{});return {status:'ended'};
    } finally {active--;}
  }};
  const run=new Supervisor(bridge,driver).run();await started.promise;
  for(let i=0;i<100;i++)env.store.setSample('count',{value:i,valid:true,receivedMs:performance.now()});
  await delay(5);assert.equal(interrupts,0);assert.equal(turns,1);
  const a=bridge.requestAttention(evidence());for(let i=0;i<50;i++)assert.equal(bridge.requestAttention(evidence()).id,a.id);
  await interrupted.promise;assert.equal(turns,1);assert.equal(active,1);await delay(5);assert.equal(turns,1);
  ended.resolve();await run;assert.equal(turns,2);assert.equal(env.effects,1);assert.equal(bridge.attention()?.coalesced,50);
  assert.equal(traces.filter(t=>t.type==='interrupt_requested').length,1);
  assert.ok(traces.some(t=>t.type==='replacement_submitted'&&t.attentionId===a.id));
  assert.ok(traces.some(t=>t.type==='admission'&&t.attentionId===a.id));
});

test('old-generation commands remain gated after fresh acknowledgement; known duplicates and controls remain available',async t=>{
  const {bridge,env,initial}=await setup(t);const c={id:'c1',kind:'publish',args:{value:'original'}};
  await bridge.step({generation:initial.generation,goalVersion:1,commands:[c]});
  bridge.requestAttention(evidence());await settleEmergency(bridge);
  const fresh=await bridge.step({schemaVersion:2});await bridge.step({seen:fresh.id});
  const stale=await bridge.step({generation:initial.generation,goalVersion:1,commands:[{...c,id:'c2'}]});
  assert.equal(stale.results?.[0]?.reason,'stale_generation');
  assert.equal((await bridge.step({goalVersion:1,commands:[c]})).results?.[0]?.status,'completed');
  const bound=createHandlers(bridge,{effectGeneration:initial.generation});
  assert.equal(((await bound.call('step',{generation:fresh.generation,goalVersion:1,commands:[{...c,id:'c3'}]})) as Bundle).results?.[0]?.reason,'stale_generation');
  await bound.call('cancel',{jobId:'job'});await bound.call('stop',{});assert.equal(env.effects,1);
});

test('emergency capsule crosses an inbox backlog without acknowledging unseen FIFO events',async t=>{
  const {bridge,env}=await setup(t,undefined,{limits:{maxBundleBytes:1600,maxRecoveryBytes:4096}});
  for(let i=0;i<80;i++)assert.ok(env.store.push('ordinary',{i,text:'x'.repeat(50)}));
  env.store.push('urgent','original event');
  const a=bridge.requestAttention({...evidence(),eventIds:[`${bridge.epoch}:e81`]});await settleEmergency(bridge);
  const b=await bridge.step({schemaVersion:2});assert.equal(b.attention?.id,a.id);assert.equal(b.events?.[0]?.seq,1);assert.ok(!b.events?.some(e=>e.seq===81));assert.equal(b.hasMore,true);
  const included=b.events!.length;const after=await bridge.step({schemaVersion:2,seen:b.id});
  assert.equal(bridge.attention()?.status,'acknowledged');assert.equal(env.store.stats().events,81-included);assert.equal(after.events?.[0]?.seq,included+1);
  let next=after;while(!next.events?.some(e=>e.seq===81))next=await bridge.step({schemaVersion:2,seen:next.id});
  assert.equal(next.events!.at(-1)!.id,`${bridge.epoch}:e81`);
});

test('held wait uses its open result for attention with no native interruption',async t=>{
  const {bridge}=await setup(t);const wait=bridge.step({schemaVersion:2,wait:{until:[{kind:'event',type:'never'}],reviewMs:10000}});
  await delay(5);bridge.requestAttention(evidence());let interrupts=0;
  const settling=settleEmergency(bridge,{ended:new Promise(()=>{}),interrupt:async()=>{interrupts++;}});
  const b=await wait;assert.ok(b.attention);assert.equal(await settling,'boundary');assert.equal(interrupts,0);
  await bridge.step({seen:b.id});assert.equal(bridge.attention()?.status,'acknowledged');
});

test('capture interruption discards old images and delivers a fresh boundary without cancelling domain jobs',async t=>{
  const entered=deferred();let oldSignal!:AbortSignal;let captures=0;
  const env=new Feed() as Feed & {capture?:(s:AbortSignal)=>Promise<import('../src/types.ts').ImageAttachment[]>};
  const {bridge}=await setup(t,env);
  env.capture=async s=>{captures++;if(captures===1){oldSignal=s;entered.resolve();await new Promise<void>((_,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true}));}return [{type:'image',id:'fresh',mimeType:'image/png',data:'eA==',receivedMs:performance.now(),valid:true,reused:false}];};
  const step=bridge.step({schemaVersion:2});await entered.promise;bridge.requestAttention(evidence());const settled=settleEmergency(bridge);
  const b=await step;await settled;assert.ok(oldSignal.aborted);assert.ok(b.attention);assert.equal(env.stops,0);
  // The aborted capture is explicitly missing; replacement acquisition happens at the next boundary.
  assert.ok(b.media || b.attachments?.[0]?.id==='fresh');
  const fresh=await bridge.step({schemaVersion:2,seen:b.id});assert.equal(fresh.attachments?.[0]?.id,'fresh');
});

test('attention during uncertain admission reconciles by identity without replay and invalidates late effects',async t=>{
  const entered=deferred(), release=deferred();let late:Promise<Receipt>|undefined;let checks=0;
  class Uncertain extends Feed {
    override async execute(c:Command,context:CommandContext):Promise<Receipt>{
      entered.resolve();late=(async()=>{await release.promise;context.assertCurrent!();this.effects++;return {id:c.id,status:'completed'};})();void late.catch(()=>{});return late;
    }
    async reconcileReceipt(identity:{id:string;digest:string}){checks++;assert.equal(identity.digest.length,64);return {id:identity.id,status:'not_executed' as const};}
  }
  const {bridge,env,initial}=await setup(t,new Uncertain(),{retainCommandArguments:false});
  const step=bridge.step({schemaVersion:2,generation:initial.generation,goalVersion:1,commands:[{id:'c1',kind:'publish',args:{important:'original'}}]});
  await entered.promise;bridge.requestAttention(evidence());const settling=settleEmergency(bridge);await step;await settling;
  assert.equal(checks,1);release.resolve();await assert.rejects(late!);assert.equal(env.effects,0);
  const b=await bridge.step({schemaVersion:2});await bridge.step({seen:b.id});
  assert.equal((await bridge.step({commands:[{id:'c1',kind:'publish',args:{important:'original'}}]})).results?.[0]?.status,'not_executed');assert.equal(env.effects,0);
});

test('explicit rearm requires acknowledgement and respects transition and interrupt budgets',async t=>{
  const {bridge}=await setup(t,undefined,{attention:{...attention,maxTransitions:2,maxInterrupts:1}});
  const a=bridge.requestAttention(evidence());assert.throws(()=>bridge.rearmAttention(a.id),/acknowledged/);
  const ended=deferred();await settleEmergency(bridge,{ended:ended.promise,interrupt:async()=>{ended.resolve();}});
  let b=await bridge.step({schemaVersion:2});await bridge.step({seen:b.id});assert.throws(()=>bridge.requestAttention(evidence()),/rearm/);
  bridge.rearmAttention(a.id);bridge.requestAttention({...evidence(),episode:'two'});
  await assert.rejects(settleEmergency(bridge,{ended:new Promise(()=>{}),interrupt:async()=>{}}),/interrupt budget/);
  assert.match(bridge.status().fault!,/attention_fault/);
});

for(const failure of ['unsupported','rpc','timeout'] as const)test(`attention ${failure} fails explicitly without replacement`,async t=>{
  const {bridge}=await setup(t,undefined,{attention:{...attention,terminationMs:20}});bridge.requestAttention(evidence());
  const turn={ended:new Promise(()=>{}),...(failure==='unsupported'?{}:{interrupt:async()=>{if(failure==='rpc')throw new Error('interrupt failed');}})};
  await assert.rejects(settleEmergency(bridge,turn),failure==='unsupported'?/cannot interrupt/:failure==='rpc'?/interrupt failed/:/exceeded/);
  assert.equal(bridge.attention()?.status,'fault');assert.match(bridge.status().fault!,/attention_fault/);
});

test('Stop and closure win over queued attention restarts',async t=>{
  for(const close of [false,true]) {
    const {bridge}=await setup(t);bridge.requestAttention(evidence());const ended=deferred(), interrupted=deferred();
    const work=settleEmergency(bridge,{ended:ended.promise,interrupt:async()=>{interrupted.resolve();}});
    await interrupted.promise;await (close?bridge.close():bridge.stop());ended.resolve();assert.equal(await work,'inactive');assert.equal(bridge.status().loop,'stopped');
  }
});

test('parked and naturally closing operators resume once on the unchanged goal',async()=>{
  for(const closing of [false,true]) {
    const bridge=new Bridge(new Feed(),'Goal',{attention});const parked=deferred(), finish=deferred();let context!:DriverContext, turns=0, active=0;
    const driver:AgentDriver={capabilities,async open(c){context=c;},async close(){},async interrupt(){finish.resolve();},async turn(b){assert.equal(++active,1);turns++;
      try {if(turns===1){await context.handlers.call('step',{seen:b.id,wait:{until:[{kind:'event',type:'never'}],reviewMs:10000}});parked.resolve();if(closing)await finish.promise;return {status:'ended'};}
      assert.equal(b.goal.version,1);assert.ok(b.attention);await context.handlers.call('stop',{});return {status:'ended'};}finally{active--;}
    }};
    const run=new Supervisor(bridge,driver).run();await parked.promise;if(!closing)await delay(5);
    bridge.requestAttention(evidence());await run;assert.equal(turns,2);
  }
});

test('natural completion racing attention needs no interrupt and capsule capacity failure remains gated',async t=>{
  const {bridge}=await setup(t);bridge.requestAttention(evidence());let interrupts=0;
  assert.equal(await settleEmergency(bridge,{ended:Promise.resolve(),interrupt:async()=>{interrupts++;}}),'restart');assert.equal(interrupts,0);
  await assert.rejects(bridge.step({schemaVersion:2},undefined,{wrapperBytes:40000}),/capacity/);
  assert.match(bridge.status().fault!,/attention_fault/);assert.equal(bridge.attention()?.status,'fault');
});

test('attention during asynchronous recovery assembly reacquires instead of marking stale evidence current',async t=>{
  const reading=deferred(),release=deferred();let notes=0;
  const env=new Feed(),bridge=new Bridge(env,'Goal',{attention,note:async()=>{if(++notes===1){reading.resolve();await release.promise;}return 'Exact note';}});
  await bridge.start();t.after(()=>bridge.close());env.store.setSample('count',{value:1,valid:true,receivedMs:performance.now()});
  const step=bridge.step({schemaVersion:2});await reading.promise;const a=bridge.requestAttention(evidence());env.store.setSample('count',{value:2,valid:true,receivedMs:performance.now()});release.resolve();
  const settling=settleEmergency(bridge);const b=await step;await settling;
  assert.equal(b.generation,a.generation);assert.equal(b.samples?.count?.value,2);assert.equal(b.recovery?.note,'Exact note');
});

test('domain death while a turn is ending wins over the queued restart',async()=>{
  const env=new Feed(),bridge=new Bridge(env,'Goal',{attention}),started=deferred(),interrupt=deferred(),ended=deferred();let turns=0;
  const driver:AgentDriver={capabilities,async open(){},async close(){},async interrupt(){interrupt.resolve();},async turn(){turns++;started.resolve();await ended.promise;return {status:'interrupted'};}};
  const run=new Supervisor(bridge,driver).run();void run.catch(()=>{});await started.promise;bridge.requestAttention(evidence());await interrupt.promise;env.store.setFault('domain_death');ended.resolve();
  await assert.rejects(run,/domain_death/);assert.equal(turns,1);assert.equal(bridge.status().loop,'stopped');
});

test('unknown receipts without reconciliation remain retained and fault the transition',async t=>{
  class Unresolved extends Feed {override async execute(c:Command):Promise<Receipt>{return {id:c.id,status:'unknown'};}}
  const {bridge,initial}=await setup(t,new Unresolved(),{retainCommandArguments:false,limits:{receiptHistory:1}});
  await bridge.step({generation:initial.generation,goalVersion:1,commands:[{id:'c1',kind:'publish',args:{}}]});bridge.requestAttention(evidence());
  await assert.rejects(settleEmergency(bridge),/reconciliation requires/);assert.equal(bridge.stats().unresolved,1);
  assert.equal((await bridge.step({commands:[{id:'c1',kind:'publish',args:{}}]})).results?.[0]?.status,'unknown');
});

test('authorized controls bypass an aborted tool signal',async t=>{
  const {bridge}=await setup(t);const controller=new AbortController();controller.abort();const h=createHandlers(bridge);
  assert.equal((await h.call('cancel',{jobId:'any'},controller.signal) as {status:string}).status,'confirmed');
  assert.equal((await h.call('stop',{},controller.signal) as {status:string}).status,'confirmed');
});

test('goal replacement invalidates a queued emergency and retains cumulative budgets',async t=>{
  const {bridge}=await setup(t);const a=bridge.requestAttention(evidence()),ended=deferred(),interrupted=deferred();
  const settling=settleEmergency(bridge,{ended:ended.promise,interrupt:async()=>{interrupted.resolve();}});
  await interrupted.promise;await bridge.updateGoal('Replacement');ended.resolve();assert.equal(await settling,'inactive');
  const next=bridge.requestAttention({...evidence(),episode:'next-goal'});assert.notEqual(next.id,a.id);assert.equal(bridge.status().goal.version,2);await settleEmergency(bridge);
});

test('rearm cooldown and fresh generation acknowledgement are enforced across recovery',async t=>{
  const {bridge}=await setup(t,undefined,{attention:{...attention,cooldownMs:10000}});const a=bridge.requestAttention(evidence());await settleEmergency(bridge);
  const before=await bridge.step({schemaVersion:2});bridge.refresh('compaction');await bridge.step({seen:before.id});assert.equal(bridge.attention()?.status,'ready');
  const after=await bridge.step({schemaVersion:2});await bridge.step({seen:after.id});assert.equal(bridge.attention()?.status,'acknowledged');assert.throws(()=>bridge.rearmAttention(a.id),/cooldown/);
});
