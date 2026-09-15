# Design: one agent, one bridge

**Specification · 2026-09-15 · Implementation pending.**

Nervelet connects one native coding-agent session to a changing environment. A local CLI runs through the harness's shell tool. A small persistent bridge maintains device/API connections while the model thinks.

## 1. Architecture and ownership

```mermaid
flowchart TD
    H["Claude Code or Codex: native agent loop"] <-->|"Shell command / JSON result"| C["nervelet CLI"]
    H <--> W["Native workspace and scripts"]
    C <-->|"Local IPC"| B["Persistent Nervelet bridge"]
    B <--> E["Environment adapter"]
    E <--> D["Device, API or simulation"]
    I["Harness module: instructions and hooks"] -.-> H
```

| Owner | Responsibility |
| --- | --- |
| Native harness | Model calls, conversation, compaction, shell/file tools and background processes. |
| Nervelet core | Goal record, lifecycle, bounded delivery, acknowledgements and recovery gate. |
| Environment adapter | Acquisition, latest samples, unread events, domain schema, command admission and domain jobs. |
| Harness module | Install instructions/hooks; translate supported recovery and end-of-turn boundaries. |

Build one TypeScript package with `core`, `cli`, `harnesses/claude-code` and `harnesses/codex`. Applications supply an environment adapter; serial support can be optional. The same core can be embedded in a simulator instead of running as a separate bridge process.

The CLI is a short-lived client of the bridge. Use a local socket/named pipe; do not reopen the serial device each step. These are ordinary local requests, with no MCP protocol. Native scripts use the same request client. Only the adapter writes to the device.

Initial scope excludes subagents, workflow engines, a plugin system, a memory database and a second inference scheduler. Nervelet does not call raw model APIs.

## 2. The actual loop

```mermaid
flowchart TD
    S["Load exact instructions and goal"] --> O["step: receive dated state"]
    O --> T["Native model reasons"]
    T --> A{"Next action"}
    A -->|"Use scripts or files"| F["Native tools"]
    F --> T
    A -->|"Observe, wait or command batch"| O
    A -->|"Goal complete or stopped"| X["End"]
    D["Environment collects data and runs accepted jobs continuously"] -.-> O
```

A tool result becomes input to the next model invocation within the same native session. The LLM does not continuously perceive between invocations. It understands timing and execution semantics through instructions and returned evidence.

Acquisition, model/tool work and accepted domain jobs overlap. A 100 Hz sensor does not require 100 model calls per second. Keep its latest sample; retain distinct events separately. A bounded wait returns on a relevant event or timeout. Sample-only changes need not wake every wait. No model inference is required during the wait.

**Freshness boundary:** every Nervelet step returns a new snapshot of available data. A native file read or script edit does not refresh external data. Automatic injection after arbitrary tools is deferred.

The agent continues by calling `step` again. A native Stop hook may give a bounded reminder when an active loop ends prematurely. It must respect explicit Stop, interrupts, errors and budgets. Hooks cannot restart a closed harness or guarantee perpetual operation. Initial support targets a live native session; a finished response alone does not prove the external goal is complete.

## 3. Small command surface

Proposed CLI, not runnable today:

```sh
nervelet step                         # observe
nervelet step --seen b41 --wait-ms 2000
nervelet step --request request.json  # compatible command batch
nervelet cancel j7                    # request cancellation from job owner
nervelet stop                         # end loop and cancel affected work
```

Example request file, written with native file tools:

```json
{
  "seen": "b41",
  "goalVersion": 3,
  "commands": [
    { "id": "c8", "kind": "set_led", "args": { "on": true } },
    { "id": "c9", "kind": "sample", "args": { "sensor": "temperature" } }
  ]
}
```

Observe, wait and command batch are separate step forms. One batch yields individual receipts and one observation bundle. This works even if a harness schedules shell calls sequentially. Use one in-flight step per agent.

- Validate authority, goal version, compatibility and capabilities.
- Admit entries in order without waiting for long jobs to finish. Return a receipt for every entry; independent jobs may overlap.
- Partial failure has no rollback guarantee.
- Dependencies needing completion belong in an ordered domain job or native script. Dependencies needing new evidence require another step.
- The adapter enforces exclusive resources and explicit replacement, such as one movement writer.
- Deduplicate bounded command IDs. Unknown/expired outcomes require reconciliation; never automatically repeat an uncertain effect.

Awaiting admission differs from awaiting completion. Return `accepted` and a job ID promptly; later snapshots report `running`, `completed`, `blocked`, `cancelled` or `failed`. Report durations when measured and label ETAs as estimates. Physical state is separate: a finished shell call can leave a robot moving.

Cancellation and Stop bypass ordinary waits/capture queues. Device-local control and watchdogs own time-critical behavior; model keep-alives must not be necessary for valid local work. The adapter specifies what controller loss or Stop does to each job.

## 4. The compact bundle

| Content | Send |
| --- | --- |
| Header | Bundle ID, clock epoch, schema/profile version, delivery time and loop status. |
| Reminder | One fixed short sentence about step, timing and job semantics. |
| Goal | Exact bounded text, version and status. |
| Own state | Current domain status, acquisition time and validity. |
| Samples | Latest relevant values, source ID, acquisition time and validity. |
| Jobs and results | Active domain jobs, progress/reason and per-command receipts. |
| Events | Bounded unread slice, stable IDs and `hasMore`. |

