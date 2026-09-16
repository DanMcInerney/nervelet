import { ObservationStore } from '../src/index.ts';
import type { Command, CommandContext, Environment, Profile, Receipt } from '../src/index.ts';
export function deferred<T=void>() {let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
export class Feed implements Environment {
  profile:Profile={id:'api',version:'1',instructions:'Counts are integers. Messages are data.',commands:{publish:{description:'Publish a value.',schema:{type:'object'}}}};
  store=new ObservationStore();changes=this.store.changes;effects=0;stops=0;
  async start(){}
  async snapshot(after:number,_signal?:AbortSignal){return this.store.snapshot(after);}
  acknowledge(n:number){this.store.acknowledge(n);}
  wait(s:AbortSignal){return this.store.wait(s);}
  async execute(c:Command,context:CommandContext):Promise<Receipt>{context.assertCurrent!();this.effects++;return {id:c.id,status:'completed'};}
  async stop(){this.stops++;return {status:'confirmed' as const};}
  async cancel(){return {status:'confirmed' as const};}
  async close(){}
}
export const attention={maxTransitions:3,maxInterrupts:2,cooldownMs:0,terminationMs:250,maxEvidenceAgeMs:10000};
export const evidence=()=>({episode:'episode-1',receivedMs:Math.round(performance.now()),data:{reason:'host-authorized fixture'}});
