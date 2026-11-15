import { backstopSql } from "@fastijs/scheduler/drizzle/pg";
import { pushSchema } from "drizzle-kit/api-postgres";

import { db, pool, schema, tables } from "./schema.ts";

// For an empty database. In an app, use drizzle-kit migrations plus a custom one for the backstop.
const push = await pushSchema(tables, db);

await push.apply();

for (const statement of backstopSql(schema)) {
  // oxlint-disable-next-line no-await-in-loop -- in order: the extension before the constraint.
  await pool.query(statement);
}

await pool.end();

console.log("migrated");
