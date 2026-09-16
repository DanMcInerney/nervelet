import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/core.ts';
import { DemoEnvironment } from '../src/adapters/demo.ts';
import { commandDigest, immutableResult, resultBytes, resultDeliveryBytes } from '../src/results.ts';
import { createHash } from 'node:crypto';
import { stable } from '../src/util.ts';
import type { Command, CommandIdentity, Environment, Json, Receipt, ResultBudget } from '../src/types.ts';

class Receipts extends DemoEnvironment {
  effects = 0;
  uncertain = false;
  override async execute(command: Command): Promise<Receipt> {
    this.effects++;
    return { id: command.id, status: this.uncertain ? 'unknown' : 'completed' };
  }
  async reconcile(command: Command): Promise<Receipt> {
    return { id: command.id, status: 'completed' };
  }
}
const command = (id: string): Command => ({ id, kind: 'sample', args: {} });

test('v2 receipt pressure preserves unread results and does not consume rejected IDs', async t => {
  const env = new Receipts();
  const bridge = new Bridge(env, 'Preserve results', { limits: { receiptHistory: 1 } });
  await bridge.start(); t.after(() => bridge.close());
  const initial = await bridge.step({ schemaVersion: 2 });
  const first = await bridge.step({ schemaVersion: 2, seen: initial.id, goalVersion: 1, commands: [command('c1')] });
  const blocked = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c2')] });
  assert.equal(blocked.results?.find(r => r.id === 'c2')?.reason, 'receipt_backpressure');
  assert.equal(env.effects, 1);
  assert.equal(blocked.nextCommandId, 'c2');
  assert.equal((await bridge.step({ schemaVersion: 2 })).results?.[0]?.id, 'c1');
  const next = await bridge.step({ schemaVersion: 2, seen: first.id, goalVersion: 1, commands: [command('c2')] });
  assert.equal(next.results?.find(r => r.id === 'c2')?.status, 'completed');
  assert.equal(env.effects, 2);
});

test('seen binds a receipt revision independently of recovery generation', async t => {
  const env = new Receipts(); env.uncertain = true;
  const bridge = new Bridge(env, 'Reconcile once');
  await bridge.start(); t.after(() => bridge.close());
  const first = await bridge.step({ schemaVersion: 2 });
  const unknown = await bridge.step({ schemaVersion: 2, seen: first.id, goalVersion: 1, commands: [command('c1')] });
  await bridge.reconcile('c1');
  const recovered = await bridge.step({ schemaVersion: 2, seen: unknown.id });
  assert.equal(recovered.results?.[0]?.status, 'completed');
  assert.ok(recovered.recovery);
  const after = await bridge.step({ schemaVersion: 2, seen: recovered.id });
  assert.equal(after.results, undefined);
  assert.equal(after.recovery, undefined);
  assert.equal(env.effects, 1);
});

class Payloads extends Receipts {
  value: Json = { content: 'original' };
  records = new Map<string, Receipt>();
  released: string[] = [];
  budget?: ResultBudget;
  snapshotFailure = false;
  resultBudget(): ResultBudget {
    return this.budget ?? { retainedBytes: resultBytes(this.value), serializedBytes: resultDeliveryBytes(this.value) + 128 };
  }
  override async execute(command: Command): Promise<Receipt> {
    this.effects++;
    const result: Receipt = { id: command.id, status: 'completed', data: immutableResult(this.value) };
    this.records.set(command.id, result);
    return result;
  }
  override async reconcile(command: Command): Promise<Receipt> { return this.records.get(command.id)!; }
  releaseReceipt(command: CommandIdentity): void { this.records.delete(command.id); this.released.push(command.id); }
  override async snapshot(after: number) {
    if (this.snapshotFailure && this.effects) throw new Error('acquisition failed after effect');
    return super.snapshot(after);
  }
}

