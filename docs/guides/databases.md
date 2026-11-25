# Databases

fasti runs on your database, through an Adapter. It never changes your database schema: you build its tables from your [fasti schema](./schema.md), next to your own, and migrate them with your own tools.

| Adapter                                   | Lock                       | Backstop | Notes                                        |
| ----------------------------------------- | -------------------------- | -------- | -------------------------------------------- |
| [Drizzle on Postgres](#drizzle-on-postgres) | Per Resource             | Yes      | `drizzle-orm` 1.0 RC.5+                       |
| [Drizzle on SQLite](#drizzle-on-sqlite)   | The whole database         | No       | libsql file databases, one writer process     |
| [Prisma on Postgres](#prisma-on-postgres) | Per Resource               | Yes      | Experimental while Prisma 8 is an RC          |
| [Memory](#memory)                         | In process                 | No       | For tests and prototypes                      |

For anything else, [write your own](./custom-adapter.md).

## Drizzle on Postgres

Build the tables and let your own drizzle-kit migrate them. `references` is optional: it adds a foreign key to your own Resource table.

```typescript
import { pgTable, integer } from "drizzle-orm/pg-core";
import {
  bookingTable,
  drizzleAdapter,
  recordTables,
} from "@fastijs/scheduler/drizzle/pg";

export const staff = pgTable("staff", { id: integer().primaryKey() });
export const appointments = bookingTable(schema, { references: () => staff.id });
// One Drizzle table per Plugin table, by logical name: here `availabilityRule`.
export const { availabilityRule } = recordTables(schema, { references: () => staff.id });

const adapter = drizzleAdapter(db);
```

Units of work, `also` and in-transaction Hooks included, run at `READ COMMITTED` whatever your database's default isolation level, because the Resource Lock needs it. A unit that fails with a deadlock or serialization failure reruns whole, up to 3 attempts.

### Indexes

The builders declare an index on the Resource id, `start` and `end` (`<table>_resource_start_idx`), or on the Resource id alone for an untimed Plugin table (`<table>_resource_idx`), so fasti's reads don't scan the whole table. After upgrading fasti, generate a migration.

On a large live table, change the generated statement to `create index concurrently` and run it outside a transaction: a plain one blocks writes until it finishes.

### The backstop

fasti's lock keeps its own writes from overlapping. The backstop is a Postgres `EXCLUDE` constraint that also refuses overlaps from writes outside fasti: no two blocking Bookings can overlap on one Resource.

Drizzle can't express `EXCLUDE`, so add it as a custom migration, after the one that creates the tables:

```bash
npx drizzle-kit generate --custom --name=fasti-backstop
```

Print the statements, and paste each into the generated file, separated by `--> statement-breakpoint`:

```typescript
import { backstopSql } from "@fastijs/scheduler/drizzle/pg";

console.log(backstopSql(schema).join("\n--> statement-breakpoint\n"));
```

drizzle-kit doesn't know about this constraint: later migrations neither include nor drop it. **Redo it by hand**, dropping the old constraint and adding the new statements in a new custom migration, when you:

- rename the Booking table, its columns or a blocking Status;
- add, remove or flip a blocking [Status](./statuses.md#changing-statuses-later).

The constraint assumes one Booking per Resource at a time, as fasti does.

The `CHECK` constraint on `status` is separate, and drizzle-kit generates its changes for you.

## Drizzle on SQLite

The same names and shapes as `drizzle/pg`, apart from the backstop, so moving between the two is an import change.

```typescript
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import {
  bookingTable,
  drizzleAdapter,
  recordTables,
} from "@fastijs/scheduler/drizzle/sqlite";

export const staff = sqliteTable("staff", { id: integer().primaryKey() });
export const appointments = bookingTable(schema, { references: () => staff.id });
export const { availabilityRule } = recordTables(schema, { references: () => staff.id });

const db = drizzle({ client: createClient({ url: "file:app.db" }) });
const adapter = drizzleAdapter(db);
```

Before you use it:

- **One writer process per file.** Another process writing to the same file makes units fail with `SQLITE_BUSY` instead of waiting. Cross-process writes wait on a libsql fix ([#142](https://github.com/duarteplesteves/fasti/issues/142)).
- **File databases only.** `:memory:` and embedded replicas get a single connection, so a read during a unit of work fails. Turso isn't tested.
- **Async drivers only.** A database on better-sqlite3, `node:sqlite` or `bun:sqlite` is a type error: their transactions can't stay open across an `await`. Switch to libsql: a different `drizzle(…)` import and client, with the same file, tables and queries. Sync drivers are on the [roadmap](../../ROADMAP.md#beyond-the-framework).
- **No backstop.** SQLite has no `EXCLUDE` constraint, so a write to the bookings table outside fasti isn't caught by the database.

Set it up:

- **Use WAL**: run `PRAGMA journal_mode = WAL` once, in your own setup. fasti never runs it ([ADR 007](../adr/007-hybrid-schema-ownership.md)).
- **Foreign keys** from `references` are enforced only with `PRAGMA foreign_keys = ON` on each connection.
- **Leave libsql's `timeout` unset.** A busy timeout blocks Node's event loop while it waits.

How it behaves:

- **The lock is the whole database.** Units on one `db` run one after another, each inside `BEGIN IMMEDIATE`, so writes to different Resources take turns. Waiting never blocks the event loop.
- **Storage.** Instants are integer milliseconds, Plugin `date` and `time` columns ISO text, `json` and `dates` columns JSON text, and Status `text` with a `CHECK` over its stored values.
- **Indexes.** The builders declare the same [indexes as on Postgres](#indexes): generate a migration after upgrading.

## Prisma on Postgres

Experimental while Prisma 8 is a release candidate. Postgres only. Spread `prismaModels` into your contract and let Prisma's tooling create the tables. It includes a model for every Plugin table.

```typescript
import { defineContract } from "@prisma/orm-postgres/contract-builder";
import postgres from "@prisma/orm-postgres/runtime";
import { prismaAdapter, prismaModels } from "@fastijs/scheduler/prisma";

export const contract = defineContract({}, (helpers) => {
  const staff = helpers
    .model("staff", {
      fields: { id: helpers.field.column(helpers.type.Int()).id() },
    })
    .sql({ table: "staff" });

  return {
    models: {
      staff,
      ...prismaModels(schema, helpers, { references: { model: staff, field: "id" } }),
    },
  };
});

const db = postgres({ contract, url: process.env.DATABASE_URL! });
const adapter = prismaAdapter(db);
```

- **The lock** is the same advisory lock as the Drizzle Postgres Adapter's, so units through either on one Resource exclude each other.
- **Isolation and retries** are the same too: `READ COMMITTED`, and a unit that fails with a serialization failure or deadlock reruns whole, `also` included, up to 3 attempts. `tx` is Prisma's own transaction.
- **Indexes.** The models declare the same [indexes](#indexes), under the same names: plan a migration after upgrading.
- **The backstop.** Prisma can't express `EXCLUDE` either: create a raw SQL migration with `prisma migration new` and paste the statements from `backstopSql(schema)`, imported from `@fastijs/scheduler/prisma`. [The same rules](#the-backstop) apply when you rename or change blocking Statuses.

## Memory

For tests and prototypes: nothing is persisted.

```typescript
import { memoryAdapter } from "@fastijs/scheduler/memory";

const scheduler = createScheduler({ adapter: memoryAdapter(), schema });
```

It holds the same lock and runs the same checks as the others, so it fits unit tests of your booking code. Its `tx` is `undefined`, so test an `also` that writes through `tx` on your real database.
