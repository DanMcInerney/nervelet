import test from 'node:test';
import assert from 'node:assert/strict';
import { createPilots } from '../examples/dronerts/pilots.ts';
import { RecordedEnvironment } from '../src/adapters/recorded.ts';
import { Bridge } from '../src/core.ts';
import { delay } from './helpers.ts';
import type { Bundle } from '../src/types.ts';
test('six embedded pilots retain quotas, isolated media/mail/goals, one writer, and independent control',async t=>{
  const pilots=await createPilots();t.after(async()=>{for(const p of pilots){await p.bridge.close();await p.environment.close();}});
  const initial=await Promise.all(pilots.map(p=>p.tools.call('step',{}) as Promise<Bundle>));
  for(let i=0;i<6;i++){assert.equal(initial[i]!.goal.version,100+i);assert.ok(initial[i]!.attachments?.[0]?.id.startsWith(`pilot-${i}:`));assert.equal(pilots[i]!.environment.starts,1);}
  const first=pilots[0]!,second=pilots[1]!;let release:()=>void=()=>{};first.environment.captureGate=new Promise<void>(r=>{release=r;});
  const blocked=first.tools.call('step',{seen:initial[0]!.id});await delay(10);
  second.environment.store.push('radio','only pilot-1');
  const b=await second.tools.call('step',{seen:initial[1]!.id,goalVersion:101,commands:[{id:'c1',kind:'move',args:{target:'tray'}},{id:'c2',kind:'move',args:{target:'elsewhere'}}]}) as Bundle;
  assert.deepEqual(b.results?.map(r=>r.status),['accepted','not_executed']);assert.equal(b.events?.[0]?.data,'only pilot-1');second.environment.tick();assert.equal(second.environment.position,1);
  await assert.rejects(second.tools.call('step',{loopRef:first.bridge.loopRef}),/Forged/);await assert.rejects(second.tools.call('stop',{}),/not exposed/);
  const at=performance.now();assert.equal((await second.bridge.cancel(b.results![0]!.jobId!)).status,'confirmed');assert.ok(performance.now()-at<100);
  release();assert.equal((await blocked as Bundle).events,undefined);
  await first.bridge.close();assert.equal(first.environment.closes,0);assert.equal(second.bridge.status().loop,'active');
});
test('recorded replay accepts matching actions and explicitly rejects divergence',async t=>{
  const command={id:'c1',kind:'set',args:{}};
  const env=new RecordedEnvironment({id:'recording',version:'1',instructions:'Recorded input, acquisition clocks unchanged.',commands:{set:{description:'Recorded action',schema:{type:'object',additionalProperties:false,properties:{}}}}},[
    {snapshot:{events:[],hasMore:false},action:command,receipt:{id:'c1',status:'completed'}},
    {snapshot:{state:{value:7,receivedMs:5,acquired:{clock:'recorded',ms:2},valid:true},events:[],hasMore:false}}
  ]);
  const bridge=new Bridge(env,'Replay');await bridge.start();t.after(()=>bridge.close());const first=await bridge.step();
  const b=await bridge.step({seen:first.id,goalVersion:1,commands:[command]});assert.equal(b.results?.[0]?.status,'completed');assert.equal(b.state?.acquired?.ms,2);
  const divergent=await bridge.step({goalVersion:1,commands:[{...command,id:'c2'}]});assert.equal(divergent.results?.[0]?.reason,'replay_divergence');assert.equal(divergent.state?.value,7);
});
