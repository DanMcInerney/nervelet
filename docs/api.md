# Adapter API

**v0.2:** This page retains the compatible CLI/adapter surface. See [embedding and drivers](v2.md) for the full shared-handler API, protocol 2, injected goals, ownership options, conditional waits, media and reconciliation.

One adapter owns the environment. The core owns goal/delivery coordination; the native harness owns the agent. See [types](../src/types.ts) and the small [demo adapter](../src/adapters/demo.ts).

## Configure

Requires Node 24+. Install the library in your application:

```sh
npm install nervelet
```

Use `npx nervelet` for the locally installed CLI. Native harness hooks invoke `nervelet` directly, so also use `npm install --global nervelet` for that path. A global CLI alone does not make package imports resolve in another project. For local library development, build the checkout and use `npm install /absolute/path/to/nervelet` instead.

`nervelet.config.ts`:

```ts
import { defineConfig } from 'nervelet';
import { createDemoEnvironment } from 'nervelet/demo';

export default defineConfig({
  environment: () => createDemoEnvironment(),
  limits: { maxWaitMs: 10000 }
});
```

Write an exact objective in `goal.txt`, then run `npx nervelet serve`. Node 24 loads the TypeScript config directly; use erasable types rather than TypeScript syntax needing transformation.

## Implement Environment

| Member | Contract |
| --- | --- |
| `profile` | Canonical ID/version, concise instructions/units and JSON Schema command definitions; changes fail closed. Use `immutableProfile` for a checked immutable copy and cheap later identity checks. |
| `start(signal)` | Open source and start continuous acquisition. Reconcile prior device work. |
| `snapshot(after, signal)` | Current complete compact state, samples, jobs and events after the acknowledged sequence. |
| `acknowledge(through)` | Consume only events through this sequence. |
| `wait(signal)` | Resolve on relevant event/job/fault; abort promptly. |
| `execute(command, context)` | Validate domain authority/freshness/resource ownership and return admission promptly. |
| `resultBudget(command)` | Optional pure synchronous reservation for retained `Receipt.data` and escaped result delivery bytes, checked before execution. Omission permits scalar receipts only, reserving 2,048 escaped bytes for reliable v2 admission. |
| `releaseReceipt(identity)` | Optional synchronous, idempotent, non-throwing release of executor-owned result storage after resolved acknowledgement or history eviction. Never cancel or replay effects here. |
| `cancel(id, signal)` | Cancel through the domain job owner; keep terminal outcomes intact. |
| `stop(signal)` | Apply the domain's Stop policy, including old-goal work. |
| `close()` | Release streams, timers and owned resources. |

`context` provides `signal`, `goalVersion` and bridge `epoch`. Profiles are canonical: their schemas validate arguments and their text explains behavior. Changing a profile requires restart. Core has no required robot field; commands can be empty for an API monitor.

`Receipt.data?: Json` holds original operation output, separately from current state and samples. Use `immutableResult` to establish one deeply frozen JSON payload shared by the executor and Bridge; `resultBytes` charges retained data and `resultDeliveryBytes` measures its escaped tool-result fragment. Reserve worst-case bounds before effects, including changes possible during asynchronous admission. The host separately accounts for profiles, receipt/execution metadata, retained command arguments and transient serialization. See [result delivery and budgets](v2.md#protocol-and-delivery).

`ObservationStore` optionally implements bounded latest-sample/event storage, acknowledgement and wait notifications. Populate it with `setState`, `setSample` and `push`. `push` returns false on backpressure; the adapter must pause/fault its producer. Do not silently drop reliable events. Store snapshots are copies; event sequences increase and do not reset within a bridge epoch.

State/sample timestamps separate `receivedMs` (bridge-monotonic `performance.now()`) and optional `acquired: {clock, ms}`. `maxAgeMs` invalidates old receipt time. Clock synchronization, image retention, object tracking, execution authority and physical control stay domain-specific.

Return `accepted` plus `jobId` for ongoing work; report it in subsequent snapshots. Retain active jobs and a bounded number of terminal jobs, including exact original arguments. Dependent sequences need an adapter-defined ordered job. A shared `resource` in command definitions blocks conflicting entries in one batch; the adapter also rejects conflicting active work across batches.

Abort signals are cooperative. Do not block the Node event loop. A timeout leaves the command outcome unknown; the core pauses new effects and does not blindly replay. Device-local watchdogs must handle a lost controller.

## Embed the bridge

```ts
import { Bridge, serve } from 'nervelet';
import { createDemoEnvironment } from 'nervelet/demo';

const bridge = new Bridge(createDemoEnvironment(), 'Inspect the bench, then stop.');
const server = await serve(bridge, { cwd: process.cwd() });
// serve starts the bridge and writes local connection/profile files.
// Your host owns shutdown:
await server.close();
```

`serve` keeps the connection open until your host closes it. In a real host, call `close` in its shutdown handler, after use. For in-process use without IPC, call `bridge.start()`, `bridge.step(...)`, then `bridge.close()` yourself.

## Native scripts

```ts
import { request, type Bundle } from 'nervelet';
const observation = await request<Bundle>({ method: 'step' });
console.log(JSON.stringify(observation));
```

The model must read output before a subsequent call sends its ID as `seen`. Do not auto-ack inside a polling script. Use one in-flight step; cancel and Stop can run concurrently with a wait. Native scripts do not independently open the same device. `snapshot` is now explicitly cheap and non-consuming; optional `capture` owns final media acquisition. The CLI compatibility path rejects image observations; MCP and capable drivers map typed pixels to native content.

Original exports remain: `nervelet`, `nervelet/demo`, `nervelet/serial`, `nervelet/claude-code`, `nervelet/codex`. Additions: `nervelet/mcp`, `nervelet/recorded`, and `nervelet/drivers/{codex,claude-code,api}`. The optional serial dependency is loaded only when a real port is requested; optional SDKs are outside the core import path.

## Default bounds

| Item | Default |
| --- | --- |
| Bundle / goal / profile | 32 KiB / 4 KiB / 16 KiB |
| Request / one command | 16 KiB / 4 KiB |
| Commands per batch | 8 |
| Wait / adapter operation / startup | 30 s / 2 s / 10 s |
| Retained receipts / delivery mappings | 128 / 32 |
| One result payload / total retained result payloads | 16 KiB / 128 KiB |
| Escaped serialized result fragment | 16 KiB |
| Own state / latest samples | 4 KiB / 8 KiB, up to 64 samples |
| Unread events / one event | 256 and 64 KiB / 2 KiB |
| Recovery workspace note | 4 KiB |

Core limits are configurable via `limits`; ObservationStore bounds are fixed in v0.1. They are ceilings, not target payload sizes. Oversized output fails explicitly. Budget enough room for profile, state, jobs and recovery note together. State, events, receipts and jobs are in memory; a new bridge process starts a new epoch and requires domain reconciliation.
