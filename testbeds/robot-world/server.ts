import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { LabRuntime } from './src/runtime.ts';
import { scenarios } from './src/scenarios.ts';
import { scriptedPolicy, jevPolicy } from './controllers/policies.ts';
import type { DecisionPolicy } from './src/contracts.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
export async function startLabServer(options: { lab?: LabRuntime; port?: number; nativeStop?: () => Promise<unknown> } = {}) {
const port = options.port ?? Number(process.env.PORT ?? 8860);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_port');
let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
let lab = options.lab ?? await LabRuntime.create(scenarios.drone()); lab.startRealtime();
let waypoint = 0, auto = false, busy = false, error = '', policyName = 'scripted', resetBusy = false;
let routeJob: string | undefined;
let policy: DecisionPolicy = scriptedPolicy('next');
const liveJev = process.env.LAB_ENABLE_JEV === '1' ? jevPolicy({ apiKey: process.env.TYPESAFE_API_KEY ?? '', model: process.env.JEV_MODEL ?? '', maxCalls: 30 }) : undefined;
const pump = setInterval(() => {
  if (!auto || busy || lab.paused || resetBusy || lab.closed) return;
  if (routeJob) {
    const job = lab.environment.jobs.get(routeJob);
    if (job?.status === 'running') return;
    routeJob = undefined;
    if (job?.status === 'completed') waypoint++;
    else { auto = false; error = `Route interrupted: ${job?.reason ?? job?.status ?? 'missing job'}. Run again to retry this waypoint.`; return; }
  }
  if ([...lab.environment.jobs.values()].some(j => j.status === 'running')) return;
  if (waypoint >= lab.world.scenario.waypoints.length) { auto = false; return; }
  busy = true; const current = lab, index = waypoint;
  void current.decide(policy, { next: { kind: 'goto', args: { ...current.world.scenario.waypoints[index]!, timeoutMs: 20000 } }, hold: { kind: 'hold', args: {} } }, 1200, 1500)
    .then(b => { if (current === lab) {
      const receipt = b.results?.find(r => r.status === 'accepted');
      if (receipt?.jobId) routeJob = receipt.jobId;
      else if (b.results?.some(r => r.status === 'rejected' || r.status === 'not_executed' || r.status === 'unknown')) {
        auto = false; error = 'Command was not admitted; inspect the trace.';
      }
    } })
    .catch(e => { if (current === lab) { error = String(e); auto = false; } })
    .finally(() => { busy = false; });
}, 100);
const server = createHttpServer((req, res) => {
  void (async () => {
    const host = `127.0.0.1:${port}`, origin = req.headers.origin;
    if (req.headers.host !== host && req.headers.host !== `localhost:${port}`) { res.writeHead(403); res.end('Invalid host'); return; }
    if (origin && origin !== `http://${host}` && origin !== `http://localhost:${port}`) { res.writeHead(403); res.end('Invalid origin'); return; }
    const url = new URL(req.url ?? '/', `http://${host}`), pathname = url.pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (pathname === '/api/state' && req.method === 'GET') { json({ ...lab.inspect(), waypoint, auto, busy, error, policy: policyName, jevEnabled: !!liveJev, native: !!options.nativeStop }); return; }
    if (pathname === '/api/trace' && req.method === 'GET') { json({ scenario: lab.world.scenario, trace: lab.trace, dropped: lab.traceDropped }); return; }
    if (pathname === '/api/diagnostics' && req.method === 'GET') {
      const batch = lab.diagnostics.read(Number(url.searchParams.get('after') ?? 0), url.searchParams.get('runId') ?? '');
      json({ ...batch, observation: lab.lastObservation, controller: lab.controller }); return;
    }
    if (pathname === '/api/diagnostics/export' && req.method === 'GET') {
      json({ scenario: lab.world.scenario, ...lab.diagnostics.export(), observation: lab.lastObservation }); return;
    }
    if (pathname === '/api/control' && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/json') { json({ error: 'JSON required' }, 415); return; }
      let data = ''; for await (const chunk of req) { data += chunk.toString(); if (Buffer.byteLength(data) > 8192) { json({ error: 'Request too large' }, 413); return; } }
      const body = JSON.parse(data);
      if (resetBusy) { json({ error: 'Reset in progress' }, 409); return; }
      if (options.nativeStop && ['run', 'reset', 'policy'].includes(body.op)) { json({ error: 'Native session owns this world. Restart its CLI runner to begin another run.' }, 409); return; }
      switch (body.op) {
        case 'run': auto = true; error = ''; break;
        case 'hold': auto = false; if (options.nativeStop) await options.nativeStop(); else await lab.hold(); routeJob = undefined; break;
        case 'pause': lab.paused = !lab.paused; break;
        case 'step': if (!lab.paused) throw new Error('Pause before stepping'); lab.advance(1); break;
        case 'reset': {
          if (!Object.hasOwn(scenarios, body.scenario)) throw new Error('Unknown scenario');
          resetBusy = true; auto = false;
          try { const next = await LabRuntime.create(scenarios[body.scenario as keyof typeof scenarios]());
            const old = lab; await old.close(); lab = next; lab.startRealtime(); waypoint = 0; routeJob = undefined; error = ''; }
          finally { resetBusy = false; }
          break;
        }
        case 'sensor': {
          const patch = { latencyMs: Number(body.latencyMs), dropout: Number(body.dropout), noise: Number(body.noise) };
          lab.world.configureSensor(String(body.id), patch); lab.record({ type: 'sensor_configuration', id: String(body.id), ...patch }); break;
        }
        case 'policy':
          if (auto || busy) throw new Error('Hold before changing controller');
          if (body.policy === 'jev') { if (!liveJev) throw new Error('Restart with explicit Jev configuration'); policy = liveJev; }
          else if (body.policy === 'scripted') policy = scriptedPolicy('next');
          else if (body.policy === 'delayed') policy = scriptedPolicy('next', 700);
          else throw new Error('Unknown controller');
          policyName = body.policy; lab.controller = { mode: 'policy', name: policy.id, status: 'idle' };
          lab.diagnostics.record('controller', 'status', 'Controller selected', lab.controller, lab.world.simMs); break;
        default: throw new Error('Unknown operation');
      }
      json({ ok: true }); return;
    }
    if (pathname.startsWith('/api/')) { json({ error: 'Not found' }, 404); return; }
    vite!.middlewares(req, res, () => {
      void readFile(new URL('./index.html', import.meta.url), 'utf8').then(html => vite!.transformIndexHtml(req.url ?? '/', html)).then(html => {
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
      }).catch(e => { res.writeHead(500); res.end(String(e)); });
    });
  })().catch(e => { if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })); });
});
let closing = false;
let resolveClosed: () => void;
const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
const signalClose = () => { void close(); };
async function close() {
  if (closing) return closed; closing = true; clearInterval(pump);
  process.removeListener('SIGINT', signalClose); process.removeListener('SIGTERM', signalClose);
  server.close(); server.closeAllConnections();
  try { await options.nativeStop?.(); }
  finally { try { await lab.close(); } finally { try { await vite?.close(); } finally { resolveClosed(); } } }
}
try {
  // Reuse this host's port so several independent test worlds cannot contend for Vite's default HMR port.
  vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'custom' });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
} catch (error) { await close(); throw error; }
process.once('SIGINT', signalClose); process.once('SIGTERM', signalClose);
console.log(`Robot World: http://127.0.0.1:${port}`);
return { url: `http://127.0.0.1:${port}`, close, closed };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await startLabServer();
