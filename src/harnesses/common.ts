import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, fail, object, optionalText } from '../util.ts';
import { request } from '../ipc.ts';

export type HarnessName='claude-code'|'codex';
export interface HarnessConfig {name:HarnessName;settings:string;instructions:string;windowsCommand?:boolean}
function quotePath(value:string):string {
  // One spelling accepted by both Windows command shells and POSIX shells.
  if(/[\r\n"$`%!^&|<>]/.test(value))fail('unsupported_path','Hook paths cannot contain shell metacharacters.');
  return '"'+value.replaceAll('\\','/')+'"';
}
export async function installHarness(config:HarnessConfig,cwd:string):Promise<string[]> {
  cwd=resolve(cwd);
  const cli=fileURLToPath(new URL('../cli.js',import.meta.url));
  const command=`${quotePath(process.execPath)} ${quotePath(cli)} hook --harness ${config.name} --cwd ${quotePath(cwd)}`;
  const commandWindows=`node ${quotePath(cli)} hook --harness ${config.name} --cwd ${quotePath(cwd)}`;
  const path=join(cwd,config.settings);
  const previous=await optionalText(path,65536);
  const settings=previous?JSON.parse(previous):{};
  if(!object(settings)||settings.hooks!==undefined&&!object(settings.hooks))fail('invalid_config','Existing hook settings must be JSON objects.');
  const hooks=(settings.hooks??={}) as Record<string,unknown>;
  for(const event of ['SessionStart','Stop']) {
    const entries=hooks[event]??[];
    if(!Array.isArray(entries))fail('invalid_config',`Existing ${event} hooks must be an array.`);
    const filtered=entries.flatMap(entry=>{
      if(!object(entry)||!Array.isArray(entry.hooks))return [entry];
      const kept=entry.hooks.filter(h=>!(object(h)&&typeof h.command==='string'&&h.command.includes(' hook --harness '+config.name+' --cwd '+quotePath(cwd))));
      return kept.length===entry.hooks.length?[entry]:kept.length?[{...entry,hooks:kept}]:[];
    });
    hooks[event]=[...filtered,{...(event==='SessionStart'?{matcher:'startup|resume|clear|compact'}:{}),hooks:[{type:'command',command,...(config.windowsCommand?{commandWindows}:{}),timeout:5}]}];
  }
  const instructionPath=join(cwd,config.instructions);
  const original=await optionalText(instructionPath,262144)??'';
  const start='<!-- nervelet:start -->',end='<!-- nervelet:end -->';
  const block=`${start}\n## Nervelet\n\nThis project connects one native agent to a Nervelet bridge. Read .nervelet/profile.md for the exact operating profile. Start with nervelet step; follow its current goal and timestamps. Echo the last received bundle in seen. Continue with bounded waits while active; use nervelet stop to finish. Native file tools do not refresh sensors. Keep important commitments in working.md.\n${end}`;
  const begin=original.indexOf(start),finish=original.indexOf(end);
  if((begin<0)!==(finish<0)||finish<begin)fail('invalid_config','Malformed existing Nervelet instruction block.');
  const instructions=begin>=0?original.slice(0,begin)+block+original.slice(finish+end.length):original+(original.endsWith('\n')||!original?'':'\n')+'\n'+block+'\n';
  // Validate and prepare all content before changing existing files.
  await atomicWrite(path,JSON.stringify(settings,null,2)+'\n');
  await atomicWrite(instructionPath,instructions);
  const ignore=await optionalText(join(cwd,'.gitignore'),65536)??'';
  if(!ignore.split(/\r?\n/).some(line=>line.trim()==='.nervelet/'))await atomicWrite(join(cwd,'.gitignore'),ignore+(ignore.endsWith('\n')||!ignore?'':'\n')+'.nervelet/\n');
  return [path,instructionPath];
}

/** Hooks mark recovery; the core delivers exact instructions with the next observation. */
export async function hook(event:unknown,cwd:string):Promise<Record<string,unknown>> {
  if(!object(event))fail('invalid_input','Hook input must be an object.');
  if(event.hook_event_name==='SessionStart') {
    // Durable marker gates the next step even if the bridge cannot be reached now.
    await atomicWrite(join(cwd,'.nervelet','refresh'),randomUUID());
    return {hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'Nervelet context recovery: call nervelet step before commands. Read recovery.instructions for the exact operating profile and current goal, state and jobs in that bundle. History is stale; accepted jobs may still run. Echo only a bundle you have actually read in seen.'}};
  }
  if(event.hook_event_name==='Stop'&&!event.stop_hook_active) {
    try {
      const state=await request<{loop:string;fault?:string}>({method:'status'},{cwd,timeoutMs:1000});
      if(state.loop!=='stopped'&&!state.fault)return {decision:'block',reason:'The configured Nervelet loop remains active. Continue with nervelet step and bounded waits, or use nervelet stop if the user has asked to stop. Respect native limits.'};
    }catch{/* An unavailable bridge is not a reason to force another model turn. */}
  }
  return {};
}
