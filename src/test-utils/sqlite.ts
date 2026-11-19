import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

/** The repo's drizzle-kit CLI, whatever the working directory. */
const drizzleKit = fileURLToPath(
  new URL("../../node_modules/.bin/drizzle-kit", import.meta.url)
);

/** A fresh libsql file database for one test file. */
export interface SqliteTestDatabase {
  readonly db: LibSQLDatabase;
  /** The database's `file:` URL, for another client on the same file. */
  readonly url: string;
  /** Close the client and delete the database's directory. */
  readonly drop: () => Promise<void>;
}

/**
 * A libsql file in a new temp directory, in WAL mode, with the tables of the schema module at
 * `schemaPath` pushed through the `drizzle-kit push` CLI (ADR 013: no hand-written DDL).
 */
// shortcut: drizzle-kit 1.0.0-rc.5 exports no SQLite `pushSchema`, so this shells out to the CLI; use the API once it ships one.
export async function sqliteTestDatabase(
  schemaPath: string
): Promise<SqliteTestDatabase> {
  const dir = await mkdtemp(path.join(tmpdir(), "fasti-sqlite-"));
  const url = `file:${path.join(dir, "test.db")}`;
  const client = createClient({ url });

  async function drop(): Promise<void> {
    client.close();
    await rm(dir, { force: true, recursive: true });
  }

  try {
    // The developer's setup, not fasti's (ADR 007): fasti never runs this pragma.
    await client.execute("pragma journal_mode = wal");
    execFileSync(drizzleKit, [
      "push",
      "--dialect",
      "sqlite",
      "--schema",
      schemaPath,
      "--url",
      url,
      "--force",
    ]);
  } catch (error) {
    await drop();
    throw error;
  }

  return { db: drizzle({ client }), drop, url };
}
