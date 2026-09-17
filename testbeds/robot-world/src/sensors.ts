import RAPIER from '@dimforge/rapier3d-compat';
import type { SensorContext, SensorPlugin, SensorSpec, Vec3 } from './contracts.ts';
import { finiteVector, vec } from './contracts.ts';

function rotate(v: Vec3, q: { x: number; y: number; z: number; w: number }): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return vec(v.x + q.w * tx + q.y * tz - q.z * ty, v.y + q.w * ty + q.z * tx - q.x * tz, v.z + q.w * tz + q.x * ty - q.y * tx);
}
function cast(c: SensorContext, direction: Vec3, range: number, spec: SensorSpec): number {
  const yaw = spec.mount?.yaw ?? 0, pitch = spec.mount?.pitch ?? 0;
  const pitched = vec(Math.cos(pitch) * direction.x - Math.sin(pitch) * direction.z, direction.y, Math.sin(pitch) * direction.x + Math.cos(pitch) * direction.z);
  const mounted = vec(Math.cos(yaw) * pitched.x - Math.sin(yaw) * pitched.y, Math.sin(yaw) * pitched.x + Math.cos(yaw) * pitched.y, pitched.z);
  const rotation = c.robot.bodies[0]!.rotation(), p = c.robot.bodies[0]!.translation(), offset = rotate(spec.mount?.translation ?? vec(), rotation);
  const origin = vec(p.x + offset.x, p.y + offset.y, p.z + offset.z);
  const hit = c.physics.castRay(new RAPIER.Ray(origin, rotate(mounted, rotation)), range, true,
    undefined, undefined, undefined, c.robot.bodies[0]);
  return hit ? hit.timeOfImpact : range;
}
const rounded = (v: number) => Math.round(v * 1000) / 1000;
const odometry: SensorPlugin = {
  id: 'odometry', sample(c, spec) {
    const s = c.robot.state();
    const noise = () => (c.random() - 0.5) * 2 * (spec.noise ?? 0);
    return { frame: 'ENU', position: { x: rounded(s.position.x + noise()), y: rounded(s.position.y + noise()), z: rounded(s.position.z + noise()) },
      velocity: { x: rounded(s.velocity.x), y: rounded(s.velocity.y), z: rounded(s.velocity.z) } };
  }
};
const rangeSensor: SensorPlugin = {
  id: 'range', sample(c, spec) {
    const range = spec.options?.range ?? 12, rays = spec.options?.rays ?? 12;
    return { frame: 'mounted sensor +X forward, +Z up', range, distances: Array.from({ length: rays }, (_, i) => {
      const a = i * Math.PI * 2 / rays;
      return rounded(Math.max(0, Math.min(range, cast(c, vec(Math.cos(a), Math.sin(a), 0), range, spec) + (c.random() - 0.5) * 2 * (spec.noise ?? 0))));
    }) };
  }
};
const depth: SensorPlugin = {
  id: 'depth', sample(c, spec) {
    const width = spec.options?.width ?? 12, height = spec.options?.height ?? 6, range = spec.options?.range ?? 15;
    const distances = Array.from({ length: width * height }, (_, i) => {
      const h = ((i % width + 0.5) / width - 0.5) * Math.PI / 2;
      const v = (0.5 - (Math.floor(i / width) + 0.5) / height) * Math.PI / 3;
      const d = cast(c, vec(Math.cos(h) * Math.cos(v), Math.sin(h) * Math.cos(v), Math.sin(v)), range, spec);
      return rounded(Math.max(0, Math.min(range, d + (c.random() - 0.5) * 2 * (spec.noise ?? 0))));
    });
    return { width, height, range, frame: 'mounted sensor +X forward, +Z up', distances };
  }
};
export const sensorPlugins = new Map<string, SensorPlugin>([odometry, rangeSensor, depth].map(s => [s.id, s]));
export function validateSensor(spec: SensorSpec) {
  if (spec.mount?.translation && !finiteVector(spec.mount.translation)) throw new Error('invalid_sensor_mount');
  for (const value of [spec.mount?.yaw ?? 0, spec.mount?.pitch ?? 0]) if (!Number.isFinite(value)) throw new Error('invalid_sensor_mount');
  if (!/^[a-zA-Z][\w.-]{0,63}$/.test(spec.id) || !Number.isFinite(spec.hz) || spec.hz <= 0 || spec.hz > 120)
    throw new Error('invalid_sensor');
  for (const [name, value, max] of [['latencyMs', spec.latencyMs ?? 0, 10000], ['noise', spec.noise ?? 0, 10],
    ['dropout', spec.dropout ?? 0, 1], ['maxAgeMs', spec.maxAgeMs ?? 1000, 60000]] as const) {
    if (!Number.isFinite(value) || value < 0 || value > max) throw new Error(`invalid_sensor_${name}`);
  }
  const o = spec.options;
  if (o?.rays !== undefined && (!Number.isInteger(o.rays) || o.rays < 1 || o.rays > 32)) throw new Error('invalid_rays');
  for (const key of ['width', 'height']) if (o?.[key] !== undefined && (!Number.isInteger(o[key]) || o[key] < 1 || o[key] > 16)) throw new Error('invalid_depth_size');
  if (o?.range !== undefined && (!Number.isFinite(o.range) || o.range <= 0 || o.range > 100)) throw new Error('invalid_range');
}
