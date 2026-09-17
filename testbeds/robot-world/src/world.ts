import RAPIER from '@dimforge/rapier3d-compat';
import type { EntitySpec, ProtocolAdapter, RobotInstance, RobotModel, Scenario, SensorPlugin, SensorReading, SensorSpec } from './contracts.ts';
import { finiteVector, vec } from './contracts.ts';
import { robotModels } from './robots.ts';
import { protocols } from './protocols.ts';
import { sensorPlugins, validateSensor } from './sensors.ts';

let initialized: Promise<void> | undefined;
export interface Registries {
  robots: Map<string, RobotModel>; sensors: Map<string, SensorPlugin>; protocols: Map<string, () => ProtocolAdapter>;
}
export const defaultRegistries = (): Registries => ({ robots: new Map(robotModels), sensors: new Map(sensorPlugins), protocols: new Map(protocols) });
type SensorSlot = { spec: SensorSpec; nextMs: number; sequence: number; latest?: SensorReading; pending: SensorReading[] };

export class RobotWorld {
  readonly physics: RAPIER.World;
  readonly robot: RobotInstance;
  readonly model: RobotModel;
  readonly protocol: ProtocolAdapter;
  readonly scenario: Scenario;
  readonly sensors = new Map<string, SensorSlot>();
  readonly changes = new Set<() => void>();
  readonly contacts = new Set<() => void>();
  ticks = 0;
  collisions = 0;
  closed = false;
  private seed: number;
  private registry: Registries;
  private events = new RAPIER.EventQueue(true);
  private obstacleHandles = new Set<number>();
  private robotHandles = new Set<number>();
  private lastTelemetryMs = -1000;
  telemetry: unknown = null;

