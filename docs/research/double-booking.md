# Research: how can a booking Action guarantee no double-booking?

Ticket: #6 (map: #2). Researched 2026-11-09 against official PostgreSQL 18, MySQL 8.4 and SQLite docs, and the Prisma, Drizzle and Kysely docs and published type definitions.

## Question

Two concurrent bookings for the same Resource and overlapping time must not both succeed. Which mechanisms guarantee this across the databases and ORMs an Adapter would target, and what must an Adapter provide for a booking Action to be race-free?

## Short answer

- The Core is pure, so a booking Action is check-then-act: read the Resource's Bookings, ask the Core whether the slot is free, insert. Under the default isolation of PostgreSQL (Read Committed) and MySQL (Repeatable Read), two transactions can both read "free" and both insert. Something has to serialize them.
- **Strongest:** a PostgreSQL exclusion constraint, `EXCLUDE USING gist (resource_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (is_blocking)`. It holds against every writer, including SQL run outside the Framework. It only exists on PostgreSQL, and none of the three ORMs can declare it in their schema, so it ships as a raw-SQL migration.
- **Most portable:** serialize booking writes per Resource inside one interactive transaction. On PostgreSQL and MySQL, lock one row per Resource with `SELECT ... FOR UPDATE`, or take a PostgreSQL transaction-level advisory lock. On SQLite, `BEGIN IMMEDIATE` serializes all writers. This only protects writers that follow the same protocol.
- **Serializable isolation** also works (PostgreSQL SSI, SQLite always, MySQL by turning reads into share locks). It needs a retry loop, and it only protects transactions that actually run at Serializable.
- **Minimal Adapter capability:** "run this callback in one transaction that excludes every other booking write for the same `resourceId` until it commits", plus a typed conflict error and a classifier for retryable errors. A constraint in the database is an optional, stronger extra that an Adapter can add where it exists.

## 1. Why the naive Action races

A booking Action built on the Core does:

1. Load blocking Bookings for `resourceId` in the window.
2. Call the Core (`isSlotValid` / `detectConflicts`).
3. `INSERT` the new Booking.

