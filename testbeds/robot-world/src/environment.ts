import { ObservationStore } from 'nervelet';
import type { Command, CommandContext, ControlOutcome, Environment, Job, Profile, Receipt, Json } from 'nervelet';
import { RobotWorld } from './world.ts';

const now = () => performance.now();
export class RobotEnvironment implements Environment {
  readonly profile: Profile;
  readonly store = new ObservationStore();
  readonly changes = this.store.changes;
  readonly world: RobotWorld;
  readonly jobs = new Map<string, Job>();
  private starts = new Map<string, number>();
  private revisions = new Map<string, number>();
  private acquiredWall = new Map<string, number>();
  private onTick = () => this.tick();
  private onContact = () => { this.store.push('collision', { count: this.world.collisions, simMs: this.world.simMs }); };
  constructor(world: RobotWorld) {
    this.world = world;
    this.profile = {
      id: 'robot-world', version: '1', camera: { policy: 'none' },
      instructions: `Simulation testbed, ${world.model.id}, ENU metres (+X east, +Y north, +Z up). Physics is simplified. Read sensor acquisition time in sim milliseconds and wall receipt time separately. Model/controller calls never pause physics. Only mounted sensors are visible; depth is a range grid, not RGB. goto is a local servo, not obstacle-avoiding navigation. One motion job at a time; cancel before replacing. Jobs have a simulation-time timeout. A completed job means the simulated controller measured arrival.`,
      commands: { ...world.model.commands, hold: { description: 'Cancel active movement and hold immediately in the simplified simulator.', resource: 'motion',
        schema: { type: 'object', properties: {}, additionalProperties: false } } },
      waitFields: { simMs: { source: 'state', path: ['simMs'], maxAgeMs: 500, description: 'Simulation clock in milliseconds.' } }
    };
  }
  async start() { this.world.changes.add(this.onTick); this.world.contacts.add(this.onContact); this.tick(); }
  private active() { return [...this.jobs.values()].find(j => j.status === 'running'); }
  private finish(job: Job, status: Job['status'], reason?: string) {
    job.status = status; job.updatedMs = now(); if (reason) job.reason = reason;
    this.store.push('job', { id: job.id, status, simMs: this.world.simMs, ...(reason ? { reason } : {}) }); this.store.wake();
  }
  private tick() {
    const job = this.active();
    if (job) {
      if (this.store.fault) { this.world.robot.hold(); this.finish(job, 'failed', this.store.fault); }
      else if (this.world.robot.reached(job.kind, job.args)) this.finish(job, 'completed');
      else if (this.world.simMs - this.starts.get(job.id)! >= Number(job.args.timeoutMs ?? 30000)) {
        this.world.robot.hold(); this.finish(job, 'failed', 'motion_deadline');
      }
    }
    const wall = now();
    this.store.setState({ value: { robotId: this.world.scenario.robot.id, model: this.world.model.id,
      simMs: this.world.simMs, motion: this.active()?.id ?? null }, receivedMs: wall,
      acquired: { clock: 'simulation', ms: this.world.simMs }, valid: true, maxAgeMs: 500 });
    for (const [id, sample] of Object.entries(this.world.readings())) {
      if (this.revisions.get(id) !== sample.sequence) { this.revisions.set(id, sample.sequence); this.acquiredWall.set(id, wall); }
      this.store.setSample(id, { value: sample.value, receivedMs: this.acquiredWall.get(id) ?? wall,
        acquired: { clock: 'simulation', ms: sample.acquiredSimMs }, valid: sample.valid,
        ...(sample.reason ? { reason: sample.reason } : {}), maxAgeMs: 1000 });
    }
  }
  async snapshot(after: number) { return this.store.snapshot(after, [...this.jobs.values()]); }
  acknowledge(through: number) { this.store.acknowledge(through); }
  wait(signal: AbortSignal) { return this.store.wait(signal); }
  async execute(command: Command, context: CommandContext): Promise<Receipt> {
    context.signal.throwIfAborted(); context.assertCurrent?.();
    if (this.store.fault) return { id: command.id, status: 'rejected', reason: this.store.fault };
    if (command.kind === 'hold') { await this.stop(); return { id: command.id, status: 'completed' }; }
    if (this.active()) return { id: command.id, status: 'rejected', reason: 'motion_busy' };
    if (!this.world.model.commands[command.kind]) return { id: command.id, status: 'rejected', reason: 'unknown_command' };
    if (command.kind === 'goto') {
      const a = command.args, bounds = this.world.scenario.bounds;
      if (Math.abs(Number(a.x)) > bounds.x || Math.abs(Number(a.y)) > bounds.y || Number(a.z) > bounds.z)
        return { id: command.id, status: 'rejected', reason: 'outside_lab_bounds' };
    }
    if (this.jobs.size >= 64) {
      const oldest = [...this.jobs.values()].find(j => j.status !== 'running');
      if (!oldest) return { id: command.id, status: 'not_executed', reason: 'job_backpressure' };
      this.jobs.delete(oldest.id); this.starts.delete(oldest.id);
    }
    context.assertCurrent?.();
    this.world.protocol.execute(command.kind, command.args, this.world.robot, this.world.simMs);
    const id = `motion-${command.id}`, at = now();
    this.jobs.set(id, { id, commandId: command.id, kind: command.kind, args: structuredClone(command.args), status: 'running', startedMs: at, updatedMs: at });
    this.starts.set(id, this.world.simMs); this.tick(); this.store.wake();
    return { id: command.id, status: 'accepted', jobId: id };
  }
  async cancel(id: string): Promise<ControlOutcome> {
    const job = this.jobs.get(id); if (!job) throw new Error('unknown_job');
    if (job.status === 'running') { this.world.robot.hold(); this.finish(job, 'cancelled'); }
    this.tick(); return { status: 'confirmed' };
  }
  async stop(): Promise<ControlOutcome> {
    this.world.robot.hold(); const job = this.active(); if (job) this.finish(job, 'cancelled');
    this.tick(); return { status: 'confirmed' };
  }
  async close() { this.world.changes.delete(this.onTick); this.world.contacts.delete(this.onContact); }
}
