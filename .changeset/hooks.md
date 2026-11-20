---
"@fastijs/scheduler": minor
---

**Hooks.** Register cross-cutting work once with `defineHook(schema, adapter, { when, appliesTo, run })` and pass it as `hooks` on `createScheduler` or `Scheduler.layer`. Hooks only observe: they can't change an Action's params, value or errors, or refuse one.

- `when: "inTransaction"` runs on the Action's `tx`, after `also`; a throw rolls the whole write back and the Action rejects with it.
- `when: "afterCommit"` runs once, after the final commit, and is awaited before the Action returns; a failure is logged and never changes the result. It isn't retried, and is lost if the process dies after the commit: write an outbox row from an in-transaction Hook for work that must never be lost.

See the README's Hooks section and ADR 017.

**Breaking, for custom Adapter authors only:** `testAdapter` now requires `groups.retry`: pass a `RetryProbe`, or `retry: null` if your Adapter never retries. **Deprecated:** `ActionTarget`, now an alias of `BookingActionName`.
