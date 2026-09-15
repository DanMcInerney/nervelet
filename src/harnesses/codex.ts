import { installHarness } from './common.ts';
import { join } from 'node:path';
import { atomicWrite, optionalText } from '../util.ts';
export async function installCodex(cwd=process.cwd()):Promise<string[]> {
  const files=await installHarness({name:'codex',settings:'.codex/hooks.json',instructions:'AGENTS.md',windowsCommand:true},cwd);
  const path=join(cwd,'.codex','config.toml');
  // An explicit project config layer also anchors hooks.json discovery on older CLIs.
  if(await optionalText(path,65536)===undefined){await atomicWrite(path,'[features]\nhooks = true\n');files.push(path);}
  return files;
}
