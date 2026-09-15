# Integration decision: CLI and a persistent bridge

**Research checked 2026-09-15. Implemented v0.1; see [validation](validation.md).**

## Decision

Use one ordinary Claude Code or Codex session. Give it a CLI through its native shell tool. Keep continuous acquisition in a small persistent bridge. Install only the native instructions and hooks needed to explain and recover the loop.

| Piece | Needed now? | Why |
| --- | --- | --- |
| Core library + CLI | Yes | Shared step, goal, delivery and cancellation contract. |
| Persistent I/O bridge | Yes | Keeps collecting while the agent reasons or edits files. Embed it when an application already has a host process. |
| Harness modules | Yes | Small native configuration and lifecycle integration. |
| Plugin packaging | No | An installer can be added once the integration works. |
| Agent SDK / App Server launcher | No for the initial CLI use | Useful later for an application that must own unattended native session lifecycle. |
| MCP | No | Native shell calls can carry JSON requests and results. |
| Multiple agents or workflow engine | No | Outside the initial scope. |

A single shell command that repeatedly starts a fresh model would lose native session continuity. A single shell command that never returns would withhold observations from the model. Instead, keep the device connection in the bridge and return from each bounded step.

## Harness differences

Claude's documented SDK custom tools use an **in-process MCP server**. Removing the network server does not remove MCP. The initial design uses native Bash instead. [Claude custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools).

Codex App Server exposes experimental `dynamicTools` for applications needing native custom tools without MCP. That is a possible later transport, with version qualification; the common CLI path needs no experimental tool API. [Codex App Server](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread).

CLI output is text. Direct same-result images and host-controlled session wakeups need additional native integration; they are not implicit CLI features. [Design limits](../DESIGN.md#camera-and-ongoing-execution).

## Dependencies worth using

Use Node's existing async primitives and filesystem support. Add [Node SerialPort](https://serialport.io/docs/) for a serial adapter: it supplies serial streams and mock bindings. The API-only core needs no serial dependency.

The native harness already supplies code execution, file tools, session history and compaction. Keep those owners. No additional agent framework or memory store is needed for the first implementation.

Start with the [Arduino example](arduino.md). [DroneRTS](dronerts.md) remains the canonical application for later integration, with its stronger isolation and image-delivery requirements.
