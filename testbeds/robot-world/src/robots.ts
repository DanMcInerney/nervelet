import RAPIER from '@dimforge/rapier3d-compat';
import type { RobotModel, RobotInstance, Vec3 } from './contracts.ts';
import { distance, vec } from './contracts.ts';

const clamp = (n: number, max: number) => Math.max(-max, Math.min(max, n));
const positionSchema = { type: 'object', properties: {
  x: { type: 'number', minimum: -100, maximum: 100 },
  y: { type: 'number', minimum: -100, maximum: 100 },
  z: { type: 'number', minimum: 0.2, maximum: 50 },
  timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 }
}, required: ['x', 'y', 'z'], additionalProperties: false };

/** Deliberately simple plant: acceleration-limited position servo, not rotor aerodynamics. */
function mobileModel(id: 'drone' | 'rover'): RobotModel {
  return {
    id,
    commands: { goto: { description: 'Move toward an ENU position in metres; completes only on arrival. No path planner. A rover preserves its ground height.',
      resource: 'motion', schema: positionSchema } },
    create(world, spec) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(spec.position.x, spec.position.y, spec.position.z)
        .lockRotations().setLinearDamping(0.5).setCcdEnabled(true));
      const s = spec.shape.size;
      world.createCollider(RAPIER.ColliderDesc.cuboid(s.x / 2, s.y / 2, s.z / 2).setMass(spec.mass ?? 1)
        .setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min), body);
      let target: Vec3 = { ...spec.position };
      const state = () => ({ position: { ...body.translation() }, velocity: { ...body.linvel() } });
      const instance: RobotInstance = {
        bodies: [body], state,
        apply(kind, args) {
          if (kind !== 'goto') throw new Error('unsupported_robot_command');
          target = vec(Number(args.x), Number(args.y), id === 'rover' ? spec.position.z : Number(args.z));
        },
        hold() { target = { ...body.translation() }; body.setLinvel(vec(), true); body.resetForces(true); },
        tick() {
          const p = body.translation(), v = body.linvel(), maxSpeed = id === 'drone' ? 2.5 : 1.5;
          const desired = vec(clamp((target.x - p.x) * 1.8, maxSpeed), clamp((target.y - p.y) * 1.8, maxSpeed), clamp((target.z - p.z) * 1.8, maxSpeed));
          const m = body.mass();
          body.resetForces(true);
          body.addForce(vec(m * clamp((desired.x - v.x) * 4, 5), m * clamp((desired.y - v.y) * 4, 5),
            id === 'drone' ? m * (9.81 + clamp((desired.z - v.z) * 4, 5)) : 0), true);
        },
        reached(_kind, args) {
          const actual = state();
          const destination = vec(Number(args.x), Number(args.y), id === 'rover' ? spec.position.z : Number(args.z));
          return distance(actual.position, destination) < 0.18 && Math.hypot(...Object.values(actual.velocity)) < 0.2;
        }
      };
      return instance;
    }
  };
}
export const droneModel = mobileModel('drone');
export const roverModel = mobileModel('rover');
export const robotModels = new Map<string, RobotModel>([droneModel, roverModel].map(model => [model.id, model]));
