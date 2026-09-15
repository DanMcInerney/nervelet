import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolResult, type Handlers, type ToolResult } from '../handlers.ts';
import { fail, message } from '../util.ts';

/** Use this dispatcher from an existing authenticated host server; no extra service needed. */
export function mcpTools(handlers:Handlers) {
  return {list:()=>structuredClone(handlers.tools),async call(name:string,args:unknown,signal?:AbortSignal):Promise<ToolResult> {
    try{return toolResult(await handlers.call(name,args,signal));}
    catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({error:{code:(error as {code?:string}).code ?? 'operation_failed',message:message(error).slice(0,1024)}})}]};}
  }};
}
export async function createMcpServer(handlers:Handlers):Promise<McpServer> {
  let sdk:typeof import('@modelcontextprotocol/sdk/server/mcp.js');
  try {sdk=await import('@modelcontextprotocol/sdk/server/mcp.js');}
  catch {fail('missing_dependency','Install @modelcontextprotocol/sdk@1.30.0 for the MCP transport.');}
  const {ListToolsRequestSchema,CallToolRequestSchema}=await import('@modelcontextprotocol/sdk/types.js');
  const server=new sdk.McpServer({name:'nervelet',version:'0.2.0'},{capabilities:{tools:{}}});
  const tools=mcpTools(handlers);
  server.server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:tools.list()}));
  server.server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>({...await tools.call(request.params.name,request.params.arguments ?? {},extra.signal)}));
  return server;
}
/** A standalone stdio tool transport over a caller-owned bridge/IPC handle. */
export async function serveStdio(handlers:Handlers):Promise<McpServer> {
  const server=await createMcpServer(handlers);
  const {StdioServerTransport}=await import('@modelcontextprotocol/sdk/server/stdio.js');
  await server.connect(new StdioServerTransport());return server;
}
/** Optional managed-native endpoint. It owns only transport resources, never an environment. */
export async function serveLocalMcp(handlers:Handlers):Promise<{url:string;token:string;close():Promise<void>}> {
  const {StreamableHTTPServerTransport}=await import('@modelcontextprotocol/sdk/server/streamableHttp.js').catch(()=>fail('missing_dependency','Install @modelcontextprotocol/sdk@1.30.0 for local MCP.'));
  const token=randomBytes(32).toString('hex'), credential=Buffer.from(`Bearer ${token}`);
  const active=new Set<McpServer>();
  const http=createServer((req,res)=>{void(async()=>{
    const supplied=Buffer.from(req.headers.authorization ?? '');
    if(req.headers.origin || supplied.length!==credential.length || !timingSafeEqual(supplied,credential)){res.writeHead(403).end();return;}
    if(req.url!=='/mcp' || req.method!=='POST'){res.writeHead(405).end();return;}
    if(active.size>=16){res.writeHead(429).end();return;}
    let size=0;const chunks:Buffer[]=[];
    for await(const chunk of req){size+=chunk.length;if(size>65536){res.writeHead(413).end();return;}chunks.push(chunk);}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const server=await createMcpServer(handlers);active.add(server);
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    const cleanup=()=>{active.delete(server);void server.close();};res.once('close',cleanup);
    await server.connect(transport);await transport.handleRequest(req,res,body);
  })().catch(()=>{if(!res.headersSent)res.writeHead(400);res.end();});});
  http.requestTimeout=35000;http.headersTimeout=5000;
  await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',()=>{http.removeListener('error',reject);resolve();});});
  const address=http.address();if(!address || typeof address==='string')fail('transport','Missing local endpoint.');
  return {url:`http://127.0.0.1:${address.port}/mcp`,token,async close(){for(const server of active)await server.close();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));}};
}
