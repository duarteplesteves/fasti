# ADR 014: Four Invariants, Everything Else a Policy the Caller Can Relax

**Status:** Accepted

**Date:** 2026-11-11

## Context

Some booking rules hold in theory but have legitimate exceptions in practice. Staff may book outside a Resource's availability, record a walk-in after the fact, or skip a buffer. An overlap with a blocking Booking, however, must never be allowed. Actions trust their caller and know nothing about roles (ADR 010), so any exception has to be decided per call by the developer's backend. ADR 009 left a Transition's preconditions ("`missed` only after the start") to this decision. Listing and booking must agree: a slot that `findSlots` shows must be bookable with the same exceptions.

Options considered:

1. **Hard-coded checks with boolean flags** (`allowOutsideAvailability: true`). Every new rule is a breaking change to every Action's params.
2. **Policies on by default**, replaced or disabled through config. Hidden defaults, and passing a custom list can silently drop the default ones.
3. **A small fixed set of Invariants, plus named Policies the developer lists**, relaxed per call by name.

## Decision

We choose option 3.

- **Invariants** are enforced on every call and can't be relaxed: params are meaningful (`InvalidParams`), no overlap with a blocking Booking on the same Resource, the Transition is declared, and the Booking exists with the expected Status. They are checked before any Policy. If one fails, its error comes back alone.
- **Policies** are everything else. Each is defined against the schema, so names, Transition edges and Developer Fields are typed:

  ```ts
  definePolicy(schema, {
    name: "missedAfterStart",
    appliesTo: [{ to: "missed" }],     // Action names, or Transition edges as { to } / { from, to }
    load: async (ctx) => data,          // optional; once per Action call
    check: ({ booking, now }, data) => null | detail,  // synchronous, once per candidate
  })
  ```

  - `load` runs once per call and `check` runs once per candidate, so `findSlots` can test every slot without a database round trip each time. For writes, both run under the Resource Lock.
  - There is no wildcard for all Transition edges, so a Policy is never applied by surprise when a new edge is declared.
- **Which Policies apply.**
  - `availability` belongs to the availability Actions. It is always present, because it enforces rules the developer stored on purpose, and it can be relaxed like any other Policy.
  - `createScheduler({ schema, adapter, policies })` requires `policies`; `[]` means none. Nothing else is on by default.
  - fasti exports the prebuilt `notice(schema, { minimum, appliesTo })`. A `minimum` of zero forbids past starts. An app whose notice varies writes its own.
- **Relaxing.**
  - The caller passes `relax: [...names]`, typed per Action and per Transition edge, so autocomplete lists exactly the Policies that apply. There is no `"all"`, because a Policy added later would then be relaxed by old code.
  - Broken Policies return `{ _tag: "PolicyViolation", violations: [{ policy, detail }, …] }`: every one that broke, not just the first, each with `detail` narrowed by `policy`.
  - A relaxed success returns `waived`, the relaxed Policies that actually broke, using the same element type.
- **`findSlots`** requires `timezone` and `interval`. It walks one grid from local midnight in `timezone`, in steps of `interval`. A candidate that breaks an Invariant or a Policy the caller didn't relax is hidden. A candidate that breaks only relaxed Policies is returned with them in `waived`. Passing the same `relax` to `book` succeeds, so listing and booking agree.
- **Time.** `now` comes from Effect's `Clock` in the Effect form, and from system time in the plain form. To test a Policy on its own, call its `check` directly.

## Consequences

- **Positive:** Buffers, group limits, notice and Transition preconditions all fit one shape. Adding a Policy never changes an Action's params beyond the `relax` union.
- **Positive:** Exceptions are visible in the types and in the result (`waived`), so the developer can log who booked outside hours.
- **Negative:** A Policy is race-free only for the Resource whose lock it runs under. A limit across Resources (sessions per pack) can be overfilled by concurrent bookings on different Resources. Its guarantee has to come from an atomic write that can veto the Action, not from a Policy.
- **Negative:** The grid starts at local midnight, not at each rule's start. A rule starting at 09:10 needs an `interval` that reaches 09:10 (for example 10 minutes), or its first slot moves.
- **Negative:** `policies: []` allows past starts. The developer has to opt into `notice`.

## Amendment (2026-11-15): Policies and `relax` are staged into checkpoint 7

