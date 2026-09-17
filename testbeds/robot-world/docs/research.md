# Jev research notes

Reviewed 2026-09-17. These are source-described community experiments, not results reproduced by this repository. Public projects are new and change rapidly.

## Useful findings

- [RomanSlack/jev-drone](https://github.com/RomanSlack/jev-drone) separates geometric control, guidance, camera-derived scene state and Jev tactical judgments. Its report says vertical evidence was necessary before the model could choose to climb. The write-up also identifies vehicle response time and simulation/wall-clock mismatch as limits. Its favorable obstacle-course result is a single run; it records unsuccessful comparisons and incomplete tunnel behavior. **Experiment implication:** vary state representation and plant response separately from inference latency.
- Its [tactics implementation](https://github.com/RomanSlack/jev-drone/blob/main/tactics.py) uses a bounded worker queue, scene fingerprints, a call budget, decision expiry and maneuver commitment intervals. It asks separate Choice, Score and Noul questions. **Experiment implication:** compare periodic calls against meaningful-change triggers; test hysteresis and deliberately missing observations. A narrow uncertainty question may be more useful than confidence in an overall action label.
- [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) creates an indexed action space from current observations. It batches operation and compatible target questions and validates the selected target again before execution. Text generation is a separate conditional path. **Experiment implication:** derive candidates from observed entities and current capabilities, then bind choices to those identities. Do not let a model invent object references or combine incompatible independently selected arguments.
- [AbdelStark/heist-one](https://github.com/AbdelStark/heist-one) separates local guard evidence from authoritative simulation and records proposed versus applied decisions in an inspector. It offers a scripted offline provider and describes one verified live run with explicit limits. **Experiment implication:** record why execution differs from the model's proposal; keep scripted and live policies behind the same interface and evaluate actual outcomes independently.
- [typesafe-ai/system-one-adapter-python](https://github.com/typesafe-ai/system-one-adapter-python) offers the same decision interface over conventional model providers. **Experiment implication:** compare policies with identical candidates and observations, so a favorable result cannot come solely from a better surrounding controller.

[awesome-typesafe](https://github.com/AbdelStark/awesome-typesafe) was useful for discovery; the project sources above support these observations. We found a relevant public simulated drone implementation, not independently validated physical Jev flight evidence.

## Decisions for this testbed

Keep the authoritative world independent of rendering and inference. Preserve a headless deterministic path and a separately paced live path. Distinguish simulation acquisition time, wall latency, response age, admission and completion. Give policies mounted observations and bounded candidates; keep spectator truth separate. Expose sensor delay/dropout and explicit stale-response rejection. Start with known motion controllers and model-free tests so subsequent AI comparisons have a stable execution baseline.

The first viewer uses a simple waypoint candidate and hold. It is an integration test, not an obstacle-solving Jev benchmark. More varied action spaces, observation-derived targets, confidence analysis, event-triggered scheduling and motion commitment are proposed experiments in [the experiment plan](experiments.md).

## Primary implementation references

- [Three.js documentation](https://threejs.org/docs/)
- [Rapier JavaScript rigid bodies](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/)
- [ArduPilot/node-mavlink](https://github.com/ArduPilot/node-mavlink)
- [MAVLink common messages](https://mavlink.io/en/messages/common.html)
- [TypeSafe API](https://docs.typesafe.ai/api), [model IDs and limits](https://docs.typesafe.ai/models)
- [Codex App Server model catalog and turn effort](https://learn.chatgpt.com/docs/app-server)

Research did not install or execute these community projects. Their code and data are not bundled into the testbed.
