import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LabRuntime } from '../src/runtime.ts';
import { scenarios } from '../src/scenarios.ts';
import { distance } from '../src/contracts.ts';

/** Fast headless benchmark: delays are explicit simulated inference, never measured model latency. */
export async function runTrial(robot: keyof typeof scenarios, seed: number, thinkMs: number) {
  const scenario = scenarios[robot](); scenario.seed = seed;
  const lab = await LabRuntime.create(scenario);
  let arrivals = 0, commands = 0;
  const started = performance.now();
  try {
    for (const target of scenario.waypoints) {
      lab.advance(Math.max(1, Math.round(thinkMs / (scenario.dt * 1000))));
      await lab.observe();
      const b = await lab.command({ kind: 'goto', args: { ...target, timeoutMs: 20000 } }); commands++;
      const receipt = b.results?.find(r => r.jobId);
      if (!receipt?.jobId) break;
      let steps = 0;
      while (lab.environment.jobs.get(receipt.jobId)?.status === 'running' && steps++ < 1500) lab.advance(1);
      const job = lab.environment.jobs.get(receipt.jobId)!;
      if (job.status !== 'completed') break;
      // Independent evaluator uses truth; the operator's command path does not receive it.
      if (distance(lab.world.robot.state().position, target) < 0.25) arrivals++;
    }
    const final = lab.world.robot.state();
    return { robot, seed, simulatedThinkMs: thinkMs, physics: 'Rapier / simplified position servo',
      arrivals, expectedArrivals: scenario.waypoints.length, collisions: lab.world.collisions,
      simMs: lab.world.simMs, wallMs: performance.now() - started, commands,
      stateHash: createHash('sha256').update(JSON.stringify(final)).digest('hex'), protocol: lab.world.protocol.stats(),
      passed: arrivals === scenario.waypoints.length && lab.world.collisions === 0 };
  } finally { await lab.close(); }
}
async function main() {
  const results = [];
  for (const robot of ['drone', 'rover'] as const) for (const seed of [1, 42, 99]) for (const delay of [0, 500, 5000]) results.push(await runTrial(robot, seed, delay));
  const directory = resolve('.runtime/experiments'); await mkdir(directory, { recursive: true });
  const path = resolve(directory, 'latest.json'); await writeFile(path, JSON.stringify({ generatedAt: new Date().toISOString(), inference: 'none', results }, null, 2));
  console.table(results.map(({ robot, seed, simulatedThinkMs, arrivals, collisions, simMs, passed }) => ({ robot, seed, simulatedThinkMs, arrivals, collisions, simMs: Math.round(simMs), passed })));
  console.log(`Evidence: ${path}`);
  if (results.some(r => !r.passed)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