`0.1.0` (checkpoint 4) ships the Invariants and the `availability` Policy only. `createScheduler` takes no `policies`, the Actions take no `relax`, `notice` isn't exported, and `Slot.waived` is always empty. `availability` is checked as decided above, after the overlap Invariant, and reported as `PolicyViolation`, so the result shapes don't change when the rest arrives. `definePolicy`, `policies`, `relax`, `notice` and `now` from `Clock` arrive together in checkpoint 7. Until then past starts are bookable.

## Amendment (2026-11-16): the overlap Invariant covers Blocks

From checkpoint 5 (`0.2`), the overlap Invariant is "no overlap with a blocking Booking or a Block on the same Resource" (ADR 016). There are still four Invariants. A Block can't be relaxed, so `findSlots` never returns a slot that overlaps one, whatever the caller relaxes.

## Amendment (2026-11-18): Policies as built in checkpoint 7

Checkpoint 7 (`0.4`) ships `definePolicy`, `policies`, `relax`, `waived` and `notice` as decided above, and the staging amendment of 2026-11-15 no longer applies. `availability` is now a Policy value always present on `book` and `reschedule`, run by the same pass as the developer's. Building it settled these details:

- **Candidates.** `check` gets one candidate per call, discriminated on `action` and narrowed to the Policy's `appliesTo`:

  | Target | Candidate |
  |---|---|
  | `"book"` | `{ action, resourceId, start, end, now }` |
  | `"reschedule"` | `{ action, resourceId, start, end, previous, now }`: `resourceId` is the destination, `previous` the stored Booking |
  | `"cancel"` | `{ action, booking, now }`: the stored Booking |
  | `{ to }` / `{ from, to }` | `{ action: "transition", booking, from, to, now }`: the stored Booking, still in `from` |

  Edges into `cancelled` belong to `"cancel"`. `{ to }` covers every declared edge into `to`, and needs at least one.
- **`load`'s context** is `{ resourceId, from, to, now, reads }`. `from` and `to` are the candidate's range on `book` and `reschedule`, the stored Booking's on `cancel` and edges, and `[from, to + duration)` of the search in `findSlots`. `reads` are fasti's reads as Promises (`getBooking`, `listBookings`, `listBlocks`, `getRules`), on the unit of work, locked inside writes. There is no `tx`, so a check on the developer's own data belongs in `also` with a Veto (ADR 015), and doesn't show in `findSlots`. A failing read is an `AdapterError`; any other throw from `load` or `check` is a defect that rolls the unit back.
- **`findSlots` with `excludeBookingId`** judges each slot with the `reschedule` Policies, with `previous` set to that Booking, and `relax` narrows to their names. Without it, the `book` Policies run. An id that names no Booking is `BookingNotFound`, which joins `FindSlotsError`. A non-blocking Booking is still searched for, so `StatusMismatch` stays out of `findSlots`.
- **`notice`'s units and name.** `minimum` is whole minutes, at least 0; a negative, fractional or non-finite value throws. `name` defaults to `"notice"`, and renaming it registers more than one (`bookingNotice`, `cancelNotice`). The start compared is the candidate's on `book` and `reschedule`, the stored Booking's on `cancel` and edges.
- **`waived` is reserved.** A Booking Developer Field named `waived` is a type error and throws in `defineSchema`, as `also` does. The value carries `waived` only when the call passed `relax` (`[]` when nothing relaxed broke), and on `cancel` only on the `alreadyCancelled: false` branch: a repeat `cancel` runs no Policy.
- **`relax` is checked before any Adapter call.** An unknown or non-applicable name is `InvalidParams` at `["relax", i]`. `CancelError` gains `InvalidParams` for it.
- **The types carry the Policies.** `PolicyViolation<V>` is generic, and is in an Action's error type only when an unrelaxed Policy applies to it, so `BookError` and `RescheduleError` no longer list it. The plain `Scheduler<S, Tx, P>` takes the Policies tuple, and the Effect form's `Scheduler<Self, S, Tx, P>` takes it as a required fourth type parameter, with no default, as `Tx`: `readonly []` for none.
- **Names.** `availability` is fasti's own, and two Policies with one name are a type error and throw in `createScheduler`. A Policy from another schema is refused by the types only.
