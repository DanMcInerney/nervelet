# Claude Code harness adapter

**Proposed module:** `harnesses/claude-code/`. No implementation or version qualification yet.

## Integration

Use the official TypeScript Claude Agent SDK, keeping native sessions, file tools, execution and compaction. Stream lifecycle output and use session resume when appropriate. [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [sessions](https://code.claude.com/docs/en/agent-sdk/sessions).

This module translates Claude's concepts into the small Nervelet contract; the core never branches on Claude message types.

## Native differences this module owns

| Concern | Adapter responsibility |
| --- | --- |
| Conversation | Map session IDs, SDK message streams and final results to logical-loop lifecycle. |
| Input | Use native tool results and supported streaming input boundaries. Coalesce external wakes while busy. |
| Compaction | Recognize the documented `compact_boundary`; use supported hooks to restore context and gate new effects. |
| Instructions | Install the profile and tool schemas; load project settings/skills only from explicitly selected sources. |
| Tool scheduling | Treat Nervelet's mutating batch as state-changing. Do not mark it read-only to force parallel scheduling. |
| Native work | Preserve permitted files, scripts, task/subagent features and execution IDs instead of reimplementing them. |
| Permissions/limits | Translate explicit settings and terminal outcomes. Preserve native budgets and approval semantics. |

The SDK can execute read-only calls concurrently, while custom tools default to sequential execution. Batch semantics therefore belong inside Nervelet's tool implementation. Listing tools in `allowedTools` auto-approves those tools; it is not by itself an exclusive tool allowlist. [Agent loop and permissions](https://code.claude.com/docs/en/agent-sdk/agent-loop).

Session and compaction hook availability differs between TypeScript and Python. A future Python adapter needs its own qualification; do not copy the TypeScript capability claim. [Hooks](https://code.claude.com/docs/en/agent-sdk/hooks).

Streaming input can queue messages around active work. It does not make newly acquired data part of an inference already underway. [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).

## Required qualification

Test context restoration after automatic/manual compaction, final-result versus idle semantics, interruptions, delivery acknowledgement, private workspaces and any permitted native children/background execution.

Use the shared contract tests plus backend-specific cases. Similar API names in Codex and Claude Code do not establish equivalent timing or cancellation.
