# Bounded observation and emergency improvements

This page documents the observation/attention changes implemented from baseline `2a806a61b5d9cc2dc48029bb9818bd228c8aba25` and their later host-submission extension. [The current v2 contract](v2.md) adds reliable receipt revisions and payload budgets, any-unread-event waiting and checked immutable profiles; [reliability validation](reliability.md) records the new checks. The earlier implementation launched no inference and changed no DroneRTS files. Its emergency evidence remains deterministic; actual Codex and Claude driver interruption/resumption is **unqualified**. DroneRTS's separate [application integration](dronerts.md) has its own evidence and remaining native gates.

## Limits, receipts and package compatibility

`limits.maxRequestBytes` defaults to 16,384 and `limits.maxCommandBytes` to 4,096, preserving the former fixed ceilings. They measure UTF-8 JSON, including escaping. Bridge and shared handlers apply the same limits. IPC advertises bounded framing ceilings derived from them; the CLI reads request files using the bridge's configured ceiling. Local HTTP MCP allows the configured argument bytes plus a bounded framing reserve. A host using its own transport must provision its own framing limits. The API driver's response/history ceilings remain separate and may also need increasing for large arguments.

`retainCommandArguments` defaults to true. With false, receipts retain ID, kind, SHA-256 payload digest and result, without an argument copy. Identical retries return the receipt, changed payloads conflict, and expired IDs never execute. Implement optional `Environment.reconcileReceipt({id, kind, digest}, signal)` using executor-owned records. Existing `reconcile(command, signal)` remains supported when arguments are retained. Missing reconciliation fails explicitly and retains unresolved receipts; the core never substitutes empty arguments or replays an uncertain effect. Active job arguments still belong to the environment and appear on recovery.

The existing package version, installer exports and driver subpaths are preserved. No version bump, tag or release is part of these changes. `npm run check:package` builds and packs using the existing package metadata, installs that archive in a new temporary consumer outside the checkout, blocks optional runtime imports, and exercises the built exports. When run, it writes ignored archive identity and installation evidence to `.runtime/package-check.json`. Nothing calls `npm publish`.

## Canonical instructions and exact packing

Use `BridgeOptions.instructions` for shared defaults or `createHandlers(bridge, {instructions, waitMode})` for a particular bound surface:

```ts
const tools = createHandlers(bridge, {
  stop: false,
  waitMode: 'hold',
  instructions: {
    refreshTools: ['observe', 'exchange'],
    commandSchemas: 'transport'
  }
});
```

These names describe host-provided aliases; they do not create tools. `refreshTools` is bounded to 16 names of 128 UTF-8 bytes each. `commandSchemas: 'transport'` is a host guarantee that the exact matching catalog remains present after recovery. It removes only duplicate command schemas from the rendered profile. Required operating text, command descriptions/resources, exact goal, active jobs and checkpoint remain. Defaults retain inline schemas. Held calls describe bounded waits; managed parking instructs the agent to end its turn. A bounded cache renders each configuration once for both reminders and recovery. Legacy CLI recovery text keeps its compatible default.

Shared handlers now size the representation they actually return instead of replacing recovery instructions after sizing. Direct Bridge text uses JSON bytes. Shared tool handlers default to `textEncoding: 'tool-result'`, charging the escaped JSON text, standard result envelope and image-content wrappers. Decoded pixels retain their separate media ceiling. `wrapperBytes` reserves a host's additional framing overhead. Native drivers verify their actual input envelope before submission; hosts should reserve enough bytes for their own surrounding fields. RPC framing limits are independent of model-visible text limits. `describe` output also charges its standard tool wrapper.

Event packing measures the fixed text once, serializes each candidate event once, adds exact punctuation/UTF-8/escaping costs, and verifies the final representation. It retains FIFO order, stable IDs, redelivery hints, `hasMore` and included-slice acknowledgements. It reserves `hasMore: true` while selecting events, retaining the former conservative selection rule. Required oversized state, or an oversized first event in an ordinary bundle, fails explicitly. Recovery can precede a queued event when its records fill the recovery budget. No summary or cross-bundle delta is introduced.

## Optional host attention

Attention is disabled unless the host supplies every policy bound:

