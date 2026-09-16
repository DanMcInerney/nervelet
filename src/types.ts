export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RecordData = { [key: string]: Json };

export interface CommandDefinition {
  description: string;
  schema: Record<string, unknown>;
  /** Commands sharing this resource cannot appear in one batch. */
  resource?: string;
}
export interface Profile {
  id: string;
  version: string;
  instructions: string;
  commands: Record<string, CommandDefinition>;
  /** Only these dated numeric inputs may be used by conditional waits. */
  waitFields?: Record<string, { source: 'state' | 'sample'; sample?: string; path?: string[]; maxAgeMs: number; description?: string }>;
  camera?: { policy: 'none' | 'capture_on_step' | 'latest'; maxAgeMs?: number };
}
export interface Sample {
  value: Json;
  /** Bridge-monotonic receipt time, never represented as device acquisition time. */
  receivedMs: number;
  acquired?: { clock: string; ms: number };
  valid: boolean;
  maxAgeMs?: number;
  reason?: string;
}
export interface Event { seq: number; kind: string; atMs: number; data: Json; id?: string; redelivered?: boolean }
export type JobStatus = 'pending' | 'running' | 'stopping' | 'completed' | 'blocked' | 'cancelled' | 'failed';
export interface Job {
  id: string;
  status: JobStatus;
  commandId: string;
  kind: string;
  args: RecordData;
  startedMs: number;
  updatedMs: number;
  reason?: string;
}
export interface Command { id: string; kind: string; args: RecordData }
export interface CommandIdentity { id: string; kind: string; digest: string }
export interface Receipt {
  id: string;
  status: 'accepted' | 'completed' | 'rejected' | 'not_executed' | 'unknown';
  jobId?: string;
  reason?: string;
  /** Historical operation output, retained until this exact receipt revision is seen. */
  data?: Json;
}
export interface ResultBudget {
  /** Maximum resultBytes(data), reserved before invoking execute. */
  retainedBytes: number;
  /** Maximum escaped JSON receipt fragment (including scalar receipt metadata). */
  serializedBytes: number;
}
export interface Snapshot {
  state?: Sample;
  samples?: Record<string, Sample>;
  jobs?: Job[];
  events: Event[];
  hasMore: boolean;
  fault?: string;
}
export interface CommandContext {
  signal: AbortSignal; goalVersion: number; epoch: string; generation?: number;
  /** Call immediately before each effect, after asynchronous preconditions. */
  assertCurrent?(): void;
}
export interface Changes { readonly sequence: number; subscribe(listener: () => void): () => void }
export interface ImageAttachment {
  type: 'image'; id: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Actual encoded pixels, kept separate from observation text by transports. */
  data: string;
  receivedMs: number; acquired?: { clock: string; ms: number };
  valid: boolean; reused: boolean; reason?: string;
}
export interface ControlOutcome { status: 'confirmed' | 'stopping' | 'unknown'; reason?: string }
export interface Environment {
  readonly profile: Profile;
  readonly changes?: Changes;
  start(signal: AbortSignal): Promise<void>;
  snapshot(after: number, signal: AbortSignal): Promise<Snapshot>;
  /** Optional final acquisition. snapshot must be cheap and non-consuming. */
  capture?(signal: AbortSignal): Promise<ImageAttachment[]>;
  acknowledge(through: number): void;
  /** Events/jobs/faults wake a wait. Streaming samples alone may coalesce. */
  wait(signal: AbortSignal): Promise<void>;
  execute(command: Command, context: CommandContext): Promise<Receipt>;
  /** Pure synchronous preflight. Omission permits scalar receipts only. */
  resultBudget?(command: Command): ResultBudget;
  /** Drop executor-owned result storage after terminal acknowledgement or history eviction.
   * Must be synchronous, idempotent and non-throwing; never cancels or replays effects. */
  releaseReceipt?(command: CommandIdentity): void;
  cancel(id: string, signal: AbortSignal): Promise<void | ControlOutcome>;
  stop(signal: AbortSignal): Promise<void | ControlOutcome>;
  /** Authoritative reconciliation only; never implement by re-executing. */
  reconcile?(command: Command, signal: AbortSignal): Promise<Receipt>;
  /** Reconcile by executor-owned identity when retained arguments are disabled. Never replay. */
  reconcileReceipt?(command: CommandIdentity, signal: AbortSignal): Promise<Receipt>;
  close(): Promise<void>;
}
export type WaitCondition = { kind: 'anyEvent' } | { kind: 'event'; type: string } | { kind: 'jobTerminal'; id: string } |
  { kind: 'threshold'; field: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number } |
  { kind: 'change'; field: string; deadband: number };
