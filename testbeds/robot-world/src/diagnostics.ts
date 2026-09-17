import { randomUUID } from 'node:crypto';

export const channels = ['controller', 'protocol', 'sensors', 'bridge'] as const;
export type DiagnosticChannel = typeof channels[number];
export interface DiagnosticEvent {
  id: number; channel: DiagnosticChannel; simMs: number; wallMs: number;
  kind: string; label: string; data: unknown; truncated: boolean;
}

/** Diagnostic copies only: never acknowledge, gate, or mutate domain evidence. */
export function diagnosticCopy(value: unknown, maxBytes = 8192): { data: unknown; truncated: boolean } {
  let truncated = false, nodes = 0;
  const seen = new WeakSet<object>();
  function visit(v: unknown, depth = 0): unknown {
    if (++nodes > 6000 || depth > 16) { truncated = true; return '[diagnostic depth/node limit]'; }
    if (typeof v === 'string') {
      const safe = v.replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [redacted]').replace(/\bsk-[\w-]{12,}/g, '[redacted]');
      if (safe.length > maxBytes) { truncated = true; return safe.slice(0, maxBytes); }
      return safe;
    }
    if (typeof v === 'bigint') return String(v);
    if (!v || typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]'; seen.add(v);
    if (Array.isArray(v)) { if (v.length > 1000) truncated = true; return v.slice(0, 1000).map(x => visit(x, depth + 1)); }
    const entries = Object.entries(v); if (entries.length > 256) truncated = true;
    return Object.fromEntries(entries.slice(0, 256).map(([key, item]) => [key,
      /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|http_headers)$/i.test(key) ? '[redacted]' : visit(item, depth + 1)]));
  }
  const data = visit(value), encoded = JSON.stringify(data ?? null);
  if (Buffer.byteLength(encoded) <= maxBytes) return { data, truncated };
  // A readable, explicitly incomplete preview; never present it as complete JSON.
  return { data: { preview: Buffer.from(encoded).subarray(0, maxBytes - 160).toString('utf8'), note: 'Payload truncated in diagnostic copy.' }, truncated: true };
}

export class Diagnostics {
  readonly runId = randomUUID();
  readonly startedAt = new Date().toISOString();
  private startedWall = performance.now();
  private next = 0;
  private queues: Record<DiagnosticChannel, DiagnosticEvent[]> = { controller: [], protocol: [], sensors: [], bridge: [] };
  readonly dropped: Record<DiagnosticChannel, number> = { controller: 0, protocol: 0, sensors: 0, bridge: 0 };
  readonly capacity: number;
  constructor(capacity = 240) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new Error('invalid_diagnostic_capacity');
    this.capacity = capacity;
  }
  record(channel: DiagnosticChannel, kind: string, label: string, data: unknown, simMs: number) {
    try {
      const copy = diagnosticCopy(data), queue = this.queues[channel];
      if (queue.length >= this.capacity) { queue.shift(); this.dropped[channel]++; }
      queue.push({ id: ++this.next, channel, kind: kind.slice(0, 100), label: label.slice(0, 180), simMs,
        wallMs: performance.now() - this.startedWall, ...copy });
    } catch { this.dropped[channel]++; } // A diagnostic failure cannot change a robot effect.
  }
  read(after = 0, runId: string = this.runId, limit = 120) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_diagnostic_cursor');
    const reset = runId !== this.runId || after > this.next; if (reset) after = 0;
    const available = channels.flatMap(c => this.queues[c]).filter(e => e.id > after).sort((a, b) => a.id - b.id);
    const events: DiagnosticEvent[] = []; let bytes = 0;
    for (const event of available) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length >= limit || bytes + size > 196608) break;
      events.push(event); bytes += size;
    }
    return { runId: this.runId, startedAt: this.startedAt, reset, cursor: events.at(-1)?.id ?? after, latest: this.next,
      hasMore: events.length < available.length, dropped: { ...this.dropped }, retained: Object.fromEntries(channels.map(c => [c, this.queues[c].length])), events };
  }
  export() {
    return { runId: this.runId, startedAt: this.startedAt, dropped: { ...this.dropped },
      events: channels.flatMap(c => this.queues[c]).sort((a, b) => a.id - b.id) };
  }
}
