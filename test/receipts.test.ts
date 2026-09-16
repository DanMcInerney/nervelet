import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/core.ts';
import { DemoEnvironment } from '../src/adapters/demo.ts';
import { commandDigest, immutableResult, resultBytes, resultDeliveryBytes } from '../src/results.ts';
import { createHash } from 'node:crypto';
import { stable } from '../src/util.ts';
import type { Command, CommandIdentity, Json, Receipt, ResultBudget } from '../src/types.ts';

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
