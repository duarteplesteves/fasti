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
- **The lock is per database, with no lock table.**
  - Postgres uses an advisory transaction lock. SQLite uses `BEGIN IMMEDIATE`. The in-memory Adapter uses a promise queue.
  - The Postgres Adapter may add an `EXCLUDE` constraint as a backstop. A clash it catches is reported as the same typed conflict.
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
