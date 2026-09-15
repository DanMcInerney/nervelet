# Nervelet

**A small nervous system for coding agents.**

Connect one native or API/local-model agent to continuously changing sensors, APIs or a simulation. Embed the TypeScript Bridge directly, or use the existing CLI. Environments own execution; native harnesses own reasoning; one optional supervisor owns continuation.

**v0.2:** Shared handlers, conditional waits and managed parking, compact recovery, acknowledged events, typed images, MCP, and modular Codex, Claude Code and API drivers. The CLI, serial adapter and installer entry points remain compatible. [Validation](docs/validation.md) records tests and remaining native/hardware qualification.

**Implemented handoff:** [NEXT-DESIGN.md](NEXT-DESIGN.md) is the accepted design. [Embedding and drivers](docs/v2.md) describes the implementation and limitations. Python and the background engineer remain unimplemented optional follow-ons. DroneRTS gameplay and live sessions are outside this refactor.

```mermaid
flowchart LR
    A["One native coding agent"] <-->|"Shell: nervelet step"| B["Nervelet bridge"]
    B <-->|"Continuous I/O"| D["Device, API or simulation"]
    A <--> W["Native scripts and files"]
```

## The small version

- **One persistent bridge** collects data while the model thinks.
- **One step command** observes, waits, or submits compatible commands together.
- **One compact result** contains the exact goal, dated data, own status, running jobs and unread events.
- **Small harness modules** install instructions and recovery hooks. Native sessions, execution and compaction stay native.
- **Plain files** preserve essential instructions and notes across compaction.

Use the native shell tool for the compatible scalar CLI path. Managed native drivers use MCP; API/local models call the same handlers directly. Each Bridge has one operator. Independent instances can share a TypeScript host.

DroneRTS is the canonical application; its vehicle fields and game rules stay outside the core.

## Try the simulated bench

Requires Node 24+, Git and an installed, signed-in coding harness. From this checkout:

```sh
npm ci
npm run build
npm link
cd examples/demo
nervelet init --harness claude-code
nervelet serve
```

In another terminal, open the **same directory**, run `claude`, and ask:

> Follow the Nervelet goal. Keep observing with bounded steps until the goal is done, then stop.

The demo samples simulated temperature every 50 ms and supports an LED and timed movement. No hardware is connected. `nervelet demo` also starts this environment without a config file.

For Codex, use `nervelet init --harness codex`, then `codex --enable hooks`. Review project/hook trust and native permissions. [Codex qualification is partial](docs/harnesses/codex.md): startup and observation passed; this Windows host blocked native file writes.

## The step

```sh
nervelet step
nervelet step --seen RECEIVED_BUNDLE_ID --wait-ms 2000
nervelet step --request request.json
nervelet cancel JOB_ID
nervelet goal --file new-goal.txt
nervelet stop
nervelet shutdown
```

Write `request.json` using the **actual** previous bundle ID, goal version and next command ID:

```json
{
  "seen": "RECEIVED_BUNDLE_ID",
  "goalVersion": 1,
  "commands": [
    {"id":"c1","kind":"set_led","args":{"on":true}},
    {"id":"c2","kind":"move","args":{"durationMs":200}}
  ]
}
```

One batch returns individual admissions and one observation. `accepted` means a job started; a later step reports completion. A finished shell call can leave the device moving. Native file tools do not refresh sensors.

## Small, recoverable context

Every step repeats compact current state and the exact goal. Startup/resume/compaction hooks require a fresh observation. That recovery bundle adds the exact operating profile, active job arguments and optional `working.md` note. Acknowledging its ID enables commands. Old sensor positions never become durable facts.

Native drivers keep the harness's session, workspace and compaction. Managed parking waits without periodic model calls; attached CLI sessions have no guaranteed idle wake. Bridge restarts create a new epoch; in-memory events and receipts are not persisted.

## Build an integration

- [Design](DESIGN.md): the loop, ownership, batches, freshness and recovery.
- [Adapter API](docs/api.md): configuration, embedding and ownership.
- [v0.2 embedding and drivers](docs/v2.md): shared tools, parking, images, native/API drivers and compatibility.
- [Arduino example](docs/arduino.md): firmware, serial setup and protocol.
- [Integration decision](docs/architecture-options.md): why a CLI and bridge.
- [Claude Code](docs/harnesses/claude-code.md) · [Codex](docs/harnesses/codex.md)
- [How DroneRTS works today](docs/dronerts.md)
- [Development instructions](AGENTS.md)

The six-pilot deterministic fixture demonstrates the DroneRTS integration shape. Actual gameplay migration and native image understanding remain unqualified. This repository has not been published to npm; install from a built local checkout for a separate project.

## Check

```sh
npm test
npm run check:package
npm run check:docs
npm run measure
```

Builds and runs deterministic bridge, CLI, hook, serial, MCP, driver and embedding tests. Package checks install an isolated core without optional peers; measurement uses a fake driver. Native inference tests are explicit opt-in commands described in [validation](docs/validation.md).
