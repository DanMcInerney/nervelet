import type RAPIER from '@dimforge/rapier3d-compat';
import type { CommandDefinition, Json } from 'nervelet';

/** World frame: metres, seconds, right-handed ENU (x east, y north, z up). */
export interface Vec3 { x: number; y: number; z: number }
export interface Shape { kind: 'box' | 'sphere'; size: Vec3; color: string }
export interface EntitySpec { id: string; position: Vec3; shape: Shape; mass?: number }
export interface SensorSpec {
  id: string; kind: string; hz: number; latencyMs?: number; noise?: number;
  dropout?: number; maxAgeMs?: number; options?: Record<string, number>;
  mount?: { translation?: Vec3; yaw?: number; pitch?: number };
}
export interface RobotSpec extends EntitySpec {
  model: string; protocol: string; sensors: SensorSpec[];
}
export interface Scenario {
  id: string; name: string; seed: number; dt: number; goal: string;
  bounds: Vec3; obstacles: EntitySpec[]; robot: RobotSpec; waypoints: Vec3[];
}
export interface RobotInstance {
  bodies: RAPIER.RigidBody[];
  state(): { position: Vec3; velocity: Vec3; joints?: number[] };
  apply(kind: string, args: Record<string, Json>): void;
  tick(dt: number): void;
  hold(): void;
  reached(kind: string, args: Record<string, Json>): boolean;
}
export interface RobotModel {
  id: string;
  commands: Record<string, CommandDefinition>;
  create(world: RAPIER.World, spec: RobotSpec): RobotInstance;
}
export interface ProtocolAdapter {
  id: string;
  execute(kind: string, args: Record<string, Json>, robot: RobotInstance, simMs: number): void;
  telemetry(robot: RobotInstance, simMs: number): Json;
  stats(): Json;
  close(): void;
  setRecorder?(record: (event: ProtocolRecord) => void): void;
}
export interface ProtocolRecord {
  direction: 'TX' | 'RX'; message: string; simMs: number; decoded: unknown;
  hex?: string; bytes?: number; frame?: string;
}
export interface SensorContext {
  physics: RAPIER.World; robot: RobotInstance; simMs: number; random(): number;
}
export interface SensorPlugin {
  id: string;
  sample(context: SensorContext, spec: SensorSpec): Json;
}
export interface SensorReading {
  value: Json; acquiredSimMs: number; receivedSimMs: number;
  valid: boolean; sequence: number; reason?: string;
}
export interface Decision {
  kind: string; args: Record<string, Json>;
}
/** Controllers get only admitted observations and declared candidates, never the physics world. */
export interface DecisionPolicy {
  id: string;
  choose(state: Json, candidates: Record<string, Decision>, signal: AbortSignal): Promise<string>;
}
export const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export function finiteVector(value: unknown): value is Vec3 {
  return !!value && typeof value === 'object' && ['x', 'y', 'z'].every(k => Number.isFinite((value as Record<string, unknown>)[k]));
}
