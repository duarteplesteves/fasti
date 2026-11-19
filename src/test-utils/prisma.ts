import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPostgresControlClient } from "@prisma/orm-postgres/control";
import postgres from "@prisma/orm-postgres/runtime";

import { freshDatabase } from "./postgres.js";
import type { FreshDatabase } from "./postgres.js";

/** A contract the Postgres client accepts. */
type AnyContract = Parameters<typeof postgres>[0]["contract"];

/** A fresh database for one test file, with `contract` applied. */
export interface PrismaTestDatabase<C extends AnyContract> {
  readonly db: ReturnType<typeof postgres<C>>;
  /** The pool `db` runs on, for statements outside Prisma (resets, a Drizzle client on the same database). */
  readonly pool: FreshDatabase["pool"];
  /** Close the client and drop the database. */
  readonly drop: () => Promise<void>;
}

/**
 * Create `fasti_<random>` on the server at `url` and apply `contract` with Prisma's own
 * `db init` (ADR 013: no hand-written DDL).
 */
export async function prismaTestDatabase<C extends AnyContract>(
  url: string,
  contract: C
): Promise<PrismaTestDatabase<C>> {
  const fresh = await freshDatabase(url);
  // `db init` reads refs from a migrations directory; an empty one means "from an empty database".
  const migrationsDir = await mkdtemp(path.join(tmpdir(), "fasti-prisma-"));

  async function drop(): Promise<void> {
    await rm(migrationsDir, { force: true, recursive: true });
    // The client was given the pool, so ending it is the pool owner's job.
    await fresh.drop();
  }

  const control = createPostgresControlClient({ connection: fresh.url });

  try {
    try {
      const init = await control.dbInit({
        contract,
        invocation: {
          configPath: undefined,
          cwd: process.cwd(),
          dbGiven: true,
        },
        migrationsDir,
        mode: "apply",
      });

      if (!init.ok) {
        throw new Error("prismaTestDatabase: db init failed", {
          cause: init.failure,
        });
      }
    } finally {
      // Before any drop: `with (force)` would kill its connection mid-close.
      await control.close();
    }
  } catch (error) {
    // Don't leave a fasti_* database behind when db init fails.
    await drop();
    throw error;
  }

  // SAFETY: the same pg Pool at runtime; Prisma pins its own copy of @types/pg, so the types differ.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- two copies of one declaration.
  const pg = fresh.pool as unknown as NonNullable<
    Parameters<typeof postgres>[0]["pg"]
  >;

  return { db: postgres({ contract, pg }), drop, pool: fresh.pool };
}
