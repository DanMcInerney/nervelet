import type { Environment, Profile, Snapshot, WaitRequest } from './types.ts';
import { ChangeSignal } from './changes.ts';
import { bounded, now } from './util.ts';

export interface LogicalWait {
  token: string;
  request: WaitRequest;
  baseline: Snapshot;
  /** Typed event predicates ignore events already assembled for delivery. */
  eventFloor: number;
  /** Any-event predicates include delivered events until explicitly acknowledged. */
  unreadEventFloor: number;
  deadlineMs?: number;
  controller: AbortController;
  ready: Promise<string>;
}

function numeric(profile: Profile, snapshot: Snapshot, name: string, at = now()): number | undefined {
  const field = profile.waitFields?.[name];
  if (!field) return;
  const sample = field.source === 'state' ? snapshot.state : snapshot.samples?.[field.sample ?? name];
  if (!sample?.valid || at - sample.receivedMs > Math.min(field.maxAgeMs, sample.maxAgeMs ?? Infinity)) return;
  let value: unknown = sample.value;
  for (const key of field.path ?? []) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Evaluates samples without waking inference. Registration belongs to the bridge lifetime. */
export async function evaluateWait(wait: LogicalWait, options: {
  environment: Environment;
  profile?: Profile;
  changes: ChangeSignal;
  snapshot(signal: AbortSignal, after?: number): Promise<Snapshot>;
  urgent(): string | undefined;
  legacy: boolean;
  checked?(reason?: string): void;
}): Promise<string> {
  const { environment, changes } = options;
  const profile = options.profile ?? environment.profile;
  const signal = wait.controller.signal;
  const baselineAt = now();
  const baseline = new Map(wait.request.until.flatMap(condition => condition.kind === 'change'
    ? [[condition.field, numeric(profile, wait.baseline, condition.field, baselineAt)] as const] : []));
  const anyEvent = options.legacy || wait.request.until.some(condition => condition.kind === 'anyEvent');
  const eventTypes = new Set(wait.request.until.flatMap(condition => condition.kind === 'event' ? [condition.type] : []));
  const snapshotFloor = anyEvent ? Math.min(wait.eventFloor, wait.unreadEventFloor) : wait.eventFloor;

  while (true) {
    signal.throwIfAborted();
    const sequence = changes.sequence;
    const urgent = options.urgent();
    if (urgent) { options.checked?.(urgent); return urgent; }
    const registration = new AbortController();
    const combined = AbortSignal.any([signal, registration.signal]);
    // Legacy adapters register before acquisition to preserve the check/wait race guarantee.
    const legacyWake = !environment.changes ? environment.wait(combined).catch(() => {}) : undefined;
    try {
      const snapshot = await options.snapshot(signal, snapshotFloor);
      let reason = options.urgent() ?? (snapshot.fault ? 'fault' : undefined);
      if (!reason && anyEvent && snapshot.events.some(event => event.seq > wait.unreadEventFloor)) reason = 'event';
      if (!reason && eventTypes.size) {
        let slice = snapshot;
        let after = snapshotFloor;
        // Each predicate keeps its own floor, even when mixed with anyEvent.
        // Bounded pages prevent a match behind the first slice being lost.
        for (let page = 0; page < 8; page++) {
          if (slice.events.some(event => event.seq > wait.eventFloor && eventTypes.has(event.kind))) {
            reason = 'event'; break;
          }
          if (!slice.hasMore) break;
          const last = slice.events.at(-1)?.seq;
          if (last === undefined || last <= after || page === 7) { reason = 'event_backlog'; break; }
          after = last;
          slice = await options.snapshot(signal, after);
          const urgent = options.urgent();
          if (urgent || slice.fault) { reason = urgent ?? 'fault'; break; }
        }
      }
      if (!reason) for (const condition of wait.request.until) {
        if (condition.kind === 'jobTerminal' && snapshot.jobs?.some(job =>
          job.id === condition.id && !['pending', 'running', 'stopping'].includes(job.status))) {
          reason = 'jobTerminal'; break;
        }
        if (condition.kind !== 'threshold' && condition.kind !== 'change') continue;
        const value = numeric(profile, snapshot, condition.field);
        if (value === undefined) continue;
        if (condition.kind === 'change') {
          const before = baseline.get(condition.field);
          if (before !== undefined && value !== before && Math.abs(value - before) >= condition.deadband) reason = 'change';
        } else if ({ gt: value > condition.value, gte: value >= condition.value,
          lt: value < condition.value, lte: value <= condition.value }[condition.op]) reason = 'threshold';
        if (reason) break;
      }
      if (wait.deadlineMs !== undefined && now() >= wait.deadlineMs) reason ??= 'review';
      options.checked?.(reason);
      options.checked = undefined;
      if (reason) return reason;
      try {
        await bounded(s => legacyWake ? Promise.race([legacyWake, changes.wait(sequence, s)]) : changes.wait(sequence, s),
          Math.max(1, (wait.deadlineMs ?? (now() + 2147483647)) - now()), combined);
      } catch (error) {
        if (signal.aborted || (error as { code?: string }).code !== 'timeout') throw error;
      }
    } finally { registration.abort(); }
  }
}