async function payloadSetup(t: test.TestContext, env = new Payloads(), options: ConstructorParameters<typeof Bridge>[2] = {}) {
  const bridge = new Bridge(env, 'Retain original outputs', options);
  await bridge.start(); t.after(() => bridge.close());
  const first = await bridge.step({ schemaVersion: 2 });
  await bridge.step({ schemaVersion: 2, seen: first.id });
  return { bridge, env };
}

test('lost operation payload is immutable and shared, survives observe/retry/conflict, and releases only when seen', async t => {
  const { bridge, env } = await payloadSetup(t);
  const first = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] });
  const original = first.results![0]!.data!;
  assert.equal(original, env.records.get('c1')!.data);
  first.results![0]!.status = 'rejected';
  first.results![0]!.reason = 'caller changed scalar';
  assert.throws(() => { (original as { content: string }).content = 'mutated'; });
  env.value = { content: 'file overwritten or deleted' };
  assert.deepEqual((await bridge.step({ schemaVersion: 2 })).results![0]!.data, { content: 'original' });
  assert.equal((await bridge.step({ schemaVersion: 2 })).results![0]!.status, 'completed');
  const duplicate = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] });
  assert.equal(duplicate.results![0]!.data, original);
  const conflict = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [{ ...command('c1'), args: { changed: true } }] });
  assert.equal(conflict.results?.[0]?.reason, 'id_conflict');
  const afterConflict = await bridge.step({ schemaVersion: 2, seen: conflict.id });
  assert.equal(afterConflict.results?.[0]?.data, original);
  await bridge.step({ schemaVersion: 2, seen: first.id });
  assert.equal(bridge.stats().retainedResultBytes, 0);
  assert.equal(env.records.size, 0);
  assert.equal((await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] })).results?.[0]?.data, undefined);
  assert.equal(env.effects, 1);
});

test('legacy bounded eviction upgrades once to reliable v2 retention and cannot downgrade', async t => {
  const env = new Receipts();
  const bridge = new Bridge(env, 'Mixed protocol', { limits: { receiptHistory: 1 } });
  await bridge.start(); t.after(() => bridge.close());
  const first = await bridge.step();
  await bridge.step({ seen: first.id, goalVersion: 1, commands: [command('c1')] });
  await bridge.step({ goalVersion: 1, commands: [command('c2')] });
  assert.equal(env.effects, 2);
  const upgraded = await bridge.step({ schemaVersion: 2 });
  assert.equal(upgraded.results?.[0]?.id, 'c2');
  const legacy = await bridge.step({ goalVersion: 1, commands: [command('c3')] });
  assert.equal(legacy.results?.[0]?.reason, 'receipt_backpressure');
  assert.equal(legacy.nextCommandId, 'c3');
  await bridge.step({ seen: upgraded.id, goalVersion: 1, commands: [command('c3')] });
  assert.equal(env.effects, 3);
});

test('maximum escaped result fits retained and transport budgets, blocks another mutation, and releases capacity', async t => {
  const env = new Payloads();
  env.value = { content: '\0'.repeat(65536) };
  const { bridge } = await payloadSetup(t, env, { retainCommandArguments: false, limits: {
    maxResultBytes: 150 * 1024, maxRetainedResultBytes: 192 * 1024, maxResultDeliveryBytes: 470 * 1024,
    maxBundleBytes: 512 * 1024, maxRecoveryBytes: 512 * 1024
  } });
  const first = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] }, undefined, { textEncoding: 'tool-result' });
  assert.deepEqual(first.results?.[0]?.data, env.value);
  assert.ok(bridge.stats().retainedResultBytes < 134 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(first) }] })) < 512 * 1024);
  const blocked = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c2')] });
  assert.equal(blocked.results?.find(r => r.id === 'c2')?.reason, 'receipt_backpressure');
  assert.equal(env.effects, 1);
  const next = await bridge.step({ schemaVersion: 2, seen: first.id, goalVersion: 1, commands: [command('c2')] });
  assert.deepEqual(next.results?.find(r => r.id === 'c2')?.data, env.value);
  assert.equal(env.effects, 2);
  assert.equal(env.records.size, 1);
});

