import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { temp } from './helpers.ts';
import { createMcpServer, serveLocalMcp } from '../src/transports/mcp.ts';
import { Bridge, createHandlers, serve } from '../src/index.ts';
import { DemoEnvironment } from '../src/adapters/demo.ts';
import { CodexDriver, type AppServerClient } from '../src/drivers/codex.ts';
import { ClaudeCodeDriver } from '../src/drivers/claude-code.ts';
import type { Query, SDKMessage, SDKUserMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import type { RpcEvent } from '../src/drivers/app-server.ts';
import type { DriverContext } from '../src/supervisor.ts';

async function context(t:test.TestContext):Promise<DriverContext>{const bridge=new Bridge(new DemoEnvironment(),'Inspect');await bridge.start();t.after(()=>bridge.close());return {bridge,handlers:createHandlers(bridge,{waitMode:'park'}),usage:()=>{}};}
test('official MCP in-memory SDK roundtrip uses shared handlers and authenticated bound identity',async t=>{
  const c=await context(t),server=await createMcpServer(c.handlers);const client=new Client({name:'test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});
  const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name),['cancel','describe','step','stop']);
  const result=await client.callTool({name:'step',arguments:{}});assert.equal(result.isError,undefined);const content=result.content as {text:string}[];assert.equal(JSON.parse(content[0]!.text).schemaVersion,2);
  const forged=await client.callTool({name:'step',arguments:{loopRef:'other'}});assert.equal(forged.isError,true);
});
test('authenticated local HTTP MCP allows concurrent responsive controls; unauthenticated requests fail',async t=>{
  const c=await context(t),endpoint=await serveLocalMcp(c.handlers);t.after(()=>endpoint.close());
  assert.equal((await fetch(endpoint.url,{method:'POST',body:'{}'})).status,403);
  const client=new Client({name:'test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url),{requestInit:{headers:{Authorization:`Bearer ${endpoint.token}`}}}));t.after(()=>client.close());
  const result=await client.callTool({name:'step',arguments:{}});assert.equal(result.isError,undefined);
  const denied=await fetch(endpoint.url,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,Origin:'https://attacker.invalid'},body:'{}'});assert.equal(denied.status,403);
});
test('compiled stdio MCP attaches to existing IPC bridge and applies native recovery markers',async t=>{
  const cwd=await temp(t),bridge=new Bridge(new DemoEnvironment(),'Attached goal');const server=await serve(bridge,{cwd});t.after(()=>server.close());
  const client=new Client({name:'stdio-fixture',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/cli.js'),'mcp','--cwd',cwd],stderr:'pipe'}));t.after(()=>client.close());
  const first=await client.callTool({name:'step',arguments:{}});const b=JSON.parse((first.content as {text:string}[])[0]!.text);
  await writeFile(join(cwd,'.nervelet','refresh'),'synthetic-compaction');
  const next=await client.callTool({name:'step',arguments:{seen:b.id,goalVersion:1,commands:[{id:'c1',kind:'sample',args:{}}]}});const recovery=JSON.parse((next.content as {text:string}[])[0]!.text);
  assert.equal(recovery.results[0].reason,'refresh_required');assert.equal(recovery.goal.text,'Attached goal');assert.ok(recovery.recovery.generation>b.recovery.generation);
});
test('Codex protocol fixture scopes session notifications, handles completion before RPC response, preserves borrowed client',async t=>{
  const c=await context(t);const listeners=new Set<(e:RpcEvent)=>void>();const requests:{method:string;params:Record<string,unknown>}[]=[];let closed=0;
  const emit=(method:string,params:Record<string,unknown>)=>{for(const l of listeners)l({method,params});};
  const client:AppServerClient={subscribe(l){listeners.add(l);return()=>{listeners.delete(l);};},async close(){closed++;},async request(method,params){requests.push({method,params});
    if(method==='thread/start')return {thread:{id:'pilot-1'},model:'explicit-model'};
    if(method==='turn/start'){emit('turn/started',{threadId:'pilot-1',turn:{id:'turn-1'}});emit('turn/completed',{threadId:'pilot-1',turn:{id:'turn-1',status:'completed'}});return {turn:{id:'turn-1'}};}return {};}};
  const driver=new CodexDriver({client,model:'explicit-model',cwd:process.cwd(),approvalPolicy:'never',sandbox:'read-only',connectTools:async()=>({config:{}})});
  await driver.open(c,new AbortController().signal);const before=c.bridge.status().generation;
  emit('thread/compacted',{threadId:'pilot-2'});assert.equal(c.bridge.status().generation,before);emit('thread/compacted',{threadId:'pilot-1'});assert.equal(c.bridge.status().generation,before+1);
  const b=await c.bridge.step({schemaVersion:2});b.attachments=[{type:'image',id:'fixture',mimeType:'image/png',data:'eA==',receivedMs:0,valid:true,reused:false}];
  assert.equal((await driver.turn(b,new AbortController().signal)).status,'ended');assert.equal((requests.find(r=>r.method==='turn/start')!.params.input as {type:string}[])[1]!.type,'image');
  await driver.close();assert.equal(closed,0);assert.equal(listeners.size,0);
});
test('Claude SDK fixture keeps streaming input across turns and uses native preset and explicit permissions',async t=>{
  const c=await context(t);let captured:Options|undefined;let sent=0,interrupts=0;let closed=false;let hook:Options['hooks'];
  const fakeQuery=({prompt,options}:{prompt:string|AsyncIterable<SDKUserMessage>;options?:Options}):Query=>{
    captured=options;hook=options?.hooks;
    const gen=(async function*(){for await(const input of prompt as AsyncIterable<SDKUserMessage>){assert.equal(input.type,'user');sent++;yield {type:'result',subtype:'success',is_error:false,permission_denials:[],total_cost_usd:sent/100,usage:{input_tokens:10,output_tokens:2,cache_read_input_tokens:0},session_id:'session-1'} as unknown as SDKMessage;if(closed)return;}})();
    return Object.assign(gen,{initializationResult:async()=>({}),interrupt:async()=>{interrupts++;},close:()=>{closed=true;}}) as unknown as Query;
  };
  const driver=new ClaudeCodeDriver({model:'explicit-claude',cwd:process.cwd(),permissionMode:'default',allowedTools:['mcp__nervelet__step'],settingSources:[],query:fakeQuery});
  await driver.open(c,new AbortController().signal);const b=await c.bridge.step();await driver.turn(b,new AbortController().signal);await driver.turn(b,new AbortController().signal);
  assert.equal(sent,2);assert.equal(driver.sessionId,'session-1');assert.equal(captured?.model,'explicit-claude');assert.deepEqual(captured?.settingSources,[]);assert.equal((captured?.systemPrompt as {preset:string}).preset,'claude_code');assert.ok(hook?.PreCompact);
  await driver.interrupt();assert.equal(interrupts,1);await driver.close();
});
