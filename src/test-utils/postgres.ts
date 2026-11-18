import { randomBytes } from "node:crypto";
import { on } from "node:events";

import { pushSchema } from "drizzle-kit/api-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";

/**
 * `FASTI_TEST_POSTGRES_URL` (ADR 013): tests never start Postgres. Unset, the Postgres entry
 * is skipped with a notice locally, and fails when `CI=true` so CI can't skip it silently.
 */
export function postgresUrl(): string | undefined {
  const url = process.env["FASTI_TEST_POSTGRES_URL"];

  if (url === undefined || url === "") {
    if (process.env["CI"] === "true") {
      throw new Error("FASTI_TEST_POSTGRES_URL is required when CI=true");
    }

    process.stderr.write(
      "Skipping the Postgres conformance run: set FASTI_TEST_POSTGRES_URL to run it.\n"
    );

    return undefined;
  }

  return url;
}

/** An empty database for one test file, with a pool on it. */
export interface FreshDatabase {
  /** The database's own URL. */
  readonly url: string;
  readonly pool: Pool;
  /** Close the pool and drop the database. */
  readonly drop: () => Promise<void>;
}

/** Create an empty `fasti_<random>` database on the server at `url`. */
export async function freshDatabase(url: string): Promise<FreshDatabase> {
  const name = `fasti_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: url });

  await admin.connect();
  await admin.query(`create database ${name}`);

  const dbUrl = new URL(url);
  dbUrl.pathname = `/${name}`;

  // 25 > the 20 concurrent units of work the concurrency cases run.
  const pool = new Pool({ connectionString: dbUrl.toString(), max: 25 });

  async function drop(): Promise<void> {
    // pool.end() resolves before its clients' sockets close; each emits `remove` once closed.
    // Dropping earlier makes `with (force)` kill them mid-close: an unhandled 57P01.
    let open = pool.totalCount;
    const removed = on(pool, "remove");

    await pool.end();

    if (open > 0) {
      for await (const _ of removed) {
        open -= 1;

        if (open === 0) {
          break;
        }
      }
    }

    await admin.query(`drop database ${name} with (force)`);
    await admin.end();
  }

  return { drop, pool, url: dbUrl.toString() };
}

/** A fresh database for one test file. */
export interface TestDatabase {
  readonly db: NodePgDatabase;
  /** Close the pool and drop the database. */
  readonly drop: () => Promise<void>;
}

/** Create `fasti_<random>` on the server at `url` and push `tables` into it through drizzle-kit. */
export async function testDatabase(
  url: string,
  tables: Parameters<typeof pushSchema>[0]
): Promise<TestDatabase> {
  const { drop, pool } = await freshDatabase(url);
  const db = drizzle({ client: pool });

  try {
    const push = await pushSchema(tables, db);

    await push.apply();
  } catch (error) {
    // Don't leave a fasti_* database behind when the push fails.
    await drop();
    throw error;
  }

  return { db, drop };
}
