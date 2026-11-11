# ADR 009: The Booking Lifecycle Is Declared as Data and Enforced by the Framework

**Status:** Accepted

**Date:** 2026-11-10

## Context

The Core reads only whether a Booking blocks (ADR 004). The Framework stores Bookings (ADR 007), so it needs a lifecycle. Real apps need more than "booked or cancelled": payment holds, visits in progress, no-shows. But fasti should not be a complete status system. One thing the Framework must own whatever the design: a Booking that starts to block again, such as an un-cancel, has to pass the overlap check under the Resource Lock (ADR 008). Otherwise it can land on top of a newer Booking.

Options considered:

1. **A fixed list of Statuses** shipped by the Framework (`pending | confirmed | completed | no_show`). Rigid, and still short of real apps.
2. **Any Status can move to any Status**, with only the blocking rule enforced. Every developer rebuilds the same guard, and a bug in it reaches the database.
3. **A state-machine library** (XState, effect-machine) as the lifecycle definition. The Framework stores one column and changes it under a lock, so a statechart engine is more than it needs. It would also make `defineSchema` depend on the library and the plain API harder to read.
4. **Declared data**: a small base, plus Statuses and Transitions the developer declares, enforced by the Framework.

## Decision

We choose option 4.

- **Statuses.** Two base Statuses ship: `booked` (blocks) and `cancelled` (doesn't). The developer declares more in `defineSchema`, each with a required `blocking: boolean`. The Framework reads nothing from a Status except whether it blocks.
- **Transitions.** They are declared as a table (`transitions: { booked: ["inProgress", "missed", "cancelled"], … }`).
  - A Status with no Transitions leaving it is terminal.
  - `booked → cancelled` is always present.
  - The developer may add Transitions out of `cancelled`.
  - The types narrow `to` by `from`.
- **Invariants.** The Framework enforces two things under the Resource Lock and never relaxes them: the Transition is declared, and moving into a blocking Status passes the overlap check.
- **Preconditions** ("`missed` only after the start") are developer policies. They run under the lock and can be relaxed per call; their shape belongs to the policies decision. Checks on the developer's own data, such as payment, happen in the developer's backend before the call.
- **Actions, one job each.**
  - `book` creates. It takes a required `status` only when the declared `initial` list (default `["booked"]`) has more than one entry.
  - `reschedule` moves a blocking Booking in time or to another Resource, and keeps its Status.
  - `cancel` is the only way into `cancelled`. It is idempotent, takes no `from`, and is allowed only where the table permits it.
  - `transition({ id, from, to })` handles every other Status change. `from` is required, as a compare-and-set that returns `changed` when the stored Status differs. The Action exists only when the developer declares Statuses.
- **Storage.**
  - Only `status` is stored, as text guarded by a `CHECK (status IN (…))` that the schema builders generate from `defineSchema`. There is no `is_blocking` column; whether a Booking blocks is derived from the declared table.
  - The Postgres backstop filters on `status IN (<blocking Statuses>)`.
  - Stored Status values can be renamed through `names`, like columns.
  - A stored value the Framework doesn't know comes back as a typed `AdapterError`.
  - `listBookings` returns every Status, with no filter.
- **Not in the base.** No lifecycle timestamps, since the UUIDv7 id carries the creation time. No holds that expire. Developer Fields and the developer's own writes alongside a Transition were left to a separate decision, now ADR 015: a typed `fields` patch, and an `also` function inside the transaction.

## Consequences

- **Positive:** Developers who declare nothing see only `book`, `reschedule`, `cancel` and `findSlots`.
- **Positive:** Status and blocking can never disagree, in the Framework or in the database. The `CHECK` constraint rejects stray values written outside fasti.
- **Positive:** Bad Transitions and silent overwrites are stopped before they reach the database. Developers can still drive the lifecycle from XState or similar in their own backend.
- **Negative:** Flipping a Status's `blocking` flag, or removing a Status that rows still use, is a schema change. The developer migrates it, and nothing checks stored rows at runtime.
- **Negative:** Preconditions can't be declared in `defineSchema`, because it is plain data. They live in the policies, separately from the Transition table.
