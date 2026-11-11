# Research: is there a place for reylo in fasti?

Ticket: #22 (map: #2). Builds on ADR 007 (hybrid schema ownership), ADR 008 (the Adapter contract), ADR 012 (one package, `tsc` only) and ADR 013 (integration tests on real databases). Touches #23 (the developer's transaction).

Researched 2026-11-11 against:

- the npm tarball of [`reylo@0.7.0`](https://www.npmjs.com/package/reylo/v/0.7.0) (published 2026-11-03, git head `7a3928a`), whose `src/` is the shipped runtime, loader and plugins;
- reylo's docs as served at [reylo.dev/llms.txt](https://reylo.dev/llms.txt), its README, and its [v0.7.0 release notes](https://github.com/colinhacks/reylo/releases/tag/v0.7.0);
- the npm registry metadata for `reylo` and `typescript`;
- the TypeScript 7.1 beta [announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/) and the content mapper PR, [microsoft/typescript-go#4712](https://github.com/microsoft/typescript-go/pull/4712).

Experiments ran in a scratch directory outside the repo, on macOS arm64 with Node 26.13.0, `typescript@7.1.0-beta`, `reylo@0.7.0` and a SQLite file (see the appendix). Nothing was run against Postgres, MySQL, Drizzle, Effect, a bundler plugin, `publint` or `attw`; claims about those come from source and docs only.

## Question

Is there a place for reylo in fasti, and what would it cost? Reylo imports `.sql` files into TypeScript with types inferred from a live database, through TypeScript 7.1 content mappers.

## Short answer

- **No place in fasti's first-party code.** Reylo types one fixed SQL text against one live schema. fasti's first-party Adapters must run against tables, columns and Status values each developer names (ADR 007), and reylo has no identifier parameters. That rules it out for the Adapters, the Conformance Suite and the backstop.
- **Packaging would break ADR 012 too.** `tsc` emits types for `.sql` imports, and a consumer on plain TypeScript 7.0 reads them with no database. But `tsc` emits no JavaScript for them. Shipping working code needs an extra build step outside `tsc`, plus `reylo` as a runtime dependency.
- **The developer's side works with no fasti changes.** A developer can use reylo in their own app: for their own writes in the same transaction (#23), or to write a custom Adapter against their fixed schema. The Adapter contract is plain async functions, and reylo's `.run()` takes a driver or Drizzle transaction.
- **Maturity: early.** Reylo is three weeks old (0.0.1 on 2026-10-22, 0.7.0 on 2026-11-03), has one maintainer, and its latest release has seven breaking changes. It needs TypeScript 7.1, which is in beta, with an RC planned for about late November 2026.
- **`examples/` app: possible, not recommended now.** It has fixed names and CI already has Postgres, but it would tie the example to beta tooling.

## 1. Fit with the Adapter contract

**What reylo is at run time.**

- An imported query is an object with `.run(client, params)`, `.runSync`, `.try`, `.trySync` and `.with(client)` (`src/index.d.ts` in the 0.7.0 tarball; [Usage](https://reylo.dev/#usage)). `.run` always returns a promise and rejects with the driver's own error.
- `.run` takes "a pool, a client, or a connection or transaction taken from one" from `pg`, postgres.js, `node:sqlite`, `better-sqlite3` and others. It also takes a Drizzle database or transaction over those drivers ([Postgres: Drizzle](https://reylo.dev/postgres#drizzle), [SQLite: Drizzle](https://reylo.dev/sqlite#drizzle)). Reylo has no driver or pool of its own.
- `.try()` returns `{ value }` or `{ error }` for database errors. The error is narrowed to the codes and constraint names the statement can hit (`condition: "unique_violation"`, `constraint: "users_email_key" | …`).

**Could a driver-level Adapter be written as `.sql` files?** Only for one fixed schema (§2). Mechanically, each verb would be one `.sql` file. Nothing in reylo conflicts with the contract:

- **Plain promises.** Adapter verbs are plain `async` functions with no Effect (ADR 008), and `.run()` is a plain promise.
- **Conflicts as values.** On Postgres, `.try()` would surface an `EXCLUDE` backstop clash as a typed `exclusion_violation`, which maps to the typed `conflict`. Reylo warns that on Postgres any error, including one `.try()` returns, aborts the transaction ([`.try()`](https://reylo.dev/#try)).
- **One file per statement.** Each file holds one statement ([Postgres limits](https://reylo.dev/postgres#limits)), which matches one verb per query.
- **Plain-text values.** Reylo decodes values itself: a `timestamptz` comes back as ISO 8601 text in UTC, a 64-bit integer as `bigint`, and never as a `Date` ([FAQ](https://reylo.dev/#faq), [dates](https://reylo.dev/postgres#dates-and-times)). That suits Temporal (`Temporal.Instant.from`).

**The Resource Lock.**

- **The lock statements fit.** `select pg_advisory_xact_lock(...)` and `begin immediate` are ordinary statements. `begin immediate` was type-checked as a reylo query by experiment and comes out as `Query<{}, never, "none", "sqlite">`. Reylo adds nothing to them: they take no columns and return no rows.
- **A transaction it doesn't own (#23).** Reylo is neutral here. It runs whatever statement it is given on whatever client it is given, including a Drizzle `tx` (docs). So the Postgres advisory transaction lock works on the developer's transaction exactly as it would without reylo.
- **SQLite's limit is SQLite's own.** `BEGIN IMMEDIATE` can't be issued inside an open transaction: `node:sqlite` reports "cannot start a transaction within a transaction" (checked by experiment). Any Adapter, reylo or not, has to use the write-first workaround from the Prisma 8 research instead.
- **An extra query inside the lock.** If a module carries `fresh` catalog facts, `.run()` first runs a catalog query on the same client to check that the schema still holds what the build saw. It does this at most once per 60 s per query, and throws a stale-schema error on a mismatch (`src/execute.js` and `src/fresh.d.ts`, `FRESH_FOR = 60000`, in the tarball). So inside a locked transaction, reylo sometimes adds a catalog read.

**Verdict: feasible with caveat.** The contract fits reylo's shape, but only for an Adapter written against one fixed schema. That is a developer's custom Adapter, not a first-party one (§2).

## 2. Static SQL against configurable names

**Reylo can't parameterise identifiers.**

- A parameter is a value. Sorting or grouping by a parameter is a documented error, and the docs' answer to dynamic sorting is a `case` over fixed columns ([Errors](https://reylo.dev/#errors), [Dynamic sorting](https://reylo.dev/#dynamic-sorting)). The docs mention no identifier interpolation anywhere.
- By experiment, `select id from :tbl` fails the type check with SQLite's own error: `src/ident.sql(1,16): error reylo6: near "?1": syntax error`.

**The SQL is fixed when it is analysed.**

- The type check, `reylo generate`, the bundler plugins and the preload analyse each `.sql` file against the one database at `DATABASE_URL` ([Database](https://reylo.dev/#database)).
- The generated module carries the compiled SQL text, the column kinds and (where present) the catalog facts it relied on (`src/loader.js` in the tarball).
- By experiment, a pre-generated `insert into bookings …` module failed after the table was renamed: `Error no such table: bookings`.

**What that means for fasti.**

- **First-party Adapters.** Their tables and columns are renamed per app, and the Conformance Suite runs a fully renamed schema (ADR 013). No single `.sql` text serves every app. Each app would need its own build of each query, which means each developer would need reylo's toolchain and a database at build time.
- **Two sources of types.** Reylo types columns by their physical names and by what the database knows. fasti types the Logical Model from `defineSchema`. An Adapter would still map one to the other by hand, so reylo's inference saves little.
- **The Postgres backstop.** Its `status IN (…)` list comes from the developer's declared Statuses (ADR 008, ADR 009). It is generated DDL that varies per app, and as a multi-statement migration it is outside what reylo types anyway ("A file of several statements, such as a migration": [Postgres limits](https://reylo.dev/postgres#limits)).
- **Status values as types.** Reylo turns a `check (x in (…))` column into a union. The docs show this on Postgres. On SQLite, a `STRICT` table with `status text not null check (status in ('booked','cancelled'))` came out as `status: string` by experiment. Either way, the union would describe the database's list, not the developer's `defineSchema` declaration.
- **Views are no way round it.** Putting views over renamed tables to restore fixed names would be DDL that varies per app, which fasti never runs (ADR 007). SQLite views are also read-only without `INSTEAD OF` triggers.

**Verdict: not feasible** for anything that must follow a renamed schema. Reylo only fits code written against one known schema.

## 3. What it demands of fasti and of its users

**fasti's build and CI.**

- **TypeScript 7.1.** fasti's `devDependencies` already pin `typescript@^7.1.0-beta`, so TypeScript 7.1 itself is no new cost.
- **`--runExternalCode` on every `tsc`.** Without it, `tsc` fails with `TS18068: Content mappers require the '--runExternalCode' command line flag to be enabled` and `TS2307` on every `.sql` import (by experiment). The flag lets `tsc` run arbitrary executables, which is why it exists ([7.1 beta](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)). Editors run mappers only in trusted workspaces.
- **A live database for every type check and build.** "Can I build without a database? No, not yet" ([FAQ](https://reylo.dev/#faq)). Reylo keeps a cache in `.reylo/` and can read it offline, but the cache is gitignored by design.
  - This puts a database in `bun run build`, `prepublishOnly` and every contributor's editor, not just in `test:integration`. ADR 013 deliberately keeps it to integration tests.
  - A Postgres Adapter and a SQLite Adapter would each need their own database, and reylo reads one `DATABASE_URL` per project. That means separate projects or `.reylo.yaml` files.
- **The native engine, on eight platforms.** The type check needs it ([v0.7.0 notes](https://github.com/colinhacks/reylo/releases/tag/v0.7.0)). On darwin-arm64, `@reylosql/engine-darwin-arm64` is 15 MB unpacked (`npm view`) and `reylo` itself is 2.1 MB (`du`).

**What a published package ships** (all by experiment, with `declaration: true`):

- **Types: resolved and portable.** `tsc` emits a declaration file per `.sql` import, named `insert_booking.d.sql.ts`, as the content mapper PR specifies: "Content-mapped files are not emitted to JavaScript. When `--declaration` is enabled, however, declaration files are emitted" ([#4712, Emit](https://github.com/microsoft/typescript-go/pull/4712)).
  - The file holds the fully inferred `Params`, `Row` and error unions as plain types, plus `import type { Query } from "reylo"`.
  - A packed library installed into a consumer on **TypeScript 7.0.2**, with no content mappers, no `--runExternalCode` and no database, type-checked. The inferred param types reached the consumer: a `@ts-expect-error` on a wrong param was used, and `--traceResolution` showed `./insert_booking.sql` resolving to the `.d.sql.ts` file.
  - The consumer still needs `reylo` installed for that `import type`.
  - Not tested: TypeScript 5.x/6.x consumers, `publint`, `attw`.
- **JavaScript: not shipped.** `dist/index.js` still says `import insertBooking from "./insert_booking.sql"`, and `tsc` emits nothing for that file.
  - Run as is, a consumer gets `ERR_MODULE_NOT_FOUND … dist/insert_booking.sql`.
  - With the `.sql` files copied into `dist/` and the consumer running `node --import reylo/register`, it still failed: `No database URL: set DATABASE_URL …`. The preload analyses each query when it loads, in the consumer's process. That needs the engine plus the database, or a `.reylo/` cache entry.
  - Once given a `DATABASE_URL`, the preload worked, and wrote a `.reylo/` cache into `node_modules/lib/`.
  - With that cache present and no URL, it worked offline. With the cache present but the engine removed, it failed again.
- **The way out is a second build step.** Reylo's build-step loader, the one its esbuild/Vite plugins call, turns a `.sql` file into a plain JS module that imports only `defineQuery` from `reylo`.
  - By experiment, such a pre-generated module ran on `node:sqlite` with the engine removed. That matches the release notes: "A bundled app's `.run()` does not [need the engine], since the build has already analyzed its queries."
  - But fasti would need that step beside `tsc`, against ADR 012's "`tsc` is the only build step". It would use either reylo's internal `src/loader.js`, which is not in its `exports` map (the experiment imported it by file path), or a bundler plugin.
  - The `./x.sql` specifiers in the emitted JS would also need rewriting to the generated files. Not tried end to end.

**What it puts on consumers at run time, even with pre-generated modules.**

- **`reylo` becomes a runtime `dependency` of `fasti`.** It is needed for `defineQuery` and value decoding. Its `optionalDependencies` pull in a 15 MB platform engine on every install unless the consumer passes `--omit=optional`.
  - ADR 012 already accepts `effect` as a regular dependency. This would add a second runtime library that every first-party Adapter needs.
  - It would also break ADR 012's rule that each Adapter imports only its own ORM.
- **Tracing channel.** `reylo/src/trace.js` creates `tracingChannel("reylo:query")` through `process.getBuiltinModule` inside a `try`, and publishes only when something subscribes. It is harmless where `node:diagnostics_channel` is missing.
  - fasti's own spans would come from Effect. A user would see a second, unrelated set of query events.
- **The sqlcommenter comment.** By default, every statement reylo sends ends with `/*file='…'*/` naming the `.sql` file ([`sqlcommenter`](https://reylo.dev/#sqlcommenter)). Inside a library, that names fasti's internal file paths in the user's database monitoring.
- **Engine requirements.** `"engines": { "node": ">=24" }` (fasti requires 26, so this is fine), and the engine runs on eight platforms only.

**Effect.** No conflict: Adapters never import Effect (ADR 008, ADR 012), and the Framework wraps the Adapter's promises. Reylo has nothing Effect-specific.

**Bundling.** Reylo's runtime module is plain ESM with no top-level side effect other than the guarded tracing-channel lookup. Not measured: tree-shaking, or whether `"sideEffects": false` holds through it. In a consumer's own bundle (Vite, Next.js, esbuild, webpack, Bun), the developer would add reylo's plugin only if *they* import `.sql` files ([Runtime / framework](https://reylo.dev/#runtime--framework)).

**Verdict: not feasible for fasti's published code.** Types travel cleanly, but the JavaScript does not without a second build step and a runtime dependency, and the build needs a database. **Feasible** for a developer's own app, which already owns its schema and build.

## 4. Maturity

- **Version.** `0.7.0` is npm `latest`. Releases: 0.0.0 (a placeholder, 2026-10-03), then 0.0.1, 0.0.2, 0.1.0, 0.2.0 and 0.3.0 all on 2026-10-22, 0.4.0 and 0.5.0 on 10-23, 0.6.0 on 10-27, and 0.7.0 on 11-03 (`npm view reylo time`). That is nine releases in twelve days.
- **Breaking changes.** 0.7.0 lists seven changes that "can surface in an existing project", among them a new engine packaging, a platform limit, and types and cardinalities that move ([v0.7.0](https://github.com/colinhacks/reylo/releases/tag/v0.7.0)). Expect more churn before 1.0.
- **People and provenance.** The GitHub repo was created 2026-10-21, has about 1.6k stars, and had 12 issues in total (5 open) when checked. There is one npm maintainer. It is MIT licensed and published from GitHub Actions with npm provenance.
- **TypeScript 7.1.** Content mappers merged in typescript-go on 2026-08-19 ([#4712](https://github.com/microsoft/typescript-go/pull/4712)). `7.1.0-beta` was published 2026-10-20, and npm `latest` is still `7.0.2`.
  - The beta post says "a Release Candidate in about a month from now, followed by a final release shortly thereafter". That puts the RC around 2026-11-20 and GA soon after, with no date given ([7.1 beta](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)).
  - The PR lists declaration maps for mapped files as unsupported and as a "later follow-up".
- **Databases.** Postgres 14–18 (including Neon and PGlite); MySQL 8.0.22+ (including PlanetScale); SQLite (including D1, Durable Objects, Turso and libSQL); and DuckDB as a preview ([Setup](https://reylo.dev/#setup)).
- **Drivers.**
  - **Postgres:** `pg`, postgres.js, `Bun.sql`, PGlite, Neon, `pg-promise`, `slonik` (an optional peer, `>=49.12.0`) and `@vercel/postgres`.
  - **MySQL:** `mysql2`, `mariadb`, PlanetScale and `Bun.sql`.
  - **SQLite:** `better-sqlite3`, `node:sqlite`, `bun:sqlite`, libSQL, Turso, D1, Durable Objects, `sqlite3`, `sqlite` and `Bun.sql`.
  - **Drizzle** over most of these ([Supported drivers](https://reylo.dev/#run)).
  - Not listed: Prisma.

**Verdict: not feasible to depend on now.** Revisit after TypeScript 7.1 GA and a reylo 1.0, and only for the developer-side uses below.

## 5. Other uses

- **Conformance Suite raw checks: not feasible.**
  - `fasti/testing` is published and runs against the developer's database and names, and the backstop group inserts raw overlapping rows into a fully renamed schema (ADR 013). That is §2's problem again.
  - ADR 013 also says the suite's tables come "from the developer's path … Never hand-written SQL".
  - Using reylo would also make every suite user adopt TypeScript 7.1 and a type-check database.
- **fasti's own repo tests: not worth it.** The negative control and the backstop runs use the same renamed schema. A typed raw query would be the only gain, and fasti's own tests need a database only in `test:integration`.
- **`examples/` app: feasible with caveat.**
  - **For it:** it uses default names, and its CI already has a Postgres service (ADR 013).
  - **What it could show:** developer-owned writes next to a fasti Action in one transaction (#23, `scheduler.with(drizzleAdapter(tx))`, then `takeCredit.run(tx, …)`), or a small custom Adapter written in `.sql`.
  - **Against it:** the example's type check would need `--runExternalCode` and a database, and it would tie the example to a beta TypeScript and a 0.x tool. The example could also read as fasti endorsing reylo.
  - Better as a short docs recipe after TypeScript 7.1 GA than as the main example.
- **Developer docs: feasible.** A recipe could show that a reylo query takes the same `tx` a scoped scheduler runs in (#23). It could also note that reylo's `.try()` errors are the developer's to map into a veto. fasti needs no code for either.

## Appendix: experiments

All of these ran in a scratch directory, never in the repo. Setup: `npm i reylo@0.7.0 typescript@7.1.0-beta @types/node@26`, and a SQLite file with

```sql
create table bookings (id text primary key, resource_id text not null, starts_at text not null,
  ends_at text not null, status text not null check (status in ('booked','cancelled'))) strict;
```

| # | What | Result |
| --- | --- | --- |
| 1 | `tsc` without `--runExternalCode` on a library importing `.sql` files | `TS2307` on each import and `TS18068` on `contentMappers` |
| 2 | `tsc --runExternalCode` with `declaration: true` | `dist/index.js` (still imports `./insert_booking.sql`), `index.d.ts`, `insert_booking.d.sql.ts`, `list_blocking.d.sql.ts`; no JS for the `.sql` files |
| 3 | `npm pack` the library, install it into a consumer on TypeScript 7.0.2 with no mapper and no DB, type-check | Passes; `--traceResolution` resolves `./insert_booking.sql` to `insert_booking.d.sql.ts`; a wrong param is a type error |
| 4 | Run that consumer with `node main.ts` | `ERR_MODULE_NOT_FOUND … dist/insert_booking.sql` |
| 5 | Ship the `.sql` files too, run with `--import reylo/register`, no `DATABASE_URL` | `No database URL: set DATABASE_URL …` |
| 6 | Same, with `DATABASE_URL=file:/…/app.db` | Insert runs; a `.reylo/` cache appears in `node_modules/lib/` |
| 7 | Same, URL unset, cache present | Runs offline |
| 8 | Same, URL unset, cache present, engine package removed | Fails again (`No database URL …`) |
| 9 | Pre-generate a JS module with reylo's internal `src/loader.js` `sqlModule`, run it on `node:sqlite` with the engine removed | Runs; the module imports only `defineQuery` from `reylo` |
| 10 | Rename `bookings` to `appointments` and run that module again | `Error no such table: bookings` |
| 11 | Type-check `select id from :tbl` | `error reylo6: near "?1": syntax error` |
| 12 | Type-check `begin immediate` | Accepted, typed `Query<{}, never, "none", "sqlite">` |
| 13 | `node:sqlite`: `begin` then `begin immediate` | `cannot start a transaction within a transaction` |
| 14 | Inferred type of the `CHECK (status IN …)` column on SQLite | `status: string` |

Not run: anything on Postgres or MySQL, Drizzle transactions, the Vite/esbuild plugins, the tracing channel, `publint`/`attw` on a package with `.d.sql.ts` files, or consumers on TypeScript older than 7.0.2.
