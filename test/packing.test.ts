import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, createHandlers, request, serve, toolResult } from '../src/index.ts';
import { serveLocalMcp } from '../src/transports/mcp.ts';
import { bytes } from '../src/util.ts';
import type { Bundle, Command, Receipt, Trace } from '../src/index.ts';
import { Feed } from './attention-fixture.ts';
import { waitInstructions } from '../src/schemas.ts';
import { temp } from './helpers.ts';

test('configurable request/command bytes use exact UTF-8 including escaping and preserve default ceilings',async t=>{
  const env=new Feed(),command={id:'c1',kind:'publish',args:{text:'λ🐉"\\\n'.repeat(9000)}};
  const input={schemaVersion:2 as const,goalVersion:1,commands:[command]};
  const limits={maxRequestBytes:bytes(input),maxCommandBytes:bytes(command)};
  const b=new Bridge(env,'Goal',{limits});await b.start();t.after(()=>b.close());const first=await b.step();await b.step({seen:first.id});
  assert.equal((await createHandlers(b).call('step',input) as Bundle).results?.[0]?.status,'completed');
  await assert.rejects(b.step({...input,commands:[{...command,id:'c2',args:{text:command.args.text+'x'}}]}),/request byte limit/);
  await assert.rejects(createHandlers(b).call('step',{...input,checkpoint:'x'}),/request byte limit/);
  const defaults=new Bridge(new Feed(),'Goal');assert.equal(defaults.limits.maxRequestBytes,16384);assert.equal(defaults.limits.maxCommandBytes,4096);
  await assert.rejects(defaults.step(input),/request byte limit/);assert.equal(env.effects,1);
  const small=new Bridge(new Feed(),'Goal',{limits:{maxRequestBytes:bytes(input)+10,maxCommandBytes:bytes(command)-1}});
  await assert.rejects(small.step(input),/Command batch/);
});

test('omitting retained arguments keeps payload deduplication and never fabricates reconciliation arguments',async t=>{
  let reconciled:Command|undefined;
  class Uncertain extends Feed {
    override async execute(c:Command):Promise<Receipt>{this.effects++;return {id:c.id,status:'unknown'};}
    async reconcile(c:Command):Promise<Receipt>{reconciled=c;return {id:c.id,status:'completed'};}
  }
  const env=new Uncertain(),b=new Bridge(env,'Goal',{retainCommandArguments:false});await b.start();t.after(()=>b.close());const first=await b.step();
  const command={id:'c1',kind:'publish',args:{payload:'retain only in executor'}};
  await b.step({seen:first.id,goalVersion:1,commands:[command]});await assert.rejects(b.reconcile('c1'),/retained arguments/);
  assert.equal(reconciled,undefined);assert.equal(b.stats().unresolved,1);
  assert.equal((await b.step({commands:[command]})).results?.[0]?.status,'unknown');
  assert.equal((await b.step({commands:[{...command,args:{}}]})).results?.[0]?.reason,'id_conflict');assert.equal(env.effects,1);
});