- **PostgreSQL.** "Read Committed is the default isolation level in PostgreSQL ... a `SELECT` query (without a `FOR UPDATE/SHARE` clause) sees only data committed before the query began" ([PG §13.2](https://www.postgresql.org/docs/current/transaction-iso.html)). Two transactions both see no conflict, then both insert.
- **MySQL.** "In `READ COMMITTED` and `REPEATABLE READ`, a plain `SELECT` is a consistent read ... and sets no locks" ([MySQL 17.7.2.3](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html)). The manual's parent/child example states the same check-then-insert race directly: "some other session could delete the parent row in the moment between your `SELECT` and your `INSERT`" ([MySQL 17.7.2.4](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)).
- **Locking the existing Bookings with `SELECT ... FOR UPDATE` is not enough.** It locks "the rows retrieved by the `SELECT`" ([PG §13.3](https://www.postgresql.org/docs/current/explicit-locking.html)). The conflicting row does not exist yet, so there is nothing to lock. The lock has to sit on something that always exists (a Resource row or an advisory key), or the database has to enforce the rule itself.

## 2. PostgreSQL

### 2a. Exclusion constraint (declarative, strongest)

- An exclusion constraint "guarantees that if any two rows are compared on the specified column(s) or expression(s) using the specified operator(s), not all of these comparisons will return `TRUE`." The operators must be commutative, and in practice the index method is GiST or SP-GiST ([CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html)).
- Comparing the scalar `resource_id` with `=` inside a GiST index needs the `btree_gist` extension ([§8.17.10](https://www.postgresql.org/docs/current/rangetypes.html)). btree_gist covers `int2/4/8`, `numeric`, `timestamptz`, `uuid`, `text` and others. It is "trusted", so a non-superuser with `CREATE` on the database can install it ([F.8](https://www.postgresql.org/docs/current/btree-gist.html)).
- `tstzrange(a, b)` builds a lower-inclusive, upper-exclusive range (`[)`) ([§8.17.6](https://www.postgresql.org/docs/current/rangetypes.html)). Back-to-back Bookings (10:00–11:00 and 11:00–12:00) therefore do not conflict.
- The exclude element can be an expression, so the table can keep plain `starts_at` / `ends_at` columns that every ORM understands. No range column is needed:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE booking
  ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (is_blocking);
```

- **Soft states (cancelled Bookings).** `WHERE (predicate)` makes it a partial constraint: "an exclusion constraint on a subset of the table; internally this creates a partial index" ([CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html)). `WHERE (is_blocking)` matches GLOSSARY invariant 3 (statuses map to `isBlocking`). A Booking that leaves the predicate stops occupying the slot. A Booking that enters it again is checked again, because constraints are "checked immediately after every command" (non-deferrable default).
- **Limitations:**
  - The predicate can only use columns of the row itself. If the lifecycle stores "blocking" anywhere other than a column on the booking row, the constraint cannot see it.
  - It can only express capacity 1. Capacity N (out of scope in v0.1) cannot be expressed this way.
  - Exclusion constraints "are not supported as arbiters with `ON CONFLICT DO UPDATE`" ([INSERT](https://www.postgresql.org/docs/current/sql-insert.html)), so an upsert-style Action cannot use them.
  - A violation is SQLSTATE `23P01 exclusion_violation` ([Appendix A](https://www.postgresql.org/docs/current/errcodes-appendix.html)). The Adapter must map it to a typed booking-conflict error. PostgreSQL recommends testing the code, not the message.
- **PostgreSQL 18 `WITHOUT OVERLAPS`.** `UNIQUE (id, valid_at WITHOUT OVERLAPS)` "behaves like `EXCLUDE USING GIST (id WITH =, valid_at WITH &&)`". It needs a real range or multirange column, rejects empty ranges, and (per the grammar) has no `WHERE` clause ([CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html)). So it cannot skip cancelled Bookings, and plain `EXCLUDE ... WHERE` is the better fit.

### 2b. Serializable isolation (SSI)

- Serializable "monitors for conditions which could make execution of a concurrent set of serializable transactions behave in a manner inconsistent with all possible serial ... executions" and uses non-blocking predicate locks (`SIReadLock`) ([§13.2.3](https://www.postgresql.org/docs/current/transaction-iso.html)). The check-then-insert pattern is exactly the read/write dependency it detects. One transaction fails with `40001 serialization_failure`.
- "Applications using this level must be prepared to retry transactions due to serialization failures." Failures "always return with an SQLSTATE value of '40001'". The retry must re-run the whole transaction, including the read, and must not reuse results read in the aborted attempt.
- **Limitations:**
  - Only transactions running at Serializable take part. A writer at Read Committed (another service, an admin script) is not protected.
  - A sequential scan takes a relation-level predicate lock, which raises false-positive aborts. An index on `(resource_id, starts_at)` matters.
  - Contention on a busy Resource becomes retries instead of waiting.

### 2c. Per-Resource lock (pessimistic, cooperative)

- **Row lock.** `SELECT ... FROM resource WHERE id = $1 FOR UPDATE` blocks other `FOR UPDATE`/`UPDATE`/`DELETE` of that row "until the current transaction ends" ([§13.3.2](https://www.postgresql.org/docs/current/explicit-locking.html)). Every booking write for that Resource then runs one at a time, and the Core check plus insert are race-free at Read Committed.
  - Caveat: the Core treats `resourceId` as opaque, so the Framework may not own a resource table. The Adapter would need its own lock table (upsert a row per `resourceId`, then `FOR UPDATE` it), or an advisory lock.
  - Under Repeatable Read or Serializable, `FOR UPDATE` on a row that changed since the snapshot raises an error rather than waiting. Read Committed is the natural level for this pattern.
- **Advisory lock.** `pg_advisory_xact_lock(bigint)` "obtains an exclusive transaction-level advisory lock, waiting if necessary". It is released automatically at transaction end, with "no provision for manual release" ([§9.28.10](https://www.postgresql.org/docs/current/functions-admin.html)). No table is needed. The Adapter hashes `resourceId` to 64 bits. A collision only serializes two unrelated Resources and never breaks correctness.
  - Use the transaction-level variant. Session-level advisory locks "do not honor transaction semantics" and survive rollback ([§13.3.5](https://www.postgresql.org/docs/current/explicit-locking.html)), which is dangerous with pooled connections.
  - Note: the single-key and two-key (`int4, int4`) key spaces do not overlap.
- **Deadlocks.** PostgreSQL detects them and aborts one transaction (`40P01`). The fix is "acquire locks on multiple objects in a consistent order" ([§13.3.4](https://www.postgresql.org/docs/current/explicit-locking.html)). This matters for future multi-Resource bookings: lock `resourceId`s in sorted order.

## 3. MySQL (InnoDB)

- **No exclusion constraint.** MySQL has no `EXCLUDE` or range types. The rule can only be enforced by locking.
- **Locking read on a Resource row.** `SELECT ... FOR UPDATE` locks the row "the same as if you issued an `UPDATE`". Locks are "released when the transaction is committed or rolled back", and locking reads require autocommit off ([17.7.2.4](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)). This is the same pattern as PostgreSQL 2c.
- **Locking the Bookings range.** Under Repeatable Read (the InnoDB default), a locking read with a range condition "locks the index range scanned, using gap locks or next-key locks to block insertions by other sessions into the gaps covered by the range" ([17.7.2.1](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)). So `SELECT ... WHERE resource_id = ? AND starts_at < ? FOR UPDATE` on an index over `(resource_id, starts_at)` also blocks phantom inserts. It is coarser and harder to reason about than a single Resource-row lock.
- **SERIALIZABLE.** InnoDB "implicitly converts all plain `SELECT` statements to `SELECT ... FOR SHARE` if autocommit is disabled" ([17.7.2.1](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)). Two concurrent Actions both take share and gap locks, then both try to insert. The usual outcome is a deadlock that rolls one back. It is correct but surfaces as deadlock errors that need a retry.
- **Named locks.** `GET_LOCK(name, timeout)` is server-wide and exclusive, but "not released when transactions commit or roll back", only by `RELEASE_LOCK()` or session end. Names are at most 64 characters ([14.14](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html)). With connection pools this is error-prone. Prefer the row-lock pattern.

## 4. SQLite

- "There can only be a single writer at a time to an SQLite database" and "all transactions in SQLite show 'serializable' isolation ... by actually serializing the writes" ([isolation](https://www.sqlite.org/isolation.html)). Correctness comes for free if the read and the insert are in the same transaction.
- **The catch is `BEGIN` (DEFERRED).** It starts as a read transaction, and the later write "will upgrade the transaction to a write transaction if possible, or return SQLITE_BUSY" ([lang_transaction](https://www.sqlite.org/lang_transaction.html)). This is safe but noisy: the loser gets `SQLITE_BUSY` and must retry. `BEGIN IMMEDIATE` "start[s] a new write immediately", so concurrent Actions queue on the write lock (with a busy timeout) instead of failing late. In WAL mode, IMMEDIATE and EXCLUSIVE are the same.
- **Declarative option.** SQLite has no exclusion constraint. A `BEFORE INSERT` (and `BEFORE UPDATE`) trigger can `SELECT RAISE(ABORT, ...)` when an overlapping blocking row exists, which returns `SQLITE_CONSTRAINT` ([CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html)). Because SQLite writers are serialized, this trigger is a real database-level guarantee. The same trick in MySQL would not be safe, because a plain `SELECT` there is a non-locking consistent read (§3).
- **Test caveat.** An in-memory or single-connection SQLite setup serializes everything in the driver, so it cannot show a race. Concurrency tests need a file database opened by several connections.

## 5. What each ORM exposes

Versions checked: Prisma ORM 7.10.1 (`prev`, fully supported) and 8.0.0-rc.33 (`latest`, release candidate); drizzle-orm 0.45.4 (`latest`; 1.0.0-rc.5 also checked); kysely 0.29.8.

| | Interactive transaction | Isolation level | Row lock (`FOR UPDATE`) | SQLite begin mode | Exclusion constraint in schema / migrations |
|---|---|---|---|---|---|
| **Prisma 7** | `$transaction(async tx => ...)` with `maxWait`, `timeout` | `isolationLevel` option (PG, MySQL, SQL Server; SQLite and CockroachDB are Serializable only) | No query-builder API. Use `$queryRaw` | Not configurable in docs | Feature matrix: `EXCLUDE` is "Not yet" in schema and Migrate. Use `migrate dev --create-only`, then hand-edit `migration.sql` |
| **Prisma 8 (RC)** | `db.transaction(async tx => ...)`, callback only | No option. Run `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` as the first statement | Not documented. Raw SQL via `tx.raw` / `tx.execute` | Not documented | Not in the contract. Use a `rawSql` step in a TypeScript migration (`migration new`) |
| **Drizzle** | `db.transaction(async tx => ...)`, savepoints for nested | PG and MySQL `isolationLevel`, `accessMode` (+ PG `deferrable`, MySQL `withConsistentSnapshot`) | `.for('update' \| 'no key update' \| 'share' \| 'key share', { noWait \| skipLocked, of })` on PG and MySQL selects | `behavior: 'deferred' \| 'immediate' \| 'exclusive'` | Not in pg-core (no `exclude`, no range column type). Use `drizzle-kit generate --custom` |
| **Kysely** | `db.transaction().execute(trx => ...)`, plus `startTransaction()` (controlled) | `.setIsolationLevel(...)`, `.setAccessMode(...)` | `.forUpdate()`, `.forShare()`, `.noWait()`, `.skipLocked()` | Built-in `SqliteDriver` issues plain `begin` (deferred) | No `exclude` builder. Migrations are TS functions, so ``sql`...`.execute(db)`` |

Sources:

- **Prisma 7:** [transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions), [database features](https://www.prisma.io/docs/orm/v7/reference/database-features), [unsupported features](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/unsupported-database-features).
  - Write conflicts and deadlocks surface as `P2034`. Prisma recommends Serializable plus a retry on `P2034`.
- **Prisma 8:** [transactions](https://www.prisma.io/docs/orm/fundamentals/transactions), [advanced PostgreSQL](https://www.prisma.io/docs/orm/contract-authoring/advanced-postgresql).
  - Supported databases are "PostgreSQL, SQLite, and MongoDB. MySQL is an early preview that reads data."
  - "Prisma ORM does not retry write conflicts for you". The docs' retry wrapper checks `sqlState` `40001` / `40P01`.
- **Drizzle:** [transactions](https://orm.drizzle.team/docs/transactions), [SQLite transactions](https://orm.drizzle.team/docs/sqlite/transactions), [MySQL transactions](https://orm.drizzle.team/docs/mysql/transactions), [indexes and constraints](https://orm.drizzle.team/docs/indexes-constraints), [custom migrations](https://orm.drizzle.team/docs/kit-custom-migrations).
  - The `for()`, `LockStrength` and `LockConfig` signatures come from the published `pg-core` / `mysql-core` `select.d.ts`.
  - The better-sqlite3 session passes `behavior` to the driver's `transaction()[behavior]`.
- **Kysely:** [transactions](https://kysely.dev/docs/examples/transactions/simple-transaction). The other entries come from the published `kysely.d.ts`, `select-query-builder.d.ts`, `create-table-builder.d.ts` and `dialect/sqlite/sqlite-driver.js`.

Consequences for the Framework:

- All three ORMs give an interactive transaction, which is the one thing every strategy needs.
- Drizzle and Kysely expose row locks natively. Prisma needs raw SQL for them.
- On PostgreSQL, advisory locks are raw SQL everywhere (`SELECT pg_advisory_xact_lock($1)`).
- No ORM can declare an exclusion constraint. In every case it is a hand-written SQL migration that the Framework would ship (or print) for the developer's database.

## 6. What an Adapter must provide

**Minimal capability (required).**

```ts
// Shape only, not a proposal for names.
withResourceWriteLock<A>(resourceId: string, fn: (tx: Tx) => Promise<A>): Promise<A>
```

Semantics:

1. **One transaction.** `fn` runs inside one database transaction. Reads and writes go through `tx`, and the transaction commits only if `fn` resolves.
2. **Mutual exclusion per Resource.** No other `withResourceWriteLock` for the same `resourceId` can read-then-commit in between. Ways to do it:
   - PostgreSQL: advisory xact lock or `FOR UPDATE` on a Resource or lock row.
   - MySQL: `FOR UPDATE` on a Resource or lock row.
   - SQLite: `BEGIN IMMEDIATE`.
   - Alternatively, run the transaction at Serializable and retry.
3. **Error classification.** The Adapter separates "retry the whole callback" from "real conflict":
   - Retry: PG `40001` / `40P01`, MySQL deadlock, SQLite `SQLITE_BUSY`, Prisma 7 `P2034`.
   - Conflict: PG `23P01`, a SQLite trigger's `SQLITE_CONSTRAINT`. The Framework maps these to one typed booking-conflict error.

Every Action that changes whether a Booking blocks a time range must go through this. That covers create, reschedule (exclude the Booking being moved from the conflict check), and re-activate (cancelled to blocking). Cancel only frees time, so it is safe without the lock, but it is simpler to route it the same way.

**Optional capability (stronger).** The Adapter can install a database-level invariant: the PostgreSQL `EXCLUDE ... WHERE (is_blocking)`, or a SQLite trigger. This also protects against writers that bypass the Framework, and turns a bug in the lock protocol into a constraint error instead of a double-booking. It cannot express capacity > 1 and depends on `is_blocking` being a column on the booking row.

### Options ranked

By **strength** (what still holds if someone misbehaves):

1. **PG exclusion constraint.** Enforced for every writer at every isolation level.
2. **SQLite trigger.** Enforced for every writer, because SQLite has a single writer.
3. **Serializable plus retry.** Holds for every Serializable transaction. Lower-isolation writers are unprotected.
4. **Per-Resource lock** (row or advisory). Holds only for writers that take the lock.

By **portability** (how many targets share one implementation):

1. **Per-Resource lock in an interactive transaction.** Same idea on PG, MySQL (`FOR UPDATE`) and SQLite (`BEGIN IMMEDIATE`). Native in Drizzle and Kysely, raw SQL in Prisma. Also generalizes to capacity N (count overlaps under the lock).
2. **Serializable plus retry.** Available everywhere, but behaves differently on each engine: PG aborts with `40001`, MySQL deadlocks, SQLite is always serializable. Prisma 8 has no isolation option. Throughput falls on hot Resources.
3. **SQLite trigger.** SQLite only.
4. **PG exclusion constraint.** PostgreSQL only, and a raw-SQL migration in every ORM.

**Suggested direction (input for the grilling ticket, not a decision):**

- Make the per-Resource lock the Adapter contract, since it is portable and works with every ORM.
- Have the PostgreSQL Adapter also ship the exclusion constraint as a recommended migration, mapping `23P01` to the same conflict error.
- Keep Serializable as a fallback for Adapters that cannot lock.

## 7. How to test the guarantee

Tests run against a real database for each Adapter, never a mock, consistent with the map's "integration tests against a real Adapter".

1. **Race test.** Fire N (for example 20) `createBooking` calls in parallel for the same Resource and overlapping times. Use a connection pool of at least N, and a file-backed database with several connections for SQLite. Assert exactly one success and N−1 typed conflicts. Repeat for many iterations, because a race that is lost only 1% of the time needs repetitions.
2. **Deterministic interleaving.** A test-only seam (a hook between "Core check" and "insert") lets the test hold transaction A after its read, start transaction B, then release A. Without the lock, both commit. With the lock, B blocks or fails. This turns a flaky race into a deterministic test.
3. **Mutation check.** Run the same suite against an Adapter variant with the lock disabled (and no constraint), and assert that the suite fails. This proves the test can detect a double-booking.
4. **Property test.** fast-check is already a dev dependency. Generate random sets of `(resourceId, interval, isBlocking)` operations, including reschedules and cancel/re-activate, and run them concurrently. Afterwards, query the database for any pair of blocking Bookings on the same Resource whose intervals overlap (a self-join with `a.starts_at < b.ends_at AND b.starts_at < a.ends_at`). The invariant is zero rows. Also check that every rejected request really did overlap a committed Booking (no false conflicts).
5. **Constraint backstop test (PG).** Insert overlapping rows with raw SQL, bypassing the Framework, and assert `23P01`. Assert that two adjacent `[)` intervals are accepted, and that a cancelled (`is_blocking = false`) overlap is accepted.
6. **Retry path.** For Serializable or SQLite-deferred Adapters, force a `40001` / `SQLITE_BUSY` and assert that the Action retries and then either succeeds or reports a conflict. It must never surface the raw driver error.
