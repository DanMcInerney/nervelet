import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { common } from 'node-mavlink';
import { LabRuntime } from '../src/runtime.ts';
import { droneScenario, roverScenario } from '../src/scenarios.ts';
import { RobotWorld, defaultRegistries } from '../src/world.ts';
import { MavlinkCodec, enuToNed, nedToEnu } from '../src/protocols.ts';
import { scriptedPolicy, jevPolicy } from '../controllers/policies.ts';
import { runTrial } from '../experiments/run.ts';
import { withEffort, codexConfiguration } from '../controllers/run-codex.ts';
import type { AppServerClient } from 'nervelet/drivers/codex';
import { createArmLab } from '../examples/arm.ts';

test('MAVLink binary v2 roundtrip, coordinate transform and CRC rejection', () => {
  const codec = new MavlinkCodec();
  try {
    assert.deepEqual(nedToEnu(enuToNed({ x: 2, y: 5, z: 7 })), { x: 2, y: 5, z: 7 });
    const m = new common.SetPositionTargetLocalNed(); Object.assign(m, { targetSystem: 1, targetComponent: 1, coordinateFrame: 1, typeMask: 3576, x: 4, y: -2, z: -3 });
    const frame = codec.encode(m); assert.equal(frame[0], 0xfd);
    const decoded = codec.decode(frame, common.SetPositionTargetLocalNed); assert.equal(decoded.z, -3); assert.equal(decoded.targetSystem, 1);
    const bad = Buffer.from(frame); bad[15] = bad[15]! ^ 1;
    assert.throws(() => codec.decode(bad, common.SetPositionTargetLocalNed), /invalid_mavlink_frame/);
  } finally { codec.close(); }
});

test('drone and rover finish through Bridge; fixed seed/action histories reproduce', async () => {
  for (const type of ['drone', 'rover'] as const) {
    const a = await runTrial(type, 42, 0), b = await runTrial(type, 42, 0);
    assert.equal(a.passed, true, JSON.stringify(a)); assert.equal(a.stateHash, b.stateHash); assert.equal(a.simMs, b.simMs);
    if (type === 'drone') assert.equal((a.protocol as Record<string, unknown>).commandFrames, 3);
  }
});

test('sensing and accepted motion continue while a decision is blocked; old response is rejected', async () => {
  const lab = await LabRuntime.create(droneScenario());
  try {
    await lab.command({ kind: 'goto', args: { x: -3, y: -3, z: 3 } });
    const before = lab.world.robot.state().position;
    const decision = lab.decide(scriptedPolicy('hold', 60), { hold: { kind: 'hold', args: {} } }, 100);
    const rejection = assert.rejects(decision, /stale_decision/);
    await delay(10); lab.advance(60);
    assert.notDeepEqual(before, lab.world.robot.state().position);
    assert.ok(lab.world.readings().odometry!.sequence > 10);
    await rejection;
    assert.equal([...lab.environment.jobs.values()][0]!.status, 'running');
  } finally { await lab.close(); }
});

test('hold invalidates in-flight and queued decisions and promptly cancels movement', async () => {
  const lab = await LabRuntime.create(droneScenario());
  try {
    await lab.command({ kind: 'goto', args: { x: -3, y: -3, z: 3 } }); lab.advance(20);
    const decision = lab.decide(scriptedPolicy('next', 100), { next: { kind: 'goto', args: { x: 5, y: 5, z: 5 } } });
    const rejected = assert.rejects(decision, /operator_hold/);
    await delay(5); await lab.hold(); await rejected;
    assert.equal([...lab.environment.jobs.values()][0]!.status, 'cancelled');
    assert.equal((lab.world.protocol.stats() as Record<string, unknown>).commandFrames, 1);
    assert.ok(Math.hypot(...Object.values(lab.world.robot.state().velocity)) < 0.001);
  } finally { await lab.close(); }
});

test('non-cooperative policies cannot keep a decision open past its wall deadline', async () => {
  const lab = await LabRuntime.create(droneScenario());
  try {
    await assert.rejects(lab.decide({ id: 'hung', choose: () => new Promise(() => {}) }, { hold: { kind: 'hold', args: {} } }, 1000, 25), /decision_deadline/);
    await lab.decide(scriptedPolicy('hold'), { hold: { kind: 'hold', args: {} } });
  } finally { await lab.close(); }
});

