import { spawn } from 'node:child_process';
import { fail, message, object } from '../util.ts';

export interface RpcEvent { method:string; params:Record<string,unknown> }
export interface AppServerClient {
  request(method:string,params:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>;
  subscribe(listener:(event:RpcEvent)=>void):()=>void;
  close?():Promise<void>;
}
/** Explicit opt-in owned process. Embedded hosts normally supply their existing client instead. */
export async function connectAppServer(options:{
  command:string; args?:string[]; cwd?:string; requestMs?:number;
  approve?:(method:string,params:unknown)=>Promise<unknown>;
}):Promise<AppServerClient> {
  const child=spawn(options.command,options.args ?? ['app-server','--listen','stdio://'],{cwd:options.cwd,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const listeners=new Set<(event:RpcEvent)=>void>();let buffer=Buffer.alloc(0),next=0,closed=false;
  const pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:unknown)=>void;cleanup:()=>void}>();
  const send=(value:unknown)=>{const data=JSON.stringify(value)+'\n';if(Buffer.byteLength(data)>8388608)fail('capacity','App Server request too large.');child.stdin.write(data);};
  const terminate=(error:Error)=>{if(closed)return;closed=true;for(const p of pending.values()){p.cleanup();p.reject(error);}pending.clear();for(const l of listeners)l({method:'transport/closed',params:{message:error.message}});child.kill();};
  child.once('error',terminate);child.once('exit',()=>terminate(new Error('App Server exited.')));child.stdin.on('error',terminate);
  // Do not retain native stderr (may include sensitive context); errors arrive through RPC/exit.
  child.stderr.resume();
  child.stdout.on('data',(chunk:Buffer)=>{
    buffer=Buffer.concat([buffer,chunk]);if(buffer.length>8388608){terminate(new Error('App Server output exceeded framing capacity.'));return;}
    let index:number;
    while((index=buffer.indexOf(10))>=0){const line=buffer.subarray(0,index).toString('utf8');buffer=buffer.subarray(index+1);
      try {
        const value:unknown=JSON.parse(line);if(!object(value))throw new Error('Invalid RPC frame.');
        if(typeof value.method==='string') {
          if(value.id !== undefined)void(async()=>{try{if(!options.approve)fail('permission','Host approval handler required.');send({id:value.id,result:await options.approve(value.method as string,value.params)});}catch(e){send({id:value.id,error:{code:-32603,message:message(e).slice(0,512)}});}})().catch(terminate);
          else if(object(value.params))for(const l of listeners)l({method:value.method,params:value.params});
        } else if(typeof value.id==='number') {const p=pending.get(value.id);if(p){p.cleanup();pending.delete(value.id);if(value.error)p.reject(new Error(JSON.stringify(value.error)));else p.resolve(value.result);}}
      }catch(error){terminate(new Error(`Invalid App Server stream: ${message(error)}`));}
    }
  });
  const client:AppServerClient={
    request(method,params,signal){return new Promise((resolve,reject)=>{
      if(closed){reject(new Error('App Server connection closed.'));return;}if(pending.size>=32){reject(new Error('App Server request backpressure.'));return;}
      const id=++next;
      const abort=()=>{const p=pending.get(id);if(p){p.cleanup();pending.delete(id);reject(signal?.reason ?? new Error('RPC timeout; outcome unknown.'));}};
      const timer=setTimeout(abort,options.requestMs ?? 10000);
      pending.set(id,{resolve,reject,cleanup:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);}});
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
      try{send({id,method,params});}catch(error){pending.get(id)?.cleanup();pending.delete(id);reject(error);}
    });},
    subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},
    async close(){terminate(new Error('Owned App Server closed.'));}
  };
  try {await client.request('initialize',{clientInfo:{name:'nervelet',version:'0.2.0'}});send({method:'initialized',params:{}});return client;}
  catch(error){await client.close!();throw error;}
}
