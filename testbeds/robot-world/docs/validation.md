# Validation record

Local validation on 2026-09-17, Windows, Node 24.15.0. No Jev API calls, native inference or physical devices were used.

- Existing Nervelet baseline: `npm ci`, `npm test` — 141 tests passed.
- Testbed: `npm ci`, `npm test` — 21 tests passed, covering the HTTP host and controls, MAVLink binary/CRC/frame conversion, drone and rover routes, deterministic replay by repeated history, sensor timing/dropout and out-of-order delivery, observation isolation, blocked inference, expired decisions, noncooperative deadline, cancellation, queued-command backpressure, goal replacement, deduplication, one movement owner, collision/deadline events, acknowledgement, plugin registration, a two-link kinematic arm, and mocked Jev/Codex bindings. Cockpit coverage includes retention/size limits, credential redaction, reset cursors, actual protocol records, observation isolation, native thread scoping and tool request/result pairing. A native-host fixture verifies that the supplied world is displayed and competing controllers are rejected.
- Testbed TypeScript checking and production viewer build passed.
- Repository documentation link/fence checks and `git diff --check` passed.
- `npm run experiment` — 18/18 baseline combinations completed three waypoints with zero contacts. Default scenes have no randomized obstacle variation. The generated report stays in ignored `.runtime/experiments/latest.json`.
- Browser verification: Three.js world rendered; drone and rover each completed 3/3 waypoints with zero contacts. The drone emitted three decoded MAVLink setpoints. Robot switching, reset, pause, a single physics tick, and 100% odometry dropout were exercised; the dropped sensor visibly became stale. Visual inspection confirmed controls, sensor samples/depth and telemetry.
- Cockpit browser verification: four instruments occupy the lower deck, with independent raw payload viewers. Exercised TX/RX filters, a pinned real MAVLink setpoint, search, panel expansion/restoration, latest observation view and a drone/rover reset. Rover traffic showed direct-adapter telemetry without synthetic MAVLink bytes. Freezing the inspector preserved both the sensor payload and pinned packet while simulation time advanced; resuming restored live capture. Native summaries/tool events were tested with fixtures only.
- Testbed installation audit: zero reported vulnerabilities after pinning the transitive XML parser to a patched version. No XML generation is performed at runtime.

The bundled graphics engine produces a client bundle above Vite's default 500 kB advisory threshold. This is isolated from the core library's dependency footprint.

This records simplified simulation and protocol evidence only. Live Jev decisions, live Codex Luna/xhigh, external UDP/SITL, native image delivery, ROS, physical flight and manipulation are unqualified.
