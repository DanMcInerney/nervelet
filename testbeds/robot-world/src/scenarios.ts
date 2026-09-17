import type { Scenario, SensorSpec } from './contracts.ts';
import { vec } from './contracts.ts';

const sensors: SensorSpec[] = [
  { id: 'odometry', kind: 'odometry', hz: 20, maxAgeMs: 250 },
  { id: 'range', kind: 'range', hz: 10, maxAgeMs: 500, options: { range: 12, rays: 12 } },
  { id: 'depth', kind: 'depth', hz: 5, maxAgeMs: 700, options: { range: 15, width: 12, height: 6 } }
];
export function droneScenario(): Scenario {
  return {
    id: 'drone-lab', name: 'Drone / waypoint laboratory', seed: 42, dt: 1 / 60,
    goal: 'Visit the three declared waypoints in order, then hold position. Use sensor evidence to confirm arrival.',
    bounds: vec(18, 14, 12),
    obstacles: [
      { id: 'tower-a', position: vec(0, 1, 1.5), shape: { kind: 'box', size: vec(2, 2, 3), color: '#8099ab' } },
      { id: 'tower-b', position: vec(4, 2, 2), shape: { kind: 'box', size: vec(1.5, 3, 4), color: '#6b859b' } },
      { id: 'low-wall', position: vec(-3, 4, 0.5), shape: { kind: 'box', size: vec(5, 0.6, 1), color: '#789689' } }
    ],
    robot: { id: 'robot-1', model: 'drone', protocol: 'mavlink', position: vec(-6, -4, 1), mass: 1.5,
      shape: { kind: 'box', size: vec(0.6, 0.6, 0.22), color: '#42d9c8' }, sensors: structuredClone(sensors) },
    waypoints: [vec(-3, -3, 3), vec(3, -3, 4), vec(6, 4, 5)]
  };
}
export function roverScenario(): Scenario {
  const s = droneScenario();
  return { ...s, id: 'rover-lab', name: 'Rover / planar navigation', robot: { ...s.robot, model: 'rover', protocol: 'direct',
    position: vec(-6, -4, 0.26), shape: { kind: 'box', size: vec(0.8, 0.6, 0.5), color: '#e7bb68' } },
    waypoints: [vec(-3, -3, 0.26), vec(3, -3, 0.26), vec(6, -1, 0.26)] };
}
export const scenarios = { drone: droneScenario, rover: roverScenario };