test('result slices advance under aggregate byte pressure and acknowledge only packed revisions', async t => {
  const env = new Payloads(); env.value = { text: 'x'.repeat(850) };
  const { bridge } = await payloadSetup(t, env, { limits: { maxBundleBytes: 2200, maxRecoveryBytes: 6000 } });
  const first = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1'), command('c2'), command('c3')] });
  assert.equal(first.results?.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal(env.effects, 3);
  const second = await bridge.step({ schemaVersion: 2, seen: first.id });
  assert.equal(second.results?.[0]?.id, 'c2');
  assert.equal(second.hasMore, true);
  const third = await bridge.step({ schemaVersion: 2, seen: second.id });
  assert.equal(third.results?.[0]?.id, 'c3');
  assert.equal(third.hasMore, undefined);
  await bridge.step({ schemaVersion: 2, seen: third.id });
  assert.equal(bridge.stats().retainedResultBytes, 0);
});

test('acquisition failure and failed host submission preserve original results until model acknowledgement', async t => {
  const env = new Payloads();
  const { bridge } = await payloadSetup(t, env, { submission: 'host' });
  env.snapshotFailure = true;
  await assert.rejects(bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] }), /acquisition failed/);
  env.snapshotFailure = false;
  const recovered = await bridge.step({ schemaVersion: 2 });
  assert.deepEqual(recovered.results?.[0]?.data, { content: 'original' });
  bridge.failSubmission(recovered.id, new Error('formatting or disconnect'));
  bridge.confirmSubmission(recovered.id);
  assert.equal((await bridge.step({ schemaVersion: 2 })).results?.[0]?.id, 'c1');
  assert.equal(env.released.length, 0);
  await bridge.step({ schemaVersion: 2, seen: recovered.id });
  assert.equal(env.records.size, 0);
  assert.equal(env.effects, 1);
});

test('recovery can defer a large retained result and its acknowledgement then permits delivery progress', async t => {
  const env = new Payloads(); env.value = { text: 'x'.repeat(2500) };
  const { bridge } = await payloadSetup(t, env, { limits: { maxBundleBytes: 6000, maxRecoveryBytes: 4200 } });
  await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] });
  bridge.refresh('compact');
  const recovery = await bridge.step({ schemaVersion: 2 });
  assert.ok(recovery.recovery);
  assert.equal(recovery.results, undefined);
  assert.equal(recovery.hasMore, true);
  const next = await bridge.step({ schemaVersion: 2, seen: recovery.id });
  assert.equal(next.recovery, undefined);
  assert.deepEqual(next.results?.[0]?.data, env.value);
  assert.equal(env.effects, 1);
});

test('late authoritative completion keeps reservation and invalidates acknowledgements of the uncertain revision', async t => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  class Late extends Payloads {
    override async execute(command: Command): Promise<Receipt> {
      const result = await super.execute(command);
      await gate;
      return result;
    }
  }
  const env = new Late();
  const { bridge } = await payloadSetup(t, env, { limits: { operationMs: 20, receiptHistory: 1 } });
  const unknown = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] });
  assert.equal(unknown.results?.[0]?.status, 'unknown');
  await bridge.step({ schemaVersion: 2, seen: unknown.id });
  assert.ok(bridge.stats().retainedResultBytes > 0);
  assert.equal(env.records.size, 1);
  assert.equal((await bridge.step({ schemaVersion: 2 })).results, undefined);
  assert.equal(bridge.stats().unresolved, 1);
  finish();
  const reconciled = await bridge.reconcile('c1');
  assert.deepEqual(reconciled.data, { content: 'original' });
  const current = await bridge.step({ schemaVersion: 2, seen: unknown.id });
  assert.deepEqual(current.results?.[0]?.data, reconciled.data);
  assert.ok(current.recovery);
  await bridge.step({ schemaVersion: 2, seen: current.id });
  assert.equal(bridge.stats().retainedResultBytes, 0);
  assert.equal(env.records.size, 0);
  assert.equal(env.effects, 1);
});

