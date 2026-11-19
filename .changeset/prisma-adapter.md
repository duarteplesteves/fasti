---
"@fastijs/scheduler": minor
---

Add `@fastijs/scheduler/prisma`, an experimental Adapter for Prisma 8 on Postgres. Spread `prismaModels(schema, helpers)` into your `defineContract` models and pass `prismaAdapter(db)` to `createScheduler`. It takes the same advisory lock as the Drizzle Postgres Adapter, so units through either Adapter on one Resource exclude each other, and `tx` is Prisma's own transaction. `@prisma/orm-postgres` (`>=8.0.0-rc.24 <9`) is an optional peer dependency.