```ts
const bridge = new Bridge(environment, receivedGoal, {
  attention: {
    maxTransitions: 3,
    maxInterrupts: 2,
    cooldownMs: 1000,
    terminationMs: 5000,
    maxEvidenceAgeMs: 2000,
    maxEvidenceBytes: 1024
  }
});
// After the application retains a reliable source event and authorizes attention:
const transition = bridge.requestAttention({
  episode: 'application-owned-episode',
  receivedMs: performance.now(),
  acquired: { clock: 'source-clock', ms: 1234 },
  eventIds: ['original-event-reference'],
  data: { condition: 'application-defined incident' }
});
```

These illustrative values are host choices, not recommended domain thresholds. `receivedMs` uses the Node process's monotonic clock; optional acquisition time retains its source clock. No model-callable attention tool exists. Ordinary samples/events never request interruption. Source text cannot authorize a transition.

The request synchronously gates new effects, advances the recovery generation and aborts pending operation/acquisition contexts. It does not change the received goal or invoke domain cancel/stop. Every new command on an attention-enabled bridge must echo the current `generation` as well as satisfy goal and recovery acknowledgement gates. Known duplicate receipts remain readable. Controls bypass ordinary steps and aborted tool signals. An adapter must check `assertCurrent()` immediately before effects after asynchronous preconditions; late callbacks cannot become current merely because a replacement has acknowledged recovery.

One pending/ready capsule is retained per bridge. Repeated requests coalesce into that transition without changing its generation or growing metadata. The first capsule remains fixed until acknowledgement; additional evidence belongs in the environment's reliable queue. The evidence object has a default 1 KiB ceiling, at most eight event references, and is also charged to the observation budget with its ID/generation envelope. If it cannot fit, attention faults explicitly.

The capsule sits outside the FIFO slice so an urgent event behind mail can be seen promptly. Acknowledging it enables the attention recovery gate only after settlement. It acknowledges **only** the ordinary included FIFO events, never the referenced unseen event. That original event can appear later with its existing identity.

`Supervisor` coordinates this transition automatically. It first lets an already-open step deliver current evidence. A held wait wakes, pending acquisition is invalidated, and an uncertain command is reconciled. Capture failure is explicit missing media; the next boundary retries acquisition. If the open boundary cannot deliver, or the agent is reasoning/closing a turn, supported drivers request interruption and wait for matching terminal completion. An interrupt RPC response is insufficient. A parked operator needs no native interruption. A natural completion racing attention is joined before replacement. The same driver/session receives fresh evidence on the unchanged goal; there are no overlapping turns or replacement actors.

`terminationMs` bounds the complete settlement sequence (open boundary, interruption, old turn end, and reconciliation), rather than restarting a deadline at each stage. A stale request loses permission to interrupt; historical events remain available. Unsupported interruption, failed RPC, missing terminal confirmation, reconciliation failure and deadline expiry fault the transition and keep effects gated. Stop, closure, changed goals, domain faults and exhausted budgets prevent queued resumption. Existing supervisor failure/Stop policy still applies; the attention request itself does not choose a physical response.

After a settled capsule has actually been acknowledged and the cooldown has elapsed, the host may call `bridge.rearmAttention(transition.id)`. Rearm never resets cumulative transition/interrupt budgets; another transition must fit both those bounds and the ordinary supervisor turn/time/usage limits. Intentional emergencies do not consume the unexpected-final retry allowance. Model/cost counts remain unavailable when the driver cannot measure them.

## Hosts with an existing actor owner

Use the exported sequencing helper, **without** creating another Supervisor:

```ts
bridge.requestAttention(evidence);
const route = await settleEmergency(bridge, activeTurn && {
  turnId: activeTurn.id,
  ended: activeTurn.terminalAndToolsSettled,
  interrupt: () => activeTurn.interrupt(),
  abortTools: () => activeTurn.abortPendingToolCalls()
});
// The existing owner submits fresh bridge evidence after 'restart', or when idle.
// 'boundary' with a live turn means the open tool result can continue that turn.
// Recheck Stop, goal, permissions and budgets before submitting anything.
```

The host's `ended` promise must resolve only for the matching native terminal event **and** settled tool/result work, never for a local abort or interrupt acknowledgement. Omit `interrupt` if that contract is unavailable; the helper reports an explicit limitation. It never starts a turn, model or process. Calls share one in-flight transition. `bridge.attention()` exposes bounded status; `whenIdle()` joins the ordinary tool lane. The lower-level settlement/fault methods are trusted-host primitives used by the helper, not model authority.

