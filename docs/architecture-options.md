# Architecture choices and related projects

**Research checked 2026-09-15.** These are design recommendations, not claims of implemented support or production qualification.

## Decision: library first

Nervelet should be an embeddable library that supervises native sessions and delivers external context. For harness-powered robots, this is the smallest useful architecture: keep native agent execution and domain control, add only the missing coordination.

| Form | Fits | Decision |
| --- | --- | --- |
| Embedded library | Continuous collection, bounded delivery, lifecycle and command coordination inside an existing application | Primary implementation. |
| Thin host process | Runs the same library when an application cannot embed it | Optional deployment wrapper. |
| Codex/Claude plugin | Installs tools, instructions, hooks and launcher commands | Optional distribution layer. |
| Orchflows workflow | Creates/configures a loop, runs a bounded trial, reviews evidence, improves the next version | Optional outer workflow. |
| Durable workflow engine | Cross-machine scheduling and restart recovery for long-lived deployments | Add only for a demonstrated deployment requirement. |
| Replacement agent framework | Builds another inference/tool/memory loop | Outside the chosen scope; native harnesses already supply that machinery. |

Plugins can bundle skills, MCP servers and hooks. That is useful packaging, but packaging alone does not guarantee collection while the model reasons, bounded queues, command ownership, recovery or an idle-session wakeup. The lifecycle bridge must be tested in each host. [Codex plugins](https://learn.chatgpt.com/docs/plugins), [Claude Code plugins](https://code.claude.com/docs/en/plugins).

MCP provides the shared tool transport. Its resources are application-driven; notifications say data changed, not that an agent read it or started reasoning. Keep delivery acknowledgement and wake ownership in the library/harness bridge. [MCP resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources).

## Orchflows fit

Current Orchflows composes work and independent review through native agents. Its architecture explicitly leaves execution to the host and adds no runtime or scheduler. That makes it suitable for directing a Nervelet run while Nervelet handles continuous collection and delivery. [Current architecture](https://github.com/DanMcInerney/orchflows/blob/main/docs/architecture.md).

A useful proposed workflow:

```mermaid
flowchart LR
    C["Choose goal, environment and bounds"] --> R["Launch bounded Nervelet run"]
    R --> E["Collect outcome and evidence"]
    E --> V["Independent assessment"]
    V --> F["Refine config or code for next run"]
```

A workflow can author a goal or adapter, launch a run with an explicit duration/cost bound, inspect the report and request a revision. During the run, retain the same native pilot session. Do not create a fresh worker/reviewer for each sensor batch or infer a team strategy outside the canonical application's rules.

An Orchflows-only prototype can call observe/act/wait tools. Once those tools implement ongoing acquisition, queues, jobs and lifecycle, that deterministic component is effectively Nervelet. Keep one implementation and let the workflow call it.

## Related projects and dependencies

| Project | Useful capability | Recommendation |
| --- | --- | --- |
| Official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | Native Claude Code execution and session integration | Direct dependency of the Claude adapter. |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | Rich native session lifecycle and streamed tool/compaction events | Direct integration for the Codex adapter; pin and qualify the actual CLI and transport. |
| Official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Tool schemas, multimodal results and client/server transport | Reuse where MCP is the chosen bridge; match supported protocol versions. |
| [XState](https://stately.ai/docs/actors) | Actors process events sequentially with encapsulated state | Useful if lifecycle logic grows complex. Start with an explicit small state machine and native async primitives. |
| [Temporal](https://docs.temporal.io/workflow-execution/continue-as-new) | Durable workflows and continuation with a fresh event history | Optional deployment supervisor; not required for an embedded loop. |
| [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/persistence) | Persisted workflow checkpoints and execution state | Consider for an outer graph workflow; avoid duplicating native conversation/compaction ownership. |
| [twaldin/harness](https://github.com/twaldin/harness) | Common interfaces over coding-agent tools; explicit capability and cancellation behavior | Reference its qualification discipline. Its README currently marks Codex App Server sessions unsupported, so it does not replace the required adapter. |
| [OpenRAL](https://github.com/OpenRAL/openral) | Separates robot control, perception and slower reasoning | Related robotics architecture. Its broader hardware/world-state stack is unnecessary for API-only loops; study boundaries rather than adopt it as core. |

The official SDKs and established workflow/state libraries supply useful building blocks. Repository descriptions alone do not establish end-to-end production reliability for harness-powered robots. No reviewed project demonstrates this exact contract across Codex, Claude Code, continuous sensors and compaction.

Temporal retries activities and recommends idempotent effects. A robot action cannot be made safe to replay merely by putting it in a workflow: retain effect IDs, reconcile the actual controller and acquire new observations after recovery. Its workflow history rollover is separate from native agent context compaction. [Temporal activities](https://docs.temporal.io/activities).

## Minimal initial dependencies

Use TypeScript, native promises/async iterators, `AbortSignal`, a small lifecycle state machine and the selected native harness integration. Bring in the official MCP SDK only for MCP transport.

Defer databases, vector memory, RxJS, workflow engines, autonomous planners and a general plugin loader until a specific requirement justifies one. Existing application storage can persist exact goal/cursor records; it should not become a second agent memory system.

Keep the implementation sequence in [DESIGN.md](../DESIGN.md#10-implementation-order-and-proof) authoritative.
