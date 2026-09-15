import { ObservationStore } from '../store.ts';
import { fail, now } from '../util.ts';
import type { Command, CommandContext, ControlOutcome, Environment, Job, Profile, Receipt } from '../types.ts';

export const demoProfile: Profile = {
  id:'demo',version:'1',
  instructions:'Simulated bench. temperature is degrees C; position is an abstract counter. Samples refresh every 50 ms. Move is a local timed job, not an instant position change. No hardware is connected.',
  commands:{
    set_led:{description:'Set the simulated LED.',resource:'led',schema:{type:'object',properties:{on:{type:'boolean'}},required:['on'],additionalProperties:false}},
    move:{description:'Start a timed simulated movement. One movement at a time.',resource:'motion',schema:{type:'object',properties:{durationMs:{type:'integer',minimum:50,maximum:30000}},required:['durationMs'],additionalProperties:false}},
    sample:{description:'Acquire a temperature sample.',schema:{type:'object',properties:{},additionalProperties:false}}
  }
};

export class DemoEnvironment implements Environment {
  readonly profile = structuredClone(demoProfile);
  readonly store = new ObservationStore();
  readonly changes = this.store.changes;
  private timer?: NodeJS.Timeout;
  private jobs = new Map<string,Job>();
  private led = false;
  private position = 0;
  private ticks = 0;
  async start(): Promise<void> { this.acquire(); this.timer = setInterval(()=>this.tick(),50); }
  private acquire(): void {
    const at = now();
    this.store.setState({value:{led:this.led,position:this.position,velocity:this.active()?1:0},receivedMs:at,acquired:{clock:'bridge',ms:at},valid:true,maxAgeMs:500});
    this.store.setSample('temperature',{value:24+Math.round(Math.sin(this.ticks/20)*10)/10,receivedMs:at,acquired:{clock:'bridge',ms:at},valid:true,maxAgeMs:500});
  }
  private tick(): void {
    this.ticks++;
    const active = this.active();
    if (active) {
      this.position++;
      if (now()-active.startedMs >= Number(active.args.durationMs)) this.finish(active,'completed');
    }
    if (this.store.fault && active) this.finish(active,'failed','event_backpressure');
    this.acquire();
  }
  private active() { return [...this.jobs.values()].find(j=>j.status==='running'); }
  private finish(job:Job,status:Job['status'],reason?:string) {
    job.status=status;job.updatedMs=now();if(reason)job.reason=reason;
    this.store.push('job',{id:job.id,status,...(reason?{reason}:{})}); this.store.wake();
  }
  async snapshot(after:number) { return this.store.snapshot(after,[...this.jobs.values()]); }
  acknowledge(through:number):void {this.store.acknowledge(through);}
  wait(signal:AbortSignal) {return this.store.wait(signal);}
  async execute(command:Command,context:CommandContext):Promise<Receipt> {
    context.signal.throwIfAborted();
    context.assertCurrent?.();
    if(this.store.fault)return {id:command.id,status:'rejected',reason:this.store.fault};
    if(command.kind==='move') {
      if(this.active())return {id:command.id,status:'rejected',reason:'motion_busy'};
      if(this.jobs.size>=16) {
        const terminal=[...this.jobs.values()].find(j=>j.status!=='running');
        if(terminal)this.jobs.delete(terminal.id);
      }
      const id=`demo-${command.id}`;
      const at=now();
      this.jobs.set(id,{id,status:'running',commandId:command.id,kind:command.kind,args:command.args,startedMs:at,updatedMs:at});
      this.acquire();this.store.wake();return {id:command.id,status:'accepted',jobId:id};
    }
    if(command.kind==='set_led')this.led=Boolean(command.args.on);
    else if(command.kind!=='sample')return {id:command.id,status:'rejected',reason:'unknown_command'};
    this.acquire();return {id:command.id,status:'completed'};
  }
  async cancel(id:string):Promise<ControlOutcome> {
    const job=this.jobs.get(id);if(!job)fail('unknown_job','Unknown or expired job.');
    if(job.status==='running')this.finish(job,'cancelled');this.acquire();
    return {status:'confirmed'};
  }
  async stop():Promise<ControlOutcome> {const job=this.active();if(job)this.finish(job,'cancelled');this.acquire();return {status:'confirmed'};}
  async close():Promise<void> {if(this.timer)clearInterval(this.timer);this.timer=undefined;}
}
export const createDemoEnvironment = () => new DemoEnvironment();
