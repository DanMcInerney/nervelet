import type { DecisionPolicy } from '../src/contracts.ts';

export function scriptedPolicy(key: string, delayMs = 0): DecisionPolicy {
  return { id: `scripted-${delayMs}ms`, async choose(_state, _candidates, signal) {
    if (delayMs) await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
      const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
      signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
    });
    signal.throwIfAborted(); return key;
  } };
}

/** Explicit opt-in, typed Jev action selection. No fallback model or automatic retry. */
export function jevPolicy(options: { apiKey: string; model: string; maxCalls?: number; fetch?: typeof fetch }): DecisionPolicy {
  let calls = 0;
  if (!options.apiKey || !options.model) throw new Error('jev_credentials_and_exact_model_required');
  return { id: `jev:${options.model}`, async choose(state, candidates, signal) {
    if (++calls > (options.maxCalls ?? 30)) throw new Error('jev_call_budget');
    if (Object.keys(candidates).length < 2 || Object.keys(candidates).length > 32) throw new Error('candidate_capacity');
    const response = await (options.fetch ?? fetch)('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ model: options.model, state: { observation: state, candidates }, questions: {
        action: { type: 'choice', instructions: 'Choose one permitted candidate that makes progress on the received goal using only valid sensor evidence. Choose hold if evidence is insufficient.',
          criteria: Object.fromEntries(Object.entries(candidates).map(([id, action]) => [id, JSON.stringify(action)])) }
      } })
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`jev_http_${response.status}`); }
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try { while (true) { const result = await reader.read(); if (result.done) break;
      bytes += result.value.length; if (bytes > 65536) throw new Error('jev_response_capacity'); chunks.push(result.value);
    } } finally { await reader.cancel(); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (result.model !== options.model) throw new Error('jev_model_changed');
    const key = result.answers?.action?.choice;
    if (typeof key !== 'string' || !Object.hasOwn(candidates, key)) throw new Error('jev_invalid_choice');
    return key;
  } };
}
