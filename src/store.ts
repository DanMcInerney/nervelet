import { bytes, fail, now } from './util.ts';
import type { Event, Json, Sample, Snapshot, Job } from './types.ts';
import { ChangeSignal } from './changes.ts';

/** Optional environment-owned storage. Latest values coalesce; events never silently evict. */
export class ObservationStore {
  readonly changes = new ChangeSignal();
  private samples: Record<string, Sample> = Object.create(null);
  private state?: Sample;
  private events: Event[] = [];
  private sequence = 0;
  private eventBytes = 0;
  private highWaterEvents=0;
  private highWaterBytes=0;
  private listeners = new Set<() => void>();
  fault?: string;
  setSample(name: string, sample: Sample): void {
    if (!/^[a-zA-Z][\w.-]{0,63}$/.test(name)) fail('invalid_input', 'Invalid sample name.');
    const next = { ...this.samples, [name]: structuredClone(sample) };
    if (Object.keys(next).length > 64 || bytes(next) > 8192) fail('capacity', 'Latest samples exceed capacity.');
    this.samples = next;
    this.changes.notify();
  }
  setState(state: Sample): void {
    if (bytes(state) > 4096) fail('capacity', 'Own state exceeds capacity.');
    this.state = structuredClone(state);
    this.changes.notify();
  }
  push(kind: string, data: Json): boolean {
    const event = { seq: this.sequence + 1, kind, atMs: now(), data };
    const size = bytes(event);
    if (size > 2048 || this.events.length >= 256 || this.eventBytes + size > 65536) {
      this.setFault('event_backpressure');
      return false;
    }
    this.sequence++;
    this.events.push(structuredClone(event)); this.eventBytes += size;
    this.highWaterEvents=Math.max(this.highWaterEvents,this.events.length);this.highWaterBytes=Math.max(this.highWaterBytes,this.eventBytes);
    this.wake(); return true;
  }
  setFault(reason: string): void { this.fault = reason.slice(0,256); this.wake(); }
  stats(){return {events:this.events.length,eventBytes:this.eventBytes,highWaterEvents:this.highWaterEvents,highWaterBytes:this.highWaterBytes,samples:Object.keys(this.samples).length};}
  acknowledge(through: number): void {
    this.events = this.events.filter(e => e.seq > through);
    this.eventBytes = this.events.reduce((sum,e) => sum + bytes(e),0);
    // Faults require explicit adapter reconciliation; acknowledging mail alone is not recovery.
  }
  snapshot(after: number, jobs: Job[] = []): Snapshot {
    const events = this.events.filter(e => e.seq > after).slice(0,64);
    const dated = (sample: Sample): Sample => ({ ...structuredClone(sample), ...(sample.maxAgeMs !== undefined && now() - sample.receivedMs > sample.maxAgeMs ? { valid: false, reason: 'stale_receipt' } : {}) });
    return {
      ...(this.state ? { state: dated(this.state) } : {}),
      ...(Object.keys(this.samples).length ? { samples: Object.fromEntries(Object.entries(this.samples).map(([k,v]) => [k,dated(v)])) } : {}),
      ...(jobs.length ? { jobs: structuredClone(jobs) } : {}),
      events: structuredClone(events), hasMore: this.events.some(e => e.seq > (events.at(-1)?.seq ?? after)),
      ...(this.fault ? { fault: this.fault } : {})
    };
  }
  wake(): void { this.changes.notify(); for (const listener of [...this.listeners]) listener(); }
  wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve,reject) => {
      const finish = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => { this.listeners.delete(finish); signal.removeEventListener('abort',abort); };
      if (signal.aborted) { reject(signal.reason); return; }
      this.listeners.add(finish); signal.addEventListener('abort',abort,{ once:true });
    });
  }
}
