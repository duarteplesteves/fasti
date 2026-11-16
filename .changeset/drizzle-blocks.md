---
"@fastijs/scheduler": minor
---

Blocks on Postgres: `drizzleAdapter(db)` now implements the `"blocks"` verb group, so a schema with `block` works with it. Make the table with the new `blockTable(schema, { references })` from `/drizzle/pg`: a uuid primary key, the Resource id column (with an optional `ON DELETE RESTRICT` foreign key), `start`/`end` as `timestamptz`, and your Developer Fields, all under your physical names. Block writes run under the same Resource Lock as Bookings. A schema without `block` needs no Block table.
