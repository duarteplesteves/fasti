---
"@fastijs/scheduler": minor
---

**Breaking (types only):** `Scheduler` now takes the Adapter's transaction type, so `Scheduler<typeof schema>` becomes `Scheduler<typeof schema, Tx>`; `createScheduler` infers `Tx` from the Adapter. `BlockActions` takes `Tx` and the form as well: `BlockActions<S, Tx, "effect" | "plain">`. Calling the Actions is unchanged in both forms.
