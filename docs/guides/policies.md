# Policies

fasti splits its checks in two ([ADR 014](../adr/014-invariants-and-relaxable-policies.md)):

|                | Invariant                                                                                          | Policy                                                          |
| -------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| What           | Valid params, no overlap, a declared Transition, and a Booking that exists in the expected Status  | Any other rule: opening hours, notice, limits                   |
| Comes from     | fasti                                                                                              | You, or an installed Plugin                                     |
| Can be skipped | Never                                                                                              | By name, on one call: `relax: ["notice"]`                       |
| Fails as       | Its own error, alone                                                                               | `PolicyViolation`, listing every Policy that broke              |

No Policy runs by default, apart from your installed Plugins': `availability()` brings `availability`, on `book` and `reschedule`.

## `notice`

The prebuilt Policy: a minimum time before the start.

```typescript
import { createScheduler, notice } from "@fastijs/scheduler";

const scheduler = createScheduler({
  adapter,
  schema,
  policies: [
    // Book or move at least 2 hours ahead.
    notice(schema, { name: "bookingNotice", minimum: 120, appliesTo: ["book", "reschedule"] }),
    // Cancel at least a day ahead.
    notice(schema, { name: "cancelNotice", minimum: 24 * 60, appliesTo: ["cancel"] }),
  ],
});

await scheduler.cancel({ id }); // an hour before the start
// PolicyViolation: [{ policy: "cancelNotice", detail: { earliest } }]
```

- `minimum` is whole minutes, at least 0; anything else throws. **`0` refuses starts in the past**, which fasti otherwise accepts.
- It breaks when the start is before `earliest`, which is `now + minimum`. On `book` and `reschedule` that's the new start; on `cancel` and Transitions, the stored Booking's.
- `name` defaults to `"notice"`. Rename it to register more than one.

## Write your own

A Policy has a `name`, the Actions it `appliesTo`, and a `check`. `check` returns `null` to pass; anything else is the violation's `detail`:

```typescript
import { definePolicy } from "@fastijs/scheduler";

const maxTwoHours = definePolicy(schema, {
  name: "maxTwoHours",
  appliesTo: ["book", "reschedule"],
  check: ({ start, end }) => {
    const minutes = start.until(end).total("minutes");
    return minutes > 120 ? { minutes } : null;
  },
});
```

### Reading the database

`check` is synchronous. To decide on stored Bookings, read them in `load`, and `check` gets what it returned:

```typescript
const lisbonDay = (instant: Temporal.Instant) =>
  instant.toZonedDateTimeISO("Europe/Lisbon").toPlainDate();

const maxFourPerDay = definePolicy(schema, {
  name: "maxFourPerDay",
  appliesTo: ["book"],
  // Once per call, under the Resource Lock on writes: does the I/O.
  load: ({ from, reads, resourceId, to }) =>
    reads.listBookings({
      overlapping: {
        from: from.toZonedDateTimeISO("Europe/Lisbon").startOfDay().toInstant(),
        to: to.toZonedDateTimeISO("Europe/Lisbon").startOfDay().add({ days: 1 }).toInstant(),
      },
      resourceId,
    }),
  // Once per candidate: one on a write, one per Grid slot in findSlots. No I/O.
  check: (candidate, bookings) => {
    const count = bookings.filter(
      (b) => b.status === "booked" && lisbonDay(b.start).equals(lisbonDay(candidate.start))
    ).length;

    return count >= 4 ? { count } : null;
  },
});
```

They are split so `findSlots` can judge hundreds of slots with one query per Policy, not one per slot.

- `load` gets `{ resourceId, from, to, now, reads }`. `from` and `to` are the candidate's range; on `cancel` and Transitions, the stored Booking's; in `findSlots`, the whole search, `[from, to + duration)`.
- `reads` holds `getBooking` and `listBookings`. Plugin data isn't there: a Plugin's own Policies read its tables.

### On Transitions

`appliesTo` also takes Transitions, for preconditions on them:

