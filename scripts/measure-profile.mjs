import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { immutableProfile, ProfileGuard } from '../dist/profile.js';

// Pass an actual application profile captured without an inference session.
// JSON input keeps this library benchmark independent of application dependencies.
const argument = process.argv.indexOf('--profile');
if (argument < 0 || !process.argv[argument + 1]) {
  throw new Error('Usage: node scripts/measure-profile.mjs --profile PATH_TO_PROFILE_JSON');
}
const source = resolve(process.argv[argument + 1]);
const profile = JSON.parse(await readFile(source, 'utf8'));
let proofObjects = 0;
const getDescriptors = Object.getOwnPropertyDescriptors;
Object.getOwnPropertyDescriptors = value => { proofObjects++; return getDescriptors(value); };
const proofStart = performance.now();
let frozen;
try { frozen = immutableProfile(profile); }
finally { Object.getOwnPropertyDescriptors = getDescriptors; }
const proofMs = performance.now() - proofStart;
const mutableGuard = new ProfileGuard(profile), immutableGuard = new ProfileGuard(frozen);
const iterations = 10000, rounds = 7;
let sink = 0;

function countTraversals(guard, value) {
  const original = Object.keys;
  let rootTraversals = 0;
  Object.keys = candidate => { if (candidate === value) rootTraversals++; return original(candidate); };
  try { for (let i = 0; i < iterations; i++) sink += Number(guard.unchanged(value)); }
  finally { Object.keys = original; }
  return { guardChecks: iterations, rootTraversals };
}

function timing(guard, value) {
  for (let i = 0; i < 3000; i++) sink += Number(guard.unchanged(value));
  const samplesUs = [];
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) sink += Number(guard.unchanged(value));
    samplesUs.push((performance.now() - start) * 1000 / iterations);
  }
  return { samplesUs, medianUs: [...samplesUs].sort((a, b) => a - b)[Math.floor(rounds / 2)] };
}

const mutable = { ...countTraversals(mutableGuard, profile), ...timing(mutableGuard, profile) };
const immutable = { ...countTraversals(immutableGuard, frozen), ...timing(immutableGuard, frozen) };
const result = {
  node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
  profileSource: source, profileId: profile.id, profileVersion: profile.version,
  profileJsonBytes: Buffer.byteLength(JSON.stringify(profile)), commands: Object.keys(profile.commands).length,
  proof: { plainObjectsAndArraysValidatedAndFrozen: proofObjects, elapsedMs: proofMs },
  iterations, rounds, mutable, immutable,
  medianSavingUsPerCheck: mutable.medianUs - immutable.medianUs,
  sink,
  limitations: 'Integrity-check CPU only. Construction proof is measured separately. Root traversals are instrumented actual calls to Object.keys on the profile root, outside timing runs. No camera, native transport, inference or timeout improvement is inferred.'
};
await mkdir('.runtime', { recursive: true });
await writeFile('.runtime/profile-measurements.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