Hosts may supply `StepOptions.effectGeneration` as a frozen trusted decision binding. An old binding overrides a model-supplied newer generation and remains rejected after acknowledgement. Such hosts must explicitly issue a new binding after delivering fresh evidence. The standard transport instead uses the generation echoed from the latest observation. Neither `loopRef` nor a generation grants cross-actor authorization.

## Driver qualification and diagnostics

Codex correlates completion to the `turn/start` response's thread/turn ID, including completion arriving before that response. It does not abort the local start-RPC wait and lose an already accepted turn. Claude uses one streaming query and a UUID on each input. Attention-enabled sessions require `user_message_uuid` on results; older bindings without it fail explicitly. Only matching `aborted_streaming` / `aborted_tools` results are classified as intentional interruption. Budget, permission, unexpected session change and stream-closure failures remain failures. Neither driver switches models.

`DriverCapabilities.interruption: 'terminal-event'` describes the implemented protocol path, **not native qualification**. Real Codex tool/result pairing through interruption and real Claude UUID/terminal-reason behavior still need separately authorized runs, with versions, permissions and models recorded. Attached sessions without an existing actor owner cannot promise emergency wake. The API driver's active-turn emergency interruption is explicitly unsupported; an open observation boundary or already parked API operator can still receive host attention. Normal API cancellation and complete tool-pair behavior remain intact.

The existing `trace` callback adds attention request/coalescing, interruption request, old-turn end, replacement input request and first subsequent admission correlations. It retains assembly/acknowledgement, acquisition/receipt timestamps, text/media bytes and adds event serialization counts, materialized serialization bytes, assembly duration and cumulative snapshot count. IDs and timestamps are recorded without evidence payloads or private reasoning. `atMs` uses host monotonic time. `driver_turn_requested`, `native_turn_start_accepted`, `sdk_input_queued`, `tool_result_returned` and `ipc_written` explicitly distinguish observable submission stages from model acknowledgement. Native internal inference timing remains unavailable.

Trace sinks must remain bounded and nonblocking; exceptions cannot change admission. The supplied measurement uses a 128-record sink. Serialized bytes are a string-allocation work proxy, not measured allocator counts or model latency. No wait-snapshot hint was added: this workload does not establish a worthwhile benefit from another adapter option. Existing checkpoints, conditional waits, parking and latest-value storage are reused.

## Consuming application responsibilities

The application still owns acquisition, emergency classification, reliable source-event retention, allowed evidence age, command preconditions, permissions, received-goal authority and mission completion. The environment owns physical safeguards, job execution, and whether accepted work continues, brakes or stops. Native hosts own actor isolation and matching tool/result settlement. Resource quotas and deployed dependency/CPU/storage costs require application qualification. DroneRTS now implements its integration and private-patch removal separately; native camera reliability, gameplay qualification and acoustic calibration remain application work.
# Borrowed-host final submission

An embedding host that formats or transports results after `Bridge.step` must set
`BridgeOptions.submission: 'host'`. Call `confirmSubmission(bundle.id)` only after
the final result is successfully submitted, or `failSubmission(bundle.id, error)`
if formatting or transport fails. These methods never acknowledge events. The
model still echoes `seen`; command completion still comes from the executor.

`settleEmergency` waits within its existing termination budget for a current
assembled capsule's host confirmation. Missing or failed output faults the
transition and retains evidence. Stale-generation confirmations cannot authorize
a boundary. If the native turn naturally ends while output settles, the helper
returns `restart` after terminal/tool settlement. Hosts must submit open results
independently of settlement: awaiting the helper inside that result deadlocks.
Hosts without this option retain the legacy assembly-based boundary contract.
This is protocol-tested, not native interruption qualification.
Reconciliation can invalidate an assembled recovery generation; settlement then
joins the native turn before requesting fresh replacement input, within the same
termination and interruption budgets.

The serial adapter declares serialport as an optional peer, like the other host integrations. A normal core install no longer installs native serial bindings. Install serialport explicitly when selecting that adapter; package qualification checks the default install without omit flags.