```typescript
// With a `noShow` Status: it can only be recorded once the Booking has started.
const noShowAfterStart = definePolicy(schema, {
  name: "noShowAfterStart",
  appliesTo: [{ to: "noShow" }],
  check: ({ booking, now }) =>
    Temporal.Instant.compare(now, booking.start) < 0 ? { start: booking.start } : null,
});
```

### `appliesTo` and the candidate

The candidate `check` gets is narrowed to the targets:

| Target                    | Candidate                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `"book"`                  | `{ action, resourceId, start, end, now }`                                                                |
| `"reschedule"`            | `{ action, resourceId, start, end, previous, now }`: `resourceId` is the destination, `previous` the stored Booking |
| `"cancel"`                | `{ action, booking, now }`: the stored Booking                                                           |
| `{ to }` / `{ from, to }` | `{ action: "transition", booking, from, to, now }`: every declared Transition into `to`, or that one     |

Transitions into `cancelled` belong to `"cancel"`. An undeclared Transition or an empty `appliesTo` is a type error, and `definePolicy` throws on it. Names are unique across your `policies` and every installed Plugin's: a clash is a type error, and `createScheduler` throws.

### Testing one

Call its `check` with a candidate and a fixed `now`:

```typescript
maxTwoHours.check({ action: "book", resourceId: "room-1", start: at("09:00"), end: at("12:00"), now: at("08:00") }, undefined);
// { minutes: 180 }
```

## `relax` and `waived`

Register the Policies, and a call that breaks one is refused. `relax` skips it by name, and `waived` reports what that call broke:

```typescript
const scheduler = createScheduler({ adapter, policies: [maxFourPerDay], schema });

const fifth = await scheduler.book({ ...slot, fields });
// { ok: false, error: { _tag: "PolicyViolation", violations: [{ policy: "maxFourPerDay", detail: { count: 4 } }] } }

const staff = await scheduler.book({ ...slot, fields, relax: ["maxFourPerDay"] });
// { ok: true, value: { …booking, waived: [{ policy: "maxFourPerDay", detail: { count: 4 } }] } }
```

- **Who may relax is up to your backend.** fasti has no users or roles, so don't pass a client's `relax` through unchecked.
- **`relax` is typed per Action and Transition**: only the Policies that apply. An unknown name is `InvalidParams` at `["relax", i]`, before any database call. There is no `"all"`, so a Policy you add later is never relaxed by old code.
- **`waived`** lists the relaxed Policies that actually broke, `[]` when none did. Without `relax`, the key is absent. Log it to see who booked outside hours. On `cancel`, only `alreadyCancelled: false` carries it.
- **Order.** Invariants run first, and a failing one comes back alone. Then every Policy that applies runs, relaxed ones included: Plugins' first, in Plugin order, then yours. Every unrelaxed one that broke is in `violations`. Nothing is written, and `also` doesn't run.
- `waived` is a reserved name: a Booking Developer Field can't be called that.

## `findSlots` agrees with the writes

`findSlots` runs the same Policies on each Grid slot: `book`'s, or `reschedule`'s when you pass `excludeBookingId`.

- A slot that breaks an unrelaxed Policy is hidden.
- With `relax`, a slot that breaks only relaxed Policies is listed, with them in `waived`. So `relax: ["availability"]` also lists the Grid slots outside opening hours.
- A slot it lists is one `book` (or `reschedule`) accepts with the same `relax`, at the same `now`.

Time moves between calls, though: a slot listed at 13:59 can be refused by `notice` at 14:01. Within one unit of work, every Policy and `also` see the same `now`. A retry reruns the whole unit with a fresh one, so `load` and `check` never decide on stale data.

## What a Policy can't do

- **Read your own tables.** `load` gets fasti's reads, not your `tx`. A check on your own data ("this customer's tier allows evenings") belongs in [`also`](./also.md), as a veto. It won't show in `findSlots`.
- **Enforce a limit across Resources.** It is race-free only for the Resource whose lock it runs under, so a limit such as sessions per pack can be overfilled by concurrent bookings on different Resources. Make it a guarded update in `also`.
- **Throw to refuse.** A read that fails in `load` is an `AdapterError`. Anything else thrown from `load` or `check` is a bug: the unit rolls back and the promise rejects.