test('large commands cross IPC and HTTP envelopes; handlers retain the same request ceiling',async t=>{
  const cwd=await temp(t),env=new Feed(),b=new Bridge(env,'Goal',{limits:{maxRequestBytes:150000,maxCommandBytes:140000}});
  const ipc=await serve(b,{cwd});t.after(()=>ipc.close());const h=createHandlers(b),http=await serveLocalMcp(h);t.after(()=>http.close());
  const initial=await request<Bundle>({method:'step'},{cwd});
  const command={id:'c1',kind:'publish',args:{text:'🐉"'.repeat(12000)}};
  const result=await request<Bundle>({method:'step',params:{seen:initial.id,goalVersion:1,commands:[command]}},{cwd});assert.equal(result.results?.[0]?.status,'completed');
  const response=await fetch(http.url,{method:'POST',headers:{Authorization:`Bearer ${http.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'step',arguments:{goalVersion:1,commands:[{...command,id:'c2'}]}}})});
  assert.equal(response.status,200);const wire=await response.json() as {result:{content:{text:string}[]}};assert.equal(JSON.parse(wire.result.content[0]!.text).results[0].status,'completed');assert.equal(env.effects,2);
  const tooLarge=await fetch(http.url,{method:'POST',headers:{Authorization:`Bearer ${http.token}`},body:'x'.repeat(154097)});assert.equal(tooLarge.status,413);
});

test('canonical compact instructions apply to reminders and recovery and budget the rendered tool envelope',async t=>{
  const env=new Feed();env.profile.instructions='Exact operating instructions "λ"\n';
  env.profile.commands.publish!.schema={type:'object',properties:{data:{type:'string',description:'TRANSPORT_SCHEMA_ONLY'.repeat(40)}}};
  const b=new Bridge(env,'Exact\ngoal');await b.start();t.after(()=>b.close());
  const h=createHandlers(b,{stop:false,waitMode:'hold',instructions:{refreshTools:['observe','exchange'],commandSchemas:'transport'}});
  const first=await h.call('step',{}) as Bundle;
  assert.equal(first.recovery!.instructions,h.instructions);assert.ok(first.rule.includes('observe, exchange'));assert.ok(!first.rule.includes('parked'));
  assert.ok(!h.instructions.includes('TRANSPORT_SCHEMA_ONLY'));assert.ok(h.instructions.includes('Exact operating instructions'));
  assert.ok(JSON.stringify(h.tools).includes('TRANSPORT_SCHEMA_ONLY'));assert.ok(!h.instructions.includes('Explicit stop ends'));
  b.refresh('fixture');const recovery=await h.call('step',{seen:first.id}) as Bundle;assert.equal(recovery.recovery!.instructions,h.instructions);
  assert.equal(recovery.goal.text,'Exact\ngoal');assert.ok(bytes(toolResult(recovery))<=b.limits.maxRecoveryBytes);
  // Keep the same envelope pressure while accounting for the new canonical wait contract.
  const longNames=['"\\λ'.repeat(30)];const constrained=new Bridge(new Feed(),'Goal',{limits:{maxRecoveryBytes:1800+bytes(waitInstructions)}});
  await assert.rejects(createHandlers(constrained,{instructions:{refreshTools:longNames}}).call('step',{}),/capacity/);
});

test('incremental packing matches exhaustive Unicode/escaping reference; included FIFO acknowledgements and work stay linear',async t=>{
  for(const encoding of ['json','tool-result'] as const) {
    const traces:Trace[]=[],env=new Feed(),b=new Bridge(env,'Goal',{limits:{maxBundleBytes:2700},trace:e=>traces.push(e)});await b.start();t.after(()=>b.close());
    const first=await b.step({schemaVersion:2});await b.step({seen:first.id});
    for(let i=0;i<40;i++)env.store.push('event',{i,text:['🐉','"\\\n','\ud800','λ','\u0000'][i%5]!.repeat(10)});
    const source=(await env.snapshot(0)).events;
    const result=await b.step({schemaVersion:2},undefined,{textEncoding:encoding});
    const {events:_events,hasMore:_more,...base}=result;const expected=[];
    for(const event of source){const e={...event,id:`${b.epoch}:e${event.seq}`,redelivered:false};const candidate={...base,events:[...expected,e],hasMore:true};if(bytes(encoding==='json'?candidate:toolResult(candidate))>2700)break;expected.push(e);}
    assert.deepEqual(result.events,expected);assert.equal(result.hasMore,true);
    const trace=traces.findLast(e=>e.type==='assembly')!;assert.equal(trace.textBytes,bytes(encoding==='json'?result:toolResult(result)));assert.equal(trace.eventSerializations,expected.length+1);
    const redelivery=await b.step({schemaVersion:2},undefined,{textEncoding:encoding});assert.equal(redelivery.events?.[0]?.id,result.events?.[0]?.id);assert.equal(redelivery.events?.[0]?.redelivered,true);
    await b.step({seen:result.id});assert.equal(env.store.stats().events,40-expected.length);
  }
});

test('actual post-escaping instructions fail capacity before effects and image metadata is charged separately from pixels',async t=>{
  const env=new Feed(),traces:Trace[]=[],b=new Bridge(env,'Goal',{trace:e=>traces.push(e)});await b.start();t.after(()=>b.close());
  (env as Feed & {capture:()=>Promise<unknown>}).capture=async()=>[{type:'image',id:'pixels',mimeType:'image/png',data:'eA==',receivedMs:0,valid:true,reused:false}];
  const result=await createHandlers(b).call('step',{}) as Bundle;
  const trace=traces.findLast(e=>e.type==='assembly')!;
  assert.equal(trace.mediaBytes,1);assert.equal(trace.textBytes,bytes(toolResult(result))-4);
  const first=await b.step();await b.step({seen:first.id});
  await assert.rejects(b.step({goalVersion:1,commands:[{id:'c1',kind:'publish',args:{}}]},undefined,{wrapperBytes:40000}),/capacity/);assert.equal(env.effects,0);
});
