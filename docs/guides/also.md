# `also`: your writes in the same transaction

Every write Action takes an optional `also`. fasti calls it after its own write, on the same transaction, with your Adapter's `tx` and the current `now`. Either everything is saved, or nothing is ([ADR 015](../adr/015-developer-writes-inside-the-action-transaction.md)).

## Example: a prepaid pack

Each Booking spends a credit from a `pack` table of your own:

```typescript
import { and, eq, gt, sql } from "drizzle-orm";

const result = await scheduler.book({
  ...slot,
  fields: { customerName: "Ada" },
  also: async ({ tx }) => {
    // A guarded update: race-free, and it changes no row when the pack is empty.
    const [row] = await tx
      .update(pack)
      .set({ remaining: sql`${pack.remaining} - 1` })
      .where(and(eq(pack.id, packId), gt(pack.remaining, 0)))
      .returning({ remaining: pack.remaining });

    return row === undefined
      ? { ok: false as const, error: "no credits left" as const }
      : { ok: true as const, value: row.remaining };
  },
});

if (result.ok) {
  result.value.also; // the credits left
} else if (result.error._tag === "Vetoed") {
  result.error.reason; // "no credits left", and no Booking was stored
}
```

| `also`                           | Then                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| returns `{ ok: true, value }`    | All is saved. `value` is on the Action's value as `also` (a `blocks.delete` value is `{ also }`). |
| returns `{ ok: false, error }`   | A **veto**: all is rolled back, and the Action fails with `{ _tag: "Vetoed", reason: error }`. |
| throws                           | All is rolled back, and the promise rejects with what was thrown.                          |

It may be sync or async.

## What to watch for

- **Write only through `tx`.** Anything else isn't part of the transaction and won't roll back. On the memory Adapter, `tx` is `undefined`.
- **It may run more than once.** The Drizzle and Prisma Postgres Adapters rerun the whole unit on a deadlock or serialization failure (`40P01`, `40001`), up to 3 attempts. When they run out, it fails as on the last attempt: an `AdapterError` if fasti's write failed, a rejection if `also` threw. So a deadlock hit by a query of yours rejects the promise.
- **No emails or webhooks here**: they can't roll back. Send them from an after-commit [Hook](./hooks.md), or after the call returns `ok`. If one must never be lost, use [an outbox](./hooks.md#when-it-must-never-be-lost).
- **Keep it fast.** It runs under the Resource Lock, so a slow `also` delays every other write to that Resource.
- **Don't call an Action inside it.** That's unsupported, and on the same Resource it deadlocks.

## What it gets

Besides `tx` and `now`:

| Action                                | Context                              |
| ------------------------------------- | ------------------------------------ |
| `book`                                | `booking`                            |
| `reschedule`, `cancel`, `transition`  | `booking`, `previous`                |
| `availability.set`                    | `resourceId`, `rules`, `previous`    |
| `blocks.create`                       | `block`                              |
| `blocks.update`                       | `block`, `previous`                  |
| `blocks.delete`                       | `previous`                           |
| any other Plugin's write Action       | the `context` its `lock` returned    |

`previous` lets you see what changed, for example to refund a late cancellation differently:

```typescript
await scheduler.cancel({
  id,
  also: async ({ tx, previous, now }) => {
    const early = Temporal.Instant.compare(now.add({ hours: 24 }), previous.start) <= 0;

    if (early) {
      await refund(tx, previous.id);
    }

    return { ok: true, value: { refunded: early } };
  },
});
```

It runs only when something changed. A repeat `cancel` writes nothing and skips it, and its value has no `also` key. A `blocks.update` that changes nothing still runs it, with `block === previous`.

`also` is a reserved name: no Booking or Block Developer Field, or Plugin write Action's param, can be called that.
