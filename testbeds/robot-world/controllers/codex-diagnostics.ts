import type { AppServerClient } from 'nervelet/drivers/codex';
import type { Handlers } from 'nervelet';
import type { LabRuntime } from '../src/runtime.ts';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Project documented native events, scoped to the one thread started through this handle. */
export function instrumentCodex(client: AppServerClient, lab: LabRuntime) {
  let threadId: string | undefined;
  const record = (kind: string, label: string, data: unknown) => lab.diagnostics.record('controller', kind, label, data, lab.world.simMs);
  const unsubscribe = client.subscribe(event => {
    const p = event.params;
    if (event.method === 'transport/closed') { record('error', 'Native transport closed', p); return; }
    if (!threadId || p.threadId !== threadId) return;
    if (event.method === 'item/started' || event.method === 'item/completed') {
      const item = p.item; if (!object(item)) return;
      const kind = item.type === 'reasoning' ? 'summary' : /ToolCall|Execution|functionCallOutput/.test(String(item.type)) ? 'tool' : 'message';
      // Reasoning summaries are the inspectable surface; do not retain raw/encrypted reasoning.
      const content = item.type === 'reasoning' ? { id: item.id, type: item.type, summary: item.summary } : item;
      record(kind, `${String(item.type)} · ${event.method.split('/')[1]}`, { threadId, turnId: p.turnId, item: content });
    } else if (event.method === 'item/reasoning/summaryTextDelta') {
      record('summary', 'Reasoning summary · delta', p);
    } else if (event.method === 'item/agentMessage/delta' || event.method === 'item/plan/delta') {
      record('message', event.method, p);
    } else if (event.method === 'item/commandExecution/outputDelta') {
      record('tool', 'Command output · delta', p);
    } else if (['turn/started', 'turn/completed', 'turn/plan/updated', 'thread/tokenUsage/updated', 'model/rerouted', 'error'].includes(event.method)) {
      // Turn.items can contain raw reasoning; item notifications above provide the safe projection.
      const { turn, ...rest } = p;
      record(event.method === 'error' ? 'error' : 'status', event.method,
        object(turn) ? { ...rest, turn: { id: turn.id, status: turn.status, error: turn.error } } : rest);
    }
  });
  return {
    client: {
      async request(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
        if (['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt'].includes(method)) {
          // Native config includes the local MCP bearer credential; never record it.
          const { model, effort, threadId: id, input } = params;
          record('request', method, { model, effort, threadId: id, ...(method === 'turn/start' ? { input } : {}) });
          if (method === 'turn/start') lab.captureObservation({ input }, 'Native turn input');
        }
        try {
          const response = await client.request(method, params, signal);
          if ((method === 'thread/start' || method === 'thread/resume') && object(response) && object(response.thread) && typeof response.thread.id === 'string') {
            threadId = response.thread.id; record('status', 'Native thread attached', { threadId, model: params.model });
          }
          return response;
        } catch (error) { record('error', `${method} failed`, { error: String(error) }); throw error; }
      },
      subscribe: listener => client.subscribe(listener), close: () => client.close?.() ?? Promise.resolve()
    } satisfies AppServerClient,
    dispose: unsubscribe
  };
}

/** Observe tool request/result pairing without advancing any delivery acknowledgement. */
export function instrumentHandlers(handlers: Handlers, lab: LabRuntime): Handlers {
  let next = 0;
  return { ...handlers, async call(name, args, signal) {
    const callId = `tool-${++next}`;
    lab.diagnostics.record('controller', 'tool', `${name} · request`, { callId, name, args }, lab.world.simMs);
    try {
      const result = await handlers.call(name, args, signal);
      lab.diagnostics.record('controller', 'tool', `${name} · result`, { callId, name, result }, lab.world.simMs);
      if (name === 'step') lab.captureObservation(result, `Native ${callId} step result`);
      return result;
    } catch (error) {
      lab.diagnostics.record('controller', 'error', `${name} · error`, { callId, name, error: String(error) }, lab.world.simMs); throw error;
    }
  } };
}
