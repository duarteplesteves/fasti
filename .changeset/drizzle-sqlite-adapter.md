---
"@fastijs/scheduler": minor
---

New `@fastijs/scheduler/drizzle/sqlite`: the Drizzle SQLite Adapter, for a libsql file database, with the same names and shapes as `drizzle/pg`. `bookingTable`, `blockTable` and `availabilityRuleTable` build your tables for drizzle-kit: Instants are integer `timestamp_ms`, recurrence and exceptions JSON text, Status `text` with a `CHECK` over its stored values, and `references` adds a foreign key with `ON DELETE RESTRICT`. `drizzleAdapter(db)` runs units on one database object one after another, each inside `BEGIN IMMEDIATE`. SQLite has no backstop, so `insertBooking` never returns `conflict`. Only async drivers type-check; a sync driver (better-sqlite3, `node:sqlite`, `bun:sqlite`) is a type error. Use a file database (`:memory:` and embedded replicas have one connection) and leave libsql's `timeout` unset, as it blocks the event loop.
