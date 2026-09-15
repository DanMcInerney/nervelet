# Decisions after Fable’s review

**2026-09-15 · revised for the accepted TypeScript core.** [Handoff](../../NEXT-DESIGN.md) · [Contract](CONTRACT.md)

The [review](https://claude.ai/artifact/J4Vo9uzP7cGiSe7JTxr3iv) correctly prioritizes fewer unnecessary model round trips. Adopt that principle without moving domain execution into a second scheduler or treating version-specific observations as universal limits.

## Runtime decision

Keep TypeScript and evolve the working Bridge. The loop needs event handling, cancellation and bounded state; those do not require Python. This avoids rewriting the implementation and lets DroneRTS embed it directly. Python remains useful for optional device adapters. There is one core state machine and one receipt authority. The earlier Python-first recommendation is superseded.

## Disposition of the fourteen findings

| Finding | Decision |
| --- | --- |
| F1: conditional waits | **Adopt and strengthen.** Separate logical wait from transport timeout. Managed parking removes periodic idle inference; merely repeating shorter tool waits does not. |
| F2: reusable sequences | **Adopt in environment utilities.** One cancellable parent, bounded children, fresh admission per child. Preserve the environment’s sole execution ownership. Implementation size is unmeasured. |
| F3: one JSON action | **Adopt as an optional API/local encoding.** Same operations, schemas and admission gate as tool calling. No inference framework required. |
| F4: prompt caching | **Adopt.** Stable trusted prefix and schema order; volatile evidence later. Preserve complete history and correctness. No mandatory session restart for cache optimization. |
| F5: image qualification | **Adopt the test, correct the evidence.** Test image-only information in each selected native/model path. The cited Desktop issue does not establish a Claude Code defect. |
| F6: long-call qualification | **Adopt the test, correct the interpretation.** Test sustained sessions and individual long waits separately; the old SDK issue is not a universal 70-second tool limit. |
| F7: current MCP design | **Adopt explicit routing and compatibility tests.** Loop state is explicitly addressed; authenticated identity authorizes it. Notifications/subscriptions do not by themselves schedule inference. |
| F8: agent-accessible goal changes | **Optional policy.** Require explicit delegation and expected-version checks. A session being attached does not grant goal authority. |
| F9: redelivery indicator | **Adopt as a hint.** Stable IDs and tracked delivery attempts support it. It needs bookkeeping and does not replace command deduplication. |
| F10: pinned routine calls | **Adopt as an environment capability.** Useful for small API models and scripts authored by native agents. No compulsory shell or interpreter. |
| F11: traces and replay | **Adopt early.** Measure real timing, bytes and available usage. Recorded replay rejects divergent action histories; it cannot invent counterfactual physical outcomes. |
| F12: contract before rewrite | **Adopt the fixtures; keep TypeScript.** Refactor the working implementation in place. Preserve baseline behavior through compatibility tests and qualify the new contract. No Python rewrite or second core. |
| F13: shorter documents | **Adopt.** Short handoff, normative contract, rationale, qualification and separate optional engineer. |
| F14: budgets | **Adopt configurable enforcement.** Count only observable units. Pause deterministically; do not force an extra model-generated summary or arbitrary three-call limit. |

## Verify mechanisms, measure performance

- **Codex MCP:** the documented default tool timeout is 60 seconds and is configurable. This is a transport configuration, not a recommended robot decision period. [Official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).
- **Claude SDK:** issue #676 describes failures after sustained session activity in older versions. It is closed as a duplicate of #730, concerning stdin closure in `query()` with hooks. These reports justify qualification; they do not prove every long tool call has a 60–70 second ceiling. [#676](https://github.com/anthropics/claude-agent-sdk-python/issues/676), [#730](https://github.com/anthropics/claude-agent-sdk-python/issues/730).
- **Images:** the cited #77338 reports Claude Desktop on Windows and was closed as unrelated to Claude Code. It does not establish SDK/CLI image failure. [Issue](https://github.com/anthropics/claude-code/issues/77338).
- **MCP:** the 2026-07-28 specification makes application state explicit across stateless requests. Keep the core transport-neutral and use a qualified SDK compatibility path for older clients; DroneRTS’s current MCP transport still initializes legacy sessions. A typed loop ID is routing data, not authentication. [Specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/index).
- **Structured output:** availability is endpoint-specific; Ollama’s documentation explicitly excludes its cloud service at this review date. Grammar-constrained JSON ensures syntax, not sound decisions. [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs).
- **Hardware:** Raspberry Pi Zero 2 W has a 64-bit Cortex-A53. Excluding it solely because a runtime requires ARMv8 is unsupported. Whether the full installation fits its memory is a separate measurement. [Hardware](https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/).

The review’s model latency, image-token, dependency-size and device-throughput estimates are not Nervelet measurements. Do not encode them as limits or restrict local support to one model/board combination. Measure an explicitly configured stack and publish the result.

## Native integration

The portable combination is deterministic library + thin driver + MCP tools. Skills teach optional procedures; hooks report lifecycle events and enforce qualified native boundaries. Neither is the source of truth for goals, freshness or cancellation. A plugin can install these pieces; it is packaging. Workflow engines and memory plugins are unnecessary.

Managed drivers expose open/resume, run-turn, interrupt, normalized events and close, plus a capability report. Steering is optional. There is one explicit session and one continuation owner. Permission/authentication failures block rather than restart forever; retry budgets are bounded.

| Driver | Native integration |
| --- | --- |
| Codex | App Server sessions/turns, completion and compaction events; MCP tools. Dynamic tools remain an optional qualified transport. [App Server](https://learn.chatgpt.com/docs/app-server) |
| Claude Code | Official TypeScript Agent SDK with persistent streaming input, native coding configuration and explicit permissions. Qualify interruption and response boundaries before the next input. Tool auto-approval is not device isolation. Check actual authentication/deployment separately. [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [setup](https://code.claude.com/docs/en/agent-sdk/quickstart) |
| API/local | Small async driver with explicit provider/model, bounded complete history, cancellation and usage. No MCP required. Tool calling or one JSON action; never silently substitute this for a native harness. [OpenRouter tools](https://openrouter.ai/docs/guides/features/tool-calling) |

Attached `/loop`, Monitor or channel integrations are optional wake conveniences, with version/lifetime qualification. They do not own domain jobs. Avoid enabling an additional native goal scheduler in managed mode. Native goal completion is not authoritative proof of an environmental outcome. [Claude scheduling](https://code.claude.com/docs/en/scheduled-tasks), [Monitor](https://code.claude.com/docs/en/tools-reference#monitor-tool), [goals](https://code.claude.com/docs/en/goal).

Keep the core callable in process. Expose tools through the host’s existing MCP server, a driver’s supported in-process MCP integration, or an authenticated local endpoint. Attached installations can use stdio. Choose one deployment path; do not spawn a second sensor/device owner just to expose tools.

### Small-model action mode

```json
{"op":"step","args":{"schemaVersion":2,"loopRef":"bench:e3","seen":"b42","goalVersion":7,"commands":[{"id":"c14","kind":"set_led","args":{"on":true}}]}}
```

The full response is one validated operation. Use schema-constrained decoding only when supported. Reject malformed, partial, extra or unknown operations before effects; bounded retries return diagnostics. No parsing prose for commands. Native tool calling remains native. An API model gets no shell unless the application deliberately supplies an executor.

### Cache discipline

Keep trusted rules/tool schemas in deterministic order before mutable evidence. Use provider-supported caching and measure actual cached tokens where reported. Earlier matching prefixes can survive later changes; not everything before the latest observation is immutable. Do not pad prompts, omit evidence or restart native conversations solely for caching. [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Claude caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

For a direct llama.cpp integration, `cache_prompt` reuses matching prefixes when possible. This is a provider optimization behind the driver, not a loop protocol feature. [Server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

## Runtime and optional dependencies

Keep Node 24+, ESM, TypeScript and Ajv already used by the repository. Use promises, async iterators, AbortSignal and explicit resource lifetimes. Keep canonical JSON Schemas and public camelCase fields; avoid a second validation stack. The existing package/build structure is sufficient.

| Integration | Decision |
| --- | --- |
| Core | Existing TypeScript and Ajv; no Python, MCP or native SDK import required |
| API/local models | Native async HTTP/fetch and a small provider adapter; bounded requests and complete exchanges |
| Native MCP | Optional official TypeScript SDK, pinned and tested; reuse a host’s server where available |
| Claude Code | Optional official TypeScript Agent SDK; loaded only by its driver |
| Serial | Existing optional `serialport` adapter; retain its protocol and reconciliation tests |
| Recovery store | In-memory by default; optional bounded store only where the application needs and does not already own it |

Use optional peer dependencies and lazy subpath imports for large integrations. Account for actual installed/transitive assets; lazy importing alone does not make installed dependencies free. Do not add a daemon or HTTP framework to an in-process host.

### Python as a device adapter

Python is optional when selected hardware libraries justify it. These are candidates for that adapter, not core dependencies:

| Library | Possible device integration |
| --- | --- |
| [`pyserial`](https://pyserial.readthedocs.io/en/latest/pyserial_api.html) | A Python-owned serial device when direct Node serial is unsuitable |
| [`gpiozero`](https://gpiozero.readthedocs.io/) / [Blinka](https://docs.circuitpython.org/projects/blinka/en/latest/) | Selected GPIO/I2C/SPI sensors |
| [`aiomqtt`](https://aiomqtt.bo3hm.com/) / Paho | Feeds already hosted in a Python application |
| [`pymavlink`](https://mavlink.io/en/mavgen_python/) | Existing Python MAVLink device integration |
| [MAVSDK-Python](https://github.com/mavlink/MAVSDK-Python) | Applications already wanting its companion server |

Such an adapter owns its device handles and jobs, reports dated observations and accepts bounded commands. TypeScript remains the loop/goal/delivery owner. Add the process protocol only for an actual integration, with bounded framing, cancellation, connection epochs and uncertain-command reconciliation.

Arduino Uno-class devices run firmware; Nervelet runs on a companion. MicroPython is an optional firmware choice. Linux Pis may run Node and selected adapters while inference runs remotely. Measure the actual OS/runtime/dependency footprint; neither language has a blanket hardware-readiness claim. [Uno](https://docs.arduino.cc/hardware/uno-rev3/), [MicroPython asyncio](https://docs.micropython.org/en/latest/library/asyncio.html).

## Existing-code constraints

Reviewed baselines: Nervelet `af0c1bfc3514aa8096eb2b7ba1fba0b1b7f92edd`, DroneRTS `7379731b4869beb25412ff0cee4d7a0d970b6662`, Clankerfights `3b8c89ff8abc7bff209bdffa722d1de47f4a030a`.

- Nervelet v0.1 has useful receipt/recovery gates, but disallows commands plus waits, samples repeatedly during a step, lacks image transport and managed/API drivers, and has no durable receipts. Goal cancellation can produce uncertain admissions. Preserve explicit uncertainty while adding reconciliation. [Core](../../src/core.ts), [validation](../validation.md).
- DroneRTS already owns native continuation, role-bound MCP, fresh images and domain execution. Reuse that host; preserve per-drone goal receipt, isolation, radio, quotas and QuickJS ownership. Embed the TypeScript core directly, with no Python service. Deployed dependencies, CPU/storage accounting and isolation still require qualification. Its older integration plan’s no-MCP direction is superseded. [Integration findings](../../../DroneRTS/NERVELET-INTEGRATION-PLAN.md).
- agent-matches contributes bounded poll/watchdog behavior, server-owned affordances and explicit batch results. Its conversation repair, game policies and room lifecycle are not a generic robot runtime. The API driver should preserve tool exchanges by construction instead of silently removing uncertain history.
