import { randomUUID, createHash } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { bounded, boundedText, bytes, fail, message, now, stable, withAbort } from './util.ts';
import type { AttentionEvidence, AttentionOptions, AttentionState, Bundle, Command, ControlOutcome, Environment, Goal, GoalProvider, InstructionOptions, Limits, Receipt, Snapshot, StepOptions, StepRequest, Trace } from './types.ts';
import { instructions, reminder } from './instructions.ts';
import { fragmentSize, observationText, textSize } from './presentation.ts';
import { ChangeSignal } from './changes.ts';
import { evaluateWait, type LogicalWait } from './waits.ts';
import { stepSchema } from './schemas.ts';

export { RULE } from './instructions.ts';
export const DEFAULT_LIMITS: Limits = {
  maxRequestBytes: 16384, maxCommandBytes: 4096, maxBundleBytes: 32768, maxGoalBytes: 4096, maxProfileBytes: 16384,
  maxBatch: 8, maxWaitMs: 30000, operationMs: 2000, startupMs: 10000, receiptHistory: 128, bundleHistory: 32,
  maxRecoveryBytes: 32768, maxMediaBytes: 4194304, maxImages: 4, maxCheckpointBytes: 1024, maxReviewMs: 86400000, maxJobs: 128
};
type Delivery = { through: number; generation: number; goalVersion: number; resultIds:string[]; attentionId?:string; submitted?:boolean };
const validateStep = new Ajv({ strict: true }).compile<StepRequest>(stepSchema);
export interface BridgeOptions {
  retainCommandArguments?: boolean;
  /** Trusted host attention only; omitted disables all emergency transitions. */
  attention?: AttentionOptions;
  /** Borrowed hosts confirm final output, after their formatting/transport work.
   * Assembly is never sufficient for attention's open-boundary route in this mode. */
  submission?: 'host';
  instructions?: InstructionOptions;
  limits?: Partial<Limits>; note?: () => Promise<string | undefined>; saveGoal?: (goal: Goal) => Promise<void>;
  saveCheckpoint?: (text: string) => Promise<void>; goalProvider?: GoalProvider;
  environmentOwnership?: 'owned' | 'borrowed'; allowIndefiniteWait?: boolean; trace?: (event: Trace) => void;
}

export class Bridge {
  readonly epoch = randomUUID();
  readonly loopRef: string;
  readonly changes = new ChangeSignal();
  readonly environment: Environment;
  readonly limits: Limits;
  readonly profileText: string;
  private validators = new Map<string, ValidateFunction>();
  private profileDigest: string;
  private goal: Goal;
  private stopped = false;
  private fault?: string;
  private transition = false;
  private inStep = false;
  private generation = 1;
  private refreshed = 0;
  private recoveryReason = 'startup; prior-process observations and receipts are not retained';
  private sequence = 0;
  private started = false;
  private persistence: Promise<void> = Promise.resolve();
  private through = 0;
  private highestCommand = 0;
  private deliveries = new Map<string, Delivery>();
  private receipts = new Map<string, { digest: string; result: Receipt; kind: string; command?: Command; acknowledged?:boolean }>();
  private operations = new AbortController();
  private acquisition = new AbortController();
  private lifetime = new AbortController();
  private note?: () => Promise<string | undefined>;
  private saveGoal?: (goal: Goal) => Promise<void>;
  private options: BridgeOptions;
  private pending?: LogicalWait;
  private waitSequence = 0;
  private deliveredThrough = 0;
  private unsubscribe?: () => void;
  private unsubscribeGoals?: () => void;
  private control?: ControlOutcome;
  private controlRevision = 0;
  private closed = false;
  private observedJobs=new Map<string,string>();
  private attentionState?:AttentionState;
  private attentionEvidence?:AttentionEvidence;
  private attentionArmed=true;
  private attentionTransitions=0;
  private attentionInterrupts=0;
  private attentionAt=-Infinity;
  private firstAttentionAdmission=false;
  private stepIdle:Promise<void>=Promise.resolve();
  private resolveStepIdle?:()=>void;
  private snapshotCount=0;
  private instructionCache=new Map<string,{rule:string;instructions:string}>();