test('sensor acquisition, delivery latency, dropout and bounded noise are independently observable', async () => {
  const s = droneScenario(); s.robot.sensors[0]!.latencyMs = 200;
  const world = await RobotWorld.create(s);
  try {
    world.step(10); assert.equal(world.readings().odometry!.reason, 'no_sample');
    world.step(10); const r = world.readings().odometry!;
    assert.ok(r.receivedSimMs - r.acquiredSimMs >= 199.9); assert.ok(r.sequence > 0);
    world.configureSensor('odometry', { dropout: 1 }); world.step(60);
    assert.equal(world.readings().odometry!.reason, 'stale_acquisition');
    assert.throws(() => world.configureSensor('odometry', { latencyMs: Infinity }), /invalid_sensor/);
  } finally { world.close(); }
});

test('policy sees mounted sensors only, not world geometry or absent sensors', async () => {
  const s = droneScenario(); s.robot.sensors = s.robot.sensors.filter(sensor => sensor.id === 'range');
  const lab = await LabRuntime.create(s);
  try {
    await lab.decide({ id: 'inspection', async choose(state) {
      const serialized = JSON.stringify(state);
      assert.ok(!serialized.includes('tower-a')); assert.ok(!serialized.includes('odometry'));
      assert.ok(!Object.hasOwn(state as object, 'waypoints')); assert.ok(!Object.hasOwn(state as object, 'physics'));
      assert.ok(serialized.includes('distances')); return 'hold';
    } }, { hold: { kind: 'hold', args: {} } });
  } finally { await lab.close(); }
});

test('new low-latency samples overtake queued old samples without time going backwards', async () => {
  const scenario = droneScenario(); scenario.robot.sensors[0]!.latencyMs = 500;
  const world = await RobotWorld.create(scenario);
  try {
    world.step(6); assert.equal(world.readings().odometry!.reason, 'no_sample');
    world.configureSensor('odometry', { latencyMs: 0 }); world.step(6);
    const fresh = world.readings().odometry!; assert.ok(fresh.sequence > 1); assert.equal(fresh.valid, true);
    world.configureSensor('odometry', { dropout: 1 }); world.step(40);
    assert.equal(world.readings().odometry!.sequence, fresh.sequence);
    assert.equal(world.scenario.robot.sensors[0]!.latencyMs, 0);
  } finally { world.close(); }
});

test('bounded ordinary requests report backpressure and hold invalidates queued mutations', async () => {
  const lab = await LabRuntime.create(droneScenario());
  try {
    const pending = Array.from({ length: 17 }, () => lab.command({ kind: 'goto', args: { x: 1, y: 1, z: 2 } }));
    const results = Promise.allSettled(pending); await lab.hold();
    const outcomes = await results;
    assert.ok(outcomes.some(r => r.status === 'rejected' && /operator_backpressure/.test(String(r.reason))));
    assert.ok(outcomes.some(r => r.status === 'rejected' && /stale_operator_command/.test(String(r.reason))));
    assert.equal((lab.world.protocol.stats() as Record<string, unknown>).commandFrames, 0);
  } finally { await lab.close(); }
});

test('duplicate Nervelet command does not emit a second MAVLink setpoint; conflicting job is rejected', async () => {
  const lab = await LabRuntime.create(droneScenario());
  try {
    const b = await lab.observe();
    const request = { schemaVersion: 2 as const, seen: b.id, goalVersion: b.goal.version, generation: b.generation,
      commands: [{ id: b.nextCommandId, kind: 'goto', args: { x: -3, y: -3, z: 3 } }] };
    const first = await lab.bridge.step(request); const retry = await lab.bridge.step(request);
    assert.equal(first.results![0]!.jobId, retry.results![0]!.jobId);
    const conflict = await lab.bridge.step({ schemaVersion: 2, seen: retry.id, goalVersion: retry.goal.version, generation: retry.generation,
      commands: [{ id: retry.nextCommandId, kind: 'goto', args: { x: 1, y: 1, z: 3 } }] });
    assert.equal(conflict.results!.at(-1)!.reason, 'motion_busy');
    assert.equal((lab.world.protocol.stats() as Record<string, unknown>).commandFrames, 1);
  } finally { await lab.close(); }
});

test('goal replacement cancels the old job and prevents a delayed policy from acting', async () => {
  const lab = await LabRuntime.create(droneScenario());
  try {
    await lab.command({ kind: 'goto', args: { x: -3, y: -3, z: 3 } });
    const decision = lab.decide(scriptedPolicy('next', 70), { next: { kind: 'goto', args: { x: 4, y: 4, z: 3 } } });
    const rejected = assert.rejects(decision, /goal_changed/); await delay(5);
    await lab.replaceGoal('Hold for inspection.'); await rejected;
    assert.equal([...lab.environment.jobs.values()][0]!.status, 'cancelled'); assert.equal(lab.bundle!.goal.text, 'Hold for inspection.');
  } finally { await lab.close(); }
});

