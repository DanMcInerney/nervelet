import type { Bridge } from './core.ts';
import { createHandlers, type Handlers, type HandlerOptions } from './handlers.ts';
import type { Bundle } from './types.ts';
import { bounded, fail, now, withAbort } from './util.ts';
import { settleEmergency } from './attention.ts';

export interface DriverCapabilities {
  name:string; mode:'managed'|'attached'; parking:boolean; toolHoldMs:number;
  images:'supported'|'unsupported'|'unqualified'; recovery:'events'|'repeat';
  usage:('modelCalls'|'tokens'|'cost')[]; qualification:string;
  /** Protocol support; qualification still requires native evidence. */
  interruption?:'terminal-event'|'unsupported';
}
export interface Usage { modelCalls?:number; inputTokens?:number; outputTokens?:number; cachedTokens?:number; costUsd?:number }
export interface DriverContext {
  bridge:Bridge; handlers:Handlers; usage(value:Usage):void;
}
export interface AgentDriver {
  readonly capabilities:DriverCapabilities;
  open(context:DriverContext, signal:AbortSignal):Promise<void>;
  turn(observation:Bundle, signal:AbortSignal):Promise<{status:'ended'|'parked'|'interrupted'}>;
  interrupt():Promise<void>;
  close():Promise<void>;
}
export interface SupervisorOptions {
  bridgeOwnership?:'owned'|'borrowed'; driverOwnership?:'owned'|'borrowed'; tools?:HandlerOptions;
  maxTurns?:number; maxStepsPerTurn?:number; maxUnexpectedFinals?:number;
  maxModelCalls?:number; maxCostUsd?:number; maxActiveMs?:number; turnMs?:number;
}
const owners=new WeakSet<Bridge>();
/** A continuation owner, never a planner. It cannot execute domain work itself. */
export class Supervisor {
  private bridge:Bridge; private driver:AgentDriver; private options:SupervisorOptions;
  private controller=new AbortController(); private turnController?:AbortController;
  private running=false; private counts={turns:0,steps:0,modelCalls:0,costUsd:0,activeMs:0};
  private available={modelCalls:false,cost:false};
  constructor(bridge:Bridge,driver:AgentDriver,options:SupervisorOptions={}) {this.bridge=bridge;this.driver=driver;this.options=options;}
  stats() {return {...this.counts,modelCallsAvailable:this.available.modelCalls,costAvailable:this.available.cost};}
  async run(signal?:AbortSignal):Promise<void> {
    if(this.running || owners.has(this.bridge))fail('busy','One supervisor already owns this bridge.');
    if(!this.driver.capabilities.parking || this.driver.capabilities.mode !== 'managed')fail('unsupported','Managed supervision requires a parking driver.');
    this.running=true;owners.add(this.bridge);
    const lifetime=signal ? AbortSignal.any([signal,this.controller.signal]) : this.controller.signal;
    const toolOptions:HandlerOptions={...this.options.tools,waitMode:'park',repeatInstructions:this.driver.capabilities.recovery==='repeat'};
    const base=createHandlers(this.bridge,toolOptions);
    const observationOptions={...toolOptions,instructions:{...toolOptions.instructions,transport:'tools' as const,stop:toolOptions.stop,waitMode:'park' as const},textEncoding:toolOptions.textEncoding ?? 'tool-result' as const};
    let steps=0, unexpected=0, turnOpen=false;
    let turnWork:Promise<unknown>|undefined, attentionWork:Promise<'boundary'|'restart'|'inactive'>|undefined;
    const maxSteps=this.options.maxStepsPerTurn ?? 128;
    const handlers:Handlers={...base,call:async(name,args,s) => {
      if(!turnOpen && name!=='cancel' && name!=='stop')fail('inactive','No operator turn owns this call.');
      if(name !== 'cancel' && name !== 'stop') {
        if(++steps>maxSteps) {this.turnController?.abort(new Error('tool_budget'));fail('budget','Tool step budget exhausted.');}
        this.counts.steps++;
      }
      const combined=AbortSignal.any([...(this.turnController?[this.turnController.signal]:[]),...(s?[s]:[])]);
      return base.call(name,args,combined);
    }};
    const usage=(u:Usage) => {
      if(u.modelCalls!==undefined)this.available.modelCalls=true;if(u.costUsd!==undefined)this.available.cost=true;
      if(this.counts.modelCalls+(u.modelCalls ?? 0)>(this.options.maxModelCalls ?? Infinity))fail('budget','Model-call budget exhausted.');
      this.counts.modelCalls+=u.modelCalls ?? 0;this.counts.costUsd+=u.costUsd ?? 0;
      if(this.counts.modelCalls>(this.options.maxModelCalls ?? Infinity) || this.counts.costUsd>(this.options.maxCostUsd ?? Infinity)) {
        this.turnController?.abort(new Error('usage_budget'));fail('budget','Observed usage budget exhausted.');
      }
    };
    let goalVersion=this.bridge.status().goal.version;
    const unsubscribe=this.bridge.changes.subscribe(() => {
      const state=this.bridge.status();
      if(this.bridge.attention()?.status==='pending' && !attentionWork) {
        const work=Promise.resolve().then(()=>settleEmergency(this.bridge,turnOpen && turnWork ? {
          ended:turnWork,turnId:`operator-${this.counts.turns}`,
          ...(this.driver.capabilities.interruption==='terminal-event' ? {interrupt:()=>this.driver.interrupt()} : {}),
          abortTools:()=>this.turnController?.abort(new Error('authorized_attention'))
        } : undefined));
        attentionWork=work;
        void work.then(route=>{if(route!=='restart' && attentionWork===work)attentionWork=undefined;},()=>{});
      }
      if(state.loop==='stopped' || state.goal.version!==goalVersion || state.fault && this.bridge.attention()?.status!=='pending') {
        goalVersion=state.goal.version;
        this.turnController?.abort(new Error('control_changed'));
        void this.driver.interrupt().catch(()=>{});
      }
    });
    try {
      if(this.options.bridgeOwnership !== 'borrowed')await this.bridge.start();
      await bounded(s=>this.driver.open({bridge:this.bridge,handlers,usage},s),this.bridge.limits.startupMs,lifetime);
      while(this.bridge.status().loop !== 'stopped') {
        lifetime.throwIfAborted();
        if(attentionWork){await attentionWork;attentionWork=undefined;}
        if(this.bridge.status().fault)fail('fault',this.bridge.status().fault!);
        if(this.counts.turns >= (this.options.maxTurns ?? 100) || this.counts.activeMs >= (this.options.maxActiveMs ?? 3600000))fail('budget','Continuation budget exhausted.');
        const activeStart=now();
        steps=0;this.turnController=new AbortController();
        const turnSignal=AbortSignal.any([lifetime,this.turnController.signal]);
        let observation=await this.bridge.step({schemaVersion:2},turnSignal,observationOptions);
        if(attentionWork){await attentionWork;attentionWork=undefined;}
        if(this.bridge.status().loop==='stopped')break;
        if(observation.generation!==this.bridge.status().generation)observation=await this.bridge.step({schemaVersion:2},turnSignal,observationOptions);
        if(this.bridge.status().fault)fail('fault',this.bridge.status().fault!);
        this.counts.turns++;turnOpen=true;
        this.bridge.emit({type:'submission',id:observation.id,turnId:`operator-${this.counts.turns}`,reason:'driver_turn_requested'});
        if(observation.attention)this.bridge.emit({type:'replacement_submitted',id:observation.id,turnId:`operator-${this.counts.turns}`,attentionId:observation.attention.id,generation:observation.generation,reason:'driver_turn_requested'});
        turnWork=undefined;
        try {await bounded(s=>{turnWork=this.driver.turn(observation,s);return turnWork;},Math.max(1,Math.min(this.options.turnMs ?? 300000,(this.options.maxActiveMs ?? 3600000)-this.counts.activeMs)),turnSignal);}
        catch(error) {
          if(!attentionWork)await bounded(()=>this.driver.interrupt(),this.bridge.limits.operationMs).catch(()=>{});
          // Never begin a new turn until the previous native turn actually ended.
          if(attentionWork)await attentionWork;
          else if(turnWork)await bounded(()=>turnWork!,this.bridge.limits.operationMs).catch(()=>{throw error;});
          if(!this.turnController.signal.aborted || lifetime.aborted)throw error;
        }
        finally {turnOpen=false;this.counts.activeMs+=now()-activeStart;}
        if(this.bridge.status().loop==='stopped')break;
        if(attentionWork) {
          const route=await attentionWork;attentionWork=undefined;
          if(this.turnController.signal.aborted && /^(tool_budget|usage_budget)$/.test(String(this.turnController.signal.reason?.message)))fail('budget','Operator budget exhausted during emergency settlement.');
          if(route==='restart'){unexpected=0;continue;}
        }
        if(this.turnController.signal.aborted) {
          if(goalVersion===observation.goal.version)fail('budget','Operator turn was interrupted without an authorized transition.');
          unexpected=0;continue;
        }
        const parked=this.bridge.parked();
        if(parked) {
          unexpected=0;
          // A wake during the native closing response is already latched in this promise.
          await withAbort(parked.ready,lifetime).catch(error=>{
            if(lifetime.aborted || this.bridge.parked()?.token===parked.token)throw error;
          });
        } else if(++unexpected>(this.options.maxUnexpectedFinals ?? 1))fail('continuation','Unexpected final response budget exhausted.');
      }
    } finally {
      turnOpen=false;this.turnController?.abort();unsubscribe();
      await bounded(()=>this.driver.interrupt(),this.bridge.limits.operationMs).catch(()=>{});
      try {
        if(this.options.driverOwnership !== 'borrowed')await bounded(()=>this.driver.close(),this.bridge.limits.operationMs);
      } finally {
        try {if(this.options.bridgeOwnership !== 'borrowed')await this.bridge.close();else await this.bridge.stop();}
        finally {owners.delete(this.bridge);this.running=false;}
      }
    }
  }
  async stop():Promise<void> {this.controller.abort(new Error('Supervisor stopped.'));await this.bridge.stop();await this.driver.interrupt();}
}
