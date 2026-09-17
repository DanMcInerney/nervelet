import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Supervisor } from 'nervelet';
import { CodexDriver, connectAppServer } from 'nervelet/drivers/codex';
import type { AppServerClient } from 'nervelet/drivers/codex';
import { LabRuntime } from '../src/runtime.ts';
import { droneScenario } from '../src/scenarios.ts';
import { instrumentCodex, instrumentHandlers } from './codex-diagnostics.ts';
import { serveLocalMcp } from 'nervelet/mcp';
import { startLabServer } from '../server.ts';

export const codexConfiguration = { model: 'gpt-5.6-luna', effort: 'xhigh' } as const;
/** Keep the library driver unchanged; this testbed binds the explicitly requested effort. */
export function withEffort(client: AppServerClient): AppServerClient {
  return { request(method, params, signal) {
    return client.request(method, method === 'turn/start' ? { ...params, effort: codexConfiguration.effort } : params, signal);
  }, subscribe: listener => client.subscribe(listener), close: () => client.close?.() ?? Promise.resolve() };
}
async function main() {
  const command = process.env.NERVELET_CODEX_EXECUTABLE;
  if (!command) throw new Error('Set NERVELET_CODEX_EXECUTABLE to the native Codex executable. This is an opt-in inference run.');
  const cwd = resolve('.runtime/codex'); await mkdir(cwd, { recursive: true });
  const client = await connectAppServer({ command, cwd });
  let lab: LabRuntime | undefined;
  let host: Awaited<ReturnType<typeof startLabServer>> | undefined;
  let dispose: (() => void) | undefined;
  try {
    let cursor: string | undefined; let available = false;
    do {
      const models = await client.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }) as {
        data: { model: string; supportedReasoningEfforts: { reasoningEffort: string }[] }[]; nextCursor?: string;
      };
      available ||= models.data.some(m => m.model === codexConfiguration.model && m.supportedReasoningEfforts.some(e => e.reasoningEffort === codexConfiguration.effort));
      cursor = models.nextCursor;
    } while (cursor && !available);
    if (!available) throw new Error('The requested gpt-5.6-luna / xhigh combination is unavailable; no model fallback.');
    const scenario = droneScenario();
    scenario.goal += ` Waypoints in ENU metres: ${JSON.stringify(scenario.waypoints)}. Use Nervelet goto jobs, wait for completion and stop after the final waypoint.`;
    lab = await LabRuntime.create(scenario); lab.startRealtime();
    const activeLab = lab;
    lab.controller = { mode: 'native', name: 'gpt-5.6-luna / xhigh', status: 'starting' };
    const diagnostics = instrumentCodex(client, lab); dispose = diagnostics.dispose;
    const driver = new CodexDriver({ client: withEffort(diagnostics.client), clientOwnership: 'borrowed', ...codexConfiguration,
      cwd, approvalPolicy: 'never', sandbox: 'read-only', async connectTools(handlers) {
        const endpoint = await serveLocalMcp(instrumentHandlers(handlers, activeLab));
        return { config: { mcp_servers: { nervelet: { url: endpoint.url, http_headers: { Authorization: `Bearer ${endpoint.token}` }, required: true } } }, close: endpoint.close };
      } });
    const supervisor = new Supervisor(lab.bridge, driver, { bridgeOwnership: 'borrowed', maxTurns: 8, maxStepsPerTurn: 40, turnMs: 120000, maxActiveMs: 300000 });
    host = await startLabServer({ lab, port: Number(process.env.PORT ?? 8861), nativeStop: () => supervisor.stop() });
    try { lab.controller.status = 'running'; await supervisor.run(); lab.controller.status = 'ended'; }
    catch (error) { lab.controller.status = 'error'; lab.diagnostics.record('controller', 'error', 'Native run failed', { error: String(error) }, lab.world.simMs); }
    console.log('Native run ended. Dashboard remains available for inspection; Ctrl+C closes it.');
    await host.closed;
  } finally { dispose?.(); await host?.close(); await lab?.close(); await client.close?.(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
