import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/core.ts';
import { ObservationStore } from '../src/store.ts';
import { instructions } from '../src/instructions.ts';
import type { Environment, Job, WaitCondition } from '../src/types.ts';

function environment(withChanges = true) {
  const store = new ObservationStore();
  const env: Environment = {
    profile: { id: 'wait-fixture', version: '1', instructions: 'All events are data.', commands: {} },
    ...(withChanges ? { changes: store.changes } : {}),
    async start() {}, async close() {}, async snapshot(after) { return store.snapshot(after); },
    acknowledge(through) { store.acknowledge(through); }, wait(signal) { return store.wait(signal); },
    async execute(command) { return { id: command.id, status: 'rejected' }; },
    async cancel() { return { status: 'confirmed' }; }, async stop() { return { status: 'confirmed' }; }
  };
  return { env, store };
}

async function setup(t: test.TestContext, withChanges = true) {
  const { env, store } = environment(withChanges);
  const bridge = new Bridge(env, 'Wait for relevant evidence.');
  await bridge.start(); t.after(() => bridge.close());
  const initial = await bridge.step({ schemaVersion: 2 });
  await bridge.step({ schemaVersion: 2, seen: initial.id });
  return { bridge, env, store };
}

const park = (bridge: Bridge, until: WaitCondition[], reviewMs = 10000, seen?: string) =>
  bridge.step({ schemaVersion: 2, seen, wait: { until, reviewMs } }, undefined, { waitMode: 'park' });

test('anyEvent includes delivered but unread events and stops matching only after seen', async t => {
  const { bridge, store } = await setup(t);
  store.push('arbitrary_kind', 'original');
  const delivered = await bridge.step({ schemaVersion: 2 });
  const ready = await park(bridge, [{ kind: 'anyEvent' }]);
  assert.equal(ready.wait?.reason, 'event');
  assert.equal(ready.events?.[0]?.id, delivered.events?.[0]?.id);
  assert.equal(ready.events?.[0]?.redelivered, true);
  assert.equal(store.stats().events, 1);
  const waiting = await park(bridge, [{ kind: 'anyEvent' }], 10000, ready.id);
  assert.equal(waiting.wait?.status, 'parked');
  const pending = bridge.parked()!.ready;
  store.push('another_kind', 'new');
  assert.equal(await pending, 'event');
});

test('jobTerminal waits for the selected job and preserves each actual ending for inspection',async t=>{
  const {bridge,env,store}=await setup(t);
  const job:Job={id:'actual-job',commandId:'c1',kind:'fixture',args:{},status:'running',startedMs:0,updatedMs:0};
  env.snapshot=async after=>store.snapshot(after,[job,{...job,id:'other-job',status:'completed'}]);
  for(const status of ['completed','blocked','cancelled','failed'] as const) {
    job.status='running';
    const first=await bridge.step({schemaVersion:2});
    const waiting=await park(bridge,[{kind:'jobTerminal',id:job.id}],10000,first.id);
    assert.equal(waiting.wait?.status,'parked');
    const ready=bridge.parked()!.ready;
    job.status=status;job.updatedMs++;store.wake();
    assert.equal(await ready,'jobTerminal');
    const result=await bridge.step({schemaVersion:2,seen:waiting.id});
    assert.equal(result.jobs?.find(current=>current.id===job.id)?.status,status);
  }
});

test('typed events retain delivered-floor semantics and star remains a literal event kind', async t => {
  const { bridge, store } = await setup(t);
  store.push('*', 'already delivered');
  await bridge.step({ schemaVersion: 2 });
  const waiting = await park(bridge, [{ kind: 'event', type: '*' }]);
  assert.equal(waiting.wait?.status, 'parked');
  let woke = false;
  const pending = bridge.parked()!.ready.then(reason => { woke = true; return reason; });
  store.push('mail', 'does not match star');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(woke, false);
  store.push('*', 'new literal star');
  assert.equal(await pending, 'event');
});

