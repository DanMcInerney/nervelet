# Codex integration

**v0.2 addition:** `nervelet/drivers/codex` implements managed App Server sessions, borrowed-client ownership, native recovery notifications and MCP tools. The installer export below keeps its original meaning. See [the driver contract](../v2.md) and [new qualification status](../validation.md). Deterministic protocol tests are not native parking, image or compaction proof.

**Implemented:** `nervelet/codex`. **Partially qualified** on Codex CLI **0.144.0**: native startup hook, recovery observation and Stop worked. The full request-file/batch scenario was blocked by this host's Windows sandbox. [Evidence](../validation.md).

```sh
nervelet init --harness codex
nervelet serve
# In another terminal, same project:
codex --enable hooks
```

Trust the project and review installed hooks with `/hooks`. Configure normal native permissions for workspace writes and the intended `nervelet` commands. The installer preserves permissions and trust requirements.

## Installed files

- `.codex/hooks.json`: Nervelet's `SessionStart` and guarded `Stop` hooks.
- `AGENTS.md`: a managed section pointing to the operating profile and step loop.
- `.codex/config.toml`: created with `features.hooks = true` only if absent; existing configuration remains unchanged. An explicit project layer anchors hook discovery.

Windows hooks include `commandWindows`; Unix hooks quote the Node executable and CLI path. Re-run installation after relocating the package or project because hook paths are absolute.

## Recovery

Codex documents `SessionStart(source=compact)` before the next root-session model request, including mid-turn automatic compaction. Hook context has developer authority. Nervelet injects only a short trusted reminder there; exact profile and environment data arrive in the next step. [Codex hooks](https://learn.chatgpt.com/docs/hooks).

The hook writes a durable marker. The next step gates commands, returns exact `recovery.instructions` and fresh available evidence, then requires acknowledgement. The Stop hook gives at most one reminder while the loop remains active. Native sessions, scripts, files and background execution stay native.

## Current Windows limitation

The tested CLI downgraded `--sandbox workspace-write` to read-only when its Windows sandbox was unconfigured. Configuring the native unelevated sandbox then failed file writes with a split-writable-roots error. Nervelet received no command batch in those runs. We did not disable sandboxing to declare a pass. A working native workspace/tool permission configuration is required; Linux/macOS and other Codex versions have not been live-qualified here.

The installer and recovery protocol have deterministic tests. Actual repeated native compaction remains unqualified. Hook installation alone is not proof of long-session recovery.

## Historical v0.1 embedding boundary

The current integration uses native shell/exec, local IPC and JSON. It needs neither MCP nor an App Server client. DroneRTS already owns native sessions through App Server and supplies isolated MCP tools; preserve that deployment until a replacement preserves its capabilities and image delivery. Experimental dynamic tools are a possible separate future transport. [App Server](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread).

Nervelet v0.1 does not create or coordinate native child agents.
