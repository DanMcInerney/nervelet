# Documentation and evidence

Current contracts and setup:

- [README](../README.md): source installation, CLI demo and embedding entrypoint.
- [Adapter API](api.md) and [v2 embedding/drivers](v2.md): supported APIs, receipt budgets, waits and ownership.
- [Observation and attention](improvements.md): packing, host submission and optional emergency behavior.
- [Codex](harnesses/codex.md), [Claude Code](harnesses/claude-code.md) and [serial/Arduino](arduino.md): setup and qualification limits.
- [DroneRTS application](dronerts.md): implemented embedding and separate native gates.
- [Reliability validation](reliability.md): current regression, package and measurement evidence.

Historical designs and evidence remain at their original paths so existing links and recorded source identities stay useful:

- [Original design](../DESIGN.md): v0.1 scope and tradeoffs, with an implementation-status banner.
- [Implementation handoff](../NEXT-DESIGN.md), [contract](next/CONTRACT.md), [rationale](next/RATIONALE.md) and [qualification plan](next/QUALIFICATION.md): the accepted refactor design and its status.
- [Validation history](validation.md): dated observation/attention, v0.2, CLI and firmware results. Historical counts and measurements apply only to their recorded revisions.

Deterministic protocol tests do not establish native image understanding, sustained held waits, repeated real compaction, hardware readiness or autonomous performance.
