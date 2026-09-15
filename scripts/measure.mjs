import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Bridge, Supervisor } from '../dist/index.js';
import { createDemoEnvironment } from '../dist/adapters/demo.js';

const trace=[];const environment=createDemoEnvironment();
const bridge=new Bridge(environment,'Measure the simulated bench.',{trace:e=>{trace.push(e);if(trace.length>128)trace.shift();}});
await bridge.start();const startup=await bridge.step({schemaVersion:2});let current=await bridge.step({schemaVersion:2,seen:startup.id});
const ordinaryBytes=Buffer.byteLength(JSON.stringify(current));
global.gc?.();const before=process.memoryUsage();const delayMonitor=monitorEventLoopDelay({resolution:10});delayMonitor.enable();
const started=performance.now();let peakRss=before.rss;
for(let i=0;i<3000;i++){environment.store.push('fixture',{i});current=await bridge.step({schemaVersion:2,seen:current.id});if(i%50===0){await delay(1);peakRss=Math.max(peakRss,process.memoryUsage().rss);}}
const elapsedMs=performance.now()-started;global.gc?.();const after=process.memoryUsage();
await bridge.step({schemaVersion:2,seen:current.id,wait:{until:[{kind:'event',type:'never'}],reviewMs:600000}},undefined,{waitMode:'park'});
const stopStart=performance.now();await bridge.stop();await bridge.parked().ready;const stopMs=performance.now()-stopStart;
await bridge.close();delayMonitor.disable();
let context,calls=0,parked;const onPark=new Promise(r=>{parked=r;});
const idleEnvironment=createDemoEnvironment(),idleBridge=new Bridge(idleEnvironment,'Wait for fixture mail.');
const driver={capabilities:{name:'measurement-fake',mode:'managed',parking:true,toolHoldMs:0,images:'unsupported',recovery:'events',usage:[],qualification:'fake'},async open(c){context=c;},async interrupt(){},async close(){},async turn(b){calls++;if(calls===1){await context.handlers.call('step',{seen:b.id,wait:{until:[{kind:'event',type:'fixture'}],reviewMs:600000}});parked();}else await context.handlers.call('stop',{});return {status:'ended'};}};
const supervisor=new Supervisor(idleBridge,driver);const running=supervisor.run();await onPark;const idleAt=performance.now();
const quietMs=Number(process.env.NERVELET_MEASURE_MS ?? 1000);if(!Number.isSafeInteger(quietMs)||quietMs<1000||quietMs>3600000)throw new Error('NERVELET_MEASURE_MS must be 1000..3600000.');
const idleHeapSamples=[];
while(performance.now()-idleAt<quietMs){global.gc?.();idleHeapSamples.push({atMs:Math.round(performance.now()-idleAt),heapUsed:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss});await delay(Math.min(10000,quietMs-(performance.now()-idleAt)));}
global.gc?.();idleHeapSamples.push({atMs:Math.round(performance.now()-idleAt),heapUsed:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss});
const quietCalls=calls-1;idleEnvironment.store.push('fixture','wake');await running;
async function disk(path){let total=0;for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);total+=e.isDirectory()?await disk(p):(await stat(p)).size;}return total;}
const result={node:process.version,platform:process.platform,iterations:3000,elapsedMs,startupBytes:Buffer.byteLength(JSON.stringify(startup)),ordinaryBytes,lastBundleBytes:Buffer.byteLength(JSON.stringify(current)),heapBefore:before.heapUsed,heapAfter:after.heapUsed,heapDelta:after.heapUsed-before.heapUsed,idleRss:before.rss,peakRss,eventLoopDelayP99Ms:delayMonitor.percentile(99)/1e6,eventLoopDelayMaxMs:delayMonitor.max/1e6,stopMs,quietWindowMs:performance.now()-idleAt,periodicModelTurns:quietCalls,periodicTurnsPerHourEstimate:quietCalls*3600000/quietMs,idleHeapSamples,usefulWakeTurns:calls-1,model:'fake; no inference',sdkSubprocessRss:null,developmentNodeModulesBytes:await disk('node_modules'),traceEvents:trace.length,queue:environment.store.stats(),bridge:bridge.stats()};
await mkdir('.runtime',{recursive:true});await writeFile('.runtime/measurements.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