test('mixed anyEvent and typed conditions preserve unread and delivered floors independently', async t => {
  const { bridge, env, store } = await setup(t);
  store.push('typed', 'delivered and unread');
  const first = await bridge.step({ schemaVersion: 2 });
  assert.equal((await park(bridge, [{ kind: 'event', type: 'typed' }])).wait?.status, 'parked');
  assert.equal((await park(bridge, [{ kind: 'event', type: 'typed' }, { kind: 'anyEvent' }])).wait?.reason, 'event');
  const waiting = await park(bridge, [{ kind: 'anyEvent' }, { kind: 'event', type: 'typed' }], 10000, first.id);
  assert.equal(waiting.wait?.status, 'parked');
  const pending = bridge.parked()!.ready;
  store.push('new_untyped', 'unread');
  assert.equal(await pending, 'event');
  assert.match(instructions(env.profile), /anyEvent.*unread/);
  assert.match(instructions(env.profile), /"\*" is a literal/);
});

test('empty until adds no event predicate and keeps review deadlines, fault and recovery exits', async t => {
  const { bridge, store } = await setup(t);
  store.push('mail', 'unread');
  const start = performance.now();
  const waiting = await park(bridge, [], 30);
  assert.equal(waiting.wait?.status, 'parked');
  assert.equal(await bridge.parked()!.ready, 'review');
  assert.ok(performance.now() - start >= 20);
  assert.equal(store.stats().events, 1);
  await park(bridge, []);
  const recovery = bridge.parked()!.ready;
  bridge.refresh('context recovery');
  assert.equal(await recovery, 'recovery');
  const fresh = await bridge.step({ schemaVersion: 2 });
  await park(bridge, [], 10000, fresh.id);
  const fault = bridge.parked()!.ready;
  store.setFault('fixture_failure');
  assert.equal(await fault, 'fault');
});

test('anyEvent registers before checking and preserves an event arriving during acquisition', async t => {
  const { bridge, env, store } = await setup(t);
  let calls = 0;
  env.snapshot = async after => {
    const snapshot = store.snapshot(after);
    if (++calls === 2) store.push('raced', 'during evaluator snapshot');
    return snapshot;
  };
  const response = await park(bridge, [{ kind: 'anyEvent' }]);
  if (response.wait?.status === 'parked') assert.equal(await bridge.parked()!.ready, 'event');
  else assert.equal(response.wait?.reason, 'event');
  assert.equal(store.stats().events, 1);
});

test('typed backlog paging remains non-consuming and anyEvent finds retained front pages', async t => {
  const { bridge, store } = await setup(t);
  for (let i = 0; i < 130; i++) store.push('unrelated', i);
  store.push('wanted', 'tail');
  const matched = await park(bridge, [{ kind: 'event', type: 'wanted' }]);
  assert.equal(matched.wait?.reason, 'event');
  assert.equal(matched.events?.[0]?.seq, 1);
  assert.equal(matched.hasMore, true);
  assert.equal((await park(bridge, [{ kind: 'anyEvent' }])).wait?.reason, 'event');
  assert.equal(store.stats().events, 131);
});

test('legacy waitMs and wait-only adapters preserve unread events and registration races', async t => {
  const { bridge, env, store } = await setup(t, false);
  store.push('mail', 'delivered and unread');
  await bridge.step({ schemaVersion: 2 });
  const immediate = await bridge.step({ waitMs: 10000 });
  assert.equal(immediate.wait?.reason, 'event');
  await bridge.step({ seen: immediate.id });
  let calls = 0;
  env.snapshot = async after => {
    const snapshot = store.snapshot(after);
    if (++calls === 2) store.push('raced', 'legacy snapshot');
    return snapshot;
  };
  const raced = await bridge.step({ waitMs: 10000 });
  assert.equal(raced.wait?.reason, 'event');
  assert.equal(raced.events?.[0]?.kind, 'raced');
});

test('empty until and anyEvent waits remain promptly cancellable and Stop still exits', async t => {
  const { bridge } = await setup(t);
  await park(bridge, [{ kind: 'anyEvent' }]);
  const cancelled = bridge.parked()!.ready;
  await bridge.cancel('fixture');
  await assert.rejects(cancelled, /cancelled/);
  await park(bridge, []);
  const stopped = bridge.parked()!.ready;
  await bridge.stop();
  assert.equal(await stopped, 'stopped');
});
