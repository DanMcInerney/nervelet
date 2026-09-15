import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { ObservationStore } from '../store.ts';
import { fail, now, object } from '../util.ts';
import type { Command, CommandContext, Environment, Job, Json, Profile, Receipt, Sample } from '../types.ts';

export interface SerialOptions {
  path?: string;
  baudRate?: number;
  profile: Profile;
  staleMs?: number;
  /** Injectable byte stream for embedding and deterministic protocol tests. */
  stream?: Duplex;
}
type Pending={resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void;cleanup:()=>void;onReply?:(value:Record<string,unknown>)=>void};

/** JSON-lines protocol v1. SerialPort is loaded only when a real port is requested. */
export class SerialEnvironment implements Environment {
  readonly profile:Profile;
  readonly store=new ObservationStore();
  private options:SerialOptions;
  private stream?:Duplex;
  private pending=new Map<string,Pending>();
  private jobs=new Map<string,Job>();
  private input=Buffer.alloc(0);
  private controlSequence=0;
  private controlEpoch=randomUUID();
  private watchdog?:NodeJS.Timeout;
  private lastReceived=0;
  private sourceClock?:string;
  private sourceSequence=-1;
  private ready=false;
  private closed=false;
  private faulted=false;
  constructor(options:SerialOptions) {
    this.options=options;this.profile=structuredClone(options.profile);
    if(!options.stream&&!options.path)fail('invalid_config','Serial adapter requires path or stream.');
    if(options.staleMs!==undefined&&(!Number.isSafeInteger(options.staleMs)||options.staleMs<250||options.staleMs>60000))fail('invalid_config','staleMs must be 250..60000.');
  }
  async start(signal:AbortSignal):Promise<void> {
    if(this.options.stream)this.stream=this.options.stream;
    else {
      const {SerialPort}=await import('serialport').catch(()=>fail('missing_dependency','Install the optional serialport dependency to use a device.'));
      const port=new SerialPort({path:this.options.path!,baudRate:this.options.baudRate??115200,autoOpen:false});
      this.stream=port;
    }
    this.stream.on('data',chunk=>this.receive(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)));
    this.stream.on('error',error=>this.fault(`serial_error: ${error.message}`));
    this.stream.on('close',()=>{if(!this.closed)this.fault('serial_disconnected');});
    if(!this.options.stream)await new Promise<void>((resolve,reject)=>(this.stream as import('serialport').SerialPort).open(error=>error?reject(error):resolve()));
    while(!this.ready) {
      signal.throwIfAborted();if(this.store.fault)fail('serial_fault',this.store.fault);
      await this.store.wait(signal);
    }
    // Reconcile startup to a stopped device before admitting any new-epoch command.
    await this.stop(signal);
    this.watchdog=setInterval(()=>{
      if(now()-this.lastReceived>(this.options.staleMs??2000))this.fault('stale_serial_telemetry');
      if(!this.store.fault){try{this.write({type:'heartbeat'});}catch{this.fault('serial_write_backpressure');}}
    },250);
  }
  private write(value:unknown):void {
    if(!this.stream||this.closed||this.stream.destroyed)fail('serial_closed','Serial connection is closed.');
    if(this.stream.writableLength>8192)fail('serial_backpressure','Serial output is blocked.');
    const line=JSON.stringify(value)+'\n';if(Buffer.byteLength(line)>8192)fail('capacity','Serial frame exceeds capacity.');
    this.stream.write(line,error=>{if(error)this.fault('serial_write_failed');});
  }
  private fault(reason:string):void {
    if(this.faulted)return;
    this.faulted=true;
    this.store.setFault(reason);
    for(const item of [...this.pending.values()]){item.cleanup();item.reject(new Error(reason));}
    for(const job of this.jobs.values())if(job.status==='running'||job.status==='blocked'){job.status='failed';job.reason=reason;job.updatedMs=now();}
    // Best effort now; firmware's independent heartbeat watchdog is the final stop path.
    try{this.write({type:'stop',id:`ctl:${this.controlEpoch}:${++this.controlSequence}`});}catch{}
  }
  private receive(chunk:Buffer):void {
    if(this.closed)return;
    this.input=Buffer.concat([this.input,chunk]);
    try {
      let end:number;
      while((end=this.input.indexOf(10))>=0) {
        if(end>8192)fail('invalid_frame','Serial frame exceeds capacity.');
        const line=this.input.subarray(0,end).toString('utf8').trim();this.input=this.input.subarray(end+1);
        if(!line)continue;
        const packet:unknown=JSON.parse(line);if(!object(packet))fail('invalid_frame','Expected a serial JSON object.');
        this.packet(packet);
      }
      if(this.input.length>8192)fail('invalid_frame','Serial frame exceeds capacity.');
    }catch{this.input=Buffer.alloc(0);this.fault('invalid_serial_frame');}
  }
  private packet(packet:Record<string,unknown>):void {
    if(packet.type==='sample') {
      if(typeof packet.clock!=='string'||packet.clock.length>64||typeof packet.seq!=='number'||!Number.isSafeInteger(packet.seq)||packet.seq<0||typeof packet.atMs!=='number'||!Number.isFinite(packet.atMs)||packet.atMs<0||typeof packet.valid!=='boolean'||!object(packet.samples))fail('invalid_frame','Invalid sample envelope.');
      if(this.sourceClock!==undefined&&(this.sourceClock!==packet.clock||packet.seq<=this.sourceSequence)) {this.fault('device_clock_reset_or_out_of_order');return;}
      this.sourceClock=packet.clock;this.sourceSequence=packet.seq;this.lastReceived=now();
      const sample=(value:unknown):Sample=>({value:value as Json,receivedMs:this.lastReceived,acquired:{clock:packet.clock as string,ms:packet.atMs as number},valid:packet.valid as boolean,maxAgeMs:this.options.staleMs??2000});
      if(packet.state!==undefined)this.store.setState(sample(packet.state));
      for(const [name,value]of Object.entries(packet.samples))this.store.setSample(name,sample(value));
      if(!packet.valid){this.fault('invalid_serial_telemetry');return;}
      if(!this.ready){this.ready=true;this.store.wake();}
    } else if(packet.type==='receipt'||packet.type==='control') {
      if(typeof packet.id!=='string')fail('invalid_frame','Missing receipt ID.');
      const pending=this.pending.get(packet.id);if(pending){pending.onReply?.(packet);pending.cleanup();pending.resolve(packet);}
    } else if(packet.type==='event') {
      if(typeof packet.kind!=='string'||packet.kind.length>64||packet.data===undefined)fail('invalid_frame','Invalid event.');
      if(!this.store.push(packet.kind,packet.data as Json))this.fault('event_backpressure');
    } else if(packet.type==='job') {
      if(typeof packet.id!=='string'||!['running','completed','cancelled','failed','blocked'].includes(String(packet.status)))fail('invalid_frame','Invalid job update.');
      const job=this.jobs.get(packet.id);if(!job){this.fault('unknown_device_job');return;}
      if(job.status!=='running'&&job.status!=='blocked') {
        if(packet.status==='running'||packet.status==='blocked')this.fault('terminal_job_restarted');
        return;
      }
      job.status=packet.status as Job['status'];job.updatedMs=now();
      if(typeof packet.reason==='string')job.reason=packet.reason.slice(0,256);
      if(!this.store.push('job',{id:job.id,status:job.status}))this.fault('event_backpressure');
    } else fail('invalid_frame','Unknown serial message type.');
  }
  private rpc(payload:Record<string,unknown>,signal:AbortSignal,onReply?:(value:Record<string,unknown>)=>void):Promise<Record<string,unknown>> {
    signal.throwIfAborted();
    if(this.pending.size>=16)fail('serial_backpressure','Too many pending device requests.');
    return new Promise((resolve,reject)=>{
      const id=String(payload.id);
      const cleanup=()=>{this.pending.delete(id);signal.removeEventListener('abort',abort);};
      const abort=()=>{cleanup();reject(signal.reason);};
      this.pending.set(id,{resolve,reject,cleanup,onReply});signal.addEventListener('abort',abort,{once:true});
      try{this.write(payload);}catch(error){cleanup();reject(error);}
    });
  }
  async execute(command:Command,context:CommandContext):Promise<Receipt> {
    if(this.store.fault)return {id:command.id,status:'rejected',reason:this.store.fault};
    if(!this.ready||now()-this.lastReceived>(this.options.staleMs??2000))return {id:command.id,status:'rejected',reason:'stale_serial_telemetry'};
    const resource=this.profile.commands[command.kind]?.resource;
    if(resource&&[...this.jobs.values()].some(job=>(job.status==='running'||job.status==='blocked')&&this.profile.commands[job.kind]?.resource===resource))return {id:command.id,status:'rejected',reason:'resource_busy'};
    let result:Receipt|undefined;
    await this.rpc({type:'command',id:`${context.epoch}:${command.id}`,kind:command.kind,args:command.args},context.signal,raw=>{result=this.admission(command,raw);});
    return result!;
  }
  private admission(command:Command,raw:Record<string,unknown>):Receipt {
    if(raw.type!=='receipt'||!['accepted','completed','rejected'].includes(String(raw.status)))fail('invalid_receipt','Invalid device admission receipt.');
    const result:Receipt={id:command.id,status:raw.status as Receipt['status']};
    if(raw.reason!==undefined){if(typeof raw.reason!=='string')fail('invalid_receipt','Invalid rejection reason.');result.reason=raw.reason.slice(0,256);}
    if(raw.status==='accepted') {
      if(typeof raw.jobId!=='string'||raw.jobId.length>128||this.jobs.has(raw.jobId))fail('invalid_receipt','Invalid or reused job ID.');
      if(this.jobs.size>=16){const terminal=[...this.jobs.values()].find(j=>j.status!=='running'&&j.status!=='blocked');if(terminal)this.jobs.delete(terminal.id);else fail('capacity','Device job capacity exceeded.');}
      const at=now();this.jobs.set(raw.jobId,{id:raw.jobId,status:'running',commandId:command.id,kind:command.kind,args:command.args,startedMs:at,updatedMs:at});result.jobId=raw.jobId;
    }
    return result;
  }
  async cancel(id:string,signal:AbortSignal):Promise<void> {
    const job=this.jobs.get(id);if(!job)fail('unknown_job','Unknown or expired device job.');
    if(job.status!=='running'&&job.status!=='blocked')return;
    const result=await this.rpc({type:'cancel',id:`ctl:${this.controlEpoch}:${++this.controlSequence}`,jobId:id},signal);
    if(result.type!=='control'||result.ok!==true)fail('cancel_failed','Device did not confirm cancellation.');
    if(job.status==='running'||job.status==='blocked'){job.status='cancelled';job.updatedMs=now();}this.store.wake();
  }
  async stop(signal:AbortSignal):Promise<void> {
    const result=await this.rpc({type:'stop',id:`ctl:${this.controlEpoch}:${++this.controlSequence}`},signal);
    if(result.type!=='control'||result.ok!==true)fail('stop_failed','Device did not confirm Stop.');
    for(const job of this.jobs.values())if(job.status==='running'||job.status==='blocked'){job.status='cancelled';job.updatedMs=now();}
    this.store.wake();
  }
  async snapshot(after:number){return this.store.snapshot(after,[...this.jobs.values()]);}
  acknowledge(through:number):void{this.store.acknowledge(through);}
  wait(signal:AbortSignal){return this.store.wait(signal);}
  async close():Promise<void> {
    this.closed=true;if(this.watchdog)clearInterval(this.watchdog);
    for(const pending of [...this.pending.values()]){pending.cleanup();pending.reject(new Error('Adapter closed.'));}
    this.stream?.destroy();
  }
}
export const createSerialEnvironment=(options:SerialOptions)=>new SerialEnvironment(options);
