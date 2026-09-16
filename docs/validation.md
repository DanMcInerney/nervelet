# Validation

**Current validation:** [The reliability implementation record](reliability.md) contains the latest test count, package checks and result/profile measurements. [The v2 contract](v2.md) documents current behavior. The dated records below preserve their original source revisions, counts and limitations; they are not validation of later changes. [Documentation and evidence index](index.md).

## Historical observation/attention checks — 2026-09-16

Started with a clean tree at `2a806a61b5d9cc2dc48029bb9818bd228c8aba25`; `npm ci` and the **57-test baseline** passed. That expanded local suite had **89 tests**. Build, `npm test`, `npm run typecheck`, isolated `npm run check:package`, `npm run check:docs`, and `git diff --check` passed on Windows with Node 24.15.0 / npm 11.12.1. This is historical local evidence; the older CI run below did not validate those changes. Dependencies were not upgraded.

New fixtures cover API-only emergency requests; continuous samples during blocked inference with zero ordinary interruptions; same-goal resumption without overlap; held waits, captures, uncertain admission, asynchronous recovery assembly, natural completion, parked/closing turns; Stop/closure/domain-death/goal-change precedence; generation checks after replacement acknowledgement; rearm/cooldown/interrupt budgets; coalescing and bounded capsules; FIFO backlog acknowledgements; unsupported/failed interruption and termination deadlines. Codex and Claude have separate terminal-correlation fixtures. Large Unicode/escaped commands cross core, handler, IPC and local HTTP MCP paths. Reference packing checks compare included events and exact final JSON/tool-result bytes. Existing tool-pairing, serial, CLI and six-actor isolation fixtures remain in the suite.

During development the original suite caught four compatibility failures involving Stop/goal-transition snapshots and legacy recovery rendering. Those regressions were corrected. An initial measurement also emitted a negative-timer warning; its sleep is now clamped and the repeat run completed without it. No native inference or DroneRTS gameplay was run; **native emergency interruption and actual tool/result pairing across interruption remain unqualified**.

Reproduce with `npm run measure:packing` and `npm run measure`. Generated records stay in ignored `.runtime/`. Representative local results:

| Measurement | Result and interpretation |
| --- | --- |
| 64-event candidate-packing work | 64 event encodes versus 2,080 event visits in the former growing-bundle loop; both also perform final verification |
| Materialized serialized bytes per fixture bundle | 48,427 versus 829,980 (94.17% less); a string-allocation work proxy, not measured allocator calls |
| 1,000 complete new Bridge observations of that fixture | 319 ms wall / 391 ms process CPU; includes runtime/JIT work, with no old/new CPU comparison |
| Packing workload heap | 7,528,208 → 7,696,864 bytes after GC; sampled peak 12,333,888; RSS 63,057,920 |
| 3,000 acknowledged streaming observations | 886 ms; about 0.57 MB post-GC heap growth |
| Streaming workload event-loop p99 / maximum | 25.2 / 25.2 ms |
| Simulated Stop while parked | 1.34 ms |
| About one second parked with streaming samples | Zero periodic fake-driver turns, one event-triggered wake |
| Core-only independent installation | About 1.67 MB, six packages; no optional SDK/MCP/serial runtime imports |
| Model latency, useful emergency response, tokens, cost, native process RAM | Unavailable; no model/native session was launched |

Counts and bytes are workload-specific; timestamps can change a few bytes between runs. CPU/heap results include allocator/JIT noise and do not establish leak freedom or reduced model latency. Independent installation checks use the existing package version, with archive identity and installation evidence written to ignored `.runtime/package-check.json`. Package version and dependencies remain unchanged; no tag, release or npm publication is part of these changes. No generated evidence or dependencies belong in Git.

Remaining qualification: actual Codex `turn/completed` and Claude UUID/abort-reason behavior with paired tools, long sessions, image understanding, compaction, application-specific failure policies and deployed resource/isolation limits. The API binding explicitly reports active emergency interruption unsupported. The host still owns emergency selection, reliable source events, physical job policy and mission completion. No wait-snapshot hint, new sensor store, background model or second actor supervisor was added.

## v0.2 checks and versions

