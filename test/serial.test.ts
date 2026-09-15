import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { SerialEnvironment } from '../src/adapters/serial.ts';
import { demoProfile } from '../src/adapters/demo.ts';
import { Bridge } from '../src/core.ts';
import { delay } from './helpers.ts';

class Device extends Duplex {
  commands:Record<string,unknown>[]=[];led=false;seq=0;clock='board:1';auto=true;
  override _read(){}
  send(packet:unknown){this.push(JSON.stringify(packet)+'\n');}
  sample(){this.send({type:'sample',clock:this.clock,seq:++this.seq,atMs:this.seq*100,valid:true,state:{ledOutput:this.led},samples:{temperatureC:23.1}});}
  override _write(chunk:Buffer,_encoding:BufferEncoding,done:(error?:Error|null)=>void){
    const packet=JSON.parse(chunk.toString());this.commands.push(packet);
    if(this.auto){
      if(packet.type==='stop'||packet.type==='cancel'){this.led=false;this.send({type:'control',id:packet.id,ok:true});this.sample();}
      if(packet.type==='command'){
        if(packet.kind==='move')this.push(JSON.stringify({type:'receipt',id:packet.id,status:'accepted',jobId:'job:1'})+'\n'+JSON.stringify({type:'job',id:'job:1',status:'completed'})+'\n');
        else{this.led=Boolean(packet.args.on);this.send({type:'receipt',id:packet.id,status:'completed'});this.sample();}
      }
    }done();
  }
}
async function setup(t:test.TestContext){
  const device=new Device();const env=new SerialEnvironment({stream:device,profile:demoProfile,staleMs:500});const bridge=new Bridge(env,'Serial test',{limits:{operationMs:200}});
  const opening=bridge.start();device.sample();await opening;
  t.after(async()=>{try{await bridge.close();}catch{await env.close();}});
  const initial=await bridge.step();return {bridge,device,env,initial};
}
test('serial startup reconciles with Stop and scopes command IDs to bridge epoch',async t=>{
  const {bridge,device,initial}=await setup(t);assert.equal(device.commands[0]?.type,'stop');
  const result=await bridge.step({seen:initial.id,goalVersion:1,commands:[{id:'c1',kind:'set_led',args:{on:true}}]});
  assert.equal(result.results?.[0]?.status,'completed');assert.equal((result.state?.value as Record<string,unknown>).ledOutput,true);
  assert.equal(device.commands.find(c=>c.type==='command')?.id,`${bridge.epoch}:c1`);
  assert.equal(result.samples?.temperatureC?.acquired?.clock,'board:1');
});
test('receipt and immediate job completion in the same serial chunk are ordered',async t=>{
  const {bridge,initial}=await setup(t);
  const result=await bridge.step({seen:initial.id,goalVersion:1,commands:[{id:'c1',kind:'move',args:{durationMs:100}}]});
  assert.equal(result.results?.[0]?.status,'accepted');assert.equal(result.jobs?.[0]?.status,'completed');assert.equal(result.fault,undefined);
});
test('malformed/oversized frames fault explicitly and stop the device',async t=>{
  const {bridge,device}=await setup(t);device.push('x'.repeat(9000));await delay(10);
  const result=await bridge.step();assert.equal(result.fault,'invalid_serial_frame');assert.ok(device.commands.filter(c=>c.type==='stop').length>=2);
});
test('device clock reset blocks new effects',async t=>{
  const {bridge,device,initial}=await setup(t);device.clock='board:2';device.seq=0;device.sample();
  const result=await bridge.step({seen:initial.id,goalVersion:1,commands:[{id:'c1',kind:'sample',args:{}}]});
  assert.equal(result.fault,'device_clock_reset_or_out_of_order');assert.equal(result.results?.[0]?.status,'not_executed');
});
test('serial data timeout prevents stale commands and heartbeat is independent of model',async t=>{
  const {bridge,device}=await setup(t);await delay(800);
  const result=await bridge.step();assert.equal(result.fault,'stale_serial_telemetry');
  assert.ok(device.commands.some(c=>c.type==='heartbeat'));
});
test('invalid device sensing blocks effects and cancellation preserves completed jobs',async t=>{
  const {bridge,device,initial}=await setup(t);
  const moved=await bridge.step({seen:initial.id,goalVersion:1,commands:[{id:'c1',kind:'move',args:{durationMs:100}}]});
  await bridge.cancel(moved.jobs![0]!.id);assert.equal((await bridge.step()).jobs?.[0]?.status,'completed');
  device.send({type:'sample',clock:device.clock,seq:++device.seq,atMs:9999,valid:false,state:{ledOutput:false},samples:{temperatureC:null}});
  const invalid=await bridge.step({goalVersion:1,commands:[{id:'c2',kind:'set_led',args:{on:true}}]});
  // The fake device sends a valid sample after emergency Stop; that does not clear the fault.
  assert.equal(invalid.fault,'invalid_serial_telemetry');assert.equal(invalid.results?.[0]?.status,'not_executed');
  assert.equal(device.commands.filter(c=>c.type==='command').length,1);
});

test('old control receipts cannot cross connections; terminal jobs cannot restart',async t=>{
  const first=await setup(t);const second=await setup(t);
  assert.notEqual(first.device.commands[0]?.id,second.device.commands[0]?.id);
  await first.bridge.step({seen:first.initial.id,goalVersion:1,commands:[{id:'c1',kind:'move',args:{durationMs:100}}]});
  first.device.send({type:'job',id:'job:1',status:'running'});
  const bundle=await first.bridge.step();assert.equal(bundle.fault,'terminal_job_restarted');assert.equal(bundle.jobs?.[0]?.status,'completed');
});
