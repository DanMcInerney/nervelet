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
export interface Event { seq: number; kind: string; atMs: number; data: Json }
export type JobStatus = 'running' | 'completed' | 'blocked' | 'cancelled' | 'failed';
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
export interface Receipt {
  id: string;
  status: 'accepted' | 'completed' | 'rejected' | 'not_executed' | 'unknown';
  jobId?: string;
  reason?: string;
}
export interface Snapshot {
  state?: Sample;
  samples?: Record<string, Sample>;
  jobs?: Job[];
  events: Event[];
  hasMore: boolean;
  fault?: string;
}
export interface CommandContext { signal: AbortSignal; goalVersion: number; epoch: string }
export interface Environment {
  readonly profile: Profile;
  start(signal: AbortSignal): Promise<void>;
  snapshot(after: number, signal: AbortSignal): Promise<Snapshot>;
  acknowledge(through: number): void;
  /** Events/jobs/faults wake a wait. Streaming samples alone may coalesce. */
  wait(signal: AbortSignal): Promise<void>;
  execute(command: Command, context: CommandContext): Promise<Receipt>;
  cancel(id: string, signal: AbortSignal): Promise<void>;
  stop(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface StepRequest { seen?: string; goalVersion?: number; waitMs?: number; commands?: Command[] }
export interface Goal { text: string; version: number; status: 'active' | 'stopped' }
export interface Bundle {
  id: string;
  epoch: string;
  deliveredMs: number;
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
}
export interface Config {
  environment: () => Environment | Promise<Environment>;
  limits?: Partial<Limits>;
}
export interface Limits {
  maxBundleBytes: number;
  maxGoalBytes: number;
  maxProfileBytes: number;
  maxBatch: number;
  maxWaitMs: number;
  operationMs: number;
  startupMs: number;
  receiptHistory: number;
  bundleHistory: number;
}
