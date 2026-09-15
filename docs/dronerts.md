# DroneRTS integration

The design originated in [DroneRTS](https://github.com/DanMcInerney/DroneRTS), a continuous drone simulation. DroneRTS is the canonical usage and integration test case; its rules remain application-specific. This document records the extraction context as of 2026-09-15. The standalone runtime and its DroneRTS integration are not implemented.

## Boundary

| Standalone library | DroneRTS environment/application |
| --- | --- |
| Native session lifecycle and compaction recovery | Existing native Codex pilots and their configured model |
| Versioned received goal and delivery boundary | Actual per-drone instruction receipt and match lifecycle |
| Compact observation envelope | Own pixels, telemetry, equipment, cargo, jobs and inbox |
| Batch admission contract | Existing compatible commands and one movement writer |
| Job/source references | Local controller, ordered routes and bounded QuickJS routines |
| Workspace integration | Existing private atomic files and storage quotas |

Keep the simulation and its rules in DroneRTS. The library does not acquire battlefield geometry, opponent telemetry, hidden locators, automatic classifiers or global pathfinding.

The environment combines DroneRTS sensor acquisition, native radio events and existing command/job interfaces. Its state schema owns pose, velocity, held equipment and cargo. Its source profile requires fresh camera acquisition at model-facing steps; the generic library permits environments with no images. Existing `observe`, `wait` and `exchange` names can remain application aliases for the shared step contract.

Native actor creation, tool delivery and compaction behavior go through the [Codex harness adapter](harnesses/codex.md). Preserve the canonical application's child actors; qualify that mode separately from dedicated root sessions. Do not move game-specific launch gating or tactical coordination into the harness module.

## Existing behavior

Normal living-pilot direct tool results and aggregate `exchange` results attempt a fresh camera acquisition and return timestamped self-state, equipment, cargo, velocity, jobs, routines and unread messages. Capture failure is explicit. Internal controller telemetry does not acquire a new image; routine camera reads use the latest model-acquired frame.

`exchange` admits up to eight compatible operations with individual outcomes. Admission is separate from physical completion. Local control continues while the agent thinks or waits.

The runtime observes native compaction events. Exact goal restoration and the proposed refresh gate remain implementation work.

Source references: [tools and instructions](https://github.com/DanMcInerney/DroneRTS/blob/main/server/runtime-tools.ts), [bundle assembly](https://github.com/DanMcInerney/DroneRTS/blob/main/server/game.ts), [native runtime](https://github.com/DanMcInerney/DroneRTS/blob/main/server/runtime.ts), [onboard contract](https://github.com/DanMcInerney/DroneRTS/blob/main/ONBOARD.md). These links require access to the source repository.

## Preserve during integration

- Preserve actual delivered observations and messages, isolated robot workspaces, existing quotas and capability restrictions.
- Preserve one movement writer, explicit replacement, local controller leases and prompt cancellation.
- Expose no additional host shell, filesystem, network, geometry or perception capability through the adapter.
- Retain authoritative goal text only after actual per-drone delivery; ordinary chat does not replace it.
- Keep game economics, geometry, radio transport and tactical decisions outside the general core.
- Verify native child behavior explicitly; root-session hooks do not establish child-session support.

## Recorded timing evidence

Historical trial `2026-09-15T02-27-58-524Z-focused-haul-single-0567e7f0`, source manifest `2bf300245ad0a486afabb22833533d1896a2d699433e8733135e7baa638b5093`:

| Measurement | Recorded value |
| --- | --- |
| Delivered salvage | 60 |
| Delivery simulation time | 181.102 s |
| Completed-tool-to-next-call gap, median | 5.177 s |
| Completed-tool-to-next-call gap, maximum | 26.502 s |
| Compactions | 0 |

Most of the reported decision delay was stationary. This is evidence about that source revision's logistics trial, not moving-target performance or validation of the standalone library.

Source: [QA investigation, first fresh single haul](https://github.com/DanMcInerney/DroneRTS/blob/main/QA-INVESTIGATION-2026-09-15.md#first-fresh-single-haul-passed). Historical rules and results retain their original meaning.

## Integration sequence

1. Implement and test the [portable contract](../DESIGN.md) using a deterministic API-only environment and native-session test doubles; prove the core works without game or robot fields.
2. Implement the Codex adapter, including manual/automatic compaction and actual child-session lifecycle.
3. Map existing DroneRTS tools and data sources through the environment boundary without changing simulation behavior.
4. Prove existing control, conservation, isolation and cancellation checks still pass.
5. Run bounded real-agent trials before making claims about recovered understanding or autonomous progress.
