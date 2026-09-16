import type { Bridge } from './core.ts';
import { bounded, fail } from './util.ts';

export interface AttentionTurn {
  /** Resolves only after the matching native turn has ended and tool/result work settled.
   * An interrupt RPC acknowledgement or locally aborted wait is not this promise. */
  ended:Promise<unknown>;
  turnId?:string;
  /** Omit if the binding cannot confirm terminal lifecycle events. */
  interrupt?:()=>Promise<void>;
  abortTools?:()=>void;
}
const transitions=new WeakMap<Bridge,Promise<'boundary'|'restart'|'inactive'>>();
/** Minimal sequencing for hosts that already own actors. Does not create or submit a turn. */
export function settleEmergency(bridge:Bridge, turn?:AttentionTurn):Promise<'boundary'|'restart'|'inactive'> {
  const existing=transitions.get(bridge);if(existing)return existing;
  const attention=bridge.attention(), config=bridge.attentionOptions;
  if(!attention || attention.status!=='pending' || !config)return Promise.resolve('inactive');
  const current=()=>bridge.status().loop!=='stopped' && bridge.attention()?.id===attention.id;
  const deadline=performance.now()+config.terminationMs;
  const remaining=()=>Math.max(1,deadline-performance.now());
  const work=(async()=>{
    try {
      // A held wait, command or capture may deliver the capsule through its open result.
      if(bridge.stepInFlight)await bounded(()=>bridge.whenIdle(),remaining());
      if(!current())return 'inactive' as const;
      let route:'boundary'|'restart'='boundary';
      if(turn && !bridge.attention()!.delivered) {
        let ended=false;void turn.ended.then(()=>{ended=true;},()=>{ended=true;});
        await Promise.resolve();
        if(!ended) {
          if(!turn.interrupt)fail('unsupported_interrupt','This binding cannot interrupt and confirm matching native termination.');
          bridge.beginAttentionInterrupt(attention.id);
          // Register the native interruption before invalidating tool request signals.
          const interrupt=turn.interrupt();turn.abortTools?.();
          await bounded(()=>interrupt,remaining());
        }
        await bounded(()=>turn.ended,remaining());
        bridge.emit({type:'turn_ended',turnId:turn.turnId,attentionId:attention.id,reason:'authorized_attention'});
        route='restart';
      }
      if(!current())return 'inactive' as const;
      await bounded(s=>bridge.settleAttention(attention.id,s),remaining());
      return route;
    } catch(error) {bridge.failAttention(attention.id,error);throw error;}
  })();
  transitions.set(bridge,work);
  void work.finally(()=>{if(transitions.get(bridge)===work)transitions.delete(bridge);}).catch(()=>{});
  return work;
}