  static async create(scenario: Scenario, registry = defaultRegistries()) {
    initialized ??= RAPIER.init(); await initialized;
    return new RobotWorld(scenario, registry);
  }
  private constructor(scenario: Scenario, registry: Registries) {
    if (!Number.isFinite(scenario.dt) || scenario.dt < 1 / 500 || scenario.dt > 0.1 || !Number.isInteger(scenario.seed)) throw new Error('invalid_clock');
    if (!finiteVector(scenario.bounds) || Object.values(scenario.bounds).some(n => n <= 0 || n > 200)) throw new Error('invalid_bounds');
    if (scenario.obstacles.length > 128 || scenario.robot.sensors.length > 8) throw new Error('world_capacity');
    for (const e of [...scenario.obstacles, scenario.robot]) {
      if (!finiteVector(e.position) || !finiteVector(e.shape.size) || Object.values(e.shape.size).some(n => n <= 0 || n > 100)) throw new Error('invalid_entity');
    }
    for (const s of scenario.robot.sensors) { validateSensor(s); if (!registry.sensors.has(s.kind)) throw new Error('unknown_sensor'); }
    if (new Set(scenario.robot.sensors.map(s => s.id)).size !== scenario.robot.sensors.length) throw new Error('duplicate_sensor');
    const model = registry.robots.get(scenario.robot.model), protocol = registry.protocols.get(scenario.robot.protocol);
    if (!model || !protocol) throw new Error('unknown_robot_or_protocol');
    this.scenario = structuredClone(scenario); this.registry = registry; this.seed = scenario.seed >>> 0;
    this.model = model; this.physics = new RAPIER.World(vec(0, 0, -9.81)); this.physics.timestep = scenario.dt;
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(scenario.bounds.x, scenario.bounds.y, 0.1).setTranslation(0, 0, -0.1));
    for (const obstacle of scenario.obstacles) this.addObstacle(obstacle);
    this.robot = model.create(this.physics, scenario.robot); this.protocol = protocol();
    for (const body of this.robot.bodies) for (let i = 0; i < body.numColliders(); i++) {
      const collider = body.collider(i); collider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS); this.robotHandles.add(collider.handle);
    }
    for (const spec of scenario.robot.sensors) this.sensors.set(spec.id, { spec: structuredClone(spec), nextMs: 0, sequence: 0, pending: [] });
  }
  get simMs() { return this.ticks * this.scenario.dt * 1000; }
  random() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
  private addObstacle(spec: EntitySpec) {
    const s = spec.shape.size;
    const collider = spec.shape.kind === 'sphere' ? RAPIER.ColliderDesc.ball(s.x / 2) : RAPIER.ColliderDesc.cuboid(s.x / 2, s.y / 2, s.z / 2);
    this.obstacleHandles.add(this.physics.createCollider(collider.setTranslation(spec.position.x, spec.position.y, spec.position.z)).handle);
  }
  configureSensor(id: string, patch: Partial<Pick<SensorSpec, 'latencyMs' | 'noise' | 'dropout'>>) {
    const slot = this.sensors.get(id); if (!slot) throw new Error('unknown_sensor');
    const spec = { ...slot.spec, ...patch }; validateSensor(spec); slot.spec = spec;
    const index = this.scenario.robot.sensors.findIndex(sensor => sensor.id === id);
    this.scenario.robot.sensors[index] = structuredClone(spec);
  }
  step(count = 1) {
    if (this.closed) throw new Error('world_closed');
    if (!Number.isInteger(count) || count < 1 || count > 36000) throw new Error('invalid_step_count');
    for (let i = 0; i < count; i++) {
      this.robot.tick(this.scenario.dt); this.physics.step(this.events); this.ticks++;
      this.events.drainCollisionEvents((a, b, started) => {
        if (started && ((this.robotHandles.has(a) && this.obstacleHandles.has(b)) || (this.robotHandles.has(b) && this.obstacleHandles.has(a)))) {
          this.collisions++; for (const listener of this.contacts) listener();
        }
      });
      this.acquire();
      if (this.simMs - this.lastTelemetryMs >= 100) { this.telemetry = this.protocol.telemetry(this.robot, this.simMs); this.lastTelemetryMs = this.simMs; }
      for (const listener of this.changes) listener();
    }
  }
  private acquire() {
    for (const slot of this.sensors.values()) {
      if (this.simMs + 0.00001 >= slot.nextMs) {
        slot.nextMs = this.simMs + 1000 / slot.spec.hz;
        if (this.random() >= (slot.spec.dropout ?? 0)) {
          const value = this.registry.sensors.get(slot.spec.kind)!.sample({ physics: this.physics, robot: this.robot, simMs: this.simMs, random: () => this.random() }, slot.spec);
          // Sensor latency buffers are bounded and represent replaceable samples.
          if (slot.pending.length >= 1201) throw new Error('sensor_backpressure');
          slot.pending.push({ value, acquiredSimMs: this.simMs, receivedSimMs: this.simMs + (slot.spec.latencyMs ?? 0), sequence: ++slot.sequence, valid: true });
        }
      }
      // A latency change can make a newer sample arrive before an older one.
      const ready = slot.pending.filter(sample => sample.receivedSimMs <= this.simMs + 0.00001);
      slot.pending = slot.pending.filter(sample => sample.receivedSimMs > this.simMs + 0.00001);
      for (const sample of ready) {
        if (!slot.latest || sample.sequence > slot.latest.sequence) slot.latest = { ...sample, receivedSimMs: this.simMs };
      }
    }
  }
  readings(): Record<string, SensorReading> {
    return Object.fromEntries([...this.sensors].map(([id, slot]) => {
      const sample = slot.latest;
      if (!sample) return [id, { value: null, acquiredSimMs: 0, receivedSimMs: 0, valid: false, sequence: 0, reason: 'no_sample' }];
      const stale = this.simMs - sample.acquiredSimMs > (slot.spec.maxAgeMs ?? 1000);
      return [id, { ...structuredClone(sample), valid: !stale, ...(stale ? { reason: 'stale_acquisition' } : {}) }];
    }));
  }
  /** Renderer and evaluator only; never pass this to a decision policy. */
  inspect() { return { simMs: this.simMs, ticks: this.ticks, robot: this.robot.state(), collisions: this.collisions,
    sensors: this.readings(), protocol: this.protocol.stats(), telemetry: this.telemetry }; }
  close() {
    if (this.closed) return;
    this.closed = true; this.changes.clear(); this.contacts.clear(); this.protocol.close(); this.events.free(); this.physics.free();
  }
}
