import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";
import { count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { drizzle as nodeSqlite } from "drizzle-orm/node-sqlite";
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AnySchema } from "../../schema/define-schema.js";
import {
  integerIdResources,
  integerIdSchema,
  recordsResources,
  recordsSchema,
  runsOn,
  textIdResources,
  textIdSchema,
  uuidIdResources,
  uuidIdSchema,
} from "../../test-utils/conformance-schemas.js";
import * as tables from "../../test-utils/sqlite-tables.js";
import { sqliteTestDatabase } from "../../test-utils/sqlite.js";
import type { SqliteTestDatabase } from "../../test-utils/sqlite.js";
import { insert, newBooking } from "../../testing/fixtures.js";
import { conformanceCases, runCase, testAdapter } from "../../testing/index.js";
import type { TestAdapterParams, TxProbe } from "../../testing/index.js";
import { createDrizzleAdapter } from "./drizzle-adapter.js";
import { drizzleAdapter } from "./index.js";

const concurrencyCases = conformanceCases.filter((c) =>
  c.tags.includes("concurrency")
);

/** What `drizzleAdapter(database.db)` hands a unit of work as `tx`. */
type Tx = Parameters<Parameters<LibSQLDatabase["transaction"]>[0]>[0];

const probe: TxProbe<Tx> = {
  async count() {
    const [row] = await database.db
      .select({ n: count() })
      .from(tables.testProbe);

    return row?.n ?? 0;
  },
  async write(tx) {
    await tx.insert(tables.testProbe).values({ id: randomUUID() });
  },
};

let database: SqliteTestDatabase;

/** Register the Conformance Suite and the negative control for one schema, each case on emptied tables. */
function suite<S extends AnySchema>(
  schema: S,
  fastiTables: readonly AnySQLiteTable[],
  resources: TestAdapterParams<S, Tx>["resources"]
): void {
  const params: TestAdapterParams<S, Tx> = {
    // SQLite has no exclusion constraint, so no backstop.
    groups: { backstop: false, retry: null, tx: probe },
    makeAdapter: () => drizzleAdapter(database.db),
    reset: async () => {
      for (const t of [...fastiTables, tables.testProbe]) {
        await database.db.delete(t);
      }
    },
    resources,
    schema,
  };

  describe(schema.names.tables.booking, () => {
    testAdapter(params);

    // Negative control: without the lock each concurrency case must fail, or the suite can't catch a missing lock.
    it.fails.each(concurrencyCases.filter((c) => runsOn(c, schema)))(
      "[lock off] $name",
      async (c) => {
        // Its own client, closed after: a unit whose write lost the race can leave its connection
        // on a stale snapshot, which would break the next case's reset on a shared client.
        const client = createClient({ url: database.url });

        try {
          await expect(
            runCase(c, {
              ...params,
              makeAdapter: () =>
                createDrizzleAdapter(drizzle({ client }), { lock: false }),
            })
          ).resolves.toBeUndefined();
        } finally {
          client.close();
        }
      }
    );

    it("a driver error rejects with the driver's error as cause", async () => {
      await params.reset();

      const adapter = drizzleAdapter(database.db)(schema);

      const b = newBooking(schema, {
        optionalFields: "null",
        resourceId: resources[0],
        status: "booked",
      });

      await insert(adapter, b);

      await expect(insert(adapter, b)).rejects.toMatchObject({
        cause: {
          code: "SQLITE_CONSTRAINT",
          extendedCode: "SQLITE_CONSTRAINT_PRIMARYKEY",
        },
        message: "drizzleAdapter: insertBooking failed",
      });
    });
  });
}

describe("drizzleAdapter on SQLite (libsql)", () => {
  beforeAll(async () => {
    database = await sqliteTestDatabase(
      fileURLToPath(
        new URL("../../test-utils/sqlite-tables.ts", import.meta.url)
      )
    );
    await database.db
      .insert(tables.testStaff)
      .values(integerIdResources.map((id) => ({ id })));
    await database.db
      .insert(tables.testRooms)
      .values(uuidIdResources.map((id) => ({ id })));
  });

  afterAll(async () => {
    await database?.drop();
  });

  suite(
    textIdSchema,
    [tables.textBooking, tables.textRule, tables.textBlock],
    textIdResources
  );
  suite(
    uuidIdSchema,
    [tables.uuidBooking, tables.uuidRule, tables.uuidBlock],
    uuidIdResources
  );
  // No `block`: no Block table exists in the database, and none is needed.
  suite(
    integerIdSchema,
    [tables.integerBooking, tables.integerRule],
    integerIdResources
  );
  suite(
    recordsSchema,
    [
      tables.recordsBooking,
      tables.recordsRule,
      tables.conformanceTimed,
      tables.conformanceUntimed,
    ],
    recordsResources
  );

  it("completes a burst of more units than libsql's 20 pooled connections", async () => {
    const adapter = drizzleAdapter(database.db)(textIdSchema);
    const units = 50;

    await database.db.delete(tables.textBooking);

    await Promise.all(
      Array.from({ length: units }, async (_, i) => {
        await insert(
          adapter,
          newBooking(textIdSchema, {
            optionalFields: "null",
            resourceId: textIdResources[i % 2] ?? "staff-a",
            status: "booked",
          })
        );
      })
    );

    const [row] = await database.db
      .select({ n: count() })
      .from(tables.textBooking);

    expect(row?.n).toBe(units);
  });

  it("does not type-check with a sync driver (type test: the @ts-expect-error line is the assertion)", () => {
    const db = nodeSqlite({ client: new DatabaseSync(":memory:") });

    // @ts-expect-error node:sqlite is a sync driver; only async drivers queue units without blocking the event loop
    expect(() => drizzleAdapter(db)).not.toThrow();

    db.$client.close();
  });
});
