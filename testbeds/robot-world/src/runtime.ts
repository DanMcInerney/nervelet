import { Bridge } from 'nervelet';
import type { Bundle, Command, Json, StepRequest, Trace } from 'nervelet';
import type { Decision, DecisionPolicy, Scenario } from './contracts.ts';
import { RobotWorld, type Registries } from './world.ts';
import { RobotEnvironment } from './environment.ts';
import { Diagnostics, diagnosticCopy } from './diagnostics.ts';

export class LabRuntime {
  readonly world: RobotWorld;
  readonly environment: RobotEnvironment;
  readonly bridge: Bridge;
  readonly diagnostics = new Diagnostics();
  controller = { mode: 'policy', name: 'Scripted / no inference', status: 'idle' };
  lastObservation: { source: string; simMs: number; data: unknown; truncated: boolean } | null = null;
  private sensorRevisions = new Map<string, string>();
  private jobRevisions = new Map<string, string>();
  readonly trace: (Trace | Record<string, unknown>)[] = [];
  traceDropped = 0;
  decisionGeneration = 0;
  private timer?: NodeJS.Timeout;
  private previousWall = 0;
  private debt = 0;
  realTimeLagMs = 0;
  paused = false;
  closed = false;
  private decision?: AbortController;
  private serial: Promise<unknown> = Promise.resolve();
  private queued = 0;
  bundle?: Bundle;
  lastDecision: Record<string, unknown> | null = null;
  static async create(scenario: Scenario, registry?: Registries) {
    const world = await RobotWorld.create(scenario, registry);
    const runtime = new LabRuntime(world);
    try { await runtime.bridge.start(); runtime.world.step(); runtime.bundle = await runtime.bridge.step({ schemaVersion: 2 }); runtime.captureObservation(runtime.bundle, 'initial observation'); return runtime; }
    catch (error) { await runtime.bridge.close(); world.close(); throw error; }
  }
  private constructor(world: RobotWorld) {
    this.world = world; this.environment = new RobotEnvironment(world);
    this.bridge = new Bridge(this.environment, world.scenario.goal, { trace: entry => this.record(entry) });
    world.protocol.setRecorder?.(event => this.diagnostics.record('protocol', event.direction,
      `${event.direction} ${world.protocol.id} · ${event.message}`, event, event.simMs));
    world.changes.add(() => {
      for (const [id, reading] of Object.entries(world.readings())) {
        const revision = `${reading.sequence}:${reading.valid}:${reading.reason}`;
        if (this.sensorRevisions.get(id) === revision) continue;
        this.sensorRevisions.set(id, revision);
        this.diagnostics.record('sensors', reading.valid ? 'sample' : 'invalid', `${id} #${reading.sequence} · ${reading.valid ? 'received' : reading.reason}`, { sensor: id, ...reading }, world.simMs);
      }
      for (const job of this.environment.jobs.values()) {
        if (this.jobRevisions.get(job.id) === job.status) continue;
        this.jobRevisions.set(job.id, job.status);
        this.diagnostics.record('bridge', 'job', `${job.id} · ${job.status}`, job, world.simMs);
      }
      if (this.jobRevisions.size > 64) for (const id of this.jobRevisions.keys()) if (!this.environment.jobs.has(id)) this.jobRevisions.delete(id);
    });
    this.diagnostics.record('controller', 'status', 'Scripted controller ready', { inference: false, goal: world.scenario.goal }, world.simMs);
  }
  captureObservation(value: unknown, source: string) {
    this.lastObservation = { source, simMs: this.world.simMs, ...diagnosticCopy(value, 65536) };
    this.diagnostics.record('bridge', 'observation', source, value, this.world.simMs);
  }
  record(entry: Trace | Record<string, unknown>) {
    if (this.trace.length >= 2000) { this.trace.shift(); this.traceDropped++; }
    this.trace.push({ ...entry, simMs: this.world.simMs });
    this.diagnostics.record('bridge', String(entry.type), String(entry.type), entry, this.world.simMs);
  }
  /** Serializes ordinary operator requests; stop/cancel deliberately bypass this queue. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.queued >= 16) return Promise.reject(new Error('operator_backpressure'));
    this.queued++;
    const next = this.serial.then(fn).finally(() => { this.queued--; }); this.serial = next.catch(() => {}); return next;
  }
  async observe() { return this.exclusive(async () => {
    const b = this.bundle;
    this.bundle = await this.bridge.step({ schemaVersion: 2, ...(b ? { seen: b.id, goalVersion: b.goal.version, generation: b.generation } : {}) });
    this.captureObservation(this.bundle, 'step observation');
    return this.bundle;
  }); }
  async command(decision: Decision) { const generation = this.decisionGeneration; return this.exclusive(async () => {
    if (this.closed) throw new Error('runtime_closed');
    if (generation !== this.decisionGeneration) throw new Error('stale_operator_command');
    let b = this.bundle ?? await this.bridge.step({ schemaVersion: 2 });
    if (b.recovery) b = await this.bridge.step({ schemaVersion: 2, seen: b.id, goalVersion: b.goal.version, generation: b.generation });
    const command: Command = { id: b.nextCommandId, ...decision };
    this.bundle = await this.bridge.step({ schemaVersion: 2, seen: b.id, goalVersion: b.goal.version, generation: b.generation, commands: [command] });
    this.record({ type: 'operator_command', command, results: this.bundle.results });
    this.captureObservation(this.bundle, 'command response');
    return this.bundle;
  }); }
  advance(ticks: number) { if (this.closed) throw new Error('runtime_closed'); this.world.step(ticks); }
  startRealtime() {
    if (this.timer) return;
    this.previousWall = performance.now();
    this.timer = setInterval(() => {
      const wall = performance.now(), elapsed = wall - this.previousWall; this.previousWall = wall;
      if (this.paused || this.closed) return;
      this.debt += elapsed;
      const dt = this.world.scenario.dt * 1000;
      // Keep debt explicit instead of pretending a stalled host ran at real time.
      const ticks = Math.min(8, Math.floor(this.debt / dt));
      if (ticks) {
        try { this.advance(ticks); this.debt -= ticks * dt; }
        catch (error) { this.record({ type: 'runtime_fault', reason: String(error) }); this.paused = true; void this.hold(); }
      }
      this.realTimeLagMs = this.debt;
    }, 8);
  }
  async hold() {
    this.decisionGeneration++; this.decision?.abort(new Error('operator_hold'));
    // The environment is the physical job owner. Bridge remains usable after a hold.
    return this.environment.stop();
  }
  async stop() {
    this.decisionGeneration++; this.decision?.abort(new Error('operator_stop'));
    return this.bridge.stop();
  }
  async replaceGoal(text: string) {
    this.decisionGeneration++; this.decision?.abort(new Error('goal_changed'));
    await this.bridge.updateGoal(text); return this.observe();
  }
  async decide(policy: DecisionPolicy, candidates: Record<string, Decision>, maxAgeMs = 500, deadlineMs = 1500) {
    if (this.decision) throw new Error('decision_busy');
    const abort = new AbortController(); this.decision = abort;
    const generation = this.decisionGeneration, startWall = performance.now(), startSim = this.world.simMs;
    const timer = setTimeout(() => abort.abort(new Error('decision_deadline')), deadlineMs);
    const options = structuredClone(candidates);
    this.controller = { mode: 'policy', name: policy.id, status: 'deciding' };
    try {
      const b = await this.observe();
      const projection = { goal: b.goal, state: b.state, samples: b.samples, jobs: b.jobs, events: b.events } as unknown as Json;
      this.diagnostics.record('controller', 'request', `${policy.id} · decision requested`, { observation: projection, candidates: options }, this.world.simMs);
      // Race enforces a deadline even if a policy fails to cooperate with AbortSignal.
      const aborted = new Promise<never>((_, reject) => { abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }); });
      abort.signal.throwIfAborted();
      const key = await Promise.race([policy.choose(structuredClone(projection), options, abort.signal), aborted]);
      this.diagnostics.record('controller', 'response', `${policy.id} → ${key}`, { policy: policy.id, choice: key, latencyMs: performance.now() - startWall }, this.world.simMs);
      abort.signal.throwIfAborted();
      const age = this.world.simMs - startSim;
      if (generation !== this.decisionGeneration || age > maxAgeMs || performance.now() - startWall > deadlineMs) throw new Error('stale_decision');
      if (!Object.hasOwn(options, key)) throw new Error('unknown_candidate');
      this.lastDecision = { policy: policy.id, key, ageMs: age, latencyMs: performance.now() - startWall, outcome: 'applied' };
      // Enqueue with the generation check inside the serialized admission boundary.
      return await this.exclusive(async () => {
        abort.signal.throwIfAborted();
        if (generation !== this.decisionGeneration || this.world.simMs - startSim > maxAgeMs) throw new Error('stale_decision');
        const current = this.bundle!;
        this.bundle = await this.bridge.step({ schemaVersion: 2, seen: current.id, goalVersion: current.goal.version, generation: current.generation,
          commands: [{ id: current.nextCommandId, ...options[key]! }] });
        const receipt = this.bundle.results?.find(r => r.id === current.nextCommandId);
        this.lastDecision = { ...this.lastDecision, outcome: receipt?.status ?? 'unknown' };
        this.captureObservation(this.bundle, 'decision command response');
        this.diagnostics.record('controller', 'admission', `${key} · ${receipt?.status ?? 'unknown'}`, receipt, this.world.simMs);
        this.record({ type: 'decision', ...this.lastDecision }); return this.bundle;
      });
    } catch (error) {
      this.lastDecision = { policy: policy.id, latencyMs: performance.now() - startWall, outcome: 'rejected', reason: String(error) };
      this.diagnostics.record('controller', 'error', `${policy.id} · rejected`, this.lastDecision, this.world.simMs);
      this.record({ type: 'decision', ...this.lastDecision }); throw error;
    } finally { this.controller.status = 'idle'; clearTimeout(timer); if (this.decision === abort) this.decision = undefined; }
  }
  inspect() { return { ...this.world.inspect(), scenario: this.world.scenario, paused: this.paused, realTimeLagMs: this.realTimeLagMs,
    jobs: [...this.environment.jobs.values()], lastDecision: this.lastDecision, trace: this.trace.slice(-20), traceDropped: this.traceDropped,
    runId: this.diagnostics.runId, controller: this.controller }; }
  async close() {
    if (this.closed) return; this.closed = true;
    this.decisionGeneration++; this.decision?.abort(new Error('runtime_closed'));
    if (this.timer) clearInterval(this.timer);
    await this.serial;
    await this.bridge.close(); this.world.close();
  }
}
