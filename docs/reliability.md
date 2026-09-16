# Reliable results and scoped waits — September 16, 2026

Implementation starts at audited revision `ea28137b8c64cfec059cca72060427a10af279c3`.
This record concerns deterministic library and application integration work. No
inference, native agent sessions, browser, match or hardware trial was run.

## Behavior and evidence

`test/receipts.test.ts` reproduces history eviction of unseen results and stale
acknowledgement after reconciliation. Delivery mappings now identify the exact
receipt revision. Resolved current revisions must be acknowledged before v2
reclamation; unknown executions keep their records and reservations even when
seen. Capacity rejection occurs before effects and leaves IDs retryable. A later
command in the same rejected batch cannot consume that retryable ID.

Legacy-only users keep bounded resolved history without a new acknowledgement
requirement. The first v2 call permanently selects reliable retention for the
remaining history. Subsequent legacy calls cannot revoke that promise. Unknown
and expired IDs retain their original no-replay behavior.

Optional `Receipt.data` carries immutable historical operation output. The
adapter reserves retained and serialized bytes before execution. The core and
executor share one frozen payload; acknowledging its resolved current revision
releases it through `releaseReceipt`, preserving scalar deduplication. The tests
cover failed output, changed/conflicting IDs, original-execution reconciliation,
maximum-size escaped output, bounded mappings and result pages under pressure.
Recovery can be delivered before a result page that needs its own byte budget.
Adapters must provide truthful bounds and keep mandatory state within their
declared output budget; an adapter violating those contracts faults explicitly.

`test/waits.test.ts` covers `anyEvent` against retained unread events, typed
events against the delivered floor, mixed conditions, literal `*`, empty
conditions, registration races, backlog slices, cancellation and wait-only
legacy adapters. `test/profile.test.ts` covers nested mutation, accessors,
proxies, replacement during asynchronous admission and the common canonical
profile used for schemas, resources, instructions and numeric wait fields.

## Validation

On Windows x64, Node **24.15.0**: `npm ci`, `npm test` (**124/124**),
`npm run typecheck`, `npm run check:docs`, `npm run check:package`, and
`git diff --check` passed. The package check built and installed the archive into
an isolated consumer, exercised its exports, and confirmed optional peers were
absent from a core-only installation. Existing compatibility, native protocol,
MCP, recovery, serial and supervisor tests remain in the default suite.

`npm run measure:packing` used 64 events and 1,000 full bridge calls. Candidate
packing encoded **64** events and materialized **48,559** bytes, versus **2,080**
event visits and **832,256** materialized bytes in the retained growing-bundle
comparison. Full current-bridge time was **237.822 ms**, process CPU **234 ms**.
This is serialization work, not a measured model or camera speedup.

`node scripts/measure-profile.mjs --profile .runtime/dronerts-profile.json`
measured the actual current DroneRTS profile: **22,239 JSON bytes**, 10 commands,
131 object/array nodes. One-time validation/copy/freeze took **0.491 ms**.
Across seven rounds of 10,000 checks, mutable-profile median was **93.469 μs**
per check; immutable identity checks measured **0.00383 μs**. Instrumented root
traversals were **10,000 versus zero**. Very small identity timings are sensitive
to JIT optimization and timer resolution. They do not predict end-to-end latency.

Raw logs and measurements are ignored under `.runtime/`. The application records
its exact package pin, storage proof, telemetry/sensor wake counts and complete
checks in its `RELIABILITY-QA.md`. The library must be reviewed/published before
that application pin is reproducible from the public upstream source.

## Remaining qualification

Actual native held-wait camera acquisition, repeated real native compaction,
image understanding, autonomous performance and hardware remain separately
qualified work. Attention and acoustic sensing remain independently off by
default. The historical evidence index in [validation](validation.md) retains
the source revisions, dates and limitations of earlier runs.
