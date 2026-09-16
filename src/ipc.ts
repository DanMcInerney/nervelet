import { createServer, createConnection, type Socket } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, realpath, lstat, unlink, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { Bridge } from './core.ts';
import { createHandlers } from './handlers.ts';
import { atomicWrite, fail, message, NerveletError, object, readBounded, optionalText } from './util.ts';
import type { StepRequest } from './types.ts';

export interface RpcRequest { method: 'step'|'cancel'|'stop'|'status'|'goal'|'refresh'|'instructions'|'shutdown'|'tools'|'tool'; params?: unknown }
interface Address { endpoint: string; token: string; epoch: string; pid: number; maxRequestBytes?:number; maxResponseBytes?:number }
const addressFile = (cwd:string) => join(cwd,'.nervelet','bridge.json');
async function endpoint(cwd:string):Promise<string> {
  const hash=createHash('sha256').update(userInfo().username+'\0'+await realpath(cwd)).digest('hex').slice(0,24);
  if(process.platform==='win32')return `\\\\.\\pipe\\nervelet-${hash}`;
  const directory=join(tmpdir(),`nervelet-${process.getuid?.() ?? userInfo().username}`);
  await mkdir(directory,{recursive:true,mode:0o700});
  return join(directory,hash+'.sock');
}
async function active(path:string):Promise<boolean> {
  return new Promise(resolve=>{
    const socket=createConnection(path);socket.setTimeout(500);
    socket.once('connect',()=>{socket.destroy();resolve(true);});
    socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(true);});
  });
}
function authorized(received:unknown,token:string):boolean {
  if(typeof received!=='string')return false;
  const a=Buffer.from(received),b=Buffer.from(token);return a.length===b.length&&timingSafeEqual(a,b);
}
export async function serve(bridge:Bridge,options:{cwd?:string}={}):Promise<{endpoint:string;close:()=>Promise<void>;closed:Promise<void>}> {
  const cwd=await realpath(resolve(options.cwd??process.cwd()));
  const path=await endpoint(cwd);
  if(process.platform!=='win32') {
    const stat=await lstat(path).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;});
    if(stat) {
      if(!stat.isSocket()||stat.uid!==process.getuid?.()||await active(path))fail('busy','Bridge endpoint already exists.');
      await unlink(path);
    }
  }
  const token=randomBytes(32).toString('hex');
  const maxRequestBytes=Math.max(65536,bridge.limits.maxRequestBytes+4096);
  const maxResponseBytes=Math.max(1048576,bridge.limits.maxRecoveryBytes*2+4096,bridge.limits.maxBundleBytes*2+4096);
  const handlers=createHandlers(bridge,{legacy:true});
  const nativeHandlers=createHandlers(bridge);
  const sockets=new Set<Socket>();
  let shuttingDown=false;
  let recoveryMarker:string|undefined;
  const applyRecoveryMarker=async()=>{
    const marker=await optionalText(join(cwd,'.nervelet','refresh'),128);
    if(marker!==recoveryMarker){recoveryMarker=marker;bridge.refresh('native_session_recovery');}
  };
  let resolveClosed:()=>void=()=>{};
  const closed=new Promise<void>(r=>{resolveClosed=r;});
  const server=createServer(socket=>{
    if(sockets.size>=16){socket.destroy();return;}
    sockets.add(socket);socket.setTimeout(90000,()=>socket.destroy());
    const controller=new AbortController();
    socket.once('close',()=>{sockets.delete(socket);controller.abort(new Error('Client disconnected; reconcile effects.'));});
    socket.on('error',()=>{});
    let input=Buffer.alloc(0),handled=false;
    socket.on('data',chunk=>{
      if(handled)return;
      input=Buffer.concat([input,chunk]);
      if(input.length>maxRequestBytes){handled=true;socket.end(JSON.stringify({ok:false,error:{code:'capacity',message:'IPC request exceeds capacity.'}})+'\n');return;}
      const index=input.indexOf(10);if(index<0)return;handled=true;
      void (async()=>{
        try {
          const rpc:unknown=JSON.parse(input.subarray(0,index).toString('utf8'));
          if(!object(rpc)||!authorized(rpc.token,token))fail('unauthorized','Invalid bridge credential.');
          const params=rpc.params;
          let result:unknown;
          switch(rpc.method) {
            case 'tools':result={tools:nativeHandlers.tools,instructions:nativeHandlers.instructions,loopRef:nativeHandlers.loopRef,maxRequestBytes:bridge.limits.maxRequestBytes};break;
            case 'tool':if(!object(params)||typeof params.name!=='string')fail('invalid_input','tool requires name and args.');if(params.name==='step')await applyRecoveryMarker();result=await nativeHandlers.call(params.name,params.args??{},controller.signal);break;
            case 'step': {
              await applyRecoveryMarker();
              result=await handlers.call('step',params??{},controller.signal);break;
            }
            case 'cancel': if(!object(params)||typeof params.id!=='string')fail('invalid_input','cancel requires id.');result={cancelRequested:params.id,outcome:await handlers.call('cancel',{jobId:params.id})};break;
            case 'goal': if(!object(params)||typeof params.text!=='string')fail('invalid_input','goal requires text.');result=await bridge.updateGoal(params.text);break;
            case 'refresh': bridge.refresh('context_recovery');result={profile:bridge.profileText,...bridge.status()};break;
            case 'instructions': result={profile:bridge.profileText};break;
            case 'status': result=bridge.status();break;
            case 'stop': await handlers.call('stop',{});result=bridge.status();break;
            case 'shutdown': await bridge.stop();result={loop:'stopped'};break;
            default: fail('invalid_method','Unknown bridge method.');
          }
          const output=JSON.stringify({ok:true,result})+'\n';
          if(Buffer.byteLength(output)>maxResponseBytes)fail('capacity','IPC response exceeds capacity.');
          socket.end(output,()=>{if(object(result)&&typeof result.id==='string')bridge.emit({type:'submission',id:result.id,reason:'ipc_written'});if(rpc.method==='shutdown')void close();});
        } catch(error) {socket.end(JSON.stringify({ok:false,error:{code:error instanceof NerveletError?error.code:'operation_failed',message:message(error).slice(0,1024)}})+'\n');}
      })();
    });
  });
  const close=async()=>{
    if(shuttingDown)return closed;
    shuttingDown=true;
    try {await bridge.close();}
    finally {
      for(const socket of sockets)socket.destroy();
      await new Promise<void>(r=>server.close(()=>r()));
      const saved=await readBounded(addressFile(cwd),4096).then(t=>JSON.parse(t) as Address).catch(()=>undefined);
      if(saved?.token===token)await unlink(addressFile(cwd)).catch(()=>{});
      resolveClosed();
    }
  };
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.removeListener('error',reject);resolve();});});
  try {
    if(process.platform!=='win32')await chmod(path,0o600);
    await bridge.start();
    await atomicWrite(addressFile(cwd),JSON.stringify({endpoint:path,token,epoch:bridge.epoch,pid:process.pid,maxRequestBytes,maxResponseBytes}));
    await atomicWrite(join(cwd,'.nervelet','profile.md'),handlers.instructions+'\n');
  } catch(error) {await close().catch(()=>{});throw error;}
  return {endpoint:path,close,closed};
}

