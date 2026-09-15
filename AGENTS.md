# Nervelet development

Read [README.md](README.md) and [DESIGN.md](DESIGN.md) before changing the library. Read the relevant [Codex](docs/harnesses/codex.md) or [Claude Code](docs/harnesses/claude-code.md) contract for harness work, and [docs/dronerts.md](docs/dronerts.md) for the canonical application.

## Scope

This repository currently contains the design. Runtime code, harness adapters and environment adapters are not implemented. Keep proposed behavior distinct from implemented and tested behavior.

The initial library connects one native coding-agent session to one persistent bridge through its shell tool and a local CLI. Sources can be APIs, event feeds, robots or simulations. Simplicity, compact observations and one owner per concept are requirements. DroneRTS is the canonical usage, not the core schema.

## Ownership

- The native harness owns sessions, reasoning, tools, workspace, execution and compaction. Keep instruction installation, recovery hooks and bounded continuation behavior in separate Codex and Claude Code modules.
- The core owns the received goal, lifecycle, delivery cursor and refresh coordination.
- The environment adapter owns acquisition, latest samples, unread events, domain schemas, command admission and domain jobs. Multiple sources compose inside this adapter.
- Agent-authored code and notes belong in the private workspace. Do not add a parallel memory database, planner or conversation compactor.
- Generate schemas and operating instructions from canonical profile definitions. Core must work with an API-only environment: no mandatory camera, pose, cargo, equipment, simulation clock or actuator fields.
- Use native shell calls and local IPC initially. Do not add MCP, plugin packaging, workflow engines, subagent support or unattended process supervision to the initial scope.

## Preserve the contract

- Keep acquisition time, delivery time, physical state and execution status distinct.
- Repeat compact current domain state and the exact received goal; retain durable sources outside summarized history.
- Keep acquisition independent of inference. Coalesce replaceable samples and preserve unread events. Each step is an explicit observation boundary; arbitrary native tools do not implicitly refresh sensors.
- Batch only compatible commands. Admission is not completion; dependencies require ordered jobs or routines.
- All domain effects use the same ownership and cancellation checks, including authored scripts. Keep native process ownership with the harness and domain job ownership with the environment.
- Cancellation and Stop remain responsive during waits, acquisition and compaction.
- Never silently replay uncertain mutations, invent fresh evidence, drop unread events or expand permissions.
- Treat ordinary messages separately from explicit goal updates.
- Use bounded queues, execution records and storage. Report backpressure explicitly.

## Verification

For documentation changes, check links, fenced diagrams and `git diff --check`.

For implementation, first test the bridge and CLI with a deterministic streaming environment. Test acquisition during inference, bounded waits/output, stale observations, duplicate/uncertain commands, delivery acknowledgement, partial batches, goal changes, cancellation and repeated compaction. Qualify one Claude Code session, then serial support and Codex. Qualify DroneRTS separately while preserving its existing actor isolation and image delivery.

Do not launch paid inference or live robots for documentation changes. Hardware or autonomy claims require separately recorded evidence.

Keep credentials, local agent configuration, runtime state, generated evidence and dependencies out of Git.
