import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/core.ts';
import { DemoEnvironment } from '../src/adapters/demo.ts';
import { ObservationStore } from '../src/store.ts';
import { delay } from './helpers.ts';
import type { Command, CommandContext, Receipt, Environment, Goal } from '../src/types.ts';

async function setup(t:test.TestContext,options:ConstructorParameters<typeof Bridge>[2]={}) {
  const env=new DemoEnvironment();const bridge=new Bridge(env,'Keep the exact goal.\nSecond line.',options);
  await bridge.start();t.after(()=>bridge.close());const initial=await bridge.step();
  return {env,bridge,initial};
}
test('startup gate, compatible batch, own state and running motion',async t=>{
  const {bridge}=await setup(t);
  const gated=await bridge.step({goalVersion:1,commands:[{id:'c1',kind:'move',args:{durationMs:5000}}]});
  assert.equal(gated.results?.[0]?.reason,'refresh_required');
  const started=await bridge.step({seen:gated.id,goalVersion:1,commands:[{id:'c1',kind:'move',args:{durationMs:5000}},{id:'c2',kind:'set_led',args:{on:true}}]});
  assert.deepEqual(started.results?.map(r=>r.status),['accepted','completed']);
  assert.equal(started.jobs?.[0]?.status,'running');
  assert.deepEqual((started.state?.value as Record<string,unknown>).led,true);
  assert.equal((started.state?.value as Record<string,unknown>).velocity,1);
  const before=started.samples?.temperature?.receivedMs??0;
  await delay(120);
  const after=await bridge.step({seen:started.id});
  assert.ok((after.samples?.temperature?.receivedMs??0)>before);
  assert.ok(Number((after.state?.value as Record<string,unknown>).position)>0);
});
test('batch conflict and invalid arguments have explicit partial outcomes',async t=>{
  const {bridge,initial}=await setup(t);
  const result=await bridge.step({seen:initial.id,goalVersion:1,commands:[
    {id:'c1',kind:'set_led',args:{on:true}},{id:'c2',kind:'set_led',args:{on:false}},
    {id:'c3',kind:'sample',args:{surprise:true}},{id:'c4',kind:'sample',args:{}}
  ]});
  assert.deepEqual(result.results?.map(r=>r.status),['completed','not_executed','rejected','completed']);
  assert.equal((result.state?.value as Record<string,unknown>).led,true);
});
test('bounded receipt history rejects expired IDs instead of replaying',async t=>{
  const {bridge,initial}=await setup(t,{limits:{receiptHistory:1}});
  const command={id:'c1',kind:'set_led',args:{on:true}};
  const first=await bridge.step({seen:initial.id,goalVersion:1,commands:[command]});
  const duplicate=await bridge.step({seen:first.id,goalVersion:1,commands:[command]});
  assert.deepEqual(duplicate.results,first.results);
  const conflict=await bridge.step({goalVersion:1,commands:[{...command,args:{on:false}}]});
  assert.equal(conflict.results?.[0]?.reason,'id_conflict');
  await bridge.step({goalVersion:1,commands:[{id:'c2',kind:'set_led',args:{on:false}}]});
  const expired=await bridge.step({goalVersion:1,commands:[command]});
  assert.equal(expired.results?.[0]?.status,'unknown');
  assert.equal((expired.state?.value as Record<string,unknown>).led,false);
});
test('events survive lost stdout and acknowledgement consumes only included slice',async t=>{
  const {bridge,env,initial}=await setup(t,{limits:{maxBundleBytes:4000}});
  await bridge.step({seen:initial.id});
  for(let i=0;i<8;i++)assert.ok(env.store.push('mail',{text:'x'.repeat(800),index:i}));
  const first=await bridge.step();assert.ok(first.hasMore);assert.ok(first.events?.length);
  const retry=await bridge.step();assert.deepEqual(retry.events,first.events);
  const rest=await bridge.step({seen:retry.id});
  assert.ok(rest.events?.every(e=>e.seq>(first.events?.at(-1)?.seq??0)));
  assert.ok(Buffer.byteLength(JSON.stringify(rest))<=4000);
});
test('three compactions restore exact goal and active arguments without replay',async t=>{
  const {bridge,initial}=await setup(t,{note:async()=> 'Inspect the running job before replacing it.'});
  let current=await bridge.step({seen:initial.id,goalVersion:1,commands:[{id:'c1',kind:'move',args:{durationMs:5000}}]});
  for(let i=0;i<3;i++){
    bridge.refresh('compact');
    current=await bridge.step({seen:current.id,goalVersion:1,commands:[{id:'c2',kind:'set_led',args:{on:true}}]});
    assert.equal(current.results?.[0]?.status,'not_executed');
    assert.equal(current.goal.text,'Keep the exact goal.\nSecond line.');
    assert.equal(current.recovery?.note,'Inspect the running job before replacing it.');
    assert.equal(current.recovery?.instructions,bridge.profileText);
    assert.deepEqual((current.jobs?.[0] as {args:unknown}).args,{durationMs:5000});
    assert.equal(current.jobs?.[0]?.status,'running');
    assert.equal((current.state?.value as Record<string,unknown>).led,false);
    current=await bridge.step({seen:current.id});assert.equal(current.recovery,undefined);
  }
});
test('older recovery acknowledgement cannot clear a newer generation',async t=>{
  const {bridge,initial}=await setup(t);bridge.refresh('compact');
  const current=await bridge.step({seen:initial.id,goalVersion:1,commands:[{id:'c1',kind:'sample',args:{}}]});
  assert.equal(current.results?.[0]?.reason,'refresh_required');
});
test('goal updates cancel old work and require acknowledgement of exact new goal',async t=>{
  const {bridge,initial}=await setup(t);
  const first=await bridge.step({seen:initial.id,goalVersion:1,commands:[{id:'c1',kind:'move',args:{durationMs:5000}}]});
  await bridge.updateGoal('New\nverbatim goal');
  const updated=await bridge.step({seen:first.id,goalVersion:1,commands:[{id:'c2',kind:'sample',args:{}}]});
  assert.equal(updated.goal.text,'New\nverbatim goal');assert.equal(updated.jobs?.[0]?.status,'cancelled');
  assert.equal(updated.results?.[0]?.status,'not_executed');
  const wrong=await bridge.step({seen:updated.id,goalVersion:1,commands:[{id:'c2',kind:'sample',args:{}}]});
  assert.equal(wrong.results?.[0]?.reason,'goal_version');
  const right=await bridge.step({goalVersion:2,commands:[{id:'c2',kind:'sample',args:{}}]});assert.equal(right.results?.[0]?.status,'completed');
});
test('Stop preempts a long wait and rejects further commands',async t=>{
  const {bridge,initial}=await setup(t);await bridge.step({seen:initial.id});
  const start=performance.now();const waiting=bridge.step({waitMs:30000});
  await delay(20);await bridge.stop();const result=await waiting;
  assert.equal(result.loop,'stopped');assert.ok(performance.now()-start<500);
  const denied=await bridge.step({goalVersion:1,commands:[{id:'c1',kind:'sample',args:{}}]});assert.equal(denied.results?.[0]?.reason,'stopped');
});
test('events wake waits; invalid wait and concurrent step are rejected',async t=>{
  const {bridge,env,initial}=await setup(t);await bridge.step({seen:initial.id});
  await assert.rejects(bridge.step({waitMs:-1}),/waitMs/);
  const pending=bridge.step({waitMs:30000});await delay(10);
  await assert.rejects(bridge.step(),/one step/i);
  env.store.push('message','wake');assert.equal((await pending).events?.[0]?.data,'wake');
});
test('environment backpressure is explicit and does not evict unread events',()=>{
  const store=new ObservationStore();for(let i=0;i<256;i++)assert.ok(store.push('event',i));
  assert.equal(store.push('event',256),false);assert.equal(store.snapshot(0).events[0]?.data,0);
  assert.equal(store.snapshot(0).fault,'event_backpressure');
});
test('stale telemetry is invalid, never synthesized as current',()=>{
  const store=new ObservationStore();store.setSample('range',{value:1,receivedMs:performance.now()-1000,valid:true,maxAgeMs:100});
  assert.equal(store.snapshot(0).samples?.range?.valid,false);
});
test('command timeout pauses effects and never blindly retries',async t=>{
  class Slow extends DemoEnvironment {
    count=0;
    override async execute(command:Command,_context:CommandContext):Promise<Receipt>{this.count++;await delay(80);return {id:command.id,status:'completed'};}
  }
  const env=new Slow();const bridge=new Bridge(env,'Test uncertainty',{limits:{operationMs:30}});await bridge.start();t.after(()=>bridge.close());
  const initial=await bridge.step();const result=await bridge.step({seen:initial.id,goalVersion:1,commands:[{id:'c1',kind:'sample',args:{}},{id:'c2',kind:'sample',args:{}}]});
  assert.equal(result.results?.[0]?.status,'unknown');assert.equal(result.results?.[1]?.status,'not_executed');
  await delay(100);assert.equal(env.count,1);assert.equal(result.loop,'paused');
});
test('core supports an API-only environment without robot fields or commands',async t=>{
  const store=new ObservationStore();store.setSample('queue',{value:4,receivedMs:performance.now(),valid:true});
  const env:Environment={profile:{id:'api',version:'1',instructions:'Queue length is a count.',commands:{}},
    start:async()=>{},snapshot:async after=>store.snapshot(after),acknowledge:n=>store.acknowledge(n),wait:s=>store.wait(s),
    execute:async command=>({id:command.id,status:'rejected'}),cancel:async()=>{},stop:async()=>{},close:async()=>{}};
  const bridge=new Bridge(env,'Watch the queue');await bridge.start();t.after(()=>bridge.close());
  const bundle=await bridge.step();assert.equal(bundle.state,undefined);assert.equal(bundle.jobs,undefined);assert.equal(bundle.samples?.queue?.value,4);
});
test('Stop wins a simultaneous goal transition, including durable goal writes',async t=>{
  class SlowStop extends DemoEnvironment {override async stop(){await delay(20);return super.stop();}}
  const saved:Goal[]=[];const bridge=new Bridge(new SlowStop(),'Original',{saveGoal:async goal=>{await delay(5);saved.push(goal);}});
  await bridge.start();t.after(()=>bridge.close());
  const changing=bridge.updateGoal('Replacement');await bridge.stop();await changing;
  assert.equal(bridge.status().loop,'stopped');assert.equal(bridge.status().goal.status,'stopped');assert.equal(saved.at(-1)?.status,'stopped');
});
test('cancel remains available while a capture is blocked',async t=>{
  class SlowCapture extends DemoEnvironment {block=false;override async snapshot(after:number){if(this.block)await delay(100);return super.snapshot(after);}}
  const env=new SlowCapture();const bridge=new Bridge(env,'Capture test');await bridge.start();t.after(()=>bridge.close());
  const first=await bridge.step();const moving=await bridge.step({seen:first.id,goalVersion:1,commands:[{id:'c1',kind:'move',args:{durationMs:5000}}]});
  env.block=true;const pending=bridge.step();const at=performance.now();await bridge.cancel(moving.results![0]!.jobId!);assert.ok(performance.now()-at<50);
  assert.equal((await pending).jobs?.[0]?.status,'cancelled');
});
test('profile changes stop effects instead of mixing schemas and instructions',async t=>{
  const {bridge,env}=await setup(t);env.profile.version='2';await assert.rejects(bridge.step(),/profile_changed/);assert.equal(bridge.status().loop,'paused');
});
test('event storage owns a copy and cannot grow through caller mutation',()=>{
  const store=new ObservationStore();const data={message:'original'};store.push('mail',data);data.message='changed';assert.deepEqual(store.snapshot(0).events[0]?.data,{message:'original'});
});
