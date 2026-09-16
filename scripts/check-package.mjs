import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const npm=process.env.npm_execpath;if(!npm)throw new Error('Run through npm run check:package.');
const run=(args,cwd=process.cwd())=>execFileSync(process.execPath,[npm,...args],{cwd,encoding:'utf8',windowsHide:true});
await mkdir('.runtime',{recursive:true});
const packed=JSON.parse(run(['pack','--json','--pack-destination','.runtime']));const pkg=packed[0];
assert.ok(pkg.files.every(f=>!/(?:^|\/)(?:\.runtime|\.codex|\.claude|node_modules|test)(?:\/|$)/.test(f.path)));
const parent=await realpath(tmpdir()),directory=await mkdtemp(join(parent,'nervelet-package-'));
async function disk(path){let total=0;for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);total+=entry.isDirectory()?await disk(file):(await stat(file)).size;}return total;}
try {
  await writeFile(join(directory,'package.json'),JSON.stringify({private:true,type:'module'}));
  run(['install','--omit=dev','--ignore-scripts','--no-audit','--no-fund',resolve('.runtime',pkg.filename)],directory);
  const lock=JSON.parse(await readFile(join(directory,'package-lock.json'),'utf8'));
  assert.ok(!Object.keys(lock.packages).some(p=>p==='node_modules/@anthropic-ai/claude-agent-sdk'||p==='node_modules/@modelcontextprotocol/sdk'||p==='node_modules/serialport'));
  const script=`import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(/@modelcontextprotocol|@anthropic-ai|serialport/.test(specifier))throw new Error('Unexpected optional runtime import: '+specifier);return next(specifier,context);}});
const {Bridge,ObservationStore,serve,request,defineConfig,settleEmergency}=await import('nervelet');assert.equal(typeof settleEmergency,'function');
const {createDemoEnvironment}=await import('nervelet/demo');
const {createSerialEnvironment}=await import('nervelet/serial');assert.equal(typeof createSerialEnvironment,'function');
const {ApiDriver}=await import('nervelet/drivers/api');assert.equal(typeof ApiDriver,'function');
const {CodexDriver}=await import('nervelet/drivers/codex');assert.equal(typeof CodexDriver,'function');
const {ClaudeCodeDriver}=await import('nervelet/drivers/claude-code');assert.equal(typeof ClaudeCodeDriver,'function');
const {mcpTools}=await import('nervelet/mcp');assert.equal(typeof mcpTools,'function');
const {installCodex}=await import('nervelet/codex');const {installClaudeCode}=await import('nervelet/claude-code');
assert.equal(typeof serve,'function');assert.equal(typeof request,'function');assert.equal(typeof defineConfig,'function');assert.equal(typeof installCodex,'function');assert.equal(typeof installClaudeCode,'function');assert.ok(new ObservationStore());
const b=new Bridge(createDemoEnvironment(),'Packed smoke');await b.start();const initial=await b.step();const result=await b.step({seen:initial.id,goalVersion:1,commands:[{id:'c1',kind:'sample',args:{}}]});assert.equal(result.results[0].status,'completed');await b.close();
`;
  await writeFile(join(directory,'check.mjs'),script);execFileSync(process.execPath,['check.mjs'],{cwd:directory,stdio:'inherit',windowsHide:true});
  const installed=await readdir(join(directory,'node_modules'),{withFileTypes:true});
  const result={node:process.version,platform:process.platform,baseRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),worktreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim(),version:pkg.version,filename:pkg.filename,sha256:createHash('sha256').update(await readFile(resolve('.runtime',pkg.filename))).digest('hex'),integrity:pkg.integrity,shasum:pkg.shasum,archiveBytes:pkg.size,unpackedPackageBytes:pkg.unpackedSize,installedCoreBytes:await disk(join(directory,'node_modules')),installedCorePackages:installed.filter(p=>p.isDirectory()&&!p.name.startsWith('.')).length,optionalPeersAbsent:true};
  await writeFile('.runtime/package-check.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
} finally {
  const actual=await realpath(directory),child=relative(parent,actual);
  assert.ok(!isAbsolute(child)&&!child.startsWith('..')&&child.startsWith('nervelet-package-'));
  await rm(actual,{recursive:true,force:true});
}
