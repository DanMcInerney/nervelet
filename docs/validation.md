# Validation

**2026-09-15 · v0.1 implementation.** These checks establish the listed behavior only.

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

## Deferred

Native repeated-compaction qualification, complete Codex qualification, physical Arduino testing, camera acquisition/image delivery, process-crash durability and DroneRTS integration are separate work. Deterministic fixtures and a basic native loop do not establish robot autonomy or hardware readiness.
