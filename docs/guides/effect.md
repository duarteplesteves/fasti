# Effect

The same Actions, with the same params, values and errors, as Effects. Declare your own service class and provide its `layer`:

```typescript
import { Scheduler } from "@fastijs/scheduler/effect";
import type { TxOf } from "@fastijs/scheduler/effect";
import { Effect } from "effect";

const adapter = drizzleAdapter(db);

class AppScheduler extends Scheduler<AppScheduler, typeof schema, TxOf<typeof adapter>>()(
  "app/Scheduler"
) {}

const program = Effect.gen(function* bookOne() {
  const scheduler = yield* AppScheduler;

  return yield* scheduler
    .book({ resourceId: "room-1", start, end, fields: { customerName: "Ada" } })
    .pipe(Effect.catchTag("SlotConflict", (error) => Effect.succeed(error.conflicts)));
});

await Effect.runPromise(program.pipe(Effect.provide(AppScheduler.layer({ adapter, schema }))));
```

Expected failures go to the error channel, tagged for `Effect.catchTag`. A bug in fasti dies.

## Type parameters

`Scheduler<Self, Schema, Tx, Policies>()(key)`:

- **`Tx`** is your Adapter's transaction handle, the `tx` an `also` gets. Leave it out if you don't use one.
- **`Policies`** is your [Policies](./policies.md) tuple. Leave it out for none.

```typescript
const policies = [notice(schema, { appliesTo: ["book"], minimum: 120 })] as const;

class StrictScheduler extends Scheduler<
  StrictScheduler,
  typeof schema,
  TxOf<typeof adapter>,
  typeof policies
>()("app/StrictScheduler") {}

const StrictLive = StrictScheduler.layer({ adapter, policies, schema });
```

## `also`

`also` returns an Effect. It may require your own services, which join the Action's requirements, and its `now` comes from Effect's `Clock`, so `TestClock` controls it. `Effect.fail` vetoes:

```typescript
const paid = Effect.gen(function* bookPaid() {
  const scheduler = yield* AppScheduler;

  return yield* scheduler.book({
    resourceId: "room-1",
    start,
    end,
    fields: { customerName: "Ada" },
    also: ({ booking, tx }) =>
      Effect.gen(function* spend() {
        const spent = yield* Effect.promise(() => spendCredit(tx, booking.id));

        return spent ? "paid" : yield* Effect.fail("no credits left" as const);
      }),
  });
});
// Fails with { _tag: "Vetoed", reason: "no credits left" } when the pack is empty.
```

## Interruption

Interrupting the fiber doesn't cancel a unit of work already running in the Adapter: it finishes, then commits or rolls back. After a commit, its after-commit [Hooks](./hooks.md) run in the background.

## Writing Plugins

`definePlugin` from `@fastijs/scheduler/effect` is the native form: see [Plugins in Effect](./plugins.md#in-effect).
