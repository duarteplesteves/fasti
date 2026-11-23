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

## Amendment (2026-11-19): the SQLite lock as built in checkpoint 8

- **Two layers.** The Drizzle SQLite Adapter queues units on one database object in this process (the in-memory Adapter's promise queue, shared), and runs each inside `BEGIN IMMEDIATE`. libsql's pool rejects a 21st open transaction instead of waiting, so `BEGIN IMMEDIATE` alone would fail the 21st concurrent booking. The queue also means waiting never blocks the event loop. The lock covers the whole database, which the contract allows.
- **One writer process per file, for now.** Waiting for another process's writer (retrying a busy `BEGIN` without rerunning `work`) and rerunning a unit whose `COMMIT` is busy are designed but not shipped: libsql 0.5.29 never resets a statement that failed with `SQLITE_BUSY`, so every later `COMMIT` on that connection fails (#142). Until a libsql release fixes it, another process writing to the file makes units fail with `SQLITE_BUSY`, and the README says to write from one process only.
- **No SQLite backstop.** SQLite has no `EXCLUDE`, so `insertBooking` never returns `conflict` from the database.
- **Prisma on Postgres** takes the same advisory lock and retries the same transient errors as the Drizzle Postgres Adapter, from one shared module, so units through either Adapter on one Resource exclude each other.

## Amendment (2026-11-19): Plugin data uses one generic verb group

ADR 018 adds one generic verb group for Plugin data, in records that each belong to one Resource, so "domain verbs only" no longer holds for Plugin data. Bookings keep their domain verbs. Availability rules and Blocks move to the generic group when they become first-party Plugins in checkpoint 9b.

## Amendment (2026-11-23): the `records` group, as built in checkpoint 9b

From `0.7`, Plugin data goes through one verb group, `"records"`, keyed by the table's logical name. "Domain verbs only" now holds for Bookings alone.

- **Reads, on both handles:** `getRecord(table, id)` and `listRecords(table, { resourceId, overlapping? })`. `overlapping` is half-open and only ever passed for timed tables. A timed table lists sorted by `start`, then `id`; an untimed one by `id`.
- **Writes, on the locked handle only:** `insertRecord(table, record)`, with the id minted by fasti; `updateRecord(table, { expected, changes })`, compare-and-set, returning `changed` when the stored record differs or is gone (JSON compares by value, not key order); `deleteRecord(table, id)`, returning `missing`; and `replaceRecords(table, { resourceId, records })`, which replaces one Resource's rows only.
- **Records cross the seam as `StoredRecord`:** logical column names, values in fasti's types (`Temporal.Instant`, `PlainDate`, `PlainTime`, JSON, lists of dates). The Adapter maps them to physical names and encodings from `schema.tables`.
- **Removed:** the `"blocks"` group (`getBlock`, `listBlocks`, `insertBlock`, `updateBlock`, `deleteBlock`) and the base `getRules`/`replaceRules`. Availability rules and Blocks are now records of the `availability()` and `blocks()` Plugins.
- **Opting in:** an Adapter declares `Adapter<Tx, "records">`, and `GroupsOf<S>` requires it exactly when an installed Plugin declares tables. A custom Adapter that implements it once runs every Plugin, present and future.
- **Conformance:** a `records` case group covers each verb on `conformancePlugin`'s timed and untimed tables, every column kind, sort order, compare-and-set, a rejected unit leaving no writes, and concurrent locked writes serialising. The Blocks and rule cases stay, now run through the Plugins.

This removes the cost in the Consequences above: a new entity no longer widens the contract.
