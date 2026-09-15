# Nervelet development

Read [README.md](README.md) and [DESIGN.md](DESIGN.md) before changing the library. Read [docs/dronerts.md](docs/dronerts.md) for DroneRTS integration work.

## Scope

This repository currently contains the design. Runtime code, native-agent adapters and robot adapters are not implemented. Keep proposed behavior distinct from implemented and tested behavior.

The library connects native coding-agent sessions to continuously changing robots or simulations. Simplicity, modularity, compact observations and one owner per concept are requirements.

## Ownership

- The native agent adapter owns sessions, tool registration, instruction restoration and compaction events. Reuse the native inference loop and workspace capabilities.
- The core owns the received goal, lifecycle, delivery cursor and refresh coordination.
- The robot adapter owns sensor acquisition, calibration, command admission, jobs, actuator ownership and local control.
- Agent-authored code and notes belong in the private workspace. Do not add a parallel memory database, planner or conversation compactor.
- Generate schemas and operating instructions from canonical profile definitions. Application rules and vehicle-specific knowledge stay in robot adapters.

## Preserve the contract

- Keep acquisition time, delivery time, physical state and execution status distinct.
- Repeat compact current self-state and the exact received goal; retain durable sources outside summarized history.
- Batch only compatible commands. Admission is not completion; dependencies require ordered jobs or routines.
- All actuator access uses the same ownership and cancellation checks, including authored scripts.
- Cancellation and Stop remain responsive during waits, acquisition and compaction.
- Never silently replay uncertain mutations, invent fresh evidence, drop unread events or expand permissions.
- Treat ordinary messages separately from explicit goal updates.
- Use bounded queues, execution records and storage. Report backpressure explicitly.

## Verification

For documentation changes, check links, fenced diagrams and `git diff --check`.

For implementation, first test the portable contract with a deterministic fake robot and native-session test doubles. Test stale observations, duplicate/uncertain commands, batch partial failures, goal changes, cancellation and repeated compaction. Add actual backend tests before claiming Codex or Claude Code support.

Do not launch paid inference or live robots for documentation changes. Hardware or autonomy claims require separately recorded evidence.

Keep credentials, local agent configuration, runtime state, generated evidence and dependencies out of Git.
