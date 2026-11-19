---
"@fastijs/scheduler": minor
---

The Prisma Adapter now has the overlap guard and transient-error retries of the Drizzle Postgres Adapter. Apply `backstopSql(schema)` through `prisma migration new`'s raw SQL, and a Booking write that overlaps another becomes a `conflict` (inside a savepoint, so the unit keeps going). A unit that fails with `40001` or `40P01` reruns whole, `also` included, up to 3 attempts.
