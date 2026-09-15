import { ChangeSignal } from '../changes.ts';
import { bytes, fail, stable } from '../util.ts';
import type { Command, CommandContext, ControlOutcome, Environment, Event, ImageAttachment, Profile, Receipt, Snapshot } from '../types.ts';

export interface RecordingFrame { snapshot:Snapshot; images?:ImageAttachment[]; action?:Command; receipt?:Receipt }
/** Finite evidence replay. It never fabricates an outcome for an unrecorded action. */
export class RecordedEnvironment implements Environment {
  readonly profile:Profile;readonly changes=new ChangeSignal();
  private frames:RecordingFrame[];private index=0;private through=0;
  private events=new Map<number,Event>();
  constructor(profile:Profile,frames:RecordingFrame[],maxBytes=1048576) {
    if(!frames.length || frames.length>1024 || bytes(frames)>maxBytes)fail('capacity','Recording exceeds declared capacity.');
    this.profile=structuredClone(profile);this.frames=structuredClone(frames);
    this.retain(this.frames[0]!);
  }
  async start():Promise<void>{}
  async snapshot(after:number):Promise<Snapshot> {
    const snapshot=structuredClone(this.frames[this.index]!.snapshot);
    const unread=[...this.events.values()].filter(e=>e.seq>Math.max(after,this.through)).sort((a,b)=>a.seq-b.seq);
    snapshot.events=structuredClone(unread.slice(0,64));snapshot.hasMore ||= unread.length>64;return snapshot;
  }
  async capture():Promise<ImageAttachment[]>{return structuredClone(this.frames[this.index]!.images ?? []);}
  acknowledge(through:number):void{this.through=Math.max(this.through,through);for(const seq of this.events.keys())if(seq<=through)this.events.delete(seq);}
  wait(signal:AbortSignal){return this.changes.wait(this.changes.sequence,signal);}
  advance():void {
    if(this.frames[this.index]!.action)fail('replay_divergence','Expected a recorded action before advancing.');
    this.next();
  }
  private retain(frame:RecordingFrame):void {
    const events=new Map(this.events);
    for(const event of frame.snapshot.events)if(event.seq>this.through){const old=events.get(event.seq);if(old&&stable(old)!==stable(event))fail('replay_divergence','Recorded event ID changed payload.');events.set(event.seq,structuredClone(event));}
    if(events.size>256 || bytes([...events.values()])>65536)fail('capacity','Recorded unread events require backpressure.');
    this.events=events;
  }
  private next():void{if(this.index+1>=this.frames.length)fail('replay_end','End of recording.');this.retain(this.frames[this.index+1]!);this.index++;this.changes.notify();}
  async execute(command:Command,context:CommandContext):Promise<Receipt> {
    context.signal.throwIfAborted();context.assertCurrent?.();const frame=this.frames[this.index]!;
    if(!frame.action || stable(frame.action)!==stable(command))return {id:command.id,status:'rejected',reason:'replay_divergence'};
    if(!frame.receipt || frame.receipt.id!==command.id || this.index+1>=this.frames.length)fail('replay_divergence','Recording has no matching outcome.');
    this.next();return structuredClone(frame.receipt);
  }
  async cancel():Promise<ControlOutcome>{return {status:'unknown',reason:'Cancellation is not recorded.'};}
  async stop():Promise<ControlOutcome>{return {status:'confirmed',reason:'Replay has no physical effects.'};}
  async close():Promise<void>{}
}
