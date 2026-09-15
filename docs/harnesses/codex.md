# Codex harness adapter

**Proposed module:** `harnesses/codex/`. No implementation or version qualification yet.

## Integration

Use Codex App Server for the lifecycle control this design needs: native sessions, streamed items, tool delivery, continuation and interruption. Prefer local stdio and pin the installed CLI/schema version. Generate types from that binary where supported. Keep App Server experimental surfaces behind explicit capability checks. [Official App Server documentation](https://learn.chatgpt.com/docs/app-server).

The application can let this adapter create a dedicated session or attach an existing actor through a host bridge. Attaching does not create another inference loop.

## Native differences this module owns

| Concern | Adapter responsibility |
| --- | --- |
| Conversation | Track native thread/session and turn IDs separately from the logical Nervelet loop ID. |
| Tool calls | Bind Nervelet tools through configured MCP or a qualified native custom-tool path; return results into the active turn. |
| Compaction | Normalize `contextCompaction` lifecycle items. Mark refresh before new environment effects can be admitted. |
| Instructions | Preserve native developer instructions and schemas; re-establish them through verified restoration hooks. |
| Completion/interrupt | Distinguish normal turn completion, interruption, errors and limits. Do not equate a finished turn with a finished external goal. |
| Native work | Expose permitted background execution IDs/status and workspace access; preserve their native ownership. |
| Capabilities | Honor model/effort, tools, sandbox and permission settings. Unsupported settings fail explicitly. |

Codex documents `SessionStart(source=compact)` context restoration before the next model request for **root** sessions, including automatic compaction within a turn. That does not establish child-session support. Qualify the actual actor type used by DroneRTS. [Hooks](https://learn.chatgpt.com/docs/hooks#sessionstart).

Hook context can have developer authority. Use it for trusted operating instructions; restore external observations and peer text as data at their original authority.

Steering is a supported boundary, not a mechanism for replacing the model's private reasoning on every sensor update. MCP notifications likewise do not prove the model ingested data.

## Required qualification

Test native tool-result inclusion, interrupted capture/waits, context restoration, root/child boundaries, capability changes and reconnects. Verify that a native helper cannot bypass the environment's command owner.

The generic Codex SDK can be evaluated if it exposes every required lifecycle boundary. A one-shot CLI wrapper alone does not satisfy this persistent-session contract.
