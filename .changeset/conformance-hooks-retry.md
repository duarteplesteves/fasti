---
"@fastijs/scheduler": minor
---

The Conformance Suite now proves Hooks are atomic with the write: a throwing in-transaction Hook leaves no Booking (and, with a `tx` probe, no probe row), and a transient retry stores the Booking once and runs after-commit Hooks once. `@fastijs/scheduler/testing` exports `RetryProbe`, `"retry"` is a case tag, and `CaseContext` gains `unbound` and `retry`.

**Custom Adapter authors:** `testAdapter`'s `groups` now requires `retry`. Pass `{ transient: () => <a value your Adapter retries> }` (the Postgres Adapters use `{ code: "40001" }`), or `retry: null` if your Adapter never retries.
