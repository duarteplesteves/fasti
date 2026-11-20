---
"@fastijs/scheduler": minor
---

`policies` is now optional on `createScheduler` and `Scheduler.layer`: `createScheduler({ schema, adapter })` behaves exactly like `policies: []`, and the Effect form's Policies type parameter defaults to `readonly []`. The Invariants and the built-in `availability` still apply, and past starts stay bookable unless you register `notice`.
