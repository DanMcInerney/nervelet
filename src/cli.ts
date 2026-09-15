#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Bridge } from './core.ts';
import { request, serve } from './ipc.ts';
import { createDemoEnvironment } from './adapters/demo.ts';
import { installClaudeCode } from './harnesses/claude-code.ts';
import { installCodex } from './harnesses/codex.ts';
import { hook } from './harnesses/common.ts';
import { atomicWrite, fail, message, NerveletError, object, optionalText, readBounded } from './util.ts';
import type { Config, StepRequest } from './types.ts';

const HELP=`nervelet — one native agent, one continuous environment

  init --harness claude-code|codex    Install project instructions/hooks
  demo                              Start a simulated device (no hardware)
  serve [--config nervelet.config.ts] [--goal goal.txt]
  step [--seen ID] [--wait-ms N]      Observe or wait
  step --request FILE               Submit JSON {seen,goalVersion,commands}
  cancel JOB                        Cancel a domain job
  goal --file FILE                  Replace the objective and cancel old work
  stop                              Stop the loop; keep bridge available for inspection
  shutdown                          Stop and close the bridge
  status                            Read loop state
  mcp                               Expose an existing bridge as MCP over stdio

Use --cwd DIR to select a project. JSON results go to stdout; mcp uses MCP framing. No model calls.
`;
async function stdin(limit:number):Promise<string> {
  let text='';for await(const chunk of process.stdin){text+=String(chunk);if(Buffer.byteLength(text)>limit)fail('capacity','stdin exceeds capacity.');}return text;
}
async function main():Promise<void> {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{harness:{type:'string'},cwd:{type:'string'},config:{type:'string'},goal:{type:'string'},seen:{type:'string'},'wait-ms':{type:'string'},request:{type:'string'},file:{type:'string'},help:{type:'boolean'}}});
  const command=positionals[0];const cwd=resolve(values.cwd??process.cwd());
  if(values.help||!command){process.stdout.write(HELP);return;}
  const allowed:Record<string,string[]>={init:['harness'],hook:['harness'],demo:['goal'],serve:['config','goal'],step:['seen','wait-ms','request'],cancel:[],goal:['file'],stop:[],status:[],shutdown:[],mcp:[]};
  if(!allowed[command])fail('invalid_input',`Unknown command ${command}. Use --help.`);
  if(positionals.length>(command==='cancel'?2:1)||Object.keys(values).some(key=>key!=='cwd'&&!allowed[command]!.includes(key)))fail('invalid_input','Unexpected arguments for this command.');
  let result:unknown;
  if(command==='mcp') {
    const {serveStdio}=await import('./transports/mcp.ts');
    const metadata=await request<Pick<import('./handlers.ts').Handlers,'tools'|'instructions'|'loopRef'>>({method:'tools'},{cwd});
    await serveStdio({...metadata,call:(name,args,signal)=>request({method:'tool',params:{name,args}},{cwd,signal})});return;
  } else if(command==='hook') {
    if(!['claude-code','codex'].includes(values.harness??''))fail('invalid_input','Specify a harness.');
    result=await hook(JSON.parse(await stdin(65536)),cwd);
  } else if(command==='init') {
    if(values.harness==='claude-code')result={installed:await installClaudeCode(cwd)};
    else if(values.harness==='codex')result={installed:await installCodex(cwd),launch:'codex --enable hooks',review:'Trust this project and review the installed hooks with /hooks.'};
    else fail('invalid_input','Use --harness claude-code or codex.');
  } else if(command==='demo'||command==='serve') {
    const config:Config=command==='demo'?{environment:createDemoEnvironment}:(await import(pathToFileURL(resolve(cwd,values.config??'nervelet.config.ts')).href)).default;
    if(!object(config)||typeof config.environment!=='function')fail('invalid_config','Config must export {environment: () => Environment}.');
    const goal=values.goal||command==='serve'?await readBounded(resolve(cwd,values.goal??'goal.txt'),4096):'Explore the simulated bench, inspect sensor changes and jobs, then stop when asked.';
    const bridge=new Bridge(await config.environment(),goal,{limits:config.limits,note:()=>optionalText(join(cwd,'working.md'),4096),saveGoal:g=>atomicWrite(join(cwd,'.nervelet','goal.json'),JSON.stringify(g)+'\n')});
    const running=await serve(bridge,{cwd});
    process.stdout.write(JSON.stringify({ready:true,epoch:bridge.epoch,environment:bridge.environment.profile.id})+'\n');
    const end=()=>{void running.close().catch(error=>{process.stderr.write(message(error)+'\n');process.exitCode=1;});};
    process.once('SIGINT',end);process.once('SIGTERM',end);
    await running.closed;
    process.removeListener('SIGINT',end);process.removeListener('SIGTERM',end);return;
  } else if(command==='step') {
    let input:StepRequest;
    if(values.request) {
      if(values.seen!==undefined||values['wait-ms']!==undefined)fail('invalid_input','Use --request separately from step flags.');
      input=JSON.parse(values.request==='-'?await stdin(16384):await readBounded(resolve(cwd,values.request),16384));
    } else input={...(values.seen?{seen:values.seen}:{}),...(values['wait-ms']!==undefined?{waitMs:Number(values['wait-ms'])}:{})};
    result=await request({method:'step',params:input},{cwd});
  } else if(command==='cancel')result=await request({method:'cancel',params:{id:positionals[1]}},{cwd});
  else if(command==='goal') {
    if(!values.file)fail('invalid_input','Use goal --file FILE.');
    result=await request({method:'goal',params:{text:await readBounded(resolve(cwd,values.file),4096)}},{cwd});
  } else if(command==='stop'||command==='status'||command==='shutdown')result=await request({method:command},{cwd});
  else fail('invalid_input',`Unknown command ${command}. Use --help.`);
  process.stdout.write(JSON.stringify(result)+'\n');
}

main().catch(error=>{process.stdout.write(JSON.stringify({error:{code:error instanceof NerveletError?error.code:'operation_failed',message:message(error)}})+'\n');process.exitCode=1;});