test('result reservations reject before effects and IDs, while delivery history expiry remains explicit', async t => {
  const env = new Payloads(); env.budget = { retainedBytes: 20000, serializedBytes: 1000 };
  const { bridge } = await payloadSetup(t, env, { limits: { bundleHistory: 1 } });
  const denied = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] });
  assert.equal(denied.results?.[0]?.reason, 'result_backpressure');
  assert.equal(denied.nextCommandId, 'c1');
  assert.equal(env.effects, 0);
  const old = await bridge.step({ schemaVersion: 2 });
  await bridge.step({ schemaVersion: 2 });
  await assert.rejects(bridge.step({ schemaVersion: 2, seen: old.id }), /Unknown or expired/);
  env.budget = undefined;
  assert.equal((await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] })).results?.[0]?.status, 'completed');
});

test('a backpressured batch cannot consume a lower retryable ID by admitting a later command', async t => {
  class Selective extends Payloads {
    override resultBudget(command?: Command): ResultBudget {
      return command?.id === 'c1' ? { retainedBytes: 20000, serializedBytes: 1000 } : super.resultBudget();
    }
  }
  const env = new Selective();
  const { bridge } = await payloadSetup(t, env);
  const denied = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1'), command('c2')] });
  assert.deepEqual(denied.results?.map(r => r.status), ['not_executed', 'not_executed']);
  assert.equal(denied.nextCommandId, 'c1');
  assert.equal(env.effects, 0);
});

test('adapter preflight backpressure is retryable and does not retain a false receipt', async t => {
  class AdapterPressure extends Payloads {
    blocked = true;
    override async execute(command: Command): Promise<Receipt> {
      return this.blocked ? { id: command.id, status: 'not_executed', reason: 'result_backpressure' } : super.execute(command);
    }
  }
  const env = new AdapterPressure();
  const { bridge } = await payloadSetup(t, env);
  const denied = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] });
  assert.equal(denied.nextCommandId, 'c1');
  assert.equal(bridge.stats().retainedResultBytes, 0);
  env.blocked = false;
  assert.equal((await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] })).results?.[0]?.status, 'completed');
  assert.equal(env.effects, 1);
});

test('shared identity preserves digest and result ownership rejects non-JSON mutation channels', () => {
  const input = { id: 'c1', kind: 'sample', args: { z: 1, a: { nested: true } } };
  assert.equal(commandDigest(input), createHash('sha256').update(stable(input)).digest('hex'));
  const owned = immutableResult({ nested: [{ value: 'x' }] });
  assert.equal(immutableResult(owned), owned);
  assert.ok(Object.isFrozen((owned as { nested: Json[] }).nested[0]));
  assert.throws(() => immutableResult({ get surprise(): Json { throw new Error('getter called'); } }), /getters/);
  assert.throws(() => immutableResult(new Proxy({}, { getPrototypeOf() { throw new Error('proxy trap called'); } })), /proxies/);
  assert.throws(() => immutableResult([, 1] as Json[]), /sparse/);
  assert.throws(() => immutableResult({ value: Infinity }), /finite/);
});

class ConcurrentReconciliation extends Payloads {
  completions: ((result: Receipt) => void)[] = [];
  override async execute(command: Command): Promise<Receipt> {
    const completed = await super.execute(command);
    return command.id === 'c1' ? { id: command.id, status: 'unknown' } : completed;
  }
  override reconcile(): Promise<Receipt> {
    return new Promise(resolve => { this.completions.push(resolve); });
  }
}

