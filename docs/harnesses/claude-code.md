# Claude Code integration

**Proposed module:** `harnesses/claude-code/`. No implementation or version qualification yet.

## Initial path

Use an ordinary Claude Code session with its native Bash and file tools. The agent calls `nervelet step`; JSON comes back as shell output in the existing conversation. No Agent SDK or MCP server is required for this path.

Install project instructions that point to the exact generated environment profile. Keep developer configuration separate from runtime goals, observations and notes. Do not overwrite existing project instructions or permissions during setup.

## Minimal native hooks

Claude documents `SessionStart` sources including startup, resume and compact; `Stop` can request continuation, but has a consecutive-continuation cap and does not run on user interruption. [Hooks reference](https://code.claude.com/docs/en/hooks).

The module should use these boundaries to:

- Restore trusted operating instructions and mark the core's recovery gate.
- Give at most a bounded reminder to call `step` when the active loop ends prematurely.
- Stop prompting when the loop is stopped, completed, out of budget or failing to progress.

The normal loop is repeated model-issued steps. A Stop hook is a fallback, not a perpetual scheduler. Keep waits bounded and cancellation available through `nervelet stop`, independent of a model turn. Do not assume Ctrl+C in Claude physically stopped the device; the adapter's controller-loss policy remains authoritative.

Claude also documents `PostToolBatch` context injection after a complete native tool batch. Automatic sensor injection there is deferred; explicit step results give the initial version one clear observation boundary. [Batch hook](https://code.claude.com/docs/en/hooks#posttoolbatch).

## Native features stay native

Use Claude's workspace for code and a short optional `working.md`. Preserve native background task IDs and status in their normal tool results. Domain jobs are reported by Nervelet. Shell permission settings are not a sandbox around the device; enforce command validation in the adapter and use only the configured device connection.

For cameras, return immutable paths for native image reads. Same-result multimodal delivery is outside the initial shell integration.

## Qualification

Test the actual installed CLI: start/resume/manual and automatic compaction, visible step output, acknowledgement loss, bounded continuation, interrupted waits, profile changes and a running domain job through three compactions. Test a hook failure explicitly; do not claim recovery support merely because configuration was written.

Additional native agents and programmatic session supervision are deferred.