  constructor(environment: Environment, goal?: string | Goal, options: BridgeOptions = {}) {
    this.environment = environment;
    this.options = options;
    if(options.attention) {
      for(const key of ['maxTransitions','maxInterrupts','cooldownMs','terminationMs','maxEvidenceAgeMs'] as const)if(!Number.isSafeInteger(options.attention[key]) || options.attention[key]<0)fail('invalid_config',`Attention requires an explicit ${key}.`);
      for(const [key,value] of Object.entries(options.attention))if(!Number.isSafeInteger(value) || value<0 || value>2147483647)fail('invalid_config',`Invalid attention limit: ${key}.`);
      for(const key of ['maxTransitions','terminationMs','maxEvidenceAgeMs'] as const)if(!(options.attention[key]>0))fail('invalid_config',`Attention requires ${key}.`);
    }
    this.loopRef = `${environment.profile.id}:${this.epoch}`;
    this.profileDigest = stable(environment.profile);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const [key,value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) fail('invalid_config', `Invalid limit: ${key}.`);
    }
    if (this.limits.maxBundleBytes < 1024) fail('invalid_config', 'Bundle limit must be at least 1024 bytes.');
    if (bytes(environment.profile) > this.limits.maxProfileBytes) fail('capacity', 'Profile exceeds capacity.');
    boundedText(environment.profile.id,128,'Profile ID');
    boundedText(environment.profile.version,128,'Profile version');
    const ajv = new Ajv({ strict: true, allErrors: false });
    for (const [name, definition] of Object.entries(environment.profile.commands)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) fail('invalid_config','Invalid command name.');
      this.validators.set(name,ajv.compile(definition.schema));
    }
    for (const field of Object.values(environment.profile.waitFields ?? {})) {
      if (!Number.isFinite(field.maxAgeMs) || field.maxAgeMs <= 0 || (field.path?.length ?? 0) > 8 || field.path?.some(k => ['__proto__','prototype','constructor'].includes(k))) fail('invalid_config','Invalid wait field.');
    }
    this.profileText = this.renderInstructions().instructions;
    this.goal = structuredClone(options.goalProvider?.get() ?? (typeof goal === 'string' ? { text: goal, version: 1, status: 'active' as const } : goal) ?? { text: '', version: 0, status: 'missing' });
    this.validateGoal(this.goal);
    if (bytes({rule:this.renderInstructions().rule,goal:this.goal,recovery:{generation:this.generation,reason:this.recoveryReason,instructions:this.profileText}})>this.limits.maxRecoveryBytes) fail('capacity','Required recovery records cannot fit.');
    this.note = options.note; this.saveGoal = options.saveGoal;
  }

  async start(): Promise<void> {
    if(this.started)fail('busy','Bridge has already started.');this.started=true;
    this.unsubscribe = this.environment.changes?.subscribe(() => this.changes.notify());
    this.unsubscribeGoals = this.options.goalProvider?.subscribe?.(goal => {
      void this.receiveGoal(goal).catch(error => { this.fault = `goal_provider: ${message(error)}`; this.changes.notify(); });
    });
    if (this.options.environmentOwnership !== 'borrowed') await bounded(signal => this.environment.start(signal),this.limits.startupMs,this.lifetime.signal);
    await this.persist();
  }
  private persist():Promise<void> {
    const goal={...this.goal};
    const next=this.persistence.catch(()=>{}).then(()=>this.saveGoal?.(goal));
    this.persistence=next;return next;
  }
  status() {
    return { epoch: this.epoch, loop: this.stopped ? 'stopped' : this.fault || this.transition || this.attentionState?.status==='pending' || this.goal.status !== 'active' || this.refreshed !== this.generation ? 'paused' : 'active', goal: { ...this.goal }, generation: this.generation, ...(this.fault ? { fault: this.fault } : {}), ...(this.control ? {control:{...this.control}} : {}) };
  }
  stats(){return {deliveries:this.deliveries.size,receipts:this.receipts.size,unresolved:[...this.receipts.values()].filter(r=>r.result.status==='unknown').length,parked:!!this.pending};}
  renderInstructions(options:InstructionOptions={}):{rule:string;instructions:string} {
    const config={...this.options.instructions,...options,requireGeneration:!!this.options.attention};
    const key=stable(config);let value=this.instructionCache.get(key);
    if(!value){value={rule:reminder(config),instructions:instructions(this.environment.profile,config)};if(this.instructionCache.size>=8)this.instructionCache.delete(this.instructionCache.keys().next().value!);this.instructionCache.set(key,value);}
    return {...value};
  }
  get attentionOptions():Readonly<AttentionOptions>|undefined {return this.options.attention ? {...this.options.attention} : undefined;}
  attention():AttentionState|undefined {return this.attentionState ? {...this.attentionState} : undefined;}
  /** Final host submission, not model acknowledgement or completed action. */
  confirmSubmission(id:string):void {
    const delivery=this.deliveries.get(id);
    if(!delivery)fail('unknown_bundle','Cannot submit an unknown or expired bundle.');
    if(delivery.submitted)return;
    delivery.submitted=true;
    if(this.attentionState && delivery.attentionId===this.attentionState.id && delivery.generation===this.generation &&
       delivery.goalVersion===this.goal.version && ['pending','ready'].includes(this.attentionState.status))this.attentionState.delivered=true;
    this.emit({type:'submission',id,generation:delivery.generation,attentionId:delivery.attentionId});
    this.changes.notify();
  }
  /** Failed final formatting/output keeps evidence and gates effects; never acknowledges mail. */
  failSubmission(id:string,error:unknown):void {
    const delivery=this.deliveries.get(id);
    if(delivery?.attentionId && !delivery.submitted && delivery.generation===this.generation && delivery.attentionId===this.attentionState?.id)
      this.failAttention(delivery.attentionId!,error);
  }
  /** Only waits when a current capsule was assembled for host submission.
   * The host must submit independently, never await settleEmergency inside that output. */
  async whenAttentionSubmitted(id:string,signal:AbortSignal):Promise<void> {
    if(this.options.submission!=='host')return;
    while(!this.stopped && this.attentionState?.id===id) {
      signal.throwIfAborted();
      const sequence=this.changes.sequence;
      if(this.attentionState.status==='fault')fail('fault',this.fault ?? 'Attention submission failed.');
      if(this.attentionState.delivered)return;
      if(![...this.deliveries.values()].some(d=>d.attentionId===id && d.generation===this.generation && d.goalVersion===this.goal.version))return;
      await this.changes.wait(sequence,signal);
    }
  }
  /** Host-only. The application retains reliable source events and owns physical response policy. */
  requestAttention(evidence:AttentionEvidence):AttentionState {
    const config=this.options.attention;
    if(!config)fail('unsupported','Emergency attention is disabled.');
    if(this.stopped || this.closed || this.transition || this.goal.status!=='active')fail('inactive','Attention cannot restart an inactive or changing goal.');
    boundedText(evidence.episode,128,'Attention episode');
    if(!Number.isFinite(evidence.receivedMs) || evidence.receivedMs<0 || evidence.receivedMs>now()+1 || now()-evidence.receivedMs>config.maxEvidenceAgeMs)fail('stale_attention','Attention needs fresh, host-monotonic receipt time. Historical evidence stays in the environment.');
    if(evidence.acquired && (!Number.isFinite(evidence.acquired.ms) || !evidence.acquired.clock || Buffer.byteLength(evidence.acquired.clock)>128))fail('invalid_input','Invalid acquisition clock.');
    if(evidence.eventIds && (evidence.eventIds.length>8 || evidence.eventIds.some(id=>typeof id!=='string' || Buffer.byteLength(id)>128)))fail('capacity','Too many attention event references.');
    if(bytes(evidence)>(config.maxEvidenceBytes ?? 1024))fail('capacity','Attention evidence exceeds its explicit duplicate-data budget.');
    if(this.attentionState && ['pending','ready'].includes(this.attentionState.status)) {
      this.attentionState.coalesced=Math.min(2147483647,this.attentionState.coalesced+1);
      this.emit({type:'attention_coalesced',attentionId:this.attentionState.id,generation:this.generation});
      return this.attention()!;
    }
    if(!this.attentionArmed || this.attentionTransitions>=config.maxTransitions)fail('attention_budget','Attention requires explicit rearm and available transition budget.');
    this.attentionArmed=false;this.attentionAt=now();this.attentionTransitions++;
    this.attentionEvidence=structuredClone(evidence);
    this.generation++;this.recoveryReason='authorized_attention';
    this.attentionState={id:`${this.epoch}:a${this.attentionTransitions}`,generation:this.generation,status:'pending',delivered:false,interrupted:false,coalesced:0};
    this.controlRevision++;this.operations.abort(new Error('Emergency attention invalidated the operation context.'));this.operations=new AbortController();
    this.acquisition.abort(new Error('Emergency attention invalidated acquisition.'));this.acquisition=new AbortController();
    this.emit({type:'attention_requested',attentionId:this.attentionState.id,generation:this.generation,receivedMs:evidence.receivedMs,acquired:evidence.acquired});
    this.changes.notify();return this.attention()!;
  }
  rearmAttention(id:string):void {
    if(this.stopped || this.attentionState?.id!==id || this.attentionState.status!=='acknowledged' || now()-this.attentionAt<this.options.attention!.cooldownMs)fail('attention_budget','Rearm requires acknowledged fresh evidence and the configured cooldown.');
    if(this.attentionTransitions>=this.options.attention!.maxTransitions)fail('attention_budget','Attention transition budget exhausted.');
    this.attentionArmed=true;
  }
  beginAttentionInterrupt(id:string):void {
    if(this.stopped || this.attentionState?.id!==id || !['pending','ready'].includes(this.attentionState.status))fail('inactive','Attention transition no longer current.');
    if(this.attentionState.interrupted)return;
    if(now()-this.attentionEvidence!.receivedMs>this.options.attention!.maxEvidenceAgeMs)fail('stale_attention','Evidence expired before native interruption; it remains historical environment data.');
    if(this.attentionInterrupts>=this.options.attention!.maxInterrupts)fail('attention_budget','Attention interrupt budget exhausted.');
    this.attentionInterrupts++;this.attentionState.interrupted=true;
    this.emit({type:'interrupt_requested',attentionId:id,generation:this.generation});
  }
  async settleAttention(id:string,signal?:AbortSignal):Promise<void> {
    await (signal ? withAbort(this.whenIdle(),signal) : this.whenIdle());
    if(this.stopped || this.attentionState?.id!==id)return;
    for(const [commandId,r] of this.receipts)if(r.result.status==='unknown')await this.reconcile(commandId,signal);
    signal?.throwIfAborted();
    if(this.stopped || this.attentionState?.id!==id || this.attentionState.status!=='pending')return;
    if(this.fault)fail('fault',this.fault);
    this.attentionState.status='ready';this.attentionState.generation=this.generation;
    this.changes.notify();
  }
  failAttention(id:string,error:unknown):void {
    if(this.stopped || !this.attentionState || this.attentionState.id!==id)return;
    this.attentionState.status='fault';this.fault=`attention_fault: ${message(error).slice(0,256)}`;
    this.operations.abort(new Error(this.fault));this.changes.notify();
  }
  whenIdle():Promise<void> {return this.stepIdle;}
  get stepInFlight():boolean {return this.inStep;}
  refresh(reason = 'context_recovery'): void {
    this.generation++; this.recoveryReason = reason.slice(0,256);
    if(this.attentionState && ['pending','ready'].includes(this.attentionState.status)){this.attentionState.generation=this.generation;this.attentionState.delivered=false;}
    this.changes.notify();
  }
  private acknowledge(id?: string): void {
    if (!id) return;
    const delivery = this.deliveries.get(id);
    if (!delivery) fail('unknown_bundle','Unknown or expired seen ID. Observe again; never replay old commands.');
    if (delivery.through > this.through) {
      this.environment.acknowledge(delivery.through); this.through = delivery.through;
    }
    if (delivery.generation === this.generation && delivery.goalVersion === this.goal.version && !this.transition && this.attentionState?.status!=='pending') {
      this.refreshed = this.generation;
      if(delivery.attentionId===this.attentionState?.id && this.attentionState?.status==='ready') {this.attentionState.status='acknowledged';this.firstAttentionAdmission=true;}
    }
    for(const resultId of delivery.resultIds){const receipt=this.receipts.get(resultId);if(receipt)receipt.acknowledged=true;}
    this.emit({type:'acknowledgement',id,generation:delivery.generation,attentionId:delivery.attentionId});
  }
  async step(input: StepRequest = {}, signal?: AbortSignal, options: StepOptions = {}): Promise<Bundle> {
    this.validateRequest(input, options);
    input=structuredClone(input);
    const v2=input.schemaVersion===2 || options.protocolVersion===2;
    if(stable(this.environment.profile)!==this.profileDigest){this.fault='profile_changed; restart and reconcile';fail('profile_changed',this.fault);}
    if (this.inStep) fail('busy','Only one step may be in flight.');
    this.inStep = true;
    this.stepIdle=new Promise(resolve=>{this.resolveStepIdle=resolve;});
    const enteredGeneration=this.generation;
    this.clearWait('superseded');
    try {
      this.acknowledge(input.seen);
      if (input.checkpoint !== undefined) await bounded(() => this.options.saveCheckpoint!(input.checkpoint!),this.limits.operationMs,signal);
      const commands = input.commands ?? [];
      const results: Receipt[] = [];
      const generation = this.generation;
      const goalVersion = this.goal.version;
      let snapshot = await this.snapshot(signal);
      if (snapshot.fault) this.fault = snapshot.fault;
      // Register baseline and event cursor before admission; notifications are already subscribed.
      const request = input.wait ?? (input.waitMs ? {until:[],reviewMs:input.waitMs} : undefined);
      const candidate: LogicalWait | undefined = request ? {
        token:`${this.epoch}:w${++this.waitSequence}`, request:structuredClone(request), baseline:snapshot,
        eventFloor: input.waitMs !== undefined ? this.through : this.deliveredThrough,
        ...(request.reviewMs === undefined ? {} : {deadlineMs:now()+request.reviewMs}),
        controller:new AbortController(), ready:Promise.resolve('unregistered')
      } : undefined;
      if (commands.length) {
        // Verify that observations fit before beginning any batch effects.
        await this.bundle(snapshot,[],false,v2,options);
        const resources = new Set<string>();
        for (const command of commands) {
          const known = this.knownReceipt(command);
          if (known) { results.push(known); continue; }
          const gate = this.stopped ? 'stopped' : this.fault ? this.fault : this.transition ? 'goal_transition' :
            this.attentionState?.status==='pending' ? 'attention_pending' :
            this.options.attention && (options.effectGeneration ?? input.generation)!==this.generation ? 'stale_generation' :
            this.goal.status !== 'active' ? 'no_goal' :
            this.refreshed !== this.generation || generation !== this.generation ? 'refresh_required' :
            input.goalVersion !== this.goal.version || goalVersion !== this.goal.version ? 'goal_version' : undefined;
          if (gate) { results.push({ id: command.id, status: 'not_executed', reason: gate }); continue; }
          const resource = this.environment.profile.commands[command.kind]?.resource;
          if (resource && resources.has(resource)) { results.push({id:command.id,status:'not_executed',reason:'batch_resource_conflict'}); continue; }
          if (resource) resources.add(resource);
          results.push(await this.admit(command, signal));
        }
      }
      let wait: Bundle['wait'];
      if (candidate && !this.stopped && !this.fault && !this.transition && this.refreshed === this.generation && results.every(r => r.status === 'accepted' || r.status === 'completed')) {
        this.pending = candidate;
        let checked:(reason?:string)=>void=()=>{};
        const firstCheck=new Promise<string|undefined>(resolve=>{checked=resolve;});
        candidate.ready = evaluateWait(candidate, {
          environment:this.environment, changes:this.changes, snapshot:(s,after) => this.snapshot(s,after), legacy:input.waitMs !== undefined,
          urgent:() => this.stopped ? 'stopped' : this.fault ? 'fault' : generation !== this.generation || goalVersion !== this.goal.version ? 'recovery' : undefined,
          checked
        }).then(reason => { this.emit({type:'wake',id:candidate.token,reason}); return reason; });
        void candidate.ready.catch(() => {});
        this.emit({type:'wait',id:candidate.token,reason:options.waitMode ?? 'hold'});
        const readyNow=await Promise.race([firstCheck,candidate.ready]);
        if (readyNow) {wait={status:'ready',token:candidate.token,reason:readyNow};this.pending=undefined;}
        else if (options.waitMode === 'park') wait = {status:'parked',token:candidate.token,...(candidate.deadlineMs === undefined ? {} : {deadlineMs:candidate.deadlineMs})};
        else {
          const abort = () => candidate.controller.abort(signal?.reason);
          signal?.addEventListener('abort',abort,{once:true});
          try { signal?.throwIfAborted(); wait = {status:'ready',token:candidate.token,reason:await candidate.ready}; }
          finally { signal?.removeEventListener('abort',abort); }
        }
      }
      const media = await this.capture(signal);
      snapshot = await this.snapshot(signal);
      if (snapshot.fault) this.fault = snapshot.fault;
      return await this.bundle(snapshot,results,true,v2,options,{...media,...(wait ? {wait} : {})});
    } catch (error) {
      this.clearWait('step_failed');
      if(this.attentionState?.status==='pending' && enteredGeneration!==this.generation && !signal?.aborted && !this.stopped) {
        const media=await this.capture(signal);
        return await this.bundle(await this.snapshot(signal),[],true,v2,options,media);
      }
      throw error;
    }
    finally { this.inStep = false;this.resolveStepIdle?.(); }
  }
  private validateRequest(input: StepRequest, options: StepOptions): void {
    if (!validateStep(input) || bytes(input)>this.limits.maxRequestBytes) fail('invalid_input','Invalid step request (including waitMs/wait syntax or request byte limit).');
    if (input.loopRef !== undefined && input.loopRef !== this.loopRef) fail('unauthorized','Request belongs to another loop.');
    if (input.waitMs !== undefined && (input.waitMs > this.limits.maxWaitMs || input.wait !== undefined || input.commands !== undefined)) fail('invalid_input','Legacy waitMs requires a separate bounded wait. Use v2 wait for commands plus wait.');
    if ((input.commands?.length ?? 0)>this.limits.maxBatch || input.commands?.some(c => bytes(c)>this.limits.maxCommandBytes)) fail('capacity','Command batch exceeds capacity.');
    if (input.checkpoint !== undefined && (!this.options.saveCheckpoint || Buffer.byteLength(input.checkpoint)>this.limits.maxCheckpointBytes)) fail('capacity','Checkpoint unavailable or too large.');
    if (input.wait) {
      if (!this.environment.changes) fail('unsupported','Conditional waits require environment change notifications.');
      if (input.wait.reviewMs === undefined && !this.options.allowIndefiniteWait) fail('invalid_input','Finite reviewMs is required.');
      if ((input.wait.reviewMs ?? 0)>this.limits.maxReviewMs) fail('invalid_input','Review deadline exceeds capacity.');
      for (const c of input.wait.until) if ('field' in c && !Object.hasOwn(this.environment.profile.waitFields ?? {},c.field)) fail('invalid_input','Wait field is not permitted.');
      if (options.waitMode !== 'park' && (input.wait.reviewMs === undefined || input.wait.reviewMs > (options.maxHoldMs ?? this.limits.maxWaitMs))) fail('hold_limit','Wait exceeds attached hold limit; use a managed parking driver.');
    }
  }
  parked(): {token:string;ready:Promise<string>} | undefined { return this.pending ? {token:this.pending.token,ready:this.pending.ready} : undefined; }
  private clearWait(reason:string): void { this.pending?.controller.abort(new Error(reason)); this.pending=undefined; }
  private knownReceipt(command:Command): Receipt | undefined {
    const cached=this.receipts.get(command.id);
    if (cached) return cached.digest === createHash('sha256').update(stable(command)).digest('hex') ? {...cached.result} : {id:command.id,status:'rejected',reason:'id_conflict'};
    if (Number(command.id.slice(1))<=this.highestCommand) return {id:command.id,status:'unknown',reason:'expired_or_out_of_order_id; reconcile, do not replay'};
  }
  private async admit(command: Command, signal?: AbortSignal): Promise<Receipt> {
    const digest = createHash('sha256').update(stable(command)).digest('hex');
    const cached = this.receipts.get(command.id);
    if (cached) return cached.digest === digest ? { ...cached.result } : { id:command.id,status:'rejected',reason:'id_conflict' };
    const number = Number(command.id.slice(1));
    if (number <= this.highestCommand) return {id:command.id,status:'unknown',reason:'expired_or_out_of_order_id; reconcile, do not replay'};
    if (this.receipts.size >= this.limits.receiptHistory) {
      const evict=[...this.receipts].find(([,r]) => r.result.status !== 'unknown');
      if (!evict) return {id:command.id,status:'not_executed',reason:'receipt_backpressure'};
      this.receipts.delete(evict[0]);
    }
    this.highestCommand = number;
    const validate = this.validators.get(command.kind);
    let result: Receipt;
    if (!validate || !validate(command.args)) result = {id:command.id,status:'rejected',reason:!validate?'unknown_command':'invalid_arguments'};
    else {
      try {
        const combined = signal ? AbortSignal.any([signal,this.operations.signal]) : this.operations.signal;
        const generation=this.generation, goalVersion=this.goal.version;
        result = await bounded(s => this.environment.execute(structuredClone(command),{signal:s,goalVersion,epoch:this.epoch,generation,assertCurrent:() => {
          s.throwIfAborted();
          if (this.stopped || this.transition || this.fault || generation !== this.generation || goalVersion !== this.goal.version || stable(this.environment.profile)!==this.profileDigest) fail('not_executed','Effect context is no longer current.');
        }}),this.limits.operationMs,combined);
        if (result.id !== command.id || !['accepted','completed','rejected','not_executed','unknown'].includes(result.status) || bytes(result) > 1024) throw new Error('Invalid adapter receipt.');
      } catch (error) {
        result = { id: command.id, status: 'unknown', reason: message(error).slice(0,256) };
        this.fault = 'uncertain_command; stop and reconcile before restarting';
      }
      if (result.status === 'unknown') {this.fault='uncertain_command; reconcile before new effects';this.changes.notify();}
    }
    this.receipts.set(command.id,{digest,result:structuredClone(result),kind:command.kind,...(this.options.retainCommandArguments===false ? {} : {command:structuredClone(command)})});
    this.emit({type:'admission',id:command.id,reason:result.status,generation:this.generation,...(this.firstAttentionAdmission ? {attentionId:this.attentionState?.id} : {})});
    if(result.status==='accepted'||result.status==='completed')this.firstAttentionAdmission=false;
    return result;
  }
  async reconcile(id:string,signal?:AbortSignal): Promise<Receipt> {
    const stored=this.receipts.get(id);
    if (!stored || stored.result.status !== 'unknown') fail('unsupported','No unresolved receipt is available.');
    const reconcile=this.environment.reconcileReceipt
      ? (s:AbortSignal)=>this.environment.reconcileReceipt!({id,kind:stored.kind,digest:stored.digest},s)
      : stored.command && this.environment.reconcile ? (s:AbortSignal)=>this.environment.reconcile!(structuredClone(stored.command!),s) : undefined;
    if(!reconcile)fail('unsupported','Authoritative reconciliation requires retained arguments or reconcileReceipt; the unresolved receipt is retained.');
    const result=await bounded(reconcile,this.limits.operationMs,signal);
    if (result.id !== id || !['accepted','completed','rejected','not_executed','unknown'].includes(result.status) || bytes(result)>1024) fail('invalid_adapter','Invalid reconciliation receipt.');
    stored.result=structuredClone(result);
    stored.acknowledged=false;
    if (![...this.receipts.values()].some(r => r.result.status === 'unknown') && this.fault?.startsWith('uncertain_command')) {this.fault=undefined;this.refresh('effects_reconciled');}
    return structuredClone(result);
  }
  async reconcileControl():Promise<ControlOutcome> {
    const outcome=await this.performControl(s=>this.environment.stop(s));
    this.control=outcome;
    if(outcome.status==='confirmed' && this.fault==='goal_transition_unconfirmed'){this.fault=undefined;this.refresh('control_reconciled');}
    return {...outcome};
  }
  private async snapshot(signal?: AbortSignal, after=this.through): Promise<Snapshot> {
    this.snapshotCount++;
    const snapshot=await bounded(s => this.environment.snapshot(after,s),this.limits.operationMs,signal ? AbortSignal.any([signal,this.acquisition.signal]) : this.acquisition.signal);
    if ((snapshot.jobs?.length ?? 0)>this.limits.maxJobs) fail('capacity','Job count exceeds capacity.');
    return snapshot;
  }
  private async capture(signal?:AbortSignal): Promise<Pick<Bundle,'attachments'|'media'>> {
    if (!this.environment.capture || this.environment.profile.camera?.policy === 'none') return {};
    const revision=this.controlRevision;
    try {
      const images=await bounded(s => this.environment.capture!(s),this.limits.operationMs,signal ? AbortSignal.any([signal,this.operations.signal]) : this.operations.signal);
      if (!Array.isArray(images) || images.length>this.limits.maxImages) fail('capacity','Image count exceeds capacity.');
      let size=0;
      for (const image of images) {
        if (image.type !== 'image' || !['image/png','image/jpeg','image/webp'].includes(image.mimeType) || !image.id || typeof image.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data) || !Number.isFinite(image.receivedMs) || typeof image.valid !== 'boolean' || typeof image.reused !== 'boolean') fail('invalid_adapter','Invalid typed image.');
        size+=Buffer.byteLength(image.data,'base64'); if (size>this.limits.maxMediaBytes) fail('capacity','Image bytes exceed capacity.');
        const policy=this.environment.profile.camera;
        if (policy?.policy === 'latest' && (policy.maxAgeMs === undefined || now()-image.receivedMs>policy.maxAgeMs)) {image.valid=false;image.reason='stale_receipt';}
      }
      if (revision !== this.controlRevision) fail('interrupted','Control changed during capture.');
      return {attachments:images};
    } catch (error) { signal?.throwIfAborted(); return {media:{status:'missing',reason:message(error).slice(0,256)}}; }
  }
  private async bundle(snapshot: Snapshot, results: Receipt[], deliver: boolean, v2=false, options:StepOptions={}, extra:Pick<Bundle,'attachments'|'media'|'wait'>={}, attempt=0): Promise<Bundle> {
    const assemblyStart=performance.now();
    const generation = this.generation;
    const goalVersion=this.goal.version;
    const recovery = this.refreshed !== generation || options.repeatInstructions;
    const note = recovery && this.note ? await bounded(() => this.note!(),this.limits.operationMs) : undefined;
    if(generation!==this.generation || goalVersion!==this.goal.version) {
      if(attempt>=1)fail('interrupted','Recovery changed repeatedly during assembly; observe again.');
      const media=deliver ? await this.capture() : {};
      return this.bundle(await this.snapshot(),results,deliver,v2,options,media,attempt+1);
    }
    if (note && Buffer.byteLength(note) > (v2 ? this.limits.maxCheckpointBytes : 4096)) fail('capacity','working.md exceeds note capacity.');
    const jobs = snapshot.jobs?.map(job => {
      if (recovery) return job;
      const { args: _args, ...status } = job; return status;
    });
    if(v2){const current=new Map([...this.receipts.values()].filter(r=>!r.acknowledged||r.result.status==='unknown').map(r=>[r.result.id,r.result]));for(const result of results)current.set(result.id,result);results=[...current.values()];}
    const at=now();
    const rendered=this.renderInstructions(options.instructions);
    const bundle: Bundle = {
      id: `${this.epoch}:b${this.sequence+1}`, epoch:this.epoch, deliveredMs:at,
      ...(v2 ? {schemaVersion:2 as const,loopRef:this.loopRef,generation,assembledMs:at} : this.options.attention ? {generation} : {}),
      profile:`${this.environment.profile.id}:${this.environment.profile.version}`, loop:this.status().loop as Bundle['loop'],
      rule:rendered.rule, goal:{...this.goal}, nextCommandId:`c${this.highestCommand+1}`,
      ...(snapshot.state ? { state:snapshot.state } : {}), ...(snapshot.samples ? {samples:snapshot.samples} : {}),
      ...(jobs?.length ? { jobs } : {}), ...(results.length ? { results } : {}),
      ...(recovery ? {recovery:{generation,reason:this.recoveryReason,instructions:rendered.instructions,...(note?{note}: {})}} : {}),
      ...(this.attentionState && this.attentionEvidence && ['pending','ready'].includes(this.attentionState.status) ? {attention:{...this.attentionEvidence,id:this.attentionState.id,generation}} : {}),
      ...(this.fault ? {fault:this.fault} : {}), ...(this.control ? {control:this.control} : {}), ...extra
    };
    const limit=recovery && v2 ? this.limits.maxRecoveryBytes : this.limits.maxBundleBytes;
    const baseText=observationText(bundle);
    const mediaWrappers=options.textEncoding==='tool-result' ? (bundle.attachments ?? []).reduce((sum,i)=>sum+1+bytes({type:'image',mimeType:i.mimeType,data:''}),0) : 0;
    const baseBytes=textSize(baseText,options)+mediaWrappers;
    const capacity=(reason:string):never=>{if(bundle.attention)this.failAttention(bundle.attention.id,new Error(reason));return fail('capacity',reason);};
    if (baseBytes > limit) capacity('Current state exceeds bundle capacity; nothing was silently truncated.');
    // Object punctuation, UTF-8 and JSON-string escaping are additive. Reserve hasMore
    // while packing, then verify the actual final representation once.
    let packedBytes=baseBytes+fragmentSize(',"events":[],"hasMore":true',options);
    let eventSerializations=0, serializedBytes=Buffer.byteLength(baseText);
    let through = this.through;
    const events = [] as Snapshot['events'];
    for (const event of snapshot.events) {
      if (event.seq <= through) fail('invalid_adapter','Events must have increasing sequence numbers.');
      const delivered=v2 ? {...event,id:`${this.epoch}:e${event.seq}`,redelivered:event.seq<=this.deliveredThrough} : event;
      const text=JSON.stringify(delivered);eventSerializations++;serializedBytes+=Buffer.byteLength(text);
      const added=fragmentSize(text,options)+(events.length ? 1 : 0);
      if (packedBytes+added > limit) break;
      packedBytes+=added;
      events.push(delivered); through = event.seq;
    }
    if (events.length) bundle.events = events;
    if (!recovery && snapshot.events.length && !events.length) fail('capacity','First unread event cannot fit this bundle; increase capacity or reduce current state.');
    if (snapshot.hasMore || events.length < snapshot.events.length) bundle.hasMore = true;
    const finalText=observationText(bundle), finalBytes=textSize(finalText,options)+mediaWrappers;
    serializedBytes+=Buffer.byteLength(finalText);
    if(finalBytes>limit)capacity('Final observation representation exceeds capacity.');
    if (deliver) {
      this.sequence++;
      this.deliveries.set(bundle.id,{through,generation,goalVersion,resultIds:results.map(r=>r.id),...(bundle.attention ? {attentionId:bundle.attention.id} : {})});
      if(bundle.attention && this.options.submission!=='host')this.attentionState!.delivered=true;
      this.deliveredThrough=Math.max(this.deliveredThrough,through);
      while(this.deliveries.size > this.limits.bundleHistory) this.deliveries.delete(this.deliveries.keys().next().value!);
      const inputs=[...(snapshot.state ? [['state',snapshot.state] as const] : []),...Object.entries(snapshot.samples ?? {})].map(([name,s])=>({name,receivedMs:s.receivedMs,acquired:s.acquired,valid:s.valid}));
      this.emit({type:'assembly',id:bundle.id,generation,attentionId:bundle.attention?.id,textBytes:finalBytes,mediaBytes:extra.attachments?.reduce((sum,i) => sum+Buffer.byteLength(i.data,'base64'),0) ?? 0,inputs,eventSerializations,serializedBytes,snapshotCount:this.snapshotCount,assemblyMs:performance.now()-assemblyStart});
      for(const job of snapshot.jobs ?? [])if(!['pending','running','stopping'].includes(job.status) && this.observedJobs.get(job.id)!==job.status)this.emit({type:'completion',id:job.id,commandId:job.commandId,completedMs:job.updatedMs,reason:job.status});
      this.observedJobs=new Map((snapshot.jobs ?? []).map(j=>[j.id,j.status]));
    }
    return structuredClone(bundle);
  }
  emit(event:Omit<Trace,'loopRef'|'atMs'>): void {
    try {this.options.trace?.({...event,loopRef:this.loopRef,atMs:now()});} catch {/* Diagnostics cannot change admission. */}
  }
  private validateGoal(goal:Goal): void {
    if (!Number.isSafeInteger(goal.version) || goal.version<0 || !['active','stopped','missing'].includes(goal.status)) fail('invalid_input','Invalid received goal.');
    if (goal.status !== 'missing') boundedText(goal.text,this.limits.maxGoalBytes,'Goal');
    else if (goal.text !== '') fail('invalid_input','A missing goal has empty text.');
  }
  private async performControl(fn:(signal:AbortSignal) => Promise<void | ControlOutcome>): Promise<ControlOutcome> {
    try {
      const result=await bounded(fn,this.limits.operationMs);
      const outcome=result ?? {status:'unknown' as const,reason:'legacy_adapter_no_confirmation'};
      if (!['confirmed','stopping','unknown'].includes(outcome.status) || bytes(outcome)>1024) fail('invalid_adapter','Invalid control outcome.');
      return outcome;
    } catch(error) {return {status:'unknown',reason:message(error).slice(0,256)};}
  }
  async cancel(id: string): Promise<ControlOutcome> {
    boundedText(id,128,'Job ID');
    this.controlRevision++; this.clearWait('cancelled'); this.changes.notify();
    return this.performControl(signal => this.environment.cancel(id,signal));
  }
  async updateGoal(text: string, expectedVersion=this.goal.version): Promise<Goal> {
    if (this.options.goalProvider) fail('unauthorized','The injected provider owns goal versions. Use receiveGoal.');
    if (expectedVersion !== this.goal.version) fail('goal_version','Goal version changed.');
    return this.receiveGoal({text,version:this.goal.version+1,status:'active'});
  }
  async receiveGoal(goal:Goal): Promise<Goal> {
    this.validateGoal(goal);
    if (this.stopped || this.transition) fail('inactive','Loop stopped or goal transition already running.');
    if (goal.version<=this.goal.version) {if(stable(goal)===stable(this.goal))return {...this.goal};fail('goal_version','Received goal version must advance.');}
    this.attentionState=undefined;this.attentionEvidence=undefined;this.attentionArmed=true;
    this.transition = true; this.controlRevision++; this.operations.abort(new Error('Goal changed.')); this.refresh('goal_changed');
    this.goal=structuredClone(goal);
    this.changes.notify();
    try {
      const outcome=await this.performControl(signal => this.environment.stop(signal));
      if (outcome.status !== 'confirmed' && outcome.reason !== 'legacy_adapter_no_confirmation') this.fault='goal_transition_unconfirmed';
      await this.persist();return {...this.goal};
    } catch(error) { this.fault = 'goal_transition_failed'; throw error; }
    finally { this.transition = false; if(!this.stopped)this.operations = new AbortController(); this.changes.notify(); }
  }
  async stop(): Promise<ControlOutcome> {
    this.stopped = true; this.goal.status = 'stopped';
    this.controlRevision++; this.operations.abort(new Error('Loop stopped.')); this.changes.notify();
    this.control={status:'stopping'};
    this.control=await this.performControl(signal => this.environment.stop(signal));
    await this.persist();
    this.emit({type:'control',reason:this.control.status});return {...this.control};
  }
  async close(): Promise<void> {
    if(this.closed)return;this.closed=true;
    try { await this.stop(); } finally { this.clearWait('closed');this.lifetime.abort();this.unsubscribe?.();this.unsubscribeGoals?.();if(this.options.environmentOwnership !== 'borrowed')await this.environment.close(); }
  }
}
