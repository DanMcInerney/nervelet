// Explicit opt-in smoke test. Uses inference; never part of npm test.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';
import { Bridge, serve } from '../dist/index.js';
import { createDemoEnvironment } from '../dist/adapters/demo.js';
import { installClaudeCode } from '../dist/harnesses/claude-code.js';
import { installCodex } from '../dist/harnesses/codex.js';

const harness=process.argv[2];
if(!['claude-code','codex'].includes(harness))throw new Error('Usage: node scripts/smoke-native.mjs claude-code|codex (uses inference).');
const cwd=resolve('.runtime',`native-${harness}-${randomUUID()}`);
await mkdir(cwd,{recursive:true});
execFileSync('git',['init','-b','codex/smoke'],{cwd,windowsHide:true,stdio:'ignore'});
const bridge=new Bridge(createDemoEnvironment(),'Turn the simulated LED on, run one 200 ms movement job, observe its completion, then stop the loop.');
const exchanges=[];
const step=bridge.step.bind(bridge);
bridge.step=async(...args)=>{const result=await step(...args);exchanges.push({input:args[0],result});return result;};
const server=await serve(bridge,{cwd});
const prompt='This is a bounded Nervelet integration test, using the simulated bench only. Use your native shell to call nervelet step. Read its actual output, then use your native file-writing tool to write request.json containing set_led(on=true) and move(durationMs=200) in one commands array, with the received seen ID and goalVersion. Call nervelet step --request request.json. Read a subsequent step to verify movement completed. Call nervelet stop, then reply NERVELET_OK. Use no subagents. Do not change code or permissions. Write only inside this project. Use a JSON request file, not shell pipelines. If any required tool fails or is denied, call nervelet stop, report NERVELET_BLOCKED and end; do not try alternate shells or file-writing methods. Never automatically acknowledge a bundle you have not read.';
let binary,args,env={...process.env};
try{
if(harness==='claude-code'){
  await installClaudeCode(cwd);
  binary=process.platform==='win32'?join(homedir(),'.local','bin','claude.exe'):'claude';
  args=['--print','--output-format','stream-json','--verbose','--include-hook-events','--max-budget-usd','1','--tools','Bash,Read,Write','--allowedTools','Bash(nervelet *)','Write','--permission-mode','dontAsk','--setting-sources','project,local','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--',prompt];
}else{
  await installCodex(cwd);
  // Isolate hook/config loading; reuse existing sign-in without reading or logging credentials.
  const codexHome=join(cwd,'codex-home');await mkdir(codexHome,{recursive:true});
  await copyFile(join(process.env.CODEX_HOME??join(homedir(),'.codex'),'auth.json'),join(codexHome,'auth.json'));
  await writeFile(join(codexHome,'config.toml'),`[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n[features]\nmulti_agent = false\nhooks = true\n${process.platform==='win32'?'[windows]\nsandbox = "unelevated"\n':''}`);
  await mkdir(join(codexHome,'rules'));
  await writeFile(join(codexHome,'rules','smoke.rules'),'prefix_rule(pattern = ["nervelet", ["step", "stop"]], decision = "allow", justification = "The owned smoke fixture authorizes these simulated-device commands.")\n');
  env.CODEX_HOME=codexHome;
  const codexScript=process.env.CODEX_JS??(process.platform==='win32'?join(process.env.APPDATA,'npm','node_modules','@openai','codex','bin','codex.js'):undefined);
  binary=codexScript?process.execPath:'codex';
  args=[...(codexScript?[codexScript]:[]),'exec','--skip-git-repo-check','--sandbox','workspace-write','--dangerously-bypass-hook-trust','--json',prompt];
}
let stdout='',stderr='',timedOut=false;
  const child=spawn(binary,args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  const timer=setTimeout(()=>{timedOut=true;if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGTERM');},90000);
  child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-2000000);});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-100000);});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}).finally(()=>clearTimeout(timer));
  await writeFile(join(cwd,'native.jsonl'),stdout);await writeFile(join(cwd,'stderr.txt'),stderr);
  const results=exchanges.flatMap(e=>e.result.results??[]);
  const summary={harness,cwd,code,timedOut,steps:exchanges.length,hookGeneration:bridge.status().generation,commands:results.map(r=>r.status),loop:bridge.status().loop,finalMarker:stdout.includes('NERVELET_OK')};
  await writeFile(join(cwd,'summary.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary,null,2));
  assert.equal(code,0);assert.equal(timedOut,false);assert.ok(summary.hookGeneration>1,'Native startup hook did not run.');
  assert.ok(results.some(r=>r.status==='accepted'));assert.ok(results.some(r=>r.status==='completed'));
  assert.ok(exchanges.some(e=>e.result.jobs?.some(j=>j.status==='completed')));assert.equal(summary.loop,'stopped');assert.equal(summary.finalMarker,true);
}finally{await server.close();}
