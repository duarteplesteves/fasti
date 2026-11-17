---
"@fastijs/scheduler": minor
---

In the Effect form, `also` can require your own services (they join the Action's requirements, `Effect<V, E, R>`), its `now` comes from Effect's `Clock` (so `TestClock` controls it), and its `tx` has the Adapter's type (ADR 010, amended). New export from `@fastijs/scheduler/effect`: `TxOf<A>`, an Adapter's transaction type.

**Breaking (types only):** `Scheduler` from `@fastijs/scheduler/effect` takes the Adapter's transaction type as a required third parameter, and `SchedulerService<S>` becomes `SchedulerService<S, Tx>`.

Before:

```ts
class AppScheduler extends Scheduler<AppScheduler, typeof schema>()("app/Scheduler") {}
const live = AppScheduler.layer({ schema, adapter: drizzleAdapter(db) });
```

After:

```ts
const adapter = drizzleAdapter(db);
class AppScheduler extends Scheduler<AppScheduler, typeof schema, TxOf<typeof adapter>>()("app/Scheduler") {}
const live = AppScheduler.layer({ schema, adapter });
```