export async function request<T=unknown>(rpc:RpcRequest,options:{cwd?:string;signal?:AbortSignal;timeoutMs?:number}={}):Promise<T> {
  const cwd=resolve(options.cwd??process.cwd());
  let address:Address;
  try {address=JSON.parse(await readBounded(addressFile(cwd),4096));}
  catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')fail('unavailable','No bridge in this project. Start nervelet serve or demo.');throw error;}
  const payload=JSON.stringify({...rpc,token:address.token})+'\n';
  if(Buffer.byteLength(payload)>(address.maxRequestBytes ?? 65536))fail('capacity','IPC request exceeds capacity.');
  return new Promise<T>((resolve,reject)=>{
    const socket=createConnection(address.endpoint);
    let input=Buffer.alloc(0),settled=false;
    const finish=(error?:unknown,result?:T)=>{if(settled)return;settled=true;options.signal?.removeEventListener('abort',abort);socket.destroy();if(error)reject(error);else resolve(result as T);};
    const abort=()=>finish(options.signal?.reason??new Error('Cancelled.'));
    if(options.signal?.aborted){abort();return;}
    options.signal?.addEventListener('abort',abort,{once:true});
    socket.setTimeout(options.timeoutMs??65000,()=>finish(new NerveletError('timeout','Bridge timed out. Reconcile any submitted commands.')));
    socket.once('connect',()=>socket.write(payload));socket.once('error',error=>finish(error));socket.once('close',()=>{if(!settled)finish(new Error('Bridge disconnected; command outcome may be unknown.'));});
    socket.on('data',chunk=>{
      input=Buffer.concat([input,chunk]);if(input.length>(address.maxResponseBytes ?? 1048576)){finish(new NerveletError('capacity','IPC response exceeds capacity.'));return;}
      const index=input.indexOf(10);if(index<0)return;
      try {
        const data=JSON.parse(input.subarray(0,index).toString('utf8'));
        if(data.ok)finish(undefined,data.result as T);else finish(new NerveletError(data.error?.code??'operation_failed',data.error?.message??'Bridge error.'));
      } catch(error){finish(error);}
    });
  });
}
