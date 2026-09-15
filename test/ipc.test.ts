import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Bridge } from '../src/core.ts';
import { serve, request } from '../src/ipc.ts';
import { DemoEnvironment } from '../src/adapters/demo.ts';
import type { Bundle } from '../src/types.ts';
import { temp } from './helpers.ts';

const exec=promisify(execFile);
const cli=resolve('dist/cli.js');
async function run(cwd:string,args:string[]){const result=await exec(process.execPath,[cli,...args],{cwd,timeout:10000,windowsHide:true});return JSON.parse(result.stdout);}
test('serve loads the shipped TypeScript config and exits on shutdown',async t=>{
  const cwd=await temp(t);
  const child=execFile(process.execPath,[cli,'serve','--config',resolve('examples/demo/nervelet.config.ts'),'--goal',resolve('examples/demo/goal.txt')],{cwd,windowsHide:true,timeout:10000});
  const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  // Keep a rejection handler attached while awaiting readiness.
  void exited.catch(()=>{});
  t.after(async()=>{if(child.exitCode===null)child.kill();await exited.catch(()=>{});});
  const ready=await new Promise<string>((resolve,reject)=>{child.stdout!.once('data',s=>resolve(String(s)));child.once('error',reject);child.once('exit',()=>reject(new Error('Bridge exited before readiness.')));});
  assert.equal(JSON.parse(ready).ready,true);
  assert.equal((await run(cwd,['step'])).profile,'demo:1');
  await run(cwd,['shutdown']);assert.equal(await exited,0);
});
test('real CLI over local IPC observes, batches, cancels, updates goal and shuts down',async t=>{
  const cwd=await temp(t);const bridge=new Bridge(new DemoEnvironment(),'CLI integration');const server=await serve(bridge,{cwd});t.after(()=>server.close());
  const first=await run(cwd,['step']);assert.equal(first.goal.text,'CLI integration');
  await writeFile(join(cwd,'request.json'),JSON.stringify({seen:first.id,goalVersion:1,commands:[{id:'c1',kind:'move',args:{durationMs:5000}}]}));
  const started=await run(cwd,['step','--request','request.json']);assert.equal(started.results[0].status,'accepted');
  await run(cwd,['cancel',started.results[0].jobId]);
  const cancelled=await run(cwd,['step']);assert.equal(cancelled.jobs[0].status,'cancelled');
  await writeFile(join(cwd,'goal.txt'),'Goal with\nexact newlines.');await run(cwd,['goal','--file','goal.txt']);
  const updated=await run(cwd,['step']);assert.equal(updated.goal.text,'Goal with\nexact newlines.');
  await run(cwd,['shutdown']);await server.closed;
  await assert.rejects(request({method:'status'},{cwd}),/No bridge/);
});
test('installer preserves existing config and instructions and is idempotent',async t=>{
  const cwd=await temp(t);
  await writeFile(join(cwd,'CLAUDE.md'),'# Existing instructions\nKeep this exact text.\n');
  await run(cwd,['init','--harness','claude-code']);
  const settingsPath=join(cwd,'.claude','settings.local.json');
  const first=JSON.parse(await readFile(settingsPath,'utf8'));first.permissions={deny:['Bash(rm:*)']};first.hooks.Stop[0].hooks.unshift({type:'command',command:'echo existing'});
  await writeFile(settingsPath,JSON.stringify(first));
  await run(cwd,['init','--harness','claude-code']);await run(cwd,['init','--harness','claude-code']);
  const second=JSON.parse(await readFile(settingsPath,'utf8'));
  assert.deepEqual(second.permissions,first.permissions);assert.equal(second.hooks.Stop.length,2);
  assert.equal(second.hooks.Stop[0].hooks[0].command,'echo existing');
  const instructions=await readFile(join(cwd,'CLAUDE.md'),'utf8');assert.ok(instructions.startsWith('# Existing instructions\nKeep this exact text.\n'));assert.equal(instructions.split('<!-- nervelet:start -->').length,2);
  await run(cwd,['init','--harness','codex']);const codex=JSON.parse(await readFile(join(cwd,'.codex','hooks.json'),'utf8'));assert.equal(codex.hooks.SessionStart.length,1);
});
test('native hook marker gates the next step, which restores the exact profile',async t=>{
  const cwd=await temp(t);const bridge=new Bridge(new DemoEnvironment(),'Hook integration');const server=await serve(bridge,{cwd});t.after(()=>server.close());
  await run(cwd,['init','--harness','claude-code']);
  const settings=JSON.parse(await readFile(join(cwd,'.claude','settings.local.json'),'utf8'));
  const command:string=settings.hooks.SessionStart[0].hooks[0].command;
  assert.ok(command.includes('hook --harness claude-code'));
  const first=await request<Bundle>({method:'step'},{cwd});await request({method:'step',params:{seen:first.id}},{cwd});
  for(let i=0;i<3;i++){
    const child=execFile(process.execPath,[cli,'hook','--harness','claude-code'],{cwd,windowsHide:true,timeout:5000});
    child.stdin!.end(JSON.stringify({hook_event_name:'SessionStart',source:'compact'}));
    const output=await new Promise<string>((resolve,reject)=>{let text='';child.stdout!.on('data',s=>text+=s);child.on('error',reject);child.on('exit',code=>code===0?resolve(text):reject(new Error('Hook failed.')));});
    assert.match(JSON.parse(output).hookSpecificOutput.additionalContext,/recovery.instructions/);
    const gated=await request<Bundle>({method:'step',params:{goalVersion:1,commands:[{id:'c1',kind:'sample',args:{}}]}},{cwd});assert.equal(gated.results?.[0]?.reason,'refresh_required');
    assert.equal(gated.recovery?.instructions,bridge.profileText);
    await request({method:'step',params:{seen:gated.id}},{cwd});
  }
});