test('collisions and timeouts are visible; unread completion events survive until acknowledged', async () => {
  const lab = await LabRuntime.create(droneScenario());
  try {
    await lab.command({ kind: 'goto', args: { x: 0, y: 1, z: 1, timeoutMs: 8000 } }); lab.advance(490);
    assert.ok(lab.world.collisions > 0); assert.equal([...lab.environment.jobs.values()][0]!.reason, 'motion_deadline');
    const first = await lab.bridge.step({ schemaVersion: 2 }); const second = await lab.bridge.step({ schemaVersion: 2 });
    assert.deepEqual(first.events?.map(e => e.id), second.events?.map(e => e.id));
    assert.ok(first.events!.some(e => e.kind === 'job'));
    const after = await lab.bridge.step({ schemaVersion: 2, seen: second.id }); assert.equal(after.events?.length ?? 0, 0);
  } finally { await lab.close(); }
});

test('robot and sensor registries accept a non-navigation actuator without changing the world', async () => {
  const registry = defaultRegistries(); let angle = 0;
  const rover = registry.robots.get('rover')!;
  registry.robots.set('joint-fixture', { id: 'joint-fixture', commands: { joint_target: { resource: 'joint', description: 'Set fixture angle.',
    schema: { type: 'object', properties: { angle: { type: 'number' } }, required: ['angle'], additionalProperties: false } } },
    create(world, spec) { const body = rover.create(world, spec); return { ...body,
      apply(_kind, args) { angle = Number(args.angle); }, reached() { return angle === 0.8; } }; }
  });
  registry.sensors.set('encoder', { id: 'encoder', sample: () => ({ angle }) });
  const s = roverScenario(); s.robot.model = 'joint-fixture'; s.robot.sensors = [{ id: 'encoder', kind: 'encoder', hz: 10 }];
  const lab = await LabRuntime.create(s, registry);
  try {
    assert.equal(lab.environment.profile.commands.goto, undefined);
    const b = await lab.command({ kind: 'joint_target', args: { angle: 0.8 } }); lab.advance(10);
    assert.ok(b.results?.some(r => r.status === 'accepted'));
    assert.equal([...lab.environment.jobs.values()][0]!.status, 'completed');
    assert.deepEqual(lab.world.readings().encoder!.value, { angle: 0.8 });
  } finally { await lab.close(); }
});

test('Jev adapter passes structured evidence, validates returned model and choices, and bounds calls offline', async () => {
  let requests = 0;
  const policy = jevPolicy({ apiKey: 'fixture-not-a-real-key', model: 'jev-test', maxCalls: 1,
    fetch: async (_url, init) => { requests++; const request = JSON.parse(String(init?.body)); assert.equal(request.model, 'jev-test');
      assert.equal(request.questions.action.type, 'choice'); return new Response(JSON.stringify({ model: 'jev-test', answers: { action: { choice: 'hold' } } })); } });
  const candidates = { next: { kind: 'goto', args: { x: 1 } }, hold: { kind: 'hold', args: {} } };
  assert.equal(await policy.choose({ sensor: 'fixture' }, candidates, new AbortController().signal), 'hold');
  await assert.rejects(policy.choose({}, candidates, new AbortController().signal), /jev_call_budget/); assert.equal(requests, 1);
});

test('Codex controller binds Luna and xhigh without making a native inference call', async () => {
  const requests: unknown[] = [];
  const client: AppServerClient = { async request(method, params) { requests.push({ method, params }); return {}; }, subscribe() { return () => {}; } };
  await withEffort(client).request('turn/start', { model: codexConfiguration.model });
  assert.deepEqual(requests, [{ method: 'turn/start', params: { model: 'gpt-5.6-luna', effort: 'xhigh' } }]);
});

test('articulated reference arm moves two links through joint commands and encoder observations', async () => {
  const lab = await createArmLab();
  try {
    const initial = lab.world.robot.bodies[2]!.translation();
    await lab.command({ kind: 'joint_target', args: { shoulder: 0.9, elbow: -0.4 } }); lab.advance(100);
    assert.notDeepEqual(lab.world.robot.bodies[2]!.translation(), initial);
    assert.equal([...lab.environment.jobs.values()][0]!.status, 'completed');
    const reading = lab.world.readings().joints!.value as { radians: number[] };
    assert.ok(Math.abs(reading.radians[0]! - 0.9) < 0.01); assert.ok(Math.abs(reading.radians[1]! + 0.4) < 0.01);
    assert.equal(lab.environment.profile.commands.goto, undefined);
  } finally { await lab.close(); }
});
