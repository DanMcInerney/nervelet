import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startLabServer } from '../server.ts';
import { LabRuntime } from '../src/runtime.ts';
import { droneScenario } from '../src/scenarios.ts';

test('HTTP host boots the viewer and controls the same continuous world', { timeout: 30000 }, async () => {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, ['server.ts'], { cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port), LAB_ENABLE_JEV: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const exit = once(child, 'exit');
  const base = `http://127.0.0.1:${port}`;
  const state = async () => (await fetch(`${base}/api/state`)).json();
  const control = (body: object) => fetch(`${base}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(`${base}/api/state`)).ok) { ready = true; break; } } catch { /* Wait for startup. */ }
      await delay(100);
    }
    assert.ok(ready, output);
    assert.match(await (await fetch(base)).text(), /Robot World/);
    assert.equal((await state()).scenario.robot.model, 'drone');
    assert.equal((await state()).jevEnabled, false);
    const diagnostics = await (await fetch(`${base}/api/diagnostics`)).json();
    assert.ok(diagnostics.events.some((e: { channel: string }) => e.channel === 'protocol'));
    assert.ok(diagnostics.observation);
    assert.equal((await fetch(`${base}/api/diagnostics?after=invalid`)).status, 400);
    assert.equal((await fetch(`${base}/api/control`, { method: 'POST', headers: { Origin: 'https://unrelated.invalid', 'Content-Type': 'application/json' }, body: '{"op":"run"}' })).status, 403);
    assert.equal((await control({ op: 'pause' })).status, 200);
    const paused = await state(); await delay(80); assert.equal((await state()).ticks, paused.ticks);
    await control({ op: 'step' }); assert.equal((await state()).ticks, paused.ticks + 1);
    await control({ op: 'sensor', id: 'odometry', latencyMs: 20, noise: 0.1, dropout: 1 });
    assert.equal((await state()).scenario.robot.sensors[0].dropout, 1);
    await control({ op: 'reset', scenario: 'rover' });
    assert.equal((await state()).scenario.robot.model, 'rover');
    const reset = await (await fetch(`${base}/api/diagnostics?after=${diagnostics.cursor}&runId=${diagnostics.runId}`)).json();
    assert.equal(reset.reset, true); assert.notEqual(reset.runId, diagnostics.runId);
    await control({ op: 'run' });
    let running = await state();
    for (let i = 0; i < 30 && !running.jobs.some((j: { status: string }) => j.status === 'running'); i++) { await delay(50); running = await state(); }
    assert.ok(running.jobs.some((j: { status: string }) => j.status === 'running'));
    await control({ op: 'hold' }); assert.ok(!(await state()).jobs.some((j: { status: string }) => j.status === 'running'));
    assert.equal((await control({ op: 'policy', policy: 'jev' })).status, 400);
    assert.ok((await (await fetch(`${base}/api/trace`)).json()).trace.length > 0);
    const exported = await (await fetch(`${base}/api/diagnostics/export`)).json();
    assert.ok(exported.events.some((e: { channel: string; kind: string }) => e.channel === 'protocol' && e.kind === 'TX'));
  } finally {
    child.kill(); await exit;
  }
});

test('native dashboard observes its supplied world and preserves its single controller owner', { timeout: 15000 }, async () => {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const lab = await LabRuntime.create(droneScenario());
  lab.controller = { mode: 'native', name: 'gpt-5.6-luna / xhigh', status: 'fixture' };
  let stopped = 0;
  const host = await startLabServer({ lab, port, nativeStop: async () => { stopped++; await lab.stop(); } });
  try {
    const state = await (await fetch(`${host.url}/api/state`)).json();
    assert.equal(state.native, true); assert.equal(state.runId, lab.diagnostics.runId);
    const control = (op: string) => fetch(`${host.url}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op }) });
    for (const op of ['run', 'reset', 'policy']) assert.equal((await control(op)).status, 409);
    assert.equal((await control('hold')).status, 200); assert.equal(stopped, 1);
    assert.equal(lab.bridge.status().loop, 'stopped');
  } finally { await host.close(); }
});
