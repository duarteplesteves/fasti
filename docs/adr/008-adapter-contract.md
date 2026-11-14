# ADR 008: The Adapter Contract Is Domain Verbs Plus a Resource Lock

**Status:** Accepted

**Date:** 2026-11-10

## Context

An Adapter connects the Framework to the developer's database (ADR 007). The Framework has to promise that a Resource is never double-booked. Its checks run in JavaScript, in the Core and in policies, between reading the data and writing the booking. Two choices shape the contract:

1. **What the Adapter speaks.**
   - Generic CRUD over any model with a filter language, as in better-auth.
   - A fixed set of scheduling verbs, as in Auth.js, Lucia and files-sdk.
2. **Where the no-double-booking guarantee lives.**
   - An atomic "insert if nothing overlaps" method that each Adapter implements in its own SQL.
   - A lock the Adapter provides, with the Framework running every check inside it.

## Decision

- **Domain verbs.** The Adapter is a small set of `async` functions: `getBooking`, `listBookings`, `getRules`, `withResourceLock`, and, only on the transaction handle, `insertBooking`, `updateBooking` and `replaceRules`.
  - Custom Adapters exist for tables that differ by more than names, and those are easy to write when each verb maps whole records. A filter translator would make them hard.
  - New entities arrive as optional verb groups.
- **A Resource Lock, with the checks in the Framework.**
  - `withResourceLock(resourceId, work)` runs `work` in one transaction that excludes every other locked unit of work for that Resource.
  - The Framework reads, checks with the Core and policies, and writes inside it.
  - Every write Action takes exactly one lock, on the Resource being written to. Rescheduling to another Resource locks only the destination.
  - Writes exist only on the transaction handle, so the types make an unlocked write impossible.
  - The handle also carries the Adapter's own transaction as `tx`, so the developer's writes can join it (ADR 015).
- **The lock is per database, with no lock table.**
  - Postgres uses an advisory transaction lock. SQLite uses `BEGIN IMMEDIATE`. The in-memory Adapter uses a promise queue.
  - The Postgres Adapter may add an `EXCLUDE` constraint as a backstop. A clash it catches is reported as the same typed conflict. The constraint applies only to Bookings whose Status blocks: `WHERE (status IN (…))`, generated from the declared Statuses (ADR 009).
- **Plain Promises at the boundary.**
  - Adapter authors need no Effect. The Framework wraps the Adapter in Effect internally.
  - A rejected call becomes a typed `AdapterError`. Adapters retry their own transient errors.
  - Expected write outcomes (`conflict`, `changed`) are returned as values.
- **A published Conformance Suite.** It runs against a real database, includes concurrency tests, and allows no opt-outs except optional groups.

## Consequences

- **Positive:** Every scheduling rule lives in one place, the Core plus the Framework. Adapters stay simple.
- **Positive:** Developer-defined policies that read bookings, such as a daily hours cap, are race-free because they run under the lock.
- **Negative:** Each new entity widens the contract, and custom Adapters must add its verb group to use it.
- **Negative:** Databases without interactive transactions, such as Cloudflare D1, can't implement the lock as specified.
- **Negative:** Writes the developer makes to the bookings table outside the Framework don't take the lock. Only a database backstop catches them.

## Amendment (2026-11-14): the contract as built in checkpoint 3

The contract now exists as types in `@fastijs/scheduler/adapter`. Building it settled four details the decision left open:

- **Per-verb results.** Each write verb returns only the outcomes it can have: `insertBooking` returns `{ ok: true }` or `conflict`; `updateBooking` returns `{ ok: true }`, `conflict` or `changed`; `replaceRules` resolves with nothing. Everything else (a duplicate id, a stored Status not in the schema, a lost connection) rejects with a plain `Error`; when a driver failed, its `cause` is the driver error. The Framework wraps rejections as `AdapterError` in checkpoint 4.
- **Object-param writes.** `updateBooking({ expected, changes })` takes the id from `expected`, so the id and the compare-and-set row can't disagree. `replaceRules({ resourceId, rules })` takes rules without a `resourceId`, so a rule can't name another Resource than the call.
- **Transient-error retries are deferred to checkpoint 6.** Under an advisory lock at READ COMMITTED, fasti's own statements can't raise a serialization failure; a deadlock needs the developer's writes in `tx`, which arrive with `also` in checkpoint 6. Until then Adapters don't retry, and "Adapters retry their own transient errors" applies from checkpoint 6.
- **The in-memory Adapter uses one global queue.** Every locked unit of work, on any Resource, runs in turn, with copy-on-write so a rejected unit leaves nothing behind. The Resource Lock is promised per Resource only, and locking more broadly is allowed, so this conforms. The cost: the in-memory Adapter can never show parallelism across Resources, which the contract doesn't require.
