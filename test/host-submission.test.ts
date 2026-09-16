import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, settleEmergency, type Environment } from '../src/index.ts';
import { attention, deferred, evidence, Feed } from './attention-fixture.ts';

test('ordinary failed host output needs no attention state and retains unread evidence',async()=>{
  const feed=new Feed(),bridge=new Bridge(feed,'Ordinary goal',{submission:'host'});
  await bridge.start();feed.store.push('notice',{value:1});
  const bundle=await bridge.step({schemaVersion:2});
  assert.doesNotThrow(()=>bridge.failSubmission(bundle.id,new Error('failed output')));
  assert.equal(bridge.attention(),undefined);assert.equal(feed.store.snapshot(0).events.length,1);
  assert.ok((await bridge.step({schemaVersion:2})).events?.length);await bridge.close();
});

async function fixture() {
  const feed=new Feed();
  const bridge=new Bridge(feed,'Exact original goal',{attention,submission:'host'});
  await bridge.start();
  const first=await bridge.step({schemaVersion:2});
  bridge.confirmSubmission(first.id);
  await bridge.step({schemaVersion:2,seen:first.id});
  feed.store.push('urgent',{value:1});
  bridge.requestAttention(evidence());
  const bundle=await bridge.step({schemaVersion:2});
  return {bridge,feed,bundle};
}

test('assembled output cannot settle an open boundary until exact host submission',async()=>{
  const {bridge,feed,bundle}=await fixture();const ended=deferred();let settled=false,interrupts=0;
  const work=settleEmergency(bridge,{ended:ended.promise,interrupt:async()=>{interrupts++;}}).then(r=>{settled=true;return r;});
  await new Promise(r=>setTimeout(r,10));
  assert.equal(settled,false);assert.equal(bridge.attention()!.delivered,false);
  bridge.confirmSubmission(bundle.id);
  assert.equal(await work,'boundary');assert.equal(interrupts,0);
  assert.equal(bridge.attention()!.status,'ready');assert.equal(feed.store.snapshot(0).events.length,1);
  await bridge.step({schemaVersion:2,seen:bundle.id});
  assert.equal(bridge.attention()!.status,'acknowledged');assert.equal(feed.store.snapshot(0).events.length,0);
  await bridge.close();
});

test('failed final output faults without acknowledging evidence or restarting',async()=>{
  const {bridge,feed,bundle}=await fixture();let interrupts=0;
  const work=settleEmergency(bridge,{ended:deferred().promise,interrupt:async()=>{interrupts++;}});
  bridge.failSubmission(bundle.id,new Error('outer formatting failed'));
  await assert.rejects(work,/outer formatting failed/);
  assert.equal(bridge.attention()!.status,'fault');assert.equal(interrupts,0);
  assert.equal(feed.store.snapshot(0).events.length,1);await bridge.close();
});

test('missing submission is bounded and retains evidence',async()=>{
  const {bridge,feed}=await fixture();
  await assert.rejects(settleEmergency(bridge,{ended:deferred().promise}),/exceeded/);
  assert.equal(bridge.attention()!.status,'fault');assert.equal(feed.store.snapshot(0).events.length,1);
  await bridge.close();
});

test('refresh invalidates late host confirmation and settles through a matching terminal',async()=>{
  const {bridge,bundle}=await fixture();bridge.refresh('compaction');bridge.confirmSubmission(bundle.id);
  assert.equal(bridge.attention()!.delivered,false);
  const ended=deferred();let interrupts=0;
  assert.equal(await settleEmergency(bridge,{ended:ended.promise,turnId:'owned',interrupt:async()=>{interrupts++;ended.resolve();}}),'restart');
  assert.equal(interrupts,1);await bridge.close();
});

test('natural completion during final submission requires a restart, not a closed boundary',async()=>{
  const {bridge,bundle}=await fixture();const ended=deferred();let interrupts=0;
  const work=settleEmergency(bridge,{ended:ended.promise,interrupt:async()=>{interrupts++;}});
  ended.resolve();bridge.confirmSubmission(bundle.id);
  assert.equal(await work,'restart');assert.equal(interrupts,0);await bridge.close();
});

test('Stop wins over waiting for host submission',async()=>{
  const {bridge,bundle}=await fixture();
  const work=settleEmergency(bridge,{ended:deferred().promise});
  await bridge.stop();bridge.confirmSubmission(bundle.id);
  assert.equal(await work,'inactive');await bridge.close();
});

test('reconciliation invalidates a submitted older recovery and joins before replacement',async()=>{
  const feed=new Feed(), entered=deferred(), release=deferred();
  feed.execute=async command=>{entered.resolve();await release.promise;return {id:command.id,status:'completed'};};
  (feed as Environment).reconcileReceipt=async identity=>({id:identity.id,status:'completed'});
  const bridge=new Bridge(feed,'same goal',{attention,submission:'host',retainCommandArguments:false});await bridge.start();
  const first=await bridge.step({schemaVersion:2});bridge.confirmSubmission(first.id);
  const active=await bridge.step({schemaVersion:2,seen:first.id});
  const step=bridge.step({schemaVersion:2,seen:active.id,goalVersion:1,generation:active.generation,commands:[{id:'c1',kind:'publish',args:{}}]});
  await entered.promise;bridge.requestAttention(evidence());
  const ended=deferred();let interrupts=0;
  const work=settleEmergency(bridge,{ended:ended.promise,interrupt:async()=>{interrupts++;ended.resolve();}});
  const bundle=await step;bridge.confirmSubmission(bundle.id);release.resolve();
  assert.equal(await work,'restart');assert.equal(interrupts,1);
  assert.equal(bridge.stats().unresolved,0);assert.equal(bridge.attention()!.delivered,false);
  const fresh=await bridge.step({schemaVersion:2});bridge.confirmSubmission(fresh.id);
  assert.equal(bridge.attention()!.delivered,true);assert.equal(fresh.goal.text,'same goal');
  await bridge.close();
});
