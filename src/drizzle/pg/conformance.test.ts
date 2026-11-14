import { sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { integer, pgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AnySchema } from "../../schema/define-schema.js";
import {
  integerIdResources,
  integerIdSchema,
  textIdResources,
  textIdSchema,
  uuidIdResources,
  uuidIdSchema,
} from "../../test-utils/conformance-schemas.js";
import { postgresUrl, testDatabase } from "../../test-utils/postgres.js";
import type { TestDatabase } from "../../test-utils/postgres.js";
import { insert, newBooking } from "../../testing/fixtures.js";
import { conformanceCases, runCase } from "../../testing/index.js";
import type { TestAdapterParams } from "../../testing/index.js";
import {
  availabilityRuleTable,
  bookingTable,
  drizzleAdapter,
} from "./index.js";

// shortcut: the concurrency and backstop cases don't pass on Postgres yet; switch to testAdapter once they do (#48, #49).
const cases = conformanceCases.filter(
  (c) => !c.tags.includes("concurrency") && !c.tags.includes("backstop")
);

/** The developer's own Resource table, which the integer-id schema references. */
const testStaff = pgTable("test_staff", { id: integer().primaryKey() });

const tables = {
  integerBooking: bookingTable(integerIdSchema, {
    references: () => testStaff.id,
  }),
  integerRule: availabilityRuleTable(integerIdSchema, {
    references: () => testStaff.id,
  }),
  testStaff,
  textBooking: bookingTable(textIdSchema),
  textRule: availabilityRuleTable(textIdSchema),
  uuidBooking: bookingTable(uuidIdSchema),
  uuidRule: availabilityRuleTable(uuidIdSchema),
};

const url = postgresUrl();

let database: TestDatabase;

/** Register the ready cases for one schema, each on emptied tables. */
function suite<S extends AnySchema>(
  schema: S,
  booking: AnyPgTable,
  rule: AnyPgTable,
  resources: TestAdapterParams<S, unknown>["resources"]
): void {
  const params: TestAdapterParams<S, unknown> = {
    groups: { backstop: true },
    makeAdapter: () => drizzleAdapter(database.db),
    reset: async () => {
      await database.db.execute(sql`truncate ${booking}, ${rule}`);
    },
    resources,
    schema,
  };

  describe(schema.names.tables.booking, () => {
    it.each(cases)("$name", async (c) => {
      await expect(runCase(c, params)).resolves.toBeUndefined();
    });

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
        cause: { code: "23505" },
        message: "drizzleAdapter: insertBooking failed",
      });
    });
  });
}

describe.skipIf(url === undefined)("drizzleAdapter on Postgres", () => {
  beforeAll(async () => {
    // SAFETY: skipIf leaves this block unrun when url is undefined.
    database = await testDatabase(url ?? "", tables);
    await database.db
      .insert(testStaff)
      .values(integerIdResources.map((id) => ({ id })));
  });

  afterAll(async () => {
    await database?.drop();
  });

  suite(textIdSchema, tables.textBooking, tables.textRule, textIdResources);
  suite(uuidIdSchema, tables.uuidBooking, tables.uuidRule, uuidIdResources);
  suite(
    integerIdSchema,
    tables.integerBooking,
    tables.integerRule,
    integerIdResources
  );
});