export interface WaitRequest { until: WaitCondition[]; reviewMs?: number }
export interface StepRequest {
  schemaVersion?: 2; loopRef?: string; seen?: string; goalVersion?: number; generation?: number;
  waitMs?: number; commands?: Command[]; wait?: WaitRequest; checkpoint?: string;
}
/** Names and paths for a host's existing step aliases; does not add capabilities. */
export interface InstructionBinding {
  observation?: string; seen?: string; commandId?: string; goalVersion?: string; generation?: string;
  observe?: string; waitTool?: string; batch?: string; waitUntil?: string; waitReviewMs?: string;
}
export interface InstructionOptions {
  transport?: 'cli' | 'tools'; stop?: boolean;
  /** Names of all tools that guarantee an observation refresh. */
  refreshTools?: string[];
  /** Host guarantees the catalog remains available, including after context recovery. */
  commandSchemas?: 'inline' | 'transport';
  waitMode?: 'hold' | 'park';
  requireGeneration?: boolean;
  binding?: InstructionBinding;
}
export interface StepOptions {
  waitMode?: 'hold' | 'park'; maxHoldMs?: number; repeatInstructions?: boolean;
  instructions?: InstructionOptions;
  /** Charge JSON text escaping and the standard tool-result envelope when selected. */
  textEncoding?: 'json' | 'tool-result'; wrapperBytes?: number;
  /** Trusted per-turn binding for hosts; never derive it from mutable current state. */
  effectGeneration?: number;
  /** Select the v2 response without adding bytes to a caller's request. */
  protocolVersion?: 2;
}
export interface Goal { text: string; version: number; status: 'active' | 'stopped' | 'missing' }
export interface GoalProvider { get(): Goal | undefined; subscribe?(listener: (goal: Goal) => void): () => void }
export interface Bundle {
  id: string;
  epoch: string;
  deliveredMs: number;
  schemaVersion?: 2;
  loopRef?: string;
  generation?: number;
  assembledMs?: number;
  profile: string;
  loop: 'active' | 'paused' | 'stopped';
  rule: string;
  goal: Goal;
  nextCommandId: string;
  state?: Sample;
  samples?: Record<string, Sample>;
  jobs?: (Job | Omit<Job, 'args'>)[];
  results?: Receipt[];
  events?: Event[];
  hasMore?: boolean;
  recovery?: { generation: number; reason: string; instructions: string; note?: string };
  fault?: string;
  attachments?: ImageAttachment[];
  media?: { status: 'missing'; reason: string };
  wait?: { status: 'parked' | 'ready'; token: string; reason?: string; deadlineMs?: number };
  control?: ControlOutcome;
  /** Bounded duplicate of host-authorized evidence; does not acknowledge its source events. */
  attention?: AttentionEvidence & { id:string; generation:number };
}
export interface AttentionEvidence {
  episode:string; receivedMs:number; acquired?:{clock:string;ms:number}; data:Json;
  /** References to reliable environment events. Those events stay in the ordinary FIFO. */
  eventIds?:string[];
}
export interface AttentionOptions {
  maxTransitions:number; maxInterrupts:number; cooldownMs:number;
  terminationMs:number; maxEvidenceAgeMs:number; maxEvidenceBytes?:number;
}
export interface AttentionState {
  id:string; generation:number; status:'pending'|'ready'|'acknowledged'|'fault';
  delivered:boolean; interrupted:boolean; coalesced:number;
}
export interface Config {
  environment: () => Environment | Promise<Environment>;
  limits?: Partial<Limits>;
}
export interface Limits {
  maxResultBytes: number;
  maxRetainedResultBytes: number;
  maxResultDeliveryBytes: number;
  maxRequestBytes: number;
  maxCommandBytes: number;
  maxBundleBytes: number;
  maxGoalBytes: number;
  maxProfileBytes: number;
  maxBatch: number;
  maxWaitMs: number;
  operationMs: number;
  startupMs: number;
  receiptHistory: number;
  bundleHistory: number;
  maxRecoveryBytes: number;
  maxMediaBytes: number;
  maxImages: number;
  maxCheckpointBytes: number;
  maxReviewMs: number;
  maxJobs: number;
}
export interface Trace {
  type: 'assembly' | 'acknowledgement' | 'admission' | 'completion' | 'wait' | 'wake' | 'control' | 'submission' | 'attention_requested' | 'attention_coalesced' | 'interrupt_requested' | 'turn_ended' | 'replacement_submitted';
  loopRef: string; atMs: number; id?: string; reason?: string; textBytes?: number; mediaBytes?: number;
  turnId?:string; commandId?:string; completedMs?:number;
  inputs?:{name:string;receivedMs:number;acquired?:{clock:string;ms:number};valid:boolean}[];
  generation?:number; attentionId?:string;
  assemblyMs?:number; eventSerializations?:number; serializedBytes?:number; snapshotCount?:number;
  receivedMs?:number; acquired?:{clock:string;ms:number};
}
