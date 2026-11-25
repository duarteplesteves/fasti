# Actions

An Action is a method on the scheduler. Every one returns a `Result`: `{ ok: true, value }` or `{ ok: false, error }`, where `error._tag` says what failed. Only bugs reject the promise.

| Action                        | Value                                   | Errors (`_tag`), besides `AdapterError`                                                  |
| ----------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`findSlots`](#findslots)     | `Slot[]`, zoned in `timezone`           | `InvalidParams`, `BookingNotFound`                                                       |
| [`book`](#book)               | the `Booking`                           | `InvalidParams`, `SlotConflict`, `PolicyViolation`                                       |
| [`reschedule`](#reschedule)   | the moved `Booking`, same id and Status | `InvalidParams`, `BookingNotFound`, `StatusMismatch`, `SlotConflict`, `PolicyViolation`  |
| [`cancel`](#cancel)           | `{ booking, alreadyCancelled }`         | `InvalidParams`, `BookingNotFound`, `TransitionNotDeclared`, `PolicyViolation`           |
| [`transition`](#transition)   | the `Booking`, in its new Status        | `InvalidParams`, `BookingNotFound`, `StatusMismatch`, `SlotConflict`, `PolicyViolation`  |
| [`availability.set`](#opening-hours) | `{ rules }`                      | `InvalidParams`                                                                          |
| [`availability.get`](#opening-hours) | the stored rules                 |                                                                                          |

- Every write Action can also fail with `Vetoed`, when you pass it an [`also`](./also.md).
- `PolicyViolation` is in an Action's error type only when some [Policy](./policies.md) applies to it and isn't relaxed.
- `availability.*` exists because the schema installs `availability()`. Every other Plugin adds its Actions under its own name the same way: see [`blocks.*`](./blocks.md).

The examples assume `at("09:00")` is an Instant on Monday 3 June 2030, and a schema with one Developer Field, `customerName`.

## Errors

Switch on `_tag`, and TypeScript narrows the rest. For example, over HTTP:

```typescript
const result = await scheduler.book(params);

if (result.ok) {
  return Response.json(result.value, { status: 201 });
}

switch (result.error._tag) {
  case "InvalidParams": // { issues: [{ path, message }] }
    return Response.json(result.error, { status: 400 });
  case "SlotConflict": // { conflicts: [{ kind, id, start, end }] }
  case "PolicyViolation": // { violations: [{ policy, detail }] }
    return Response.json(result.error, { status: 409 });
  case "AdapterError": // an Error, with your driver's error as `cause`
    console.error(result.error);
    return new Response(null, { status: 500 });
}
```

| Error                   | Means                                                        | Carries                                  |
| ----------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| `InvalidParams`         | The call itself is wrong, such as an end before its start    | `issues`: each a `path` and a `message`  |
| `SlotConflict`          | The time is taken                                            | `conflicts`: each a `kind`, `id`, `start`, `end` |
| `PolicyViolation`       | One or more Policies refused                                 | `violations`: each a `policy` and `detail` |
| `BookingNotFound`       | No Booking has this id                                       | `id`                                     |
| `StatusMismatch`        | The Booking isn't in the Status the call needs               | `id`, and the stored `status`            |
| `TransitionNotDeclared` | `cancel` from a Status that can't be cancelled               | `id`, `from`, `to`                       |
| `Vetoed`                | Your `also` refused                                          | `reason`: what it returned               |
| `AdapterError`          | The database failed                                          | `cause`: your driver's error             |

All but `AdapterError` are plain objects with no `message`, safe to send to a client as JSON: a `SlotConflict` carries ids and times, never Developer Fields ([ADR 010](../adr/010-action-results-and-two-forms.md)).

**Overlap comes first.** Invariants are checked before any Policy, so an overlapping Booking outside hours is a `SlotConflict` alone ([ADR 014](../adr/014-invariants-and-relaxable-policies.md)).

**Ids.** A Booking's `id` is a branded string. When it comes from outside, such as a URL, brand it yourself; an unknown one is `BookingNotFound`:

```typescript
import type { BookingId } from "@fastijs/scheduler/core";

await scheduler.cancel({ id: request.params.id as BookingId });
```

## `findSlots`

Lists the free slots on one Resource that start in `[from, to)`.

```typescript
const slots = await scheduler.findSlots({
  resourceId: "room-1",
  from: at("00:00"),
  to: at("23:59"),
  duration: 45, // minutes each slot lasts
  interval: 15, // minutes between possible starts
  timezone: "Europe/Lisbon",
});
// 09:00–09:45, 09:15–10:00, 09:30–10:15, …

if (slots.ok) {
  for (const { start, end } of slots.value) {
    console.log(`${start.toPlainTime()}–${end.toPlainTime()}`);
  }
}
```

- **The Grid.** Slots start at local midnight in `timezone` plus whole `interval`s, whatever the opening hours. Opening at 09:10 on a 15-minute Grid gives a first slot at 09:15.
- **Booking a slot.** A slot's `start` and `end` are `Temporal.ZonedDateTime`, for display. `book` takes Instants: `slot.start.toInstant()`. A slot's end may pass `to`.
- **Policies.** It runs `book`'s Policies on every slot and hides those that break one. With `relax`, it lists them too, each with what it broke in `waived`:

  ```typescript
  await scheduler.findSlots({ ...search, relax: ["availability"] });
  // 08:30 has waived: [{ policy: "availability", detail: {} }], 09:00 has waived: []
  ```

- **For moving a Booking.** Pass `excludeBookingId` to list the times `reschedule` would accept. That Booking leaves the overlap check, and each slot is judged by `reschedule`'s Policies instead of `book`'s. An unknown id is `BookingNotFound`.

## `book`

```typescript
const result = await scheduler.book({
  resourceId: "room-1",
  start: at("09:00"),
  end: at("09:30"),
  fields: { customerName: "Ada" },
});
// { ok: true, value: { id, resourceId, start, end, status: "booked", customerName: "Ada" } }
```

- `status` picks the initial Status. It's required when the schema's [`initial`](./statuses.md) has more than one, and absent otherwise.
- `book` isn't idempotent: each call mints a new id, so dedupe retries in your backend.

## `reschedule`

```typescript
await scheduler.reschedule({ id, start: at("10:00"), end: at("10:30") });

// To another Resource, changing a field too:
await scheduler.reschedule({
  id,
  resourceId: "room-2",
  start: at("10:00"),
  end: at("10:30"),
  fields: { customerName: "Ada L." },
});
```

- The Booking doesn't conflict with itself, so it can move by 15 minutes.
- It takes the lock on the destination Resource only.
- A Booking in a non-blocking Status, such as `cancelled`, is a `StatusMismatch`.

## `cancel`

```typescript
await scheduler.cancel({ id }); // value: { booking, alreadyCancelled: false }
await scheduler.cancel({ id }); // value: { booking, alreadyCancelled: true }
```

- It's idempotent: a repeat writes nothing, and runs no Policy, `also` or Hook.
- From a Status with no Transition to `cancelled`, it's `TransitionNotDeclared`.
- It takes a partial `fields` patch.

## `transition`

```typescript
await scheduler.transition({ id, from: "booked", to: "noShow" });
// If the stored Status is something else: { _tag: "StatusMismatch", id, status: "cancelled" }
```

- Only [declared Transitions](./statuses.md) are allowed: `to` is narrowed by `from`. `cancelled` is never a `to`; use `cancel`.
- It is compare-and-set: it succeeds only if the stored Status is `from`.
- Moving from a non-blocking Status into a blocking one checks overlap again. Availability is never checked.
- It takes a partial `fields` patch.
- It exists when some declared Transition doesn't end in `cancelled`.

## Opening hours

`availability()` adds `scheduler.availability` and the `availability` [Policy](./policies.md), which applies to `book` and `reschedule`. A Resource with no rules has no opening hours, so nothing on it is bookable unless the call relaxes `availability`.

```typescript
await scheduler.availability.set({
  resourceId: "room-1",
  rules: [
    {
      recurrence: { frequency: "weekly", interval: 1, daysOfWeek: [1, 2, 3, 4, 5] },
      timeWindow: { start: Temporal.PlainTime.from("09:00"), end: Temporal.PlainTime.from("13:00") },
      timezone: "Europe/Lisbon",
      exceptions: [Temporal.PlainDate.from("2030-12-25")], // closed that day
    },
    {
      // Every other Saturday, summer only.
      recurrence: { frequency: "weekly", interval: 2, daysOfWeek: [6] },
      timeWindow: { start: Temporal.PlainTime.from("10:00"), end: Temporal.PlainTime.from("12:00") },
      timezone: "Europe/Lisbon",
      effectiveFrom: Temporal.PlainDate.from("2030-06-01"),
      effectiveTo: Temporal.PlainDate.from("2030-08-31"),
    },
  ],
});

const rules = await scheduler.availability.get({ resourceId: "room-1" });
```

- `set` replaces the Resource's whole set of rules; `[]` clears it.
- Days are ISO: 1 is Monday, 7 is Sunday.
- A window can't cross midnight: use two rules.
- A Booking must fit inside a single window: 12:00–14:00 doesn't fit 09:00–13:00 plus 13:00–17:00.

## Limits

Work is bounded, and going over is `InvalidParams`, never a truncated list ([ADR 019](../adr/019-bounded-work-and-a-supported-date-range.md)):

| What                      | Limit                                                         |
| ------------------------- | ------------------------------------------------------------- |
| Dates                     | Years 0001–9999                                               |
| One `findSlots` search    | 10,000 Grid times: its span in days × the Grid times in a day |
| `duration`                | 31 days                                                       |
| `availability.set`        | 100 rules, each with at most 1,000 exceptions                 |

Page a longer search: the slots of `[a, b)` and `[b, c)` together are those of `[a, c)`.

Instants are floored to the millisecond.
