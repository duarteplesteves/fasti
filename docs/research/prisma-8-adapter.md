# Research: can Prisma 8 implement the Adapter contract?

Ticket: #21 (map: #2). Builds on ADR 007 (hybrid schema ownership) and ADR 008 / the resolution of #10 (the Adapter contract).

Researched 2026-11-10 against:

- the `prisma/orm` source at tag [`v8.0.0-rc.23`](https://github.com/prisma/orm/tree/v8.0.0-rc.23) (commit `557c0d4`), including the docs, scorecard and `prisma-8` agent skill shipped in that tag;
- prisma.io docs and the npm registry;
- the SQLite, Node.js and PostgreSQL docs.

SQLite lock behaviour was also checked by experiment (SQLite 3.51.0, through Python's `sqlite3` and Bun 1.4.4's `node:sqlite`, see the appendix). Nothing was run against Prisma 8 itself or against a PostgreSQL server; claims about those come from source and docs only.

Versions: the `prisma` CLI's npm `latest` is `8.0.0-rc.33` (published 2026-11-06 from `prisma/prisma-cli`). The ORM packages (`@prisma/orm-postgres`, `@prisma/orm-sqlite`, …) are at `8.0.0-rc.23` (tag 2026-11-06). Prisma 7 is the `prev` tag, `7.10.1`.

## Question

Can a first-party Prisma 8 Adapter implement the Adapter contract (ADR 008), and how does a Prisma user get the schema without a CLI (ADR 007)?

## Short answer

- **Prisma 8 is not Prisma 7 with new numbers.** It is a TypeScript rewrite ([README L23](https://github.com/prisma/orm/blob/v8.0.0-rc.23/README.md#L23)). There is no `$executeRaw`, no `schema.prisma`, no generators, and no `migrate dev --create-only`. Each question below is answered in Prisma 8's own terms: `db.transaction(fn)`, `tx.raw.sql`, a "contract" in `contract.prisma` or `contract.ts`, and `prisma migration …` commands.
- **Postgres lock: feasible.** `SELECT pg_advisory_xact_lock(…)` runs as raw SQL through `tx` on the one connection the transaction holds. Postgres releases it at `COMMIT` or `ROLLBACK`, and Prisma always ends the transaction one way or the other, or destroys the connection.
- **SQLite lock: feasible with caveat.** Prisma 8 always sends a deferred `BEGIN`, and `db.transaction` takes no options, so `BEGIN IMMEDIATE` is impossible. The same single-writer behaviour comes from making the first statement a write that changes no rows. The driver is synchronous `node:sqlite` with a 5-second busy timeout, though, so a waiting writer blocks the whole event loop. In one process, that stalls every contended booking for about 5 s. The Adapter must set `busy_timeout = 0` for that first write and retry with an async back-off.
- **Schema delivery: feasible with caveat.** There are two routes, and both work without a CLI. Prisma 8 has no generator hook, and no way for a package to inject models that vary per app.
  - **`contract.ts` users:** fasti exports a function that builds Prisma 8 `model(…)` values from `defineSchema`, and the developer adds them to their contract.
  - **`contract.prisma` users:** a fasti-rendered `.prisma` file goes in the schema folder (Prisma 8 reads a glob of files), checked by a test.
- **Backstop: feasible.** `EXCLUDE` can't be declared in the contract. It ships as a hand-written `rawSql` operation in a `prisma migration new` package, which `db migrate` applies inside its one transaction. `db verify` tolerates it unless run with `--strict`.
- **Status: still an RC.** At rc.23, the README expects `8.0.0` final "in the next four to eight weeks". The docs' "October 2026" has already passed. The four databases are at different maturity:
  - **PostgreSQL:** release candidate.
  - **MongoDB:** early access, with no `db.transaction`.
  - **MySQL:** early preview.
  - **SQLite:** "experimental" in the docs, "a proof of concept today" in the README.
  - **Drivers:** each target has one driver (`pg`, `node:sqlite`, `mongodb`, `mariadb`). Prisma 7's driver adapters are gone.

## 1. Lock on Postgres

**What Prisma 8 offers.**

- **The transaction API.** `db.transaction(async (tx) => …)` is the only form. It commits when the callback returns and rolls back when it throws ([transactions docs](https://www.prisma.io/docs/orm/fundamentals/transactions)).
  - It has no `isolationLevel`, `timeout` or `maxWait` option, and no savepoints ([scorecard: transactions](https://github.com/prisma/orm/blob/v8.0.0-rc.23/scorecard/14-transactions.md)).
  - Prisma ORM does not retry write conflicts. Errors carry `sqlState`, on the error or on its `cause` ([transactions docs](https://www.prisma.io/docs/orm/fundamentals/transactions)).
- **`tx` members.** `tx` offers `sql`, `orm`, `raw`, `prepare`, `query` (rows) and `execute` (affected count). The docs show raw SQL in a transaction as ``tx.execute(tx.raw.sql`UPDATE …`.affectedCount().build())`` ([runtime reference L358–L375](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/runtime.md#L358-L375)). This is Prisma 8's `$executeRaw`.
- **One connection per transaction.** The runtime takes one connection and begins the transaction on it ([`withTransaction`](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/5-runtime/src/sql-runtime.ts#L1802-L1981)). The Postgres driver sends a plain `BEGIN` on that pinned `pg` connection ([postgres-driver.ts L553–L560](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/postgres/3-driver/src/postgres-driver.ts#L553-L560)).
- **A `SELECT` runs through `execute`.** The driver's `execute` passes any SQL to `pg`'s `client.query` and returns `rowCount` ([L284–L297](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/postgres/3-driver/src/postgres-driver.ts#L284-L297)). A row-returning `SELECT pg_advisory_xact_lock(…)` therefore works with `.affectedCount()`. `tx.query(… .returnsRow({…}).build())` is the alternative.
- **Parameter types.** Interpolated JS values become parameters. A safe integer in int4 range is typed `pg/int4@1` and a string `pg/text@1` ([Postgres adapter `inferCodec`](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/postgres/2-adapter/src/core/adapter.ts)). So `pg_advisory_xact_lock(${ns}, hashtext(${resourceId}))` binds `(int4, text)` without a cast.

```ts
// Sketch: inside the Prisma Postgres Adapter's withResourceLock
await db.transaction(async (tx) => {
  await tx.execute(
    tx.raw.sql`SELECT pg_advisory_xact_lock(${FASTI_LOCK_NS}, hashtext(${resourceId}))`
      .affectedCount()
      .build(),
  );
  return work(makeAdapterTx(tx)); // every read and write goes through tx
});
```

**Release at commit or rollback.**

- `pg_advisory_xact_lock` is released automatically when the transaction ends, and has no manual release ([PostgreSQL §9.28.10](https://www.postgresql.org/docs/current/functions-admin.html)).
- Prisma ends every transaction:
  - It runs `ROLLBACK` when the callback throws.
  - It runs `COMMIT` when the callback resolves.
  - After a failed `COMMIT`, it tries a `ROLLBACK` and throws `RUNTIME.TRANSACTION_COMMIT_FAILED` with the database error as `cause` ([sql-runtime.ts](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/5-runtime/src/sql-runtime.ts#L1921-L1975)).
  - If the `ROLLBACK` itself fails, it destroys the connection, and `pg-pool` evicts it instead of reusing it ([owned-transaction.ts L6–L8](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/5-runtime/src/owned-transaction.ts#L6-L8), [postgres-driver.ts L585–L599](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/postgres/3-driver/src/postgres-driver.ts#L585-L599)). Closing the session releases the lock too.
- So the lock can't leak back into the pool.

**Caveats.**

- **No transaction timeout.** Prisma 8 has none, so a slow `work` holds the lock for as long as it runs. The docs point to Postgres's own `idle_in_transaction_session_timeout` or `transaction_timeout` ([transactions docs](https://www.prisma.io/docs/orm/fundamentals/transactions)). Unlike Prisma 7, there is no 5-second interactive-transaction cap that could abort a booking.
- **Everything inside goes through `tx`.** A query sent through `db` inside the callback may run inside the open transaction without saying so, or hang waiting for the connection the transaction holds ([runtime reference L172](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/runtime.md#L172)). The Adapter controls this, since `work` only sees `AdapterTx`.
- **Untested surface.** Prisma's own scorecard (headed "RC1") marks the statement-level `raw` tag as untested on Postgres and SQLite ([scorecard: raw SQL](https://github.com/prisma/orm/blob/v8.0.0-rc.23/scorecard/13-raw-and-typed-sql.md)). The Conformance Suite would be the first real test of this path.
- **Error classification.** Retry on `sqlState` `40001` / `40P01`, and map `23P01` (the backstop) to `conflict`. The Postgres driver normalizes `pg` errors to `SqlQueryError` with `sqlState` ([errors.ts](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/1-core/errors/src/errors.ts)).

**Verdict: feasible.**

## 2. Lock on SQLite

**What the Prisma 8 SQLite driver does** ([sqlite-driver.ts](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/sqlite/3-driver/src/sqlite-driver.ts)):

- It uses Node's built-in `node:sqlite` (`DatabaseSync`) (L1).
- Every connection runs `PRAGMA foreign_keys = ON` and `PRAGMA busy_timeout = 5000` (L53–L62).
- Each transaction gets a **new connection** to the database file (`acquireConnection`, L206–L209). The connection is closed when the transaction releases it (L121–L131).
- `beginTransaction` sends a plain **`BEGIN`**, which is deferred (L111–L119).
- `db.transaction(fn)` takes only the callback (`SqliteClient.transaction`, [sqlite.ts L121–L123](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/sqlite/9-facade/src/runtime/sqlite.ts#L121-L123)). The binding is only `{ path }` ([binding.ts](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/sqlite/9-facade/src/runtime/binding.ts)). There is no knob for the begin mode.
- `SQLITE_BUSY` / `SQLITE_LOCKED` surface as `SqlConnectionError` with `transient: true`, and the `node:sqlite` error as `cause` ([normalize-error.ts L98–L103](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/sqlite/3-driver/src/normalize-error.ts#L98-L103)).

**So `BEGIN IMMEDIATE` is not reachable.** Sending it from inside the callback fails with "cannot start a transaction within a transaction" (appendix, experiment 5).

**What a deferred `BEGIN` does.**

- After a deferred `BEGIN`, "if the first statement … is a SELECT, then a read transaction is started. Subsequent write statements will upgrade the transaction to a write transaction if possible, or return SQLITE_BUSY. If the first statement … is a write statement, then a write transaction is started" ([SQLite: BEGIN](https://www.sqlite.org/lang_transaction.html)).
- The busy handler is skipped when waiting could deadlock: "SQLite will go ahead and return SQLITE_BUSY … instead of invoking the busy handler" ([sqlite3_busy_handler](https://www.sqlite.org/c3ref/busy_handler.html)).

Measured with two connections (appendix, experiments 1–4; same result in rollback-journal and WAL mode):

| Situation | Result |
|---|---|
| First statement is a write that changes no rows (`UPDATE booking SET id = id WHERE 0`) | Takes the write lock. A second writer gets `SQLITE_BUSY`. |
| Read first, then a write while another connection holds the write lock | `SQLITE_BUSY` at once (0 ms), even with a 2 s busy timeout |
| WAL: read first, another connection commits, then write | `SQLITE_BUSY` at once (stale snapshot) |
| First statement is a write while another connection holds the write lock | Waits the full busy timeout (2,083 ms for 2,000 ms), then `SQLITE_BUSY` |

**The catch: `node:sqlite` is synchronous.**

- "All APIs exposed by this class execute synchronously" ([Node.js `node:sqlite`](https://nodejs.org/api/sqlite.html)), so the busy wait blocks the event loop.
- With Prisma's 5,000 ms timeout, one Node process with two contending bookings deadlocks with itself for 5 s. The waiter blocks the thread, so the lock holder can't run its `COMMIT` until the waiter gives up.
- The appendix reproduces Prisma's driver setup with Bun's `node:sqlite`. Two concurrent works on one Resource, 50 ms of "checks" each:

| Strategy | Outcome | First booking committed at |
|---|---|---|
| **Deferred `BEGIN`, retry the whole work on busy** | Correct: 1 booked, 1 conflict. B ran its read and checks alongside A, then failed at its write and retried. | 52 ms |
| **Zero-row write first, Prisma's 5 s busy timeout** | Correct, but **the process stalled ~5.2 s** | 5,278 ms |
| **`PRAGMA busy_timeout = 0`, zero-row write first, async retry** | Correct. B never started its work until A committed. | 53 ms |

**What the SQLite Adapter can do.**

1. **Recommended: lock first, never wait synchronously.** Inside `db.transaction`:
   1. Run ``tx.query(tx.raw.sql`PRAGMA busy_timeout = 0`.returnsRow({…}))``. A PRAGMA returns a row, and the driver's `execute` refuses row-returning statements ([L82–L96](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/sqlite/3-driver/src/sqlite-driver.ts#L82-L96)).
   2. Run a write that changes no rows on the bookings table.
   3. On `SqlConnectionError` with `transient: true`, let the transaction roll back, wait asynchronously (`setTimeout` with jitter), and start a new `db.transaction`. A busy start costs nothing, because `work` has not run yet.
   4. Once the lock is held, set `busy_timeout` back to 5000, so that a `COMMIT` in rollback-journal mode can still wait for readers.

   This gives the same promise as `BEGIN IMMEDIATE`: `work` never interleaves, so the Conformance Suite's "N parallel works never interleave" check holds as written.
2. **Alternative: deferred `BEGIN` plus retry of the whole work.** Also race-free, because SQLite serializes writers. But `work`, including developer policies, runs alongside another work and is then thrown away, so it can run more than once. The interleaving check would fail on aborted attempts. A work whose first statement is a write (for example `replaceRules`) can still hit the 5 s stall.

**Other caveats.**

- **No `:memory:` tests.** Each transaction opens a new `DatabaseSync(path)`, so with `:memory:` every transaction would see a fresh, empty database. This is inferred from the source, not run. The Conformance Suite must use a file database, which it needs anyway to show a race.
- **Renamed tables in raw SQL.** Raw-template interpolations are values (expressions, parameters or literals), not identifiers ([expression.ts L337](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/4-lanes/relational-core/src/expression.ts#L337)). The zero-row write, and every query on a table whose name comes from `defineSchema`, must go through `tx.sql` / `tx.orm` keyed by that name. Whether the raw tag accepts a hand-built template array is unverified.
- **Maturity.** Prisma's SQLite target is "experimental" ([supported databases](https://www.prisma.io/docs/orm/supported-databases)) and "a proof of concept today" ([README L101](https://github.com/prisma/orm/blob/v8.0.0-rc.23/README.md#L97-L103)). Migration authoring is documented as first-class only for Postgres and MongoDB ([migrations reference L14](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/migrations.md#L14)).

**Verdict: feasible with caveat.** No `BEGIN IMMEDIATE`. A zero-row first write gives the same single-writer behaviour, but only with `busy_timeout = 0` and an async retry, because the driver is synchronous. Prisma's SQLite support itself is experimental.

## 3. Schema delivery without a CLI

**What a Prisma 8 "schema" is.**

- There is no `schema.prisma` and no `generator` block. The developer edits a **contract source**: `contract.prisma` (PSL, "the canonical surface") or `contract.ts` (a TypeScript builder). `prisma contract emit` writes `contract.json` and `contract.d.ts` from it ([contract reference L6–L17, L45–L49](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/contract.md#L6-L49)).
- The config takes **one** `contract` path. A `.ts` path goes to the TypeScript provider; anything else goes to PSL ([sqlite define-config.ts L31–L47](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/sqlite/9-facade/src/config/define-config.ts#L31-L47); Postgres is the same).
- I found no code-generation hook. In the PSL interpreter, "generator" means a value generator such as `@onCreate(uuid())` ([contract-psl README](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/2-authoring/contract-psl/README.md)). That there is none is an inference from the docs and source, not a stated fact.

**Option A: a TypeScript builder function (for `contract.ts` users). Feasible.**

- Prisma 8 models are plain values: `const User = model('User', { fields: {…} }).sql({ table: 'app_user' })`, then `models: { User }` ([contract-ts README L84–L127](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/2-authoring/contract-ts/README.md#L84-L127)).
- Columns are renamed with `field.column(…).column('org_id')` ([L246–L256](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/2-authoring/contract-ts/README.md#L246-L256)).
- The docs recommend `contract.ts` for "programmatic composition (per-tenant variants, generated fields)" ([contract reference L47](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/contract.md#L47)).
- So fasti can export something like `prismaModels(schema, { field, model, type, gen })`. It returns `Booking` and `AvailabilityRule` with the physical names, the `resourceId` type, Developer Fields and indexes taken from `defineSchema`. The developer spreads the result into `defineContract`'s `models`.
- Pass the helpers in rather than importing them: on SQLite, `type` and `gen` exist only inside the `defineContract` callback ([sqlite facade README](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/sqlite/9-facade/README.md); [contract reference L199](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/contract.md#L199)).
- There is no codegen and no CLI, and the developer's own `prisma contract emit` and migration commands do the rest.
- Cost: it reaches only developers who author `contract.ts`, and fasti's code depends on a builder API that still changes between RCs.

**Option B: a `.prisma` file checked by a test (for `contract.prisma` users). Feasible.**

- The PSL provider accepts a **glob**. It reads every matching file that starts with `// use prisma-8` and merges them into one schema ([contract-psl provider.ts L35–L75, L113–L171](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/2-authoring/contract-psl/src/provider.ts#L35-L171)).
- So a developer can set `contract: './src/prisma/*.prisma'` and keep a `fasti.prisma` next to their own file. Renames are `@@map` / `@map`.
- fasti can export a pure function that renders that file's text from `defineSchema`, plus a test helper that fails when the checked-in file differs and prints the expected text. A stronger version checks the emitted `contract.json`, the canonical machine-readable form, against `defineSchema`. That also covers hand-edited models.
- This is copy-paste with a guard, run by the developer's test runner. It is not a CLI.

**Option C: a fasti contract space (an extension pack). Not suitable.**

- A package can own a "contract space": its own `contract.json` and migration graph, applied by the app's `db migrate` (Supabase's `auth` tables work this way; [ADR 212 L50–L56, L88](https://github.com/prisma/orm/blob/v8.0.0-rc.23/docs/architecture%20docs/adrs/ADR%20212%20-%20Contract%20spaces.md#L50-L88)).
- The space's contract and migrations are emitted when the *package* is built, so they are fixed at publish time. They can't carry one app's renames, `resourceId` type or Developer Fields.
- "Spaces … integrate only via the live database", and the app reaches another space's models only through cross-space relations ([contract reference L436–L456](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/contract.md#L436-L456)). That contradicts ADR 007.

**Things that hold for A and B.**

- **The contract doesn't record renames.** When a fasti release renames a logical column, the planner sees a drop plus an add. The developer must pass `--rename Booking.old:Booking.new` to `migration plan` ([contract reference L518, L523](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/contract.md#L518-L523)). The changelog has to say so, which matches ADR 007's "flagged in the changelog".
- **Temporal fits.** `DateTime(as: temporal)` reads and writes `Temporal.Instant`.
  - On Postgres, `DateTime` is `timestamptz(3)`, which is millisecond precision and matches ADR 008's millisecond round-trip. On SQLite it is text with milliseconds.
  - It needs a global `Temporal` (Node 26.8.2+, or a polyfill) ([contract reference L122–L124](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/contract.md#L122-L124)).

**Verdict: feasible with caveat.** There is no generator hook and no way to inject a model that varies per app. fasti delivers models either as builder values (`contract.ts`) or as a rendered `.prisma` file in a glob-loaded folder, guarded by a test (`contract.prisma`).

## 4. Backstop: shipping `EXCLUDE` with Prisma 8 migrations

- **No `--create-only`.** Prisma 7's `migrate dev` and the rest answer `CLI.COMMAND_MOVED`. `migrate dev` becomes `contract emit`, then `migration plan`, then `db migrate` ([migrations reference L594](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/migrations.md#L594)).
- **The contract can't declare it.**
  - `@@check` / `check()` declare only `CHECK` constraints ([contract reference L356–L377](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/contract.md#L356-L377)).
  - `@@index(type: …)` declares indexes, not exclusion constraints.
  - I found no `EXCLUDE` support in the contract surface.
- **The route.**
  1. `prisma migration new --name booking_no_overlap` renders an empty migration package.
  2. In its `operations` getter, add the `btree_gist` extension (`this.installExtension(…)` / `createExtension(…)`) and a `rawSql({ id, label, operationClass, target, precheck, execute, postcheck })` operation with the `ALTER TABLE … ADD CONSTRAINT … EXCLUDE USING gist (…) WHERE (is_blocking)` ([migrations reference L390–L409](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/migrations.md#L390-L409)).
  3. Run `node <package dir>/migration.ts` to re-emit `ops.json` and `migration.json`, then `prisma db migrate`.
- **Writing the postcheck.** "The runner runs an operation's postchecks first and skips the operation when they all hold", so the postcheck should look for the constraint in `pg_constraint`, or be left empty (L409).
- **Atomicity.** On Postgres, one `db migrate` run is one transaction, and "`rawSql(...)` steps are ordinary steps inside it and roll back with the rest" ([L49, L521](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/migrations.md#L49)).
- **Verification.** `db verify` allows schema objects the contract doesn't declare by default. `--strict` reports them as errors ([L442–L447](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/migrations.md#L442-L447)).
- **fasti can't ship the package itself.** It is rendered into the developer's `migrations/app/` and names their contract snapshots by hash. fasti documents the snippet to paste, generated from `defineSchema` so it uses the developer's table and column names.
  - A migrations-only contract space, like ParadeDB's (ADR 212), would be fixed at publish time, so it can't follow renames.
- **Mapping the violation.** A violation surfaces as `sqlState` `23P01` and maps to `{ ok: false, reason: "conflict" }`.

**Unverified.**

- Whether `db update`, the dev path that diffs the live database, would ask to drop an undeclared constraint. The `@@check` docs say a hand-added constraint used to look "like an undeclared extra a destructive migration could drop" ([contract reference L358](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/contract.md#L358)). The Conformance Suite's backstop group would catch a dropped constraint.
- The exact `rawSql` signature: check the installed `@prisma/orm-postgres/migration` `.d.ts` when writing the snippet.

**Verdict: feasible.** It is a hand-written `rawSql` migration, as in every ORM ([double-booking research](https://github.com/duarteplesteves/better-schedule/blob/research/double-booking/docs/research/double-booking.md)).

## 5. Status

- **Still an RC.** "Prisma 8 is a release candidate. `8.0.0` final is expected in the next four to eight weeks. Until then a release candidate may include breaking changes" ([README L21](https://github.com/prisma/orm/blob/v8.0.0-rc.23/README.md#L21), tag 2026-11-06, so roughly early December 2026 to early January 2027).
  - The docs' [release status](https://www.prisma.io/docs/orm/release-status) page (modified 2026-11-09) still says "General availability is expected in October 2026", which has passed.
  - Every RC ships breaking changes with upgrade recipes. rc.23 alone renamed scalar types and column helpers ([rc.23 release notes](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.23)).
  - The earliest RC on npm is `8.0.0-rc.3`, from 2026-08-17.
- **Prisma 7.** It is maintained for 18 months after `8.0.0` final ([README L19](https://github.com/prisma/orm/blob/v8.0.0-rc.23/README.md#L19)).
- **Databases** ([supported databases](https://www.prisma.io/docs/orm/supported-databases); [README L97–L103](https://github.com/prisma/orm/blob/v8.0.0-rc.23/README.md#L97-L103); [Supported Versions](https://github.com/prisma/orm/blob/v8.0.0-rc.23/docs/Supported%20Versions.md)):

| Database | Status | Package | Driver (from source) | Floor |
|---|---|---|---|---|
| PostgreSQL | Release candidate, "first-class" | `@prisma/orm-postgres` | `pg` (`pg.Pool` from a URL, your own `pg.Pool`/`pg.Client`, or `postgresServerless()` per request, for example Workers + Hyperdrive) | PG 15 |
| MongoDB | Early access. No `db.transaction` | `@prisma/orm-mongo` | `mongodb` | 8.0 |
| MySQL | Early preview. ORM writes arrived in rc.23 | `@prisma/orm-mysql` | `mariadb` | not stated (the docs say DDL is checked "against MySQL 8.4") |
| SQLite | Experimental, "a proof of concept today" | `@prisma/orm-sqlite` | `node:sqlite`, file path only | none stated |
| MariaDB, SQL Server, CockroachDB | Coming soon | none | none | none |

- **Driver adapters.** I found no Prisma 7-style driver adapters (`adapter-neon`, `adapter-libsql`, `adapter-d1`, `adapter-better-sqlite3`). Each target has one driver.
  - Cloudflare D1 exists only as a [plan document](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/sqlite/2-adapter/D1-Support-Plan.md). It notes D1 has "no interactive transactions", which matches ADR 008's reason to exclude D1.
- **Runtime.**
  - Node.js 24+ is required. Bun 1.2+ and Deno 2.0+ are best-effort.
  - It is ESM-only and needs TypeScript 5.9+ with `moduleResolution: "bundler"` ([Supported Versions](https://github.com/prisma/orm/blob/v8.0.0-rc.23/docs/Supported%20Versions.md)).
  - The CLI's `engines` field is `^22.18.0 || ^24.11.0 || >=26.0.0` (npm `prisma@8.0.0-rc.33`).

**Verdict: not stable yet.** Postgres is the only Prisma 8 database at release-candidate maturity.

## Suggested direction (input for the next decision, not a decision)

- **Postgres first.**
  - Ship the Prisma 8 Adapter for Postgres with the advisory lock via `tx.execute(tx.raw.sql…)`, retrying `40001`/`40P01`.
  - Pin the Prisma version range, and run the Conformance Suite against every RC until `8.0.0` final.
  - The Adapter's subpath must be ESM and needs Node 24+.
- **Schema delivery from `defineSchema`, two outputs.**
  - A PSL renderer plus a test helper for `contract.prisma` users, since PSL is Prisma's canonical surface.
  - A `prismaModels(schema, helpers)` builder function for `contract.ts` users.
  - Both keep ADR 007's rule that the Framework never runs DDL. The developer's `prisma migration plan` / `db migrate` applies them.
- **SQLite.**
  - If Prisma's SQLite stays in scope, lock with `PRAGMA busy_timeout = 0`, a zero-row write, async retry, then restore the timeout. Document that Prisma's SQLite is experimental.
  - Or defer the Prisma SQLite Adapter until Prisma calls SQLite stable, and prove the contract's SQLite path through Drizzle.
- **Backstop.** Documented as a `migration new` + `rawSql` snippet rendered from `defineSchema`, with a postcheck on `pg_constraint`.

## Unverified / open

- None of this was run against Prisma 8 or a real PostgreSQL server. The Postgres lock path and the raw tag through `tx` rest on source and docs. Prisma's scorecard lists the statement-level raw tag as untested.
- Whether the raw tag accepts a hand-built template-strings array (needed to put a renamed table name into raw SQL). Using `tx.sql` / `tx.orm` keyed by name is the safe route.
- Whether the runtime's marker check, or anything else, sends a statement on the transaction connection before the Adapter's first one. If it does, the zero-row write becomes an upgrade, which still fails fast and is retried.
- Whether `db update` drops or asks about an `EXCLUDE` constraint the contract doesn't declare.
- The exact `rawSql` options type.
- That Prisma 8 has no code-generation hook is inferred from its docs and the PSL interpreter. No document states it.
- The `:memory:` behaviour is read from the source, not run.

## Appendix: SQLite experiments

Raw SQLite (Python 3.9 `sqlite3`, SQLite 3.51.0, two connections with `isolation_level=None`, results identical in rollback-journal and WAL mode unless noted):

| # | Steps | Result |
|---|---|---|
| 1 | A: `BEGIN; UPDATE booking SET id = id WHERE 0` → B: `BEGIN; INSERT …` | B: `database is locked` (0 ms). A zero-row write takes the write lock. Same with `DELETE … WHERE 0`. |
| 2 | A, B: `BEGIN; SELECT`. A: `INSERT`. B: `INSERT` (busy_timeout 2000) | B: `database is locked` after 0 ms (busy handler not called) |
| 3 | WAL only. B: `BEGIN; SELECT`. A: `INSERT; COMMIT`. B: `INSERT` | B: `database is locked` after 0 ms (stale snapshot) |
| 4 | A holds the write lock. B: `BEGIN; UPDATE … WHERE 0` (busy_timeout 2000) | B waits 2,082 ms, then `database is locked` |
| 5 | B: `BEGIN; BEGIN IMMEDIATE` | `cannot start a transaction within a transaction` |
| 6 | B: `BEGIN; PRAGMA busy_timeout = 0` | Returns `[(0,)]`. B's first write then fails at once instead of waiting |

In-process strategies (Bun 1.4.4 `node:sqlite`, WAL). This mirrors Prisma's driver: a fresh `DatabaseSync` per transaction, `busy_timeout = 5000`, deferred `BEGIN`. Two works on one Resource each read, await 50 ms ("checks"), then insert if free; B starts 10 ms after A.

```text
== deferred (retry whole work on busy)
  B: SQLITE_BUSY at 63ms (attempt 1) -> retry
  A: booked at 52ms (attempt 1)
  B: conflict at 141ms (attempt 2)
== first-write (zero-row write first, busy_timeout 5000)
  B: SQLITE_BUSY at 5275ms (attempt 1) -> retry
  A: booked at 5278ms (attempt 1)
  B: conflict at 5346ms (attempt 2)
== first-write-nowait (busy_timeout 0, zero-row write first, async retry)
  B: SQLITE_BUSY at 12ms / 31ms / 44ms (attempts 1-3) -> retry
  A: booked at 53ms (attempt 1)
  B: conflict at 116ms (attempt 4)
```

Every run ended with exactly one booking row. Bun is not Prisma 8's primary runtime (Node 24 is). The blocking comes from `node:sqlite` being synchronous, which Node documents for its own implementation.

## Sources

- Prisma source at `v8.0.0-rc.23`: [sqlite-driver.ts](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/sqlite/3-driver/src/sqlite-driver.ts), [normalize-error.ts](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/sqlite/3-driver/src/normalize-error.ts), [sqlite facade runtime](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/sqlite/9-facade/src/runtime/sqlite.ts), [postgres-driver.ts](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/postgres/3-driver/src/postgres-driver.ts), [Postgres adapter](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/3-targets/postgres/2-adapter/src/core/adapter.ts), [sql-runtime.ts](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/5-runtime/src/sql-runtime.ts), [owned-transaction.ts](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/5-runtime/src/owned-transaction.ts), [raw lane expression.ts](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/4-lanes/relational-core/src/expression.ts), [contract-psl provider.ts](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/2-authoring/contract-psl/src/provider.ts), [contract-ts README](https://github.com/prisma/orm/blob/v8.0.0-rc.23/packages/2-sql-family/2-authoring/contract-ts/README.md), [ADR 212 Contract spaces](https://github.com/prisma/orm/blob/v8.0.0-rc.23/docs/architecture%20docs/adrs/ADR%20212%20-%20Contract%20spaces.md), [Supported Versions](https://github.com/prisma/orm/blob/v8.0.0-rc.23/docs/Supported%20Versions.md), [README](https://github.com/prisma/orm/blob/v8.0.0-rc.23/README.md), [scorecard](https://github.com/prisma/orm/blob/v8.0.0-rc.23/scorecard.md).
- Prisma 8 skill references at `v8.0.0-rc.23`: [runtime](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/runtime.md), [queries-postgres](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/queries-postgres.md), [contract](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/contract.md), [migrations](https://github.com/prisma/orm/blob/v8.0.0-rc.23/skills/prisma-8/references/migrations.md).
- Prisma releases and docs: [v8.0.0-rc.23 release notes](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.23), [transactions](https://www.prisma.io/docs/orm/fundamentals/transactions), [release status](https://www.prisma.io/docs/orm/release-status), [supported databases](https://www.prisma.io/docs/orm/supported-databases), [ORM overview](https://www.prisma.io/docs/orm), npm registry (`prisma`, `@prisma/orm-toolchain` dist-tags and versions).
- Databases and runtimes: [SQLite BEGIN](https://www.sqlite.org/lang_transaction.html), [sqlite3_busy_handler](https://www.sqlite.org/c3ref/busy_handler.html), [Node.js `node:sqlite`](https://nodejs.org/api/sqlite.html), [PostgreSQL advisory lock functions](https://www.postgresql.org/docs/current/functions-admin.html).
