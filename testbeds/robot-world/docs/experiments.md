# Experiments

## Implemented baseline

`npm run experiment` runs 18 headless trials: two robot models, three seeds and three simulated decision delays. A scripted controller issues waypoint commands through Nervelet; the robot executes locally while the world advances. The independent evaluator checks actual final position, collisions, completion count and a deterministic state hash. Credentials and inference are unnecessary.

This first fixture is intentionally simple. Seeds do not randomize the obstacle course, and noise/dropout defaults to zero. The delay matrix therefore measures the stationary cost between jobs, not moving-obstacle intelligence or a comparison between real models. `wallMs` is local compute time for a fast-forwarded simulation, never model inference latency. Do not present 18 passes as 18 varied navigation tasks.

`npm test` separately blocks fake inference while advancing physics, tests stale response rejection and cancellation, introduces sensor latency/dropout, drives into an obstacle to check collision/deadline evidence, tests duplicate command receipts and event acknowledgement, and moves an articulated two-joint fixture.

## Next experiment matrix

| Question | Independent variables | Controls | Primary outcomes |
| --- | --- | --- | --- |
| Does speed improve adaptation? | Real policy choice: scripted, Jev, Luna/xhigh; injected 0/100/500/5000 ms delay | Same observations, candidates, plant and moving-obstacle episode | Goal completion, contacts, sensor-to-effect age p50/p95/p99, deadline rejection |
| Does richer state matter more than speed? | Horizontal range only; range plus vertical depth; recent velocity/history | Same decision model and candidate set | Correct maneuver selection, stalled time, unnecessary actions |
| How often should we ask? | Periodic 1/3/5 Hz; threshold events; scene fingerprint plus review deadline | Same model, expiry and local execution | Calls, tokens, cost when reported, reaction delay, missed events |
| Does commitment prevent oscillation? | No commitment; fixed dwell; risk-triggered replacement | Same scene sequence and proposals | Action reversals, route length, time stuck, collisions |
| How should responses age out? | Acquisition age, request age, candidate revision; network jitter and loss | Same policy outputs | Stale effects prevented, useful decisions discarded, control continuity |
| What must survive recovery? | Native compaction fixture, actual native compaction, goal replacement, lost response | Same active job and unread events | No effect replay, exact goal restoration, preserved events, cancellation time |
| Can one contract span robot types? | Drone position, rover movement, arm joint action | Same Bridge contract and sensor timing harness | Controller reuse, required adapter changes, unchanged core schema |
| Where does realism change conclusions? | Simple servo; calibrated actuator response; future PX4/MuJoCo/ROS backend | Same external goals and evaluation definitions | Tracking error, time to react, sensitivity of policy ranking |

## Episode and measurement requirements

1. Pin scenario, seed, robot/controller/protocol versions, complete policy configuration and input budget. Give each policy identical allowed sensing. Separate evaluation-only geometry from observation-derived objects.
2. Predeclare success and failure, time budget and candidate construction. Add a moving occluder or gate only with a deterministic schedule and explicit acquisition history.
3. Record acquisition, receipt, decision request/response, admitted/rejected command and first measured motion in their actual clock domains. A simulation-to-wall mapping is measured, not assumed. Track host lag during real-time episodes.
4. Keep low-level control continuous during inference. Make action replacement explicit and revalidate goal, epoch, candidate identity and command-specific freshness at execution. Do not silently reuse an expired decision.
5. Report proposed actions as well as effects and rejection reasons. Preserve failed runs. Separate network failures, observation failures, model choices and actuator inability.
6. Use paired randomized episodes and multiple repeats before ranking policies. Tune thresholds on a separate scenario set. A different seed on an unchanged noiseless world is a repeat, not diversity.
7. State costs as measured, estimated or unavailable. Live Jev and native runs are opt-in and bounded; no periodic model calls are needed during a parked Nervelet wait.

## Backend progression

The current deterministic lab proves library/executor mechanics. Next add realistic action candidates and a moving-scene fixture, then compare Jev with a capable deterministic baseline under matched inputs. Qualify Luna/xhigh independently. After that, introduce external MAVLink/SITL and ROS action adapters with explicit transport loss/reconciliation tests. Hardware claims require a separate recorded qualification.

RGB cameras, image delivery, real attitude control, wheel dynamics, force-controlled arms, URDF loading, ROS 2 integration, native compaction and mixed slow/fast controllers are future work. They are extension targets, not features inferred from a Three.js rendering or MAVLink codec.
