import type { Environment, Snapshot, WaitRequest } from './types.ts';
import { ChangeSignal } from './changes.ts';
import { bounded, now } from './util.ts';

export interface LogicalWait {
  token: string; request: WaitRequest; baseline: Snapshot; eventFloor: number;
  deadlineMs?: number; controller: AbortController; ready: Promise<string>;
}
function numeric(environment: Environment, snapshot: Snapshot, name: string, at = now()): number | undefined {
  const field = environment.profile.waitFields?.[name]; if (!field) return;
  const sample = field.source === 'state' ? snapshot.state : snapshot.samples?.[field.sample ?? name];
  if (!sample?.valid || at-sample.receivedMs > Math.min(field.maxAgeMs,sample.maxAgeMs ?? Infinity)) return;
  let value: unknown = sample.value;
  for (const key of field.path ?? []) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value,key)) return;
    value = (value as Record<string,unknown>)[key];
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** Evaluates samples without waking inference. Registration is owned by the bridge lifetime. */
export async function evaluateWait(wait: LogicalWait, options: {
  environment: Environment; changes: ChangeSignal; snapshot(signal: AbortSignal, after?:number): Promise<Snapshot>;
  urgent(): string | undefined; legacy: boolean; checked?(reason?:string):void;
}): Promise<string> {
  const { environment, changes } = options, signal = wait.controller.signal;
  const baselineAt = now();
  const baseline = new Map(wait.request.until.flatMap(c => c.kind === 'change' ? [[c.field,numeric(environment,wait.baseline,c.field,baselineAt)] as const] : []));
  while (true) {
    signal.throwIfAborted();
    const sequence = changes.sequence, urgent = options.urgent(); if (urgent) {options.checked?.(urgent);return urgent;}
    const registration = new AbortController();
    const combined = AbortSignal.any([signal,registration.signal]);
    const legacyWake = !environment.changes ? environment.wait(combined).catch(() => {}) : undefined;
    try {
      const snapshot = await options.snapshot(signal,wait.eventFloor);
      let reason = snapshot.fault ? 'fault' : undefined;
      if (options.legacy && snapshot.events.length) reason = 'event';
      const eventTypes=new Set(wait.request.until.flatMap(c=>c.kind==='event'?[c.type]:[]));
      if(eventTypes.size){
        let slice=snapshot,after=wait.eventFloor;
        // Bounded non-consuming pages prevent a matching event behind the first slice being lost.
        for(let page=0;page<8;page++){
          if(slice.events.some(e=>e.seq>wait.eventFloor&&eventTypes.has(e.kind))){reason='event';break;}
          const last=slice.events.at(-1)?.seq;
          if(!slice.hasMore)break;
          if(last===undefined || last<=after){reason='event_backlog';break;}
          if(page===7){reason='event_backlog';break;}
          after=last;slice=await options.snapshot(signal,after);
          if(slice.fault){reason='fault';break;}
        }
      }
      for (const c of wait.request.until) {
        if (c.kind === 'jobTerminal' && snapshot.jobs?.some(j => j.id === c.id && !['pending','running','stopping'].includes(j.status))) reason = 'jobTerminal';
        if (c.kind === 'threshold' || c.kind === 'change') {
          const value = numeric(environment,snapshot,c.field); if (value === undefined) continue;
          if (c.kind === 'change') { const before = baseline.get(c.field); if (before !== undefined && value !== before && Math.abs(value-before) >= c.deadband) reason = 'change'; }
          else if ({ gt: value > c.value, gte: value >= c.value, lt: value < c.value, lte: value <= c.value }[c.op]) reason = 'threshold';
        }
      }
      if (wait.deadlineMs !== undefined && now() >= wait.deadlineMs) reason ??= 'review';
      options.checked?.(reason); options.checked=undefined;
      if (reason) return reason;
      try {
        await bounded(s => legacyWake ? Promise.race([legacyWake,changes.wait(sequence,s)]) : changes.wait(sequence,s), Math.max(1,(wait.deadlineMs ?? (now()+2147483647))-now()),combined);
      } catch (error) { if (signal.aborted || (error as {code?:string}).code !== 'timeout') throw error; }
    } finally { registration.abort(); }
  }
}
