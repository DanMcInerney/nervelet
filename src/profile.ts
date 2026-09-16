import { types } from 'node:util';
import type { Profile } from './types.ts';
import { fail, stable } from './util.ts';

// Only this module can establish the proof. Freezing an arbitrary caller object
// (or attaching a public brand to one) cannot select the identity-only path.
const immutableProfiles = new WeakSet<object>();

/** Copy and freeze a plain JSON-data profile, rejecting accessors without invoking them. */
export function immutableProfile(profile: Profile): Profile {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    fail('invalid_profile', 'Immutable profiles require a plain object root.');
  }
  if (immutableProfiles.has(profile)) return profile;
  const ancestors = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || types.isProxy(value)) {
      fail('invalid_profile', 'Immutable profiles require finite plain JSON data, without proxies or accessors.');
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) {
      fail('invalid_profile', 'Immutable profiles require plain objects and arrays.');
    }
    if (depth > 128 || ancestors.has(value)) fail('invalid_profile', 'Immutable profile is cyclic or too deeply nested.');
    ancestors.add(value);
    // Null prototypes prevent later additions to Object.prototype from changing
    // missing optional fields or injecting inherited getters into the proof.
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (array && keys.length !== (value as unknown[]).length + 1) {
      fail('invalid_profile', 'Immutable profile arrays must be dense and have no extra properties.');
    }
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = typeof key === 'string' ? descriptors[key]! : undefined;
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('invalid_profile', 'Immutable profiles cannot contain symbols, hidden properties or accessors.');
      }
      if (array && !/^(0|[1-9][0-9]*)$/.test(key as string)) {
        fail('invalid_profile', 'Immutable profile arrays cannot have extra properties.');
      }
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1), enumerable: true, writable: false, configurable: false
      });
    }
    ancestors.delete(value);
    return Object.freeze(result);
  }
  const result = copy(profile, 0) as Profile;
  immutableProfiles.add(result);
  return result;
}

/** One canonical profile for schemas, instructions, fields and resource claims. */
export class ProfileGuard {
  readonly profile: Profile;
  private readonly identityOnly: boolean;
  private readonly digest?: string;

  constructor(profile: Profile) {
    this.profile = profile;
    this.identityOnly = immutableProfiles.has(profile);
    if (!this.identityOnly) this.digest = stable(profile);
  }

  unchanged(profile: Profile): boolean {
    if (this.identityOnly) return profile === this.profile;
    // Legacy equivalent replacements remain compatible, but cannot hide a later
    // mutation of the canonical object still used by validators and instructions.
    return stable(profile) === this.digest && (profile === this.profile || stable(this.profile) === this.digest);
  }
}
