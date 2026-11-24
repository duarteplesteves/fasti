---
"@fastijs/scheduler": patch
---

The Drizzle and Prisma Postgres Adapters now run every unit of work at `READ COMMITTED`, whatever the database's default isolation level. On a database or role defaulting to `REPEATABLE READ`, concurrent writes could double-book a Resource. If you default to `SERIALIZABLE`, units of work now run at `READ COMMITTED`, your `also` writes and in-transaction Hooks included.