Starting revision: `af0c1bfc3514aa8096eb2b7ba1fba0b1b7f92edd`. The starting tree already had modified `AGENTS.md`/`README.md` and untracked `NEXT-DESIGN.md`/`docs/next/`. Those changes were preserved and the handoff received explicit implementation-status annotations. Baseline: **28/28 tests passed** before implementation.

Historical v0.2 local suite: **57/57 passing tests**, including all original tests. `npm ci`, `npm test`, `npm run typecheck` (source, tests and examples), `npm run check:package`, `npm run check:docs`, and `git diff --check` pass. [GitHub Actions run 35031618314](https://github.com/DanMcInerney/nervelet/actions/runs/35031618314) also passed installation, tests, types, documentation and isolated package checks on both Ubuntu and Windows for implementation commit `b529f3732660855196b92c446420be73e6001215`. No paid inference, robots, DroneRTS matches or live sessions were used.

| Component | Local version/evidence |
| --- | --- |
| Platform | Windows, Node 24.15.0, npm 11.12.1 |
| Remote CI | Ubuntu and Windows, Node 24.20.0, npm 11.19.0 |
| TypeScript / Node types | 5.9.3 / 24.13.4 |
| Ajv / schema dialect | 8.20.0 / draft-07 |
| MCP TypeScript SDK | 1.30.0, pinned optional peer and development dependency |
| Claude Agent SDK | 0.3.273, pinned optional peer; official types plus injected query fixture |
| Serialport | 13.0.0; byte-stream fixtures, no UART |
| Codex App Server schema | Generated locally with installed CLI 0.144.0; driver exercised with scoped protocol fixtures |
| API provider/model | Local HTTP fixtures / `fixture-model`; no real provider/model qualification |

Required behavior exercised:

- Single Bridge shared by CLI, IPC, embedded handlers, MCP and driver paths. Packed legacy imports and installers retain their meaning.
- Complete request validation before effects; compatible/partial batches; increasing IDs; known/expired/unknown receipts; authoritative reconciliation; no late effects after goal replacement.
- No-goal startup, host-owned received versions, stale-generation acknowledgements and three synthetic recovery cycles with active jobs.
- Event peek/ack, lost responses, stable redelivery IDs, partial slices, bounded delivery history and backpressure. V2 unacknowledged command results are redelivered.
- Conditional event, threshold, deadband, review and actual terminal-job waits; invalid/stale input filtering; event arrival during registration and native closing response; invalidated wait tokens.
- Fake managed supervision with no periodic idle calls, bounded unexpected finals, goal interruption and no overlapping operator turns. Borrowed clients/environments are not closed.
- One final image capture per observation; capture interruption; typed MCP and native request image mapping. These assertions check protocol content, not model vision.
- Official MCP SDK client/server in-memory and authenticated HTTP round trips. A real compiled `nervelet mcp` subprocess attaches to the existing IPC bridge and applies synthetic native recovery markers. Forged routing, missing credentials and browser-origin HTTP requests are rejected.
- API HTTP pairing for every declared tool ID, concurrent `busy` results, provider message-field preservation, malformed/incomplete JSON, bounded retries, complete-exchange rotation, explicit model mismatch, unsupported images and HTTP authentication failure.
- Six DroneRTS-shaped pilots in one Node process: isolated goals, images, inboxes and resource ownership; quotas; one pilot's blocked capture does not block another's control. No game migration or native child qualification is implied.
- Finite recorded-action replay rejects divergent commands; it never invents a counterfactual result.

## v0.2 measurements

`npm run measure` uses the simulated bench, a fake driver and a bounded 128-record trace sink. It records JSON in ignored `.runtime/measurements.json`; `npm run check:package` records ignored package evidence. Set `NERVELET_MEASURE_MS` for a longer quiet window (1,000–3,600,000 ms). The figures below are local samples, not production latency or autonomous-performance guarantees.

| Measurement | Local sample |
| --- | --- |
| Demo startup / ordinary / one-event text | About 2.7 KiB / 0.75 KiB / 0.90 KiB JSON |
| 3,000 acknowledged streaming observations | About 0.92 s |
| Post-GC heap growth over that run | About 0.52 MiB; allocator/JIT noise included |
| Idle / peak RSS during observation workload | About 57 / 63 MiB, Node process included |
| Event-loop delay p99 / maximum | About 18 / 18.5 ms under this workload |
| Simulated Stop while parked | About 0.8 ms |
| 60-second quiet streaming window | Zero periodic fake-driver turns; one useful event wake |
| Post-GC heap during quiet window | 8,161,576 → 8,587,376 bytes; no leak-freedom claim |
| Reliable-event high water | 2 events / 118 bytes; zero unread at end |
| Delivery mappings after 3,000 observations | 32 (configured bound) |
| Core-only installation | About 1.6 MB on disk, six packages; no optional MCP/Claude SDK/serial binaries |
| Full development `node_modules` | 292,969,358 bytes, including selected SDK assets, serial and build/test dependencies |
| Native subprocess RSS, model tokens/cache, billed cost | Unavailable: no native/API inference launched |

Package checks build and pack the project, install it into a fresh temporary consumer with optional dependencies omitted, prohibit optional integration imports via a Node resolve hook, and run a Bridge command plus all original public-entry imports. The measurement excludes the separately installed Node executable from disk totals. Loading lazily does not erase the installed cost of SDKs.

The 60,008 ms quiet-window trace and its sampled heap are recorded separately in the measurement JSON. Its zero-turn hourly estimate is extrapolated from one minute with a fake driver, not an hour of native inference. A multi-hour native soak and deployed DroneRTS resource accounting remain outstanding. The short workload does not establish leak freedom.

## New-driver qualification gaps

The Codex and Claude drivers implement lifecycle and media mappings, but **native image understanding, sustained native parking/tool holds, at least three actual compaction/resume cycles, and permission/auth/rate-limit/interruption recovery across real sessions remain unqualified**. Claude fixture input is injected into the official query-shaped interface; no SDK inference process was launched. Codex fixture notifications are synthetic. Capability reports explicitly label the lack of qualification. Native internal call counts are not guessed from host turns.

The implementation follows the official [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude streaming-input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [OpenRouter tool-pairing](https://openrouter.ai/docs/guides/features/tool-calling) and [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility) contracts. Documentation and installed types do not establish native behavior.

The [managed examples](../examples/managed/claude-code.ts) require an explicit model before invoking inference; the [Codex example](../examples/managed/codex.ts) also requires an explicit executable. Qualify each chosen provider/model, auth mode, permissions and OS in a separately bounded run. The library never substitutes an API/local model for a native session.

Further library gaps remain physical serial hardware; long-duration memory/transport soak; source-specific image freshness and decoding; provider-specific JSON constraints; crash-durable events/receipts; and application-owned artifact and routine capabilities. DroneRTS has since implemented its [embedded application integration](dronerts.md), with separately recorded dependency/quota/isolation tests and unresolved native qualification. Optional sequence helpers, persisted core store, engineer and Python device adapter are not implemented or enabled.

## Historical v0.1 evidence

The following records predate the new drivers. They remain evidence for the original CLI path only.

## Deterministic checks

`npm test` builds TypeScript and runs **28 passing tests** on Windows, Node **24.15.0**, npm **11.12.1**. No model inference or hardware is used by this suite.

- Real compiled CLI over a named pipe: load the shipped TypeScript config, observe, submit a batch, cancel, replace the exact goal and shut down.
- Acquisition and local movement progress independently; active and completed jobs are observable.
- Conflicting/invalid commands, bounded partial batches, duplicate/expired IDs and uncertain admission timeouts.
- Lost stdout/event redelivery, acknowledgement of only included slices, capacity/backpressure and stale receipt time.
- Three simulated compactions with a running job: exact goal/profile/note/arguments restored; old acknowledgements cannot clear new recovery.
- Stop during a wait, cancellation during a blocked capture and simultaneous goal/Stop persistence.
- Installer preservation/idempotency and actual hook subprocesses receiving simulated compact events.
- Serial byte-stream protocol: confirmed startup Stop, epoch-scoped IDs, same-chunk receipt/completion, malformed input, clock reset, stale/invalid sensing, independent heartbeat and terminal-job preservation.

CI runs this suite on Node 24 with Ubuntu and Windows. CI contains no native inference tests.

A local demo measurement with the goal `Inspect the bench, then stop.` produced a **2,671-byte startup recovery bundle** and a **664-byte ordinary bundle**, without jobs/events/notes. These are JSON byte sizes, not measured model tokens. Default 32 KiB output capacity is a ceiling; source profiles and current data determine actual size.

## Native Claude Code: passed basic loop

CLI **2.1.270**, signed-in native session; no model override. Run:

`native-claude-code-f0f553ff-d8bd-46d1-bf29-38d343279091`

Native session: `b2b6f3d7-0e95-47e6-ad88-b33a3b36935f`.

The actual agent received the startup hook, called three steps, wrote `request.json` using its native file tool, batched LED + 200 ms movement, received `completed` and `accepted` receipts, observed the movement complete, then called Stop. Exit 0; final marker `NERVELET_OK`; no permission denials. Native reported duration: 24.136 s. The observed job ran from bridge 12,588 ms to 12,813 ms. Both clocks measure this test, not physical hardware.

An earlier basic-loop run also passed. No subagents were spawned. **Actual manual/automatic compaction, resume and long unattended operation were not qualified by this run.** Repeated recovery testing above injects lifecycle events deterministically.

## Native Codex: partial; Windows sandbox blocked full test

CLI **0.144.0**, signed-in native session; no model override. Startup hook execution advanced the recovery generation, and the agent received exact recovery instructions and dated simulated state through a real step.

Run `native-codex-56c41e21-e953-4a03-b3b1-8d5aed85aa7f` exited normally with `NERVELET_BLOCKED`: native workspace writing was read-only despite `--sandbox workspace-write`; the agent stopped the loop without commands. The installed CLI source explicitly downgrades that legacy mode when the Windows sandbox is unconfigured. [Versioned Codex configuration source](https://github.com/openai/codex/blob/rust-v0.144.0/codex-rs/config/src/config_toml.rs).

Run `native-codex-363943de-a943-4bd4-859c-1389d0133b42` selected the native unelevated Windows sandbox. Native file writes failed with `windows unelevated restricted-token sandbox cannot enforce split writable root sets directly; refusing to run unsandboxed`. The test reached its 90 s deadline; the owned process tree was terminated and bridge closed. No batch was admitted. The script now tells the test agent to stop immediately after any required tool failure.

This is **not a complete Codex integration pass**. Full batch/workspace qualification needs a functioning native permission configuration. The installer does not change user permissions; we did not bypass the Windows sandbox to declare success. Linux/macOS native sessions and repeated real native compaction remain unqualified.

## Arduino firmware: compilation passed; hardware untested

The Uno sketch compiled using Arduino CLI **1.5.2-rc.1**, `arduino:avr@1.8.6`, ArduinoJson **7.4.2**, FQBN `arduino:avr:uno`.

- Flash: **13,852 / 32,256 bytes (42%)**.
- Static globals: **856 / 2,048 bytes (41%)**; 1,192 bytes remain for stack/heap. This is not a runtime peak-memory measurement.

No board was flashed or connected. Serial tests used an injected Duplex stream, not a physical UART. Sensor calibration, real watchdog timing, unplug/replug behavior and hardware reliability need a bench test.

## Repeat native tests explicitly

After building and `npm link`, with the corresponding CLI installed and signed in:

```sh
node scripts/smoke-native.mjs claude-code
node scripts/smoke-native.mjs codex
```

These commands **use inference**. Claude has a $1 run budget; both have a 90 s process deadline. Codex uses an isolated home with a copy of existing sign-in and narrowly scoped fixture rules. Only the fixture's installed hooks bypass native hook trust review for this test. Normal installation does not bypass review. On Windows, set `CODEX_JS` if the CLI JavaScript entry point is outside the usual global npm location.

The script records bounded native logs and summaries in ignored `.runtime/`. These files can contain private context and credentials in the isolated native home; keep them out of Git. Owned bridges/processes are stopped on completion/failure. Tests target only the simulated environment, never DroneRTS or attached hardware.

## Deferred at the v0.1 baseline

At this historical baseline, typed image transport, embedding and actual DroneRTS integration were deferred. V0.2 and the later application integration implement those surfaces; their native/hardware qualification remains separate. Native repeated-compaction qualification, complete Codex driver qualification, physical Arduino testing and process-crash durability remain outstanding. Deterministic fixtures and a basic historical native loop do not establish robot autonomy or hardware readiness.