test('out-of-order reconciliation cannot revive an acknowledged and evicted receipt or charge its payload again', async t => {
  const env = new ConcurrentReconciliation(); env.value = { content: 'x'.repeat(500) };
  const retainedBytes = resultBytes(env.value);
  const { bridge } = await payloadSetup(t, env, { limits: { receiptHistory: 1, maxRetainedResultBytes: retainedBytes } });
  const unknown = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] });
  const earlier = bridge.reconcile('c1');
  const rejected = assert.rejects(earlier, (error: { code: string }) => error.code === 'stale_reconciliation');
  const later = bridge.reconcile('c1');
  const completed = env.records.get('c1')!;
  env.completions[1]!(completed);
  await later;
  const revised = await bridge.step({ schemaVersion: 2, seen: unknown.id });
  assert.equal(revised.results?.[0]?.status, 'completed');
  assert.ok(revised.recovery);
  const next = await bridge.step({ schemaVersion: 2, seen: revised.id, goalVersion: 1, commands: [command('c2')] });
  assert.equal(next.results?.[0]?.id, 'c2');
  const generation = bridge.status().generation;
  assert.equal(bridge.stats().retainedResultBytes, retainedBytes);
  env.completions[0]!(completed);
  await rejected;
  assert.equal(bridge.stats().retainedResultBytes, retainedBytes);
  assert.equal(bridge.stats().receipts, 1);
  assert.equal(bridge.status().generation, generation);
  const current = await bridge.step({ schemaVersion: 2 });
  assert.equal(current.results?.[0]?.id, 'c2');
  assert.equal(current.recovery, undefined);
  assert.equal(env.effects, 2);
});

test('reconciliation also rejects a superseded unknown revision without resetting its acknowledgement', async t => {
  const env = new ConcurrentReconciliation();
  const { bridge } = await payloadSetup(t, env);
  const first = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] });
  const earlier = bridge.reconcile('c1');
  const rejected = assert.rejects(earlier, (error: { code: string }) => error.code === 'stale_reconciliation');
  const later = bridge.reconcile('c1');
  env.completions[1]!({ id: 'c1', status: 'unknown', reason: 'newer authoritative lookup' });
  await later;
  bridge.refresh('new recovery');
  const revised = await bridge.step({ schemaVersion: 2, seen: first.id });
  assert.equal(revised.results?.[0]?.reason, 'newer authoritative lookup');
  assert.ok(revised.recovery);
  await bridge.step({ schemaVersion: 2, seen: revised.id });
  const reserved = bridge.stats().retainedResultBytes;
  const generation = bridge.status().generation;
  env.completions[0]!({ id: 'c1', status: 'unknown', reason: 'stale lookup' });
  await rejected;
  assert.equal(bridge.stats().unresolved, 1);
  assert.equal(bridge.stats().retainedResultBytes, reserved);
  assert.equal(bridge.status().generation, generation);
  assert.equal((await bridge.step({ schemaVersion: 2 })).results, undefined);
});

function scalarEnvironment(reason: string): Environment & { effects: number; reason: string } {
  return {
    effects: 0, reason,
    profile: { id: 'scalar', version: '1', instructions: '', commands: { sample: { description: 'One operation.', schema: { type: 'object' } } } },
    async start() {}, async snapshot() { return { events: [], hasMore: false }; }, acknowledge() {}, async wait() {},
    async execute(command) { this.effects++; return { id: command.id, status: 'completed', reason: this.reason }; },
    async cancel() {}, async stop() {}, async close() {}
  };
}

