# ADR 016: A Block Is Its Own Entity, Not a Kind of Booking

**Status:** Accepted

**Date:** 2026-11-16

## Context

Developers need periods when a Resource can't be booked: vacations, lunch, meetings. A Booking whose Status blocks could already hold such a period. In real apps, though, these periods carry different data from an appointment (a title, who created it, a calendar event id) and have no lifecycle: they are created, changed and deleted. A Booking with required Developer Fields such as a customer id can't hold one without dummy values.

Options considered:

1. **A Block as a kind of Booking**: a developer Status such as `blocked`. It costs nothing in the Logical Model, and the Postgres `EXCLUDE` backstop covers it. But every Developer Field has to fit both appointments and Blocks, and Blocks inherit a lifecycle they don't have.
2. **Unavailability as part of availability**: a range removed from the AvailabilityRules, covered by the relaxable `availability` Policy. Staff could book over a vacation by relaxing it, which apps refuse for everyone.
3. **Its own entity**, whose overlap is an Invariant.

## Decision

We choose option 3.

- **Shape.** A Block is `{ id: BlockId, resourceId, start, end }` plus its own Developer Fields. `[start, end)` are Instants. There is no timezone, no all-day flag, no recurrence and no Status. fasti mints and brands `BlockId`.
- **The overlap Invariant widens.** It becomes "no overlap with a blocking Booking or a Block on the same Resource" (ADR 014). It can't be relaxed, and `findSlots` hides every slot that overlaps a Block.
- **Both directions are checked under the Resource Lock.** Booking over a Block is refused. Creating or updating a Block over a blocking Booking is refused too, with the same `SlotConflict`. Each item in `conflicts` carries `kind: "booking" | "block"`, with ids and times only.
- **Blocks may overlap each other**, may be in the past, and no Policy applies to their writes.
- **Actions.** `scheduler.blocks.create / update / delete / list`. `update` can't move a Block to another Resource.
- **Opt-in through the schema.** `defineSchema({ block: { fields } })` turns Blocks on. `SchemaAdapter<S>` requires the Block verb group (`listBlocks`, and `insertBlock`, `updateBlock`, `deleteBlock` on the transaction handle) exactly when `S` declares `block`, so a schema with Blocks and an Adapter without them is a type error (ADR 008: new entities arrive as optional verb groups). The Conformance Suite gets an optional Blocks group.
- **The Core doesn't change.** The Framework gives Blocks to the Core as blocking Bookings and maps conflicts back by id.

## Consequences

- **Positive:** Blocks carry their own data, and the race between writing a Block and booking over it is closed by the lock.
- **Positive:** Apps that never use Blocks add no table.
- **Negative:** The Postgres `EXCLUDE` backstop works within one table, so it can't catch a Booking overlapping a Block. Writes made outside fasti lose that safety net.
- **Negative:** `SlotConflict`'s item type changes from 0.1, a breaking type change in a `0.x` minor.
- **Negative:** Without availability, recurring busy time (a daily lunch) has no home until recurring Blocks exist.

## Amendment (2026-11-16): `getBlock` joins the verb group

The Block verb group also has `getBlock(id)` on reads. `update` and `delete` are addressed by id, so they read the Block first to learn which Resource to lock, as `cancel` does with `getBooking`.

## Amendment (2026-11-19): Blocks become a first-party Plugin

From checkpoint 9b (ADR 018), Blocks are a first-party Plugin, `blocks({ fields })` in `defineSchema({ plugins })`, instead of `defineSchema({ block })`. Their overlap stays part of the overlap Invariant and still can't be relaxed.
