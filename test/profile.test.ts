import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/core.ts';
import { immutableProfile, ProfileGuard } from '../src/profile.ts';
import { ObservationStore } from '../src/store.ts';
import type { Command, CommandContext, Environment, Profile, Receipt } from '../src/types.ts';

function profile(): Profile {
  return {
    id: 'immutable-test', version: '1', instructions: 'Only set the declared value.',
    commands: { set: { description: 'Set a value.', resource: 'writer', schema: {
      type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false
    } } },
    waitFields: { value: { source: 'state', path: ['value'], maxAgeMs: 1000 } },
    camera: { policy: 'none' }
  };
}

class ProfileEnvironment implements Environment {
  profile = profile();
  store = new ObservationStore();
  changes = this.store.changes;
  effects = 0;
  beforeEffect = async () => {};
  async start() {}
  async close() {}
  async snapshot(after: number) { return this.store.snapshot(after); }
  acknowledge(through: number) { this.store.acknowledge(through); }
  wait(signal: AbortSignal) { return this.store.wait(signal); }
  async cancel() { return { status: 'confirmed' as const }; }
  async stop() { return { status: 'confirmed' as const }; }
  async execute(command: Command, context: CommandContext): Promise<Receipt> {
    await this.beforeEffect();
    try { context.assertCurrent?.(); }
    catch { return { id: command.id, status: 'not_executed', reason: 'stale_context' }; }
    this.effects++;
    return { id: command.id, status: 'completed' };
  }
}

test('immutableProfile owns a deeply frozen data copy, including schemas, arrays and special keys', () => {
  const source = profile();
  const properties = source.commands.set!.schema.properties as Record<string, unknown>;
  Object.defineProperty(properties, '__proto__', { value: { type: 'string' }, enumerable: true });
  const frozen = immutableProfile(source);
  assert.notEqual(frozen, source);
  assert.equal(immutableProfile(frozen), frozen);
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.commands.set!.schema));
  assert.ok(Object.isFrozen(frozen.waitFields!.value!.path));
  assert.throws(() => { frozen.waitFields!.value!.path![0] = 'forged'; }, TypeError);
  assert.throws(() => { frozen.commands.set!.resource = 'forged'; }, TypeError);
  assert.equal(Object.getPrototypeOf(frozen.commands), null);
  assert.throws(() => Object.setPrototypeOf(frozen.commands, {}), TypeError);
  source.instructions = 'Changed elsewhere';
  source.waitFields!.value!.path![0] = 'changed';
  properties.value = { type: 'string' };
  assert.equal(frozen.instructions, 'Only set the declared value.');
  assert.deepEqual(frozen.waitFields!.value!.path, ['value']);
  assert.deepEqual(JSON.parse(JSON.stringify((frozen.commands.set!.schema.properties as Record<string, unknown>).value)), { type: 'number' });
  assert.equal(Object.hasOwn(frozen.commands.set!.schema.properties as object, '__proto__'), true);
});

test('immutableProfile rejects accessors, proxies and non-data graphs without invoking code', () => {
  let accessed = 0;
  const getter = profile();
  Object.defineProperty(getter.commands.set!, 'schema', { enumerable: true, get() { accessed++; return {}; } });
  assert.throws(() => immutableProfile(getter), { code: 'invalid_profile' });
  const proxy = new Proxy(profile(), { ownKeys() { accessed++; return []; } });
  assert.throws(() => immutableProfile(proxy), { code: 'invalid_profile' });
  assert.equal(accessed, 0);
  const invalid: unknown[] = [undefined, Infinity, NaN, 1n, () => {}, new Date(), new Map(), new Uint8Array(1), new Array(2)];
  for (const value of invalid) {
    const candidate = profile();
    candidate.commands.set!.schema.extra = value;
    assert.throws(() => immutableProfile(candidate), { code: 'invalid_profile' });
  }
  const hidden = profile();
  Object.defineProperty(hidden, 'hidden', { value: {} });
  assert.throws(() => immutableProfile(hidden), { code: 'invalid_profile' });
  const symbol = profile();
  Object.defineProperty(symbol, Symbol('hidden'), { enumerable: true, value: {} });
  assert.throws(() => immutableProfile(symbol), { code: 'invalid_profile' });
  const cyclic = profile();
  cyclic.commands.set!.schema.extra = cyclic;
  assert.throws(() => immutableProfile(cyclic), { code: 'invalid_profile' });
});

