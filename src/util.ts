import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export class NerveletError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function fail(code: string, message: string): never { throw new NerveletError(code, message); }
export const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export const now = () => Math.round(performance.now());
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function boundedText(value: unknown, limit: number, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit) fail('invalid_input', `${name} must be nonempty and at most ${limit} bytes.`);
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
/** The adapter must honor abort before effects; timeout never implies an effect did not occur. */
export async function bounded<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new Error('Cancelled.'));
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(new NerveletError('timeout', `Operation exceeded ${ms} ms; reconcile uncertain effects.`)), ms);
    });
    return await Promise.race([fn(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    parent?.removeEventListener('abort', abort);
  }
}
/** Abort a logical wait without inventing or periodically extending a deadline. */
export function withAbort<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const cleanup=()=>signal.removeEventListener('abort',abort);
    const abort=()=>{cleanup();reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
    if(signal.aborted)abort();
  });
}
export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}
export async function readBounded(path: string, limit: number): Promise<string> {
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let total=0;
    while(total<buffer.length){const {bytesRead}=await handle.read(buffer,total,buffer.length-total,total);if(!bytesRead)break;total+=bytesRead;}
    if (total > limit) fail('capacity', `${path} exceeds ${limit} bytes.`);
    return buffer.subarray(0, total).toString('utf8');
  } finally { await handle.close(); }
}
export async function optionalText(path: string, limit: number): Promise<string | undefined> {
  try { return await readBounded(path, limit); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
