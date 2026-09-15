# Codex integration

**Proposed module:** `harnesses/codex/`. No implementation or version qualification yet.

## Initial path

Use Codex's native shell/exec tool to call the same `nervelet` CLI. Preserve the native session, files, scripts and background execution. This path needs neither MCP nor an App Server client.

Install a reference to the generated environment profile in project instructions and configure supported native recovery hooks. Preserve existing configuration, permissions and required hook trust review.

Codex documents `SessionStart(source=compact)` restoration before the next root-session model request, including mid-turn automatic compaction. Its hook context has developer authority: restore trusted operating rules there, and keep sensor data in ordinary step output. `Stop` can request continuation; use it only for a bounded reminder. [Codex hooks](https://learn.chatgpt.com/docs/hooks).

The shared [recovery gate](../../DESIGN.md#6-compaction-keep-exact-sources-small) prevents new commands until a post-recovery observation has been acknowledged. Native tools other than `nervelet step` do not implicitly refresh sensors.

## Later embedded applications

DroneRTS already owns native Codex sessions through App Server and exposes tools through MCP. Preserve that deployment while qualifying an alternative. Experimental `dynamicTools` provide a possible direct tool path without MCP, but are not part of the initial CLI integration. [App Server](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread).

Native tool policy and isolation remain application responsibilities. Enabling an unrestricted host shell would change DroneRTS's experiment and is not an acceptable transport substitution.

## Qualification

Test one root session on a pinned CLI version: shell output, native execution handles, cancelled waits, Stop, startup/resume and three successive compactions with active work. Hooks do not cover every possible native tool path; command enforcement belongs in the environment adapter. Report unsupported recovery explicitly.

Existing DroneRTS actor types need separate qualification during its integration. Nervelet's initial version does not create or coordinate subagents.