test('default scalar reservation prevents an undeliverable effect without consuming its ID', async t => {
  const env = scalarEnvironment('x'.repeat(950));
  const bridge = new Bridge(env, 'Goal', { limits: { maxBundleBytes: 1024 } });
  await bridge.start(); t.after(() => bridge.close());
  const first = await bridge.step({ schemaVersion: 2 });
  const denied = await bridge.step({ schemaVersion: 2, seen: first.id, goalVersion: 1, commands: [command('c1')] });
  assert.equal(denied.results?.[0]?.reason, 'result_backpressure');
  assert.equal(denied.nextCommandId, 'c1');
  assert.equal(env.effects, 0);
  assert.equal(bridge.stats().receipts, 0);
  assert.equal((await bridge.step({ schemaVersion: 2 })).results, undefined);
  // An adapter that promises a genuinely smaller scalar result can use this cap.
  env.reason = 'bounded';
  env.resultBudget = () => ({ retainedBytes: 0, serializedBytes: 128 });
  const allowed = await bridge.step({ schemaVersion: 2, goalVersion: 1, commands: [command('c1')] });
  assert.equal(allowed.results?.[0]?.status, 'completed');
  assert.equal(env.effects, 1);
  assert.deepEqual((await bridge.step({ schemaVersion: 2 })).results, allowed.results);
  assert.equal((await bridge.step({ schemaVersion: 2, seen: allowed.id })).results, undefined);
});

test('scalar defaults cover escaped control characters and text envelopes while legacy preflight stays compatible', async t => {
  const env = scalarEnvironment('small legacy receipt');
  // Startup instructions fit; a host envelope later leaves only 1,096 bytes.
  const legacy = new Bridge(env, 'Goal', { limits: { maxBundleBytes: 4096 } });
  await legacy.start(); t.after(() => legacy.close());
  const start = await legacy.step();
  assert.equal((await legacy.step({ seen: start.id, goalVersion: 1, commands: [command('c1')] }, undefined, { wrapperBytes: 3000 })).results?.[0]?.status, 'completed');
  await legacy.step({ schemaVersion: 2 });
  assert.equal((await legacy.step({ goalVersion: 1, commands: [command('c2')] }, undefined, { wrapperBytes: 3000 })).results?.find(r => r.id === 'c2')?.reason, 'result_backpressure');
  assert.equal(env.effects, 1);

  for (const reason of ['\\'.repeat(480), '\0'.repeat(158), '"'.repeat(480)]) {
    const escaped = scalarEnvironment(reason);
    const roomy = new Bridge(escaped, 'Goal', { limits: { maxBundleBytes: 3000 } });
    await roomy.start(); t.after(() => roomy.close());
    const initial = await roomy.step({ schemaVersion: 2 });
    const done = await roomy.step({ schemaVersion: 2, seen: initial.id, goalVersion: 1, commands: [command('c1')] }, undefined, { textEncoding: 'tool-result' });
    assert.equal(done.results?.[0]?.reason, reason);
    assert.equal(escaped.effects, 1);
    assert.ok(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(done) }] })) <= 3000);
    assert.equal((await roomy.step({ schemaVersion: 2, seen: done.id })).results, undefined);
  }
});

test('explicit serialized reservations are enforced for scalar and data receipts alike', async t => {
  for (const data of [undefined, { value: 'historical' }]) {
    const env = scalarEnvironment('a scalar result larger than its false reservation');
    env.resultBudget = () => ({ retainedBytes: data ? resultBytes(data) : 0, serializedBytes: 1 });
    env.execute = async command => { env.effects++; return { id: command.id, status: 'completed', reason: env.reason, ...(data ? { data } : {}) }; };
    const bridge = new Bridge(env, 'Goal');
    await bridge.start(); t.after(() => bridge.close());
    const first = await bridge.step({ schemaVersion: 2 });
    const result = await bridge.step({ schemaVersion: 2, seen: first.id, goalVersion: 1, commands: [command('c1')] });
    assert.equal(result.results?.[0]?.status, 'unknown');
    assert.match(result.results?.[0]?.reason ?? '', /serialized-byte reservation/);
    assert.equal(bridge.stats().unresolved, 1);
    assert.equal(env.effects, 1);
  }
});
