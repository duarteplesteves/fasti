import { randomUUID } from "node:crypto";

import { count, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { integer, pgTable, uuid } from "drizzle-orm/pg-core";
import {
  assert,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { defineAdapter } from "../../adapter/contract.js";
import { createScheduler } from "../../framework/create-scheduler.js";
import { noOverlapConstraint } from "../../schema/backstop-sql.js";
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
import { unwrap } from "../../test-utils/results.js";
import { bookingId, insert, newBooking } from "../../testing/fixtures.js";
import { conformanceCases, runCase, testAdapter } from "../../testing/index.js";
import type { TestAdapterParams, TxProbe } from "../../testing/index.js";
import { encodeBooking } from "../codec.js";
import { createDrizzleAdapter } from "./drizzle-adapter.js";
import {
  availabilityRuleTable,
  backstopSql,
  blockTable,
  bookingTable,
  drizzleAdapter,
} from "./index.js";

const concurrencyCases = conformanceCases.filter((c) =>
  c.tags.includes("concurrency")
);

/** The developer's own Resource table, which the integer-id schema references. */
const testStaff = pgTable("test_staff", { id: integer().primaryKey() });

/** The developer's own Resource table, which the uuid-id schema's Blocks reference. */
const testRooms = pgTable("test_rooms", { id: uuid().primaryKey() });

/** A scratch table of the developer's own, written through `tx` by the `tx` probe. */
const testProbe = pgTable("test_probe", { id: uuid().primaryKey() });

/** What `drizzleAdapter(database.db)` hands a unit of work as `tx`. */
type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

const probe: TxProbe<Tx> = {
  async count() {
    const [row] = await database.db.select({ n: count() }).from(testProbe);

    return row?.n ?? 0;
  },
  async write(tx) {
    await tx.insert(testProbe).values({ id: randomUUID() });
  },
};

const tables = {
  integerBooking: bookingTable(integerIdSchema, {
    references: () => testStaff.id,
  }),
  integerRule: availabilityRuleTable(integerIdSchema, {
    references: () => testStaff.id,
  }),
  testProbe,
  testRooms,
  testStaff,
  textBlock: blockTable(textIdSchema),
  textBooking: bookingTable(textIdSchema),
  textRule: availabilityRuleTable(textIdSchema),
  uuidBlock: blockTable(uuidIdSchema, { references: () => testRooms.id }),
  uuidBooking: bookingTable(uuidIdSchema),
  uuidRule: availabilityRuleTable(uuidIdSchema),
};

/** A statement that raises `code` from the database, as a driver error. */
function raise(code: string): SQL {
  return sql.raw(
    `do $$ begin raise exception 'test' using errcode = '${code}'; end $$`
  );
}

const url = postgresUrl();

/** `hour`:00 UTC on Monday 3 June 2030. */
function at(hour: number): Temporal.Instant {
  return Temporal.Instant.from("2030-06-03T00:00:00Z").add({ hours: hour });
}

let database: TestDatabase;

/** Register the Conformance Suite and the negative control for one schema, each case on emptied tables. */
function suite<S extends AnySchema>(
  schema: S,
  booking: AnyPgTable,
  others: readonly AnyPgTable[],
  resources: TestAdapterParams<S, Tx>["resources"]
): void {
  const params: TestAdapterParams<S, Tx> = {
    groups: {
      backstop: true,
      retry: { transient: () => ({ code: "40001" }) },
      tx: probe,
    },
    makeAdapter: () => drizzleAdapter(database.db),
    reset: async () => {
      await database.db.execute(
        sql`truncate ${sql.join(
          [booking, ...others].map((t) => sql`${t}`),
          sql`, `
        )}`
      );
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
    // Blocks cases are skipped without `block`, so a failure there would prove nothing.
    it.fails.each(
      concurrencyCases.filter(
        (c) => schema.block !== null || !c.tags.includes("blocks")
      )
    )("[lock off] $name", async (c) => {
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
    await database.db
      .insert(testRooms)
      .values(uuidIdResources.map((id) => ({ id })));
  });

  afterAll(async () => {
    await database?.drop();
  });

  suite(
    textIdSchema,
    tables.textBooking,
    [tables.textRule, tables.textBlock],
    textIdResources
  );
  suite(
    uuidIdSchema,
    tables.uuidBooking,
    [tables.uuidRule, tables.uuidBlock],
    uuidIdResources
  );
  // No `block`: no Block table exists in the database, and none is needed.
  suite(
    integerIdSchema,
    tables.integerBooking,
    [tables.integerRule],
    integerIdResources
  );

  it("a Block whose Resource id breaks the foreign key gives AdapterError with the driver's cause", async () => {
    const scheduler = createScheduler({
      policies: [],
      adapter: drizzleAdapter(database.db),
      schema: uuidIdSchema,
    });

    const start = Temporal.Instant.from("2030-06-03T09:00:00Z");

    const result = await scheduler.blocks.create({
      end: start.add({ hours: 1 }),
      resourceId: "0193b6e2-7c00-7000-8000-0000000000ff",
      start,
    });

    assert(!result.ok, "expected an error");
    expect(result.error).toMatchObject({
      _tag: "AdapterError",
      cause: {
        cause: { code: "23503" },
        message: "drizzleAdapter: insertBlock failed",
      },
    });
  });

  describe("transient errors (ADR 008)", () => {
    const [roomA, roomB] = uuidIdResources;
    const start = Temporal.Instant.from("2030-06-03T09:00:00Z");
    const slot = { end: start.add({ hours: 1 }), start };

    beforeEach(async () => {
      await database.db.execute(
        sql`truncate ${tables.uuidBooking}, ${tables.uuidRule}, ${testProbe}`
      );

      const scheduler = createScheduler({
        policies: [],
        adapter: drizzleAdapter(database.db),
        schema: uuidIdSchema,
      });

      for (const resourceId of uuidIdResources) {
        // oxlint-disable-next-line no-await-in-loop -- two Resources, setup only.
        await scheduler.availability.set({
          resourceId,
          rules: [
            {
              exceptions: [],
              recurrence: {
                daysOfWeek: [1, 2, 3, 4, 5],
                frequency: "weekly",
                interval: 1,
              },
              timeWindow: {
                end: Temporal.PlainTime.from("17:00"),
                start: Temporal.PlainTime.from("09:00"),
              },
              timezone: "Europe/Lisbon",
            },
          ],
        });
      }
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("an `also` that deadlocks with a concurrent unit through tx succeeds on retry, and both Actions commit", async () => {
      const scheduler = createScheduler({
        policies: [],
        adapter: drizzleAdapter(database.db),
        schema: uuidIdSchema,
      });

      const rows = [randomUUID(), randomUUID()] as const;

      await database.db.insert(testProbe).values(rows.map((id) => ({ id })));

      // Both units hold their first row before either asks for its second: a deadlock.
      let arrived = 0;
      const bothHold = Promise.withResolvers<undefined>();

      /** An `also` that locks the probe rows in this order through `tx`. */
      function lockInOrder(first: string, second: string) {
        return async ({ tx }: { readonly tx: Tx }) => {
          await tx.execute(
            sql`select 1 from ${testProbe} where id = ${first} for update`
          );
          arrived += 1;

          if (arrived === 2) {
            bothHold.resolve(undefined);
          }

          await bothHold.promise;
          await tx.execute(
            sql`select 1 from ${testProbe} where id = ${second} for update`
          );

          return { ok: true, value: null } as const;
        };
      }

      const results = await Promise.all([
        scheduler.book({
          ...slot,
          also: lockInOrder(rows[0], rows[1]),
          resourceId: roomA,
        }),
        scheduler.book({
          ...slot,
          also: lockInOrder(rows[1], rows[0]),
          resourceId: roomB,
        }),
      ]);

      const reads = drizzleAdapter(database.db)(uuidIdSchema);

      for (const result of results) {
        // oxlint-disable-next-line no-await-in-loop -- two results.
        await expect(
          reads.getBooking(unwrap(result).id)
        ).resolves.not.toBeNull();
      }
    });

    it("a unit that always fails with 40001 rejects after 3 attempts", async () => {
      let attempts = 0;
      const adapter = drizzleAdapter(database.db)(uuidIdSchema);

      await expect(
        adapter.withResourceLock(roomA, async ({ tx }) => {
          attempts += 1;
          await tx.execute(raise("40001"));
        })
      ).rejects.toMatchObject({ cause: { code: "40001" } });
      expect(attempts).toBe(3);
    });

    it("a non-transient error isn't retried", async () => {
      let attempts = 0;
      const adapter = drizzleAdapter(database.db)(uuidIdSchema);

      await expect(
        adapter.withResourceLock(roomA, async ({ tx }) => {
          attempts += 1;
          await tx.execute(raise("P0001"));
        })
      ).rejects.toMatchObject({ cause: { code: "P0001" } });
      expect(attempts).toBe(1);
    });

    it("through the Framework, 40001 from `also` rejects after 3 attempts", async () => {
      const scheduler = createScheduler({
        policies: [],
        adapter: drizzleAdapter(database.db),
        schema: uuidIdSchema,
      });

      let attempts = 0;

      await expect(
        scheduler.book({
          ...slot,
          also: async ({ tx }) => {
            attempts += 1;
            await tx.execute(raise("40001"));

            return { ok: true, value: null };
          },
          resourceId: roomA,
        })
      ).rejects.toMatchObject({ cause: { code: "40001" } });
      expect(attempts).toBe(3);
    });

    it("through the Framework, 40001 from fasti's own verb is an AdapterError after 3 attempts", async () => {
      const table = sql`${tables.uuidBooking}`;

      await database.db.execute(sql`
        create function fasti_test_fail() returns trigger language plpgsql
        as $$ begin raise exception 'test' using errcode = '40001'; end $$`);
      await database.db.execute(
        sql`create trigger fasti_test_fail before insert on ${table} for each row execute function fasti_test_fail()`
      );

      try {
        const transaction = vi.spyOn(database.db, "transaction");

        const scheduler = createScheduler({
          policies: [],
          adapter: drizzleAdapter(database.db),
          schema: uuidIdSchema,
        });

        const result = await scheduler.book({ ...slot, resourceId: roomA });

        assert(!result.ok, "expected an error");
        expect(result.error).toMatchObject({
          _tag: "AdapterError",
          cause: {
            cause: { code: "40001" },
            message: "drizzleAdapter: insertBooking failed",
          },
        });
        expect(transaction).toHaveBeenCalledTimes(3);
      } finally {
        await database.db.execute(
          sql`drop trigger fasti_test_fail on ${table}; drop function fasti_test_fail()`
        );
      }
    });
  });

  describe("reschedule with the backstop", () => {
    const schema = uuidIdSchema;
    const [room] = uuidIdResources;

    beforeAll(async () => {
      for (const statement of backstopSql(schema)) {
        // oxlint-disable-next-line no-await-in-loop -- in order: the extension before the constraint that needs it.
        await database.db.execute(sql.raw(statement));
      }
    });

    afterAll(async () => {
      await database.db.execute(
        sql`alter table ${tables.uuidBooking} drop constraint ${sql.identifier(noOverlapConstraint(schema))}`
      );
    });

    it("gives SlotConflict when the backstop catches an outside write the lock missed", async () => {
      await database.db.execute(
        sql`truncate ${tables.uuidBooking}, ${tables.uuidRule}, ${tables.uuidBlock}`
      );

      const inner = drizzleAdapter(database.db);
      const plain = createScheduler({ policies: [], adapter: inner, schema });

      await plain.availability.set({
        resourceId: room,
        rules: [
          {
            exceptions: [],
            recurrence: { daysOfWeek: [1], frequency: "weekly", interval: 1 },
            timeWindow: {
              end: Temporal.PlainTime.from("17:00"),
              start: Temporal.PlainTime.from("09:00"),
            },
            timezone: "UTC",
          },
        ],
      });

      const moving = await plain.book({
        end: at(11),
        resourceId: room,
        start: at(10),
      });

      const outside = await plain.book({
        end: at(15),
        resourceId: room,
        start: at(14),
      });

      assert(moving.ok && outside.ok, "expected both seed bookings");

      // Hides the outside Booking from the unit's first read, as a write the lock can't see would be.
      const adapter = defineAdapter<Tx, "blocks">((s) => {
        const raw = inner(s);

        return {
          ...raw,
          withResourceLock: async (id, work) =>
            await raw.withResourceLock(id, async (locked) => {
              let reads = 0;

              return await work({
                ...locked,
                listBookings: async (q) => {
                  reads += 1;

                  return reads === 1 ? [] : await locked.listBookings(q);
                },
              });
            }),
        };
      });

      const result = await createScheduler({
        policies: [],
        adapter,
        schema,
      }).reschedule({
        end: at(15),
        id: moving.value.id,
        start: at(14),
      });

      expect(result).toStrictEqual({
        error: {
          _tag: "SlotConflict",
          conflicts: [
            {
              end: at(15),
              id: outside.value.id,
              kind: "booking",
              start: at(14),
            },
          ],
        },
        ok: false,
      });
    });
  });
});
