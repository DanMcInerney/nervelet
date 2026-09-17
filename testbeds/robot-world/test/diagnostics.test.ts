import test from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostics, diagnosticCopy } from '../src/diagnostics.ts';
import { LabRuntime } from '../src/runtime.ts';
import { droneScenario, roverScenario } from '../src/scenarios.ts';
import { instrumentCodex, instrumentHandlers } from '../controllers/codex-diagnostics.ts';
import { createHandlers } from 'nervelet';
import type { AppServerClient } from 'nervelet/drivers/codex';

test('diagnostic streams bound storage and copies, preserve clocks, and reset stale cursors', () => {
  const journal = new Diagnostics(3);
  for (let i = 0; i < 10; i++) journal.record('protocol', 'RX', 'frame', { i }, i * 100);
  journal.record('controller', 'summary', 'A readable summary', { text: 'example' }, 900);
  const first = journal.read(0, journal.runId, 2);
  assert.equal(first.dropped.protocol, 7); assert.equal(first.events.length, 2); assert.equal(first.hasMore, true);
  assert.equal(first.events[0]!.simMs, 700); assert.ok(first.events[0]!.wallMs >= 0);
  const second = journal.read(first.cursor); assert.equal(second.events.length, 2);
  assert.ok(second.events.every(e => e.id > first.cursor));
  assert.equal(journal.read(second.cursor).events.length, 0);
  assert.equal(journal.read(10000, 'previous-world').reset, true);
  assert.throws(() => journal.read(NaN), /invalid_diagnostic_cursor/);
  const copy = diagnosticCopy({ authorization: 'secret', apiKey: 'secret', nested: { text: 'Bearer abcd-credential' } });
  assert.ok(!JSON.stringify(copy).includes('secret')); assert.ok(!JSON.stringify(copy).includes('abcd-credential'));
  const big = diagnosticCopy({ text: 'x'.repeat(50000) }); assert.equal(big.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(big.data)) < 8192);
});

test('diagnostics capture real MAVLink traffic and direct adapters without acknowledging observations', async () => {
  for (const scenario of [droneScenario(), roverScenario()]) {
    const lab = await LabRuntime.create(scenario);
    try {
      const before = lab.bundle!.id;
      for (let i = 0; i < 5; i++) lab.diagnostics.read();
      assert.equal(lab.bundle!.id, before);
      await lab.command({ kind: 'goto', args: { ...scenario.waypoints[0]! } }); lab.advance(4);
      const data = lab.diagnostics.export();
      const tx = data.events.find(e => e.channel === 'protocol' && e.kind === 'TX'); assert.ok(tx);
      if (scenario.robot.protocol === 'mavlink') {
        const frame = tx.data as { hex: string; decoded: { x: number; y: number; z: number } };
        assert.ok(frame.hex.startsWith('fd')); assert.equal(frame.decoded.z, -scenario.waypoints[0]!.z);
      } else assert.equal((tx.data as { hex?: string }).hex, undefined);
      assert.ok(data.events.some(e => e.channel === 'sensors' && (e.data as { acquiredSimMs?: number }).acquiredSimMs !== undefined));
      assert.ok(data.events.some(e => e.channel === 'bridge' && e.kind === 'job'));
      assert.ok(!JSON.stringify(lab.bundle).includes('diagnostics'));
    } finally { await lab.close(); }
  }
});

test('native diagnostics retain exposed summaries and tool pairs, scoped to the attached thread', async () => {
  const lab = await LabRuntime.create(droneScenario());
  let listener: Parameters<AppServerClient['subscribe']>[0] | undefined;
  const client: AppServerClient = { async request() { return { thread: { id: 'own-thread' } }; }, subscribe(fn) { listener = fn; return () => { listener = undefined; }; } };
  const native = instrumentCodex(client, lab);
  try {
    await native.client.request('thread/start', { model: 'gpt-5.6-luna', config: { http_headers: { Authorization: 'Bearer secret-value' } } });
    listener!({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'other-thread', delta: 'wrong-thread' } });
    listener!({ method: 'item/reasoning/textDelta', params: { threadId: 'own-thread', delta: 'unexposed raw text' } });
    listener!({ method: 'item/completed', params: { threadId: 'own-thread', item: { id: 'r1', type: 'reasoning', summary: ['Inspecting range evidence'], content: ['raw-private-block'] } } });
    listener!({ method: 'turn/completed', params: { threadId: 'own-thread', turn: { id: 'turn1', status: 'completed', items: [{ content: 'raw-private-block' }] } } });
    const handlers = instrumentHandlers(createHandlers(lab.bridge), lab);
    await handlers.call('step', { schemaVersion: 2 });
    const events = lab.diagnostics.export().events.filter(e => e.channel === 'controller'), encoded = JSON.stringify(events);
    assert.ok(encoded.includes('Inspecting range evidence'));
    for (const text of ['wrong-thread', 'unexposed raw text', 'raw-private-block', 'secret-value']) assert.ok(!encoded.includes(text));
    const pair = events.filter(e => e.kind === 'tool'); assert.equal(pair.length, 2);
    assert.equal((pair[0]!.data as { callId: string }).callId, (pair[1]!.data as { callId: string }).callId);
    assert.match(lab.lastObservation!.source, /Native tool-1/);
  } finally { native.dispose(); await lab.close(); }
});