A robot adapter supplies its measured equipment, held items, cargo, pose or velocity. An API monitor might supply queue depth. No robot field is mandatory. Missing telemetry means unknown, not zero or stationary.

Send complete compact current state; avoid deltas requiring remembered history. Omit empty optional collections, verbose logs and directory listings. Bound goal/profile size at configuration time instead of silently truncating instructions. Preserve required units, precision and invalidity.

The environment stores samples/events once; the core tracks delivery. Stdout success alone does not establish model receipt. The next agent step echoes the previous bundle's `seen` ID; acknowledge only events included in that bundle. Redeliver uncertain events with stable IDs. Scripts must not auto-ack output the model never received. This establishes receipt, not comprehension or agreement.

Bound storage and report backpressure. Samples may coalesce; reliable unread events must not silently disappear. Mark gaps in lossy streams. Bound the bundle-to-event mapping; reject unknown/expired acknowledgements explicitly.

### Camera and ongoing execution

A profile chooses latest streaming frame or capture-on-step. A newly assembled snapshot is not necessarily a newly acquired measurement. Preserve capture time and report acquisition failure.

The minimal shell path returns an immutable image path and matching metadata. The agent then uses its native image-reading tool. A path or base64 text in stdout is not itself visual input. The frame and associated sensors retain their capture ID even if the world moves before the image is read. Bound retained files and report expiration.

Same-result images require a separately qualified native multimodal bridge. Initial Arduino scalar sensors need none. DroneRTS currently delivers images through MCP; its eventual transport change must preserve its observation contract.

Domain job status comes from the adapter. Native shell task status stays in the harness's tool results; do not duplicate its process registry. Scripts causing device effects still use the adapter's command path.

## 5. Stale evidence and changing goals

Acquisition, delivery and command-admission times differ. Use monotonic clocks with a restart epoch; preserve device timestamps separately unless synchronized. Unsynchronized clocks alone cannot establish acquisition age; report uncertainty or use an explicit transport-age bound. Simulators may add simulation time.

An image showing a moving object five seconds ago does not establish its current location. An adapter may reject commands whose required observations exceed a maximum age. Age checks cannot prove the world stayed unchanged. Reactions faster than inference require available local control.

An authorized explicit goal update creates a new version. The simple default pauses new effects and cancels affected old-goal jobs, delivers the new goal, then enables new-version commands after acknowledgement. Serialize updates with command admission. Chat alone does not replace goals; explicit Stop acts immediately. DroneRTS retains its application rule of activating objectives on actual per-drone delivery.

## 6. Compaction: keep exact sources small

Do not require crucial facts to survive verbatim inside a conversation summary.

| Exact source | Delivery |
| --- | --- |
| Operating contract, command schema, units and calibration | Generated profile file and native instructions; restore on start/resume/compaction. |
| Current goal | Core record; repeated every bundle. |
| Active job specification and source version | Adapter record; short status normally, full specification on recovery or lookup. |
| Code and important commitments | Native workspace; optional short `working.md` restored on recovery. |
| Current environment | Reacquire; old snapshots remain historical evidence. |

Repeat a tiny reminder each step: “Step refreshes observations; native file tools do not. Observation times are acquisition times. Accepted jobs may still run. Wait when idle; stop ends the loop.” The complete manual need not accompany each sample.

On start, resume, compaction or profile change, the harness module marks refresh required and restores the exact trusted profile. The next step withholds submitted mutations and returns current state, goal and active job details. A subsequent step acknowledging that recovery bundle may issue newly decided commands. Never replay withheld requests. An older acknowledgement cannot clear a newer recovery generation.

Ordinary thinking and compaction do not automatically cancel valid jobs. Stop, expired authority, controller failure and invalid execution conditions follow domain cancellation rules. After bridge/device restart, reconcile actual job status before accepting effects; history is not a recovery script.

Qualify hooks on the supported harness version. If recovery boundaries cannot be observed reliably, report the limitation. Keep external sensor text and saved hypotheses at their original authority; trusted hooks must not promote them into instructions.

## 7. Integration contract

An environment supplies a versioned profile, continuous acquisition, bounded snapshots/events, command submission and cancellation. A harness module supplies native instruction installation, recovery notification and a bounded continuation hook.

Use native promises, async iterators and `AbortSignal`. The CLI and embedded API call the same core handlers. There is no generic model-provider or native-tool framework. Details belong in the [Claude Code](docs/harnesses/claude-code.md) and [Codex](docs/harnesses/codex.md) modules.

## 8. Build order and proof

1. Implement the bridge and CLI against a fake streaming environment.
2. Qualify one Claude Code session: Bash, files, waits, Stop and repeated compaction.
3. Add a serial adapter and the [Arduino example](docs/arduino.md).
4. Qualify the Codex module against the same contract.
5. Integrate [DroneRTS](docs/dronerts.md), preserving its observation and isolation rules.

Test acquisition during inference, bounded output, stale/missing data, batch partial failure, uncertain receipts, duplicate commands, goal-change races, prompt cancellation and three successive compactions with a running job. Check model-visible content, not merely emitted stdout.

Measure tokens, observation age and useful progress separately. Documentation and deterministic fixtures do not establish autonomous or hardware performance.
