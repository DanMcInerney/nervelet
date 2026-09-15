# Claude Code integration

**v0.2 addition:** `nervelet/drivers/claude-code` implements the official TypeScript Agent SDK with one persistent streaming query, explicit permissions, in-process MCP and recovery hooks. The installer export below remains compatible. See [the driver contract](../v2.md) and [new qualification status](../validation.md). Its native behavior is not qualified by the historical CLI run below.

**Implemented:** `nervelet/claude-code`. Live basic-loop test passed on Claude Code **2.1.270**. [Evidence and limits](../validation.md).

```sh
nervelet init --harness claude-code
nervelet serve
# In another terminal, same project:
claude
```

The installer merges its own entries into `.claude/settings.local.json` and a managed section in `CLAUDE.md`. Existing hooks, instructions and permissions remain. Re-running installation updates the Nervelet entries. Generated `.nervelet/` runtime files are ignored by Git. No Agent SDK or MCP server is used.

## Native boundaries

| Hook | Behavior |
| --- | --- |
| `SessionStart`: startup/resume/clear/compact | Write a recovery marker and inject a short instruction to call step. |
| `Stop` | One guarded reminder if the bridge remains active; no reminder after Stop, a fault or an unavailable bridge. |

The next step returns exact `recovery.instructions`, current goal, own state, jobs and optional `working.md`. Command effects remain gated until the model echoes that bundle ID. Full profiles stay out of hook output, avoiding large hook-context payloads. If a native hook fails, treat recovery as unqualified and obtain a fresh observation explicitly.

Claude documents startup/resume/compact sources and Stop continuation. Stop does not run on user interruption and has native continuation limits. Our `stop_hook_active` guard permits one reminder; this is not an unattended scheduler. [Native hooks](https://code.claude.com/docs/en/hooks).

## Native tools

Use Bash for `nervelet step`, native file tools for request JSON and scripts, and normal background execution where useful. Agent-authored scripts use the same bridge client; they must not independently open the device or acknowledge evidence the model never received.

Permissions must permit the intended Nervelet commands and workspace writes. The installer does not grant them automatically. Native file tools do not refresh sensors. Automatic `PostToolBatch` injection and same-result images are deferred.

`nervelet stop` invokes the adapter's stopping policy independently of the model. Ctrl+C in Claude is a different event; valid device work may continue while the bridge remains alive.

The live test covered startup hook delivery, a native request-file write, a two-command batch, a completed job observed in a later step and explicit Stop. Three repeated recovery cycles are deterministic tests; actual manual/automatic compaction and uninterrupted long sessions still need separate qualification.
