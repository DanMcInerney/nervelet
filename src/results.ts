import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { Command, Json } from './types.ts';
import { fail, stable } from './util.ts';

/** Stable wire identity, shared by the bridge and authoritative executors. */
export function commandDigest(command: Command): string {
  return createHash('sha256').update(stable(command)).digest('hex');
}

const retained = new WeakMap<object, number>();

/** Retained-data charge: UTF-16 strings plus container, pooled key and slot overhead.
 * This is an explicit allocation budget, not a measurement of a particular JS engine's heap.
 * Receipt/executor/profile metadata must be budgeted separately by the embedding host. */
export function resultBytes(data: Json): number {
  return inspect(data, false).size;
}

/** Own a deeply frozen JSON copy once. Already-owned payloads are shared without copying. */
export function immutableResult(data: Json): Json {
  return inspect(data, true).value;
}

/** Payload's serialized fragment charge inside a JSON-encoded text result. */
export function resultDeliveryBytes(data: Json): number {
  resultBytes(data);
  return Buffer.byteLength(JSON.stringify(JSON.stringify(data))) - 2;
}

function inspect(data: Json, copy: boolean, parents = new Set<object>(), depth = 0, keys = new Map<string, string>()): { value: Json; size: number } {
  if (depth > 64) fail('invalid_adapter', 'Result JSON nesting exceeds 64 levels.');
  if (data === null) return { value: data, size: 8 };
  if (typeof data === 'string') return { value: data, size: 24 + 2 * data.length };
  if (typeof data === 'boolean') return { value: data, size: 8 };
  if (typeof data === 'number' && Number.isFinite(data)) return { value: data, size: 16 };
  if (typeof data !== 'object' || types.isProxy(data)) fail('invalid_adapter', 'Result data must be finite plain JSON without proxies.');
  const cached = retained.get(data);
  if (cached !== undefined) return { value: data, size: cached };
  if (parents.has(data)) fail('invalid_adapter', 'Result data cannot contain cycles.');
  const array = Array.isArray(data);
  const prototype = Object.getPrototypeOf(data);
  if ((!array && prototype !== Object.prototype && prototype !== null) || (array && prototype !== Array.prototype)) {
    fail('invalid_adapter', 'Result data must use plain JSON containers.');
  }
  parents.add(data);
  const target: Json[] | { [key: string]: Json } = array ? [] : {};
  let size = 64;
  let elements = 0;
  for (const key of Reflect.ownKeys(data)) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') fail('invalid_adapter', 'Result data cannot contain symbol properties.');
    const descriptor = Object.getOwnPropertyDescriptor(data, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
        (array && key !== String(elements++))) fail('invalid_adapter', 'Result data cannot contain getters, hidden fields or sparse arrays.');
    let canonicalKey = keys.get(key);
    if (!array && canonicalKey === undefined) {
      canonicalKey = key;
      keys.set(key, key);
      // Equal property names use a single canonical key for the owned tree.
      // Its string/header and intern-table entry remain charged for its lifetime.
      size += 40 + 2 * key.length;
    }
    const child = inspect(descriptor.value, copy, parents, depth + 1, keys);
    size += 16 + child.size;
    if (copy) Object.defineProperty(target, canonicalKey ?? key, { value: child.value, enumerable: true, writable: true, configurable: true });
  }
  if (array && elements !== data.length) fail('invalid_adapter', 'Result data cannot contain sparse arrays.');
  parents.delete(data);
  if (!copy) return { value: data, size };
  Object.freeze(target);
  // A subtree shares its parent's key charge; only whole roots can cache cost.
  if (depth === 0) retained.set(target, size);
  return { value: target, size };
}