test('only privately proven immutable profiles use identity checks; ordinary shallow freezes retain deep checks', () => {
  const mutable = Object.freeze(profile());
  const defaultGuard = new ProfileGuard(mutable);
  const equivalent = structuredClone(mutable);
  assert.equal(defaultGuard.unchanged(equivalent), true);
  mutable.commands.set!.description = 'Mutated beneath a shallow freeze';
  assert.equal(defaultGuard.unchanged(mutable), false);
  assert.equal(defaultGuard.unchanged(equivalent), false);
  const frozen = immutableProfile(profile());
  const fastGuard = new ProfileGuard(frozen);
  assert.equal(fastGuard.unchanged(frozen), true);
  assert.equal(fastGuard.unchanged(immutableProfile(profile())), false);
  assert.equal(fastGuard.unchanged(structuredClone(frozen)), false);
});

test('immutable profile governs validators, instructions, resource conflicts and numeric wait fields together', async t => {
  const env = new ProfileEnvironment();
  const source = env.profile;
  env.profile = immutableProfile(source);
  const bridge = new Bridge(env, 'Set the value.');
  await bridge.start(); t.after(() => bridge.close());
  const first = await bridge.step({ schemaVersion: 2 });
  source.commands.set!.resource = 'changed';
  source.waitFields!.value!.path = ['wrong'];
  source.instructions = 'Wrong instructions';
  const result = await bridge.step({ schemaVersion: 2, seen: first.id, goalVersion: 1, commands: [
    { id: 'c1', kind: 'set', args: { value: 1 } }, { id: 'c2', kind: 'set', args: { value: 2 } }
  ] });
  assert.equal(env.effects, 1);
  assert.equal(result.results?.find(receipt => receipt.id === 'c2')?.reason, 'batch_resource_conflict');
  assert.match(bridge.profileText, /Only set the declared value/);
  assert.doesNotMatch(bridge.profileText, /Wrong instructions/);
  const invalid = await bridge.step({ schemaVersion: 2, seen: result.id, goalVersion: 1,
    commands: [{ id: 'c3', kind: 'set', args: { value: 'invalid' } }] });
  assert.equal(invalid.results?.find(receipt => receipt.id === 'c3')?.status, 'rejected');
  env.store.setState({ value: { value: 7 }, receivedMs: performance.now(), valid: true });
  const ready = await bridge.step({ schemaVersion: 2, wait: { until: [{ kind: 'threshold', field: 'value', op: 'gte', value: 7 }], reviewMs: 1000 } }, undefined, { waitMode: 'park' });
  assert.equal(ready.wait?.reason, 'threshold');
});

for (const immutable of [false, true]) test(`${immutable ? 'immutable replacement' : 'mutable nested change'} during asynchronous admission prevents effects`, async t => {
  const env = new ProfileEnvironment();
  if (immutable) env.profile = immutableProfile(env.profile);
  const bridge = new Bridge(env, 'Check authority.');
  await bridge.start(); t.after(() => bridge.close());
  const first = await bridge.step();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  env.beforeEffect = async () => { entered(); await gate; };
  const pending = bridge.step({ seen: first.id, goalVersion: 1, commands: [{ id: 'c1', kind: 'set', args: { value: 1 } }] });
  await started;
  if (immutable) {
    assert.throws(() => { env.profile.commands.set!.resource = 'new'; }, TypeError);
    env.profile = immutableProfile(profile());
  } else env.profile.commands.set!.resource = 'new';
  release();
  assert.equal((await pending).results?.[0]?.status, 'not_executed');
  assert.equal(env.effects, 0);
  await assert.rejects(bridge.step(), { code: 'profile_changed' });
});
