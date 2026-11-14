import { sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { integer, pgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AnySchema } from "../../schema/define-schema.js";
import { statusCodec } from "../../schema/status-codec.js";
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
import { bookingId, insert, newBooking } from "../../testing/fixtures.js";
import { conformanceCases, runCase, testAdapter } from "../../testing/index.js";
import type { TestAdapterParams } from "../../testing/index.js";
import { noOverlapConstraint } from "./backstop.js";
import { encodeBooking } from "./codec.js";
import { createDrizzleAdapter } from "./drizzle-adapter.js";
import {
  availabilityRuleTable,
  backstopSql,
  bookingTable,
  drizzleAdapter,
} from "./index.js";

const concurrencyCases = conformanceCases.filter((c) =>
  c.tags.includes("concurrency")
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

/** Register the Conformance Suite and the negative control for one schema, each case on emptied tables. */
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

  const constraint = noOverlapConstraint(schema);

  describe(schema.names.tables.booking, () => {
    describe("with the backstop", () => {
      beforeAll(async () => {
        // As a developer would: backstopSql in a custom migration after drizzle-kit's own.
        for (const statement of backstopSql(schema)) {
          // oxlint-disable-next-line no-await-in-loop -- in order: the extension before the constraint that needs it.
          await database.db.execute(sql.raw(statement));
        }
      });

      afterAll(async () => {
        await database.db.execute(
          sql`alter table ${booking} drop constraint ${sql.identifier(constraint)}`
        );
      });

      testAdapter(params);

      it("an overlap the backstop refuses has the driver error shape the 23P01 mapping reads", async () => {
        await params.reset();

        const b = newBooking(schema, {
          optionalFields: "null",
          resourceId: resources[0],
          status: "booked",
        });

        await insert(drizzleAdapter(database.db)(schema), b);

        // Through Drizzle directly: the 1.0 RC's DrizzleQueryError.cause, which the adapter's 23P01 check reads.
        await expect(
          database.db
            .insert(booking)
            .values(
              encodeBooking(statusCodec(schema), { ...b, id: bookingId() })
            )
        ).rejects.toMatchObject({ cause: { code: "23P01", constraint } });
      });
    });

    // Negative control: without the lock each concurrency case must fail, or the suite can't catch a missing lock.
    // Run without the backstop, which would refuse the overlap a missing lock lets through and so mask it.
    it.fails.each(concurrencyCases)("[lock off] $name", async (c) => {
      await expect(
        runCase(c, {
          ...params,
          makeAdapter: () => createDrizzleAdapter(database.db, { lock: false }),
        })
      ).resolves.toBeUndefined();
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
