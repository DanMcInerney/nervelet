# Build and qualification plan

**Implementation status:** Phases 0–4 now have deterministic tests and implementation in v0.2. This plan remains the acceptance checklist. [Validation](../validation.md) records results; native image understanding, sustained parking and repeated actual compaction are still unqualified.

**TypeScript refactor · 2026-09-15 · design only.** [Handoff](../../NEXT-DESIGN.md) · [Contract](CONTRACT.md)

## Implementation order

### Phase 0 — preserve the baseline and pin schemas

Read repository instructions, inspect Git status and run `npm test` (includes the build). Record the starting revision and existing failures. Preserve uncommitted work; do not reset the checkout. Retain meaningful core, IPC, installer and serial tests.

Define protocol-v2 schemas/fixtures and the v0.1 compatibility mapping. Keep public camelCase fields and existing installer export meanings. Explicitly migrate assembly timestamps, commands-plus-wait, media and control receipts. Do not build a second legacy core. Verify a core-only import works without MCP, native SDKs, serial binaries or Python installed.

### Phase 1 — evolve Bridge and the environment boundary

Separate semantic instructions, shared handlers, cheap snapshots and bounded final media acquisition. Add injected/no-goal operation, typed cancellation/stop outcomes, explicit reconciliation, versioned recovery and bounded delivery tracking. Preserve increasing command IDs, event peek/ack and resource ownership.

Add conditional waits and change-sequence registration. Extend ObservationStore to signal field changes for predicate evaluation without waking inference on every sample. Build a deterministic supervisor with a fake driver: intentional parking, coalesced wakeups, bounded retries, immediate control and explicit owned/borrowed resource lifetimes. Preserve old CLI/IPC behavior through the same handlers.

### Phase 2 — native tool and session integration

Add MCP handlers over the shared contract. Support an existing host server and one standalone transport path; do not create redundant services. Keep CLI installers functional, with transport-specific instructions generated from the same definitions.

Implement Claude Code through the official TypeScript Agent SDK and Codex through App Server. Keep driver subpaths distinct from existing installer exports. Qualify managed parking and attached limitations separately. Test native image delivery and actual compaction before claiming those capabilities. Do not use a Python helper to host either core or driver.

### Phase 3 — API/local models

Add a minimal bounded API driver using the same handlers: complete tool-call/result pairs, explicit model/provider, usage when available, cancellation and authoritative recovery during history rotation. Add optional one-JSON-action encoding and schema constraints where supported. Malformed, incomplete or unsupported output never executes. Provide an API-feed example with no robot fields; use mocked HTTP first.

### Phase 4 — compatibility, embedding and measurement

Migrate demo and serial adapters without weakening reconnect/stop behavior. Add a recorded environment that rejects divergent actions, and an in-process fixture with multiple isolated bridge instances representing DroneRTS pilots. One pilot’s blocked step must not hold up the others. Existing hosts must be able to borrow a driver/client without Nervelet closing the entire host process.

Measure package/transitive footprint, memory, event-loop delay, bundle/media bytes, model wakes and control latency. Update README, API docs, examples and versioned qualification results. Run `npm test`, build/package checks, and the native scenarios explicitly authorized for qualification. Actual DroneRTS gameplay migration remains a separate task.

### Optional follow-ons

Add a bounded sequence helper/pinned routine capability where an environment needs it, with its execution/cancellation fixtures. Add the engineer only after single-operator qualification and keep it disabled by default. Add a Python device adapter only for a real integration. Neither extension blocks the TypeScript core release.

## Required deterministic fixtures

| Concern | Evidence required |
| --- | --- |
| Concurrent world | Samples and jobs advance while fake inference is blocked. Latest samples coalesce; reliable events survive. |
| Quiet operation | Managed parking makes no periodic model calls. Cover deadline, threshold/deadband, terminal job and reliable-event wakes. |
| Races | Event before/during wait registration, during closing response, after cancellation, and during resume; no lost wake or overlapping operator turn. |
| Batched effects | Paired receipts, conflicts, partial admission, duplicate/expired IDs, invalid wait syntax and cancellation during admission. Unknown effects never silently replay. |
| Recovery | Stale `seen`, changed epoch/profile/goal, no initial goal, exact restored records and active job provenance. |
| Reliable delivery | Lost response, redelivery, partial slice, backpressure and bounded acknowledgement metadata. |
| Urgency | Stop/goal replacement during admission, I/O, encoding and recovery; late callbacks cannot apply stale effects. |
| API protocol | Complete pairs, bounded history rotation, invalid/partial JSON, unsupported images and bounded retries. |
| Isolation | Forged loop references fail. Native scripts and helpers cannot bypass the actuator owner. |
| Compatibility | Existing imports/CLI/hook installers and serial protocol remain functional, or receive an explicit documented migration. |
| Optional extensions | Sequence failure/cancel/restart, store recovery, Python disconnect and engineer authority only when that capability is implemented. |

Recorded replay accepts matching actions against recorded evidence. Divergence must be explicit; never invent a counterfactual world outcome. Deterministic fixtures establish protocol behavior, not perception or physical safety.

## Per-driver qualification

Record exact harness/SDK/model/provider/OS versions, auth mode, transport and permissions. Test:

- One long tool hold and many tools across a sustained session; cancellation, interruption and clean shutdown.
- Managed parking, its closing turn, event-arrival races and bounded failure if the agent ignores parking.
- At least three actual native compaction/resume cycles with active work; verify exact goal/profile recovery and no stale commands. Synthetic hooks do not count as native proof.
- Image-only information through the real tool path, without textual answer leakage. Frame timeout/reuse metadata remains honest.
- Permission denial, authentication failure, rate limits, interrupted responses and retry exhaustion.
- Provider-required response fields, result pairing, attachment formats and supported JSON constraints. No silent provider fallback.

Default CI uses deterministic fakes. Paid inference and live devices need separately scoped runs. Existing [v0.1 evidence](../validation.md) does not qualify new driver behavior. Missing native qualification is reported explicitly, not converted into a passing mock result.

## Measurements and completion

Emit bounded traces with loop/turn/step/command IDs and known times: acquisition, assembly, submission, acknowledgement, admission and completion. Record text/media size, queue high-water marks, wait/wake reason, tool latency, input age and available input/output/cache tokens. Native internal inference timings or call counts may be unavailable; label unknown values or name a turn-level proxy. No private chain-of-thought capture is needed.

Measure idle model turns/hour, useful wakes, long-run memory/storage growth, event-loop delay, stop latency, installed/transitive disk size and idle/peak RSS. Include any deployed SDK subprocesses. Caching is measured, not assumed.

The core refactor is complete when Phases 0–4 work, tests and examples use the shared implementation, and documentation clearly identifies any remaining native/hardware qualification. Do not advertise untested capabilities. For eventual DroneRTS migration, retain its quota/isolation checks even though the Python deployment boundary has been removed.
