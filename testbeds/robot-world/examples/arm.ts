import RAPIER from '@dimforge/rapier3d-compat';
import type { RobotModel } from '../src/contracts.ts';
import { vec } from '../src/contracts.ts';
import { roverScenario } from '../src/scenarios.ts';
import { defaultRegistries } from '../src/world.ts';
import { LabRuntime } from '../src/runtime.ts';

/** Two-joint kinematic reference, not torque/contact-qualified manipulation. */
export const armModel: RobotModel = {
  id: 'reference-arm',
  commands: { joint_target: {
    description: 'Move shoulder and elbow to angles in radians, at a bounded joint speed.', resource: 'arm',
    schema: { type: 'object', properties: { shoulder: { type: 'number', minimum: -0.6, maximum: 1.8 },
      elbow: { type: 'number', minimum: -1.8, maximum: 1.8 } }, required: ['shoulder', 'elbow'], additionalProperties: false }
  } },
  create(world, spec) {
    const base = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(spec.position.x, spec.position.y, spec.position.z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.25, 0.25, 0.4), base);
    const lengths = [1.4, 1.1], joints = [0.3, 0.2], target = [...joints];
    const links = lengths.map(length => {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      world.createCollider(RAPIER.ColliderDesc.cuboid(length / 2, 0.08, 0.08), body); return body;
    });
    const origin = { ...spec.position, z: spec.position.z + 0.4 };
    function poses() {
      const a = joints[0]!, b = a + joints[1]!, elbow = vec(origin.x + Math.cos(a) * lengths[0]!, origin.y, origin.z + Math.sin(a) * lengths[0]!);
      const tip = vec(elbow.x + Math.cos(b) * lengths[1]!, elbow.y, elbow.z + Math.sin(b) * lengths[1]!);
      return { tip, centers: [vec((origin.x + elbow.x) / 2, origin.y, (origin.z + elbow.z) / 2), vec((elbow.x + tip.x) / 2, origin.y, (elbow.z + tip.z) / 2)], angles: [a, b] };
    }
    function update(initial = false) {
      const p = poses();
      links.forEach((body, i) => {
        const rotation = { x: 0, y: -Math.sin(p.angles[i]! / 2), z: 0, w: Math.cos(p.angles[i]! / 2) };
        if (initial) { body.setTranslation(p.centers[i]!, true); body.setRotation(rotation, true); }
        else { body.setNextKinematicTranslation(p.centers[i]!); body.setNextKinematicRotation(rotation); }
      });
    }
    update(true);
    return {
      bodies: [base, ...links],
      state: () => ({ position: poses().tip, velocity: vec(), joints: [...joints] }),
      apply(kind, args) { if (kind !== 'joint_target') throw new Error('unknown_arm_command'); target[0] = Number(args.shoulder); target[1] = Number(args.elbow); },
      hold() { target[0] = joints[0]!; target[1] = joints[1]!; },
      tick(dt) { for (let i = 0; i < 2; i++) joints[i] = joints[i]! + Math.max(-dt * 0.8, Math.min(dt * 0.8, target[i]! - joints[i]!)); update(); },
      reached(_kind, args) { return Math.abs(joints[0]! - Number(args.shoulder)) < 0.01 && Math.abs(joints[1]! - Number(args.elbow)) < 0.01; }
    };
  }
};
export async function createArmLab() {
  const registry = defaultRegistries(); registry.robots.set(armModel.id, armModel);
  registry.sensors.set('joint-encoder', { id: 'joint-encoder', sample: c => ({ radians: c.robot.state().joints ?? [] }) });
  const scenario = roverScenario(); scenario.id = 'arm-lab'; scenario.obstacles = []; scenario.waypoints = [];
  scenario.robot.model = armModel.id; scenario.robot.position = vec(0, 0, 0.4);
  scenario.robot.sensors = [{ id: 'joints', kind: 'joint-encoder', hz: 30 }];
  scenario.goal = 'Move the shoulder to 0.9 radians and elbow to -0.4 radians, then hold.';
  return LabRuntime.create(scenario, registry);
}
