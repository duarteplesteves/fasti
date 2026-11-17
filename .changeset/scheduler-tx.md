---
"@fastijs/scheduler": minor
---

`Scheduler` now takes the Adapter's transaction type: `Scheduler<S, Tx>` (was `Scheduler<S>`), and `createScheduler` infers `Tx` from the Adapter. `BlockActions` takes the form too: `BlockActions<S, "effect" | "plain">`. Calling the Actions is unchanged in both forms.
