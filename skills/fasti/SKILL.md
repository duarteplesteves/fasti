---
name: fasti
description: Writing code with fasti (`@fastijs/scheduler`), the TypeScript scheduling framework. Use when code imports `@fastijs/scheduler`, or when building bookings, free slots, opening hours or availability with it.
---

# fasti

fasti finds free slots and writes Bookings on the app's own database, with no double bookings. The docs ship in the package and match the installed version: `node_modules/@fastijs/scheduler/README.md` and `node_modules/@fastijs/scheduler/docs/guides/` (in a monorepo, look for the `node_modules` the app resolves from).

## Steps

1. **Route.** Read the README's "Which piece do I need?" table. It maps each task to the piece that does it and to that piece's guide.
2. **Read the guide** for every piece the change touches, in full, before writing code. The guides list each Action's params, values, errors and limits. The README's "Entry points" table says which subpath exports what.
3. **Write the code** following the rules below.
4. **Done** when the project typechecks and every Result the code gets is handled on `ok`, and then on `error._tag`.

## The model

- A **schema** (`defineSchema`) declares the Developer Fields, Statuses and Plugins. An **Adapter** connects fasti to a database. `createScheduler({ schema, adapter })` returns the **Actions**: `findSlots`, `book`, `reschedule`, `cancel`, `transition`, and one group per Plugin, such as `availability.set` or `blocks.create`.
- Every write runs in one transaction, under a lock on its Resource. First the **Invariants** (no overlap with blocking Bookings or busy time; never skippable), then the **Policies** (rules that one call may skip by name with `relax`), then the write, then `also`, then the Hooks.
- Every Action returns a **Result**: `{ ok: true, value }` or `{ ok: false, error }`. Branch on `result.ok`, then switch on `error._tag` and TypeScript narrows the error. A rejected promise means a bug, or a throw in the app's own `also` or in-transaction Hook.

## Rules

**Time**

- Times are `Temporal` values, a global on Node 26+ and Bun 1.4+. Actions take `Temporal.Instant`. Opening hours take `Temporal.PlainTime` and an IANA `timezone`.
- Ranges are half-open `[start, end)`, so 09:00–09:30 and 09:30–10:00 can both be booked.
- `findSlots` returns slots as `Temporal.ZonedDateTime`. To book one, pass `slot.start.toInstant()` and `slot.end.toInstant()`. `duration` and `interval` are in minutes, and slot starts fall on a grid from local midnight in `timezone`.

**What is bookable**

- Opening hours exist only with `plugins: [availability()]` in the schema, followed by `scheduler.availability.set(...)`. Starts in the past are refused only with the `notice` Policy.
- Unavailable periods (lunch, vacations) are Blocks, from the `blocks()` Plugin. A rule of the app's own is a Policy from `definePolicy`. A rule that needs the app's own tables is a veto in `also`.

**Reading and ids**

- Read stored Bookings through the app's own ORM, from the tables fasti built (`bookingTable(schema)`, `recordTables(schema)`, `prismaModels`). fasti has no get or list Action for Bookings.
- A Booking id from outside, such as a URL param, gets branded with `as BookingId` (a type from `@fastijs/scheduler/core`). An unknown id comes back as `BookingNotFound`.

**Writes of the app's own**

- `also` holds the app's own writes for one call, in fasti's transaction. Its body is queries through its `tx` and nothing else: other writes escape the rollback, and calling an Action there deadlocks on the same Resource. Keep it fast, since it runs under the lock, and safe to rerun, since Postgres Adapters retry the whole unit on a deadlock. Return `{ ok: true as const, value }` to commit, or `{ ok: false as const, error }` to roll back as `Vetoed`.
- Emails, webhooks and other outside effects go in an after-commit Hook (`defineHook` with `when: "afterCommit"`) or after the call returns `ok`. After-commit Hooks run once with no retry. When an effect must never be lost, follow the outbox in the Hooks guide.
- `relax` comes from the app's backend, after it checks who is calling: fasti has no users or roles.

**Database**

- fasti never changes the database schema. Add its tables to the app's migration tool and migrate, then add the overlap backstop on Postgres (`backstopSql`). The Databases guide has the steps for each Adapter.
- Unit tests run on `memoryAdapter()` from `@fastijs/scheduler/memory`. Its `tx` is `undefined`, so an `also` that writes through `tx` gets tested on the real database.

**Forms**

- The plain async form comes from `@fastijs/scheduler`. The Effect form comes from `@fastijs/scheduler/effect` (see the Effect guide). Use the one the app already uses.
