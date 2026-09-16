import { mkdir, writeFile } from 'node:fs/promises';
import { Bridge, ObservationStore } from '../dist/index.js';
import { performance } from 'node:perf_hooks';

// No model, transport or domain work. Same 64-event observation on every boundary.
const store=new ObservationStore();let lastTrace;
const environment={profile:{id:'packing-fixture',version:'1',instructions:'Dated API events.',commands:{}},changes:store.changes,
  async start(){},async close(){},async snapshot(after){return store.snapshot(after);},acknowledge(n){store.acknowledge(n);},wait(s){return store.wait(s);},
  async execute(){throw new Error('No commands');},async cancel(){return {status:'confirmed'};},async stop(){return {status:'confirmed'};}};
const bridge=new Bridge(environment,'Measure lossless event packing.',{limits:{maxBundleBytes:65536},trace:e=>{if(e.type==='assembly')lastTrace=e;}});
await bridge.start();const first=await bridge.step({schemaVersion:2});await bridge.step({seen:first.id});
for(let i=0;i<64;i++)store.push('fixture',{i,text:'🐉"\\\nλ'.repeat(20)});
await bridge.step({schemaVersion:2});const specimen=await bridge.step({schemaVersion:2});
const actualWork={eventSerializations:lastTrace.eventSerializations,serializedBytes:lastTrace.serializedBytes};
const {events,hasMore,...base}=specimen;
// Exact original growing-bundle algorithm; count all bytes materialized by JSON.stringify.
function legacy(){let bytes=0,eventVisits=0;const size=v=>{const s=JSON.stringify(v);bytes+=Buffer.byteLength(s);return Buffer.byteLength(s);};
  size(base);const included=[];for(const event of events){eventVisits+=included.length+1;if(size({...base,events:[...included,event],hasMore:true})>65536)break;included.push(event);}size({...base,events:included});
  return {eventSerializations:eventVisits,serializedBytes:bytes,temporaryEventArrays:events.length};}
const oldWork=legacy();
for(let i=0;i<100;i++)await bridge.step({schemaVersion:2});
global.gc?.();const before=process.memoryUsage(),cpu=process.cpuUsage(),start=performance.now();let peakHeap=before.heapUsed;
const iterations=1000;
for(let i=0;i<iterations;i++){await bridge.step({schemaVersion:2});if(i%25===0)peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);}
const elapsedMs=performance.now()-start,cpuUsed=process.cpuUsage(cpu);global.gc?.();const after=process.memoryUsage();await bridge.close();
const result={node:process.version,platform:process.platform,events:64,iterations,actualWork,legacyWork:oldWork,
  serializedByteReductionPercent:100*(1-actualWork.serializedBytes/oldWork.serializedBytes),
  fullBridgeElapsedMs:elapsedMs,fullBridgeCpuMs:(cpuUsed.user+cpuUsed.system)/1000,heapBefore:before.heapUsed,heapAfter:after.heapUsed,peakSampledHeap:peakHeap,rss:after.rss,
  limitations:'Serialized bytes are a string-allocation work proxy, not allocator counts. CPU is the complete new Bridge workload, not a measured old/new CPU comparison. No model latency, native inference, network, image encoding or private reasoning measured.'};
await mkdir('.runtime',{recursive:true});await writeFile('.runtime/packing-measurements.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
