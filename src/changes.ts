import type { Changes } from './types.ts';

/** Synchronous registration plus a monotonic sequence closes the check/subscribe race. */
export class ChangeSignal implements Changes {
  sequence = 0;
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  notify(): void { this.sequence++; for (const listener of [...this.listeners]) listener(); }
  wait(after: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const unsubscribe = this.subscribe(done);
      const cleanup = () => { unsubscribe(); signal.removeEventListener('abort', abort); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else if (after !== this.sequence) done();
    });
  }
}
