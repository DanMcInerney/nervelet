/** Deterministic integration shape only. No DroneRTS connection, gameplay or live sessions. */
import { Bridge, ObservationStore, createHandlers } from 'nervelet';
import type { Command, CommandContext, ControlOutcome, Environment, ImageAttachment, Job, Profile } from 'nervelet';

const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII=';
export class PilotEnvironment implements Environment {
  readonly profile:Profile={id:'pilot',version:'fixture-2',instructions:'Fixture telemetry uses metres and metres/second. Pixels and received mail belong only to this actor. One movement writer. No shell or world geometry capability.',
    camera:{policy:'capture_on_step'},commands:{move:{description:'Start one local controller job.',resource:'motion',schema:{type:'object',additionalProperties:false,required:['target'],properties:{target:{type:'string',maxLength:32}}}}}};
  readonly store=new ObservationStore();readonly changes=this.store.changes;
  readonly actor:string;captures=0;starts=0;closes=0;position=0;captureGate?:Promise<void>;private job?:Job;
  constructor(actor:string){this.actor=actor;}
  private acquire(){this.store.setState({value:{actor:this.actor,position:this.position,velocity:this.job?.status==='running'?1:0,equipment:['camera'],cargo:[]},receivedMs:performance.now(),acquired:{clock:'fixture',ms:performance.now()},valid:true,maxAgeMs:1000});}
  async start(){this.starts++;this.acquire();}
  tick(){if(this.job?.status==='running'){this.position++;this.job.updatedMs=performance.now();}this.acquire();}
  finish(){if(this.job){this.job.status='completed';this.store.push('job',{id:this.job.id,status:'completed'});this.acquire();}}
  async snapshot(after:number){return this.store.snapshot(after,this.job?[this.job]:[]);}
  async capture(signal:AbortSignal):Promise<ImageAttachment[]>{this.captures++;await this.captureGate;signal.throwIfAborted();return [{type:'image',id:`${this.actor}:frame${this.captures}`,mimeType:'image/png',data:pixel,receivedMs:performance.now(),acquired:{clock:'fixture',ms:performance.now()},valid:true,reused:false}];}
  acknowledge(n:number){this.store.acknowledge(n);}
  wait(s:AbortSignal){return this.store.wait(s);}
  async execute(c:Command,context:CommandContext){context.signal.throwIfAborted();context.assertCurrent?.();if(this.job?.status==='running')return {id:c.id,status:'rejected' as const,reason:'motion_busy'};
    const at=performance.now();this.job={id:`${this.actor}:${c.id}`,commandId:c.id,kind:c.kind,args:c.args,status:'running',startedMs:at,updatedMs:at};this.acquire();this.store.wake();return {id:c.id,status:'accepted' as const,jobId:this.job.id};}
  async cancel(id:string):Promise<ControlOutcome>{if(this.job?.id!==id)return {status:'unknown',reason:'not_owned'};return this.stop();}
  async stop():Promise<ControlOutcome>{if(this.job?.status==='running')this.job.status='cancelled';this.acquire();this.store.wake();return {status:'confirmed'};}
  async close(){this.closes++;}
}
export async function createPilots(count=6){
  const pilots=[];
  for(let i=0;i<count;i++){
    const environment=new PilotEnvironment(`pilot-${i}`);await environment.start();
    const received={text:`Received mission for pilot-${i}`,version:100+i,status:'active' as const};
    const bridge=new Bridge(environment,undefined,{environmentOwnership:'borrowed',goalProvider:{get:()=>received},limits:{maxMediaBytes:1024,maxImages:1,maxJobs:8}});
    await bridge.start();pilots.push({environment,bridge,tools:createHandlers(bridge,{stop:false,waitMode:'park'})});
  }
  return pilots;
}
