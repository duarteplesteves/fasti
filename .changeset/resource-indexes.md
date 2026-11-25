---
"@fastijs/scheduler": minor
---

The Drizzle and Prisma tables now declare an index on the Resource id, `start` and `end` (the Resource id alone on untimed Plugin tables), so booking and searching no longer scan the whole table. Generate a migration after upgrading; on a large live Postgres table, create the indexes concurrently. fasti works without them, only slower.
