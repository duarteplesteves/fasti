---
"@fastijs/scheduler": minor
---

The Drizzle Adapter retries transient errors (ADR 008): a unit of work that fails with `40001` (serialization failure) or `40P01` (deadlock), found anywhere on the error's `cause` chain, reruns whole, `also` included, up to 3 attempts. Other errors aren't retried. When attempts run out, the error surfaces as before: an `AdapterError` when it came from fasti's own write, a rejection with what was thrown when it came from `also`.
