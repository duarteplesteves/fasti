---
"@fastijs/scheduler": minor
---

Add Policies: define one with `definePolicy(schema, { name, appliesTo: ["book"], load?, check })` and register it through `createScheduler({ schema, adapter, policies })`. `book` runs every applicable Policy under the Resource Lock, after the Invariants, with the built-in `availability` first, and reports every broken one in a single `PolicyViolation<V>` whose `detail` is typed per Policy. `load` gets `{ resourceId, from, to, now, reads }` and runs once per call; `also` sees the same `now`.

Breaking: `policies` is now required (pass `policies: []` for none), the plain `Scheduler` type and `SchedulerService` take the Policies tuple as a third type parameter, and the Effect-form `Scheduler<Self, S, Tx, P>` takes it as a required fourth. `BookError` no longer lists `PolicyViolation`; the scheduler types it from its Policies.
