import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { defineContract } from "@prisma/orm-postgres/contract-builder";
import { drizzle } from "drizzle-orm/node-postgres";
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

import { defineAdapter } from "../adapter/contract.js";
import { drizzleAdapter } from "../drizzle/pg/index.js";
import { createScheduler } from "../framework/create-scheduler.js";
import { backstopSql, noOverlapConstraint } from "../schema/backstop-sql.js";
import type { AnySchema } from "../schema/define-schema.js";
import { physicalTable, tablesOf } from "../schema/table.js";
import {
  recordsResources,
  recordsSchema,
  runsOn,
  integerIdResources,
  integerIdSchema,
  textIdResources,
  textIdSchema,
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { postgresUrl } from "../test-utils/postgres.js";
import { prismaTestDatabase } from "../test-utils/prisma.js";
import { unwrap } from "../test-utils/results.js";
import { conformanceCases, runCase, testAdapter } from "../testing/index.js";
import type { TestAdapterParams, TxProbe } from "../testing/index.js";
import { prismaModels } from "./models.js";
import { createPrismaAdapter, prismaAdapter } from "./prisma-adapter.js";

const url = postgresUrl();

/**
 * The four Conformance schemas' tables, a scratch table of the developer's own for the `tx` probe,
 * and the developer's own Resource table, which the integer-id schema references.
 */
const contract = defineContract({}, (helpers) => {
  const testStaff = helpers
    .model("test_staff", {
      fields: {
        id: helpers.field.column(helpers.type.Int()).id().column("id"),
      },
    })
    .sql({ table: "test_staff" });

  return {
    models: {
      ...prismaModels(textIdSchema, helpers),
      ...prismaModels(uuidIdSchema, helpers),
      ...prismaModels(recordsSchema, helpers),
      ...prismaModels(integerIdSchema, helpers, {
        references: { field: "id", model: testStaff },
      }),
      test_staff: testStaff,
      test_probe: helpers
        .model("test_probe", {
          fields: {
            id: helpers.field.column(helpers.type.Uuid()).id().column("id"),
          },
        })
        .sql({ table: "test_probe" }),
    },
  };
});

let database: Awaited<ReturnType<typeof prismaTestDatabase<typeof contract>>>;

/** Strategy (a): the Booking table, looked up on `tx.sql` by a physical name only known at runtime. */
const bookingTable: string = textIdSchema.names.tables.booking;

/** Physical Booking column names, as the Adapter will hold them. */
const col = textIdSchema.names.columns.booking;

type Tx = Parameters<Parameters<typeof database.db.transaction>[0]>[0];

/** A value as the contract's codecs read and write it. */
type Value = string | number | boolean | Temporal.Instant | null;

/** A row, keyed by physical column name. */
type Row = Readonly<Record<string, Value>>;

/** A column or a condition of the builder; opaque to the spike. */
interface Expression {
  readonly buildAst: () => object;
}

/** Builds a `WHERE` from the column proxy and the operators. */
type Where = (
  f: Readonly<Partial<Record<string, Expression>>>,
  fns: {
    readonly and: (...conditions: Expression[]) => Expression;
    readonly eq: (column: Expression, value: Value) => Expression;
  }
) => Expression;

/** The column `name` of the builder's column proxy. */
function ref(
  f: Readonly<Partial<Record<string, Expression>>>,
  name: string
): Expression {
  const column = f[name];

  if (column === undefined) {
    throw new Error(`No column ${name}`);
  }

  return column;
}

/** A built plan, for `tx.query` / `tx.execute`. */
interface Plan {
  readonly build: () => Parameters<Tx["query"]>[0];
}

/** The part of a `tx.sql` table builder the spike uses. Untyped: the price of a runtime name. */
interface AnyTable {
  readonly insert: (rows: readonly Row[]) => Plan & {
    readonly returning: (...columns: string[]) => Plan;
  };
  readonly select: (...columns: string[]) => {
    readonly where: (where: Where) => Plan;
  };
  readonly update: (set: Row) => {
    readonly where: (where: Where) => {
      readonly returning: (...columns: string[]) => Plan;
    };
  };
}

/** The table builder of `bookingTable`, looked up by name at runtime. */
function booking(tx: Tx): AnyTable {
  // SAFETY: the contract declares `bookingTable`; tx.sql.public is keyed by physical table name.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the typed builder can't be indexed by a runtime string.
  const tables = tx.sql.public as unknown as Readonly<
    Partial<Record<string, AnyTable>>
  >;

  const table = tables[bookingTable];

  if (table === undefined) {
    throw new Error(`No table ${bookingTable} on tx.sql.public`);
  }

  return table;
}

/** Run a row-returning plan. */
async function query(tx: Tx, plan: Plan): Promise<readonly Row[]> {
  // SAFETY: a plan's rows hold the columns it returns, decoded by the contract's codecs.
  return (await tx.query(plan.build())) as readonly Row[];
}

/** A Booking row in physical column names (the SQL builder addresses storage columns). */
function row(id: string, status: string) {
  return {
    t_booking_id: id,
    t_count: 1,
    t_ends_at: Temporal.Instant.from("2026-03-02T10:30:00.123Z"),
    t_label: "first",
    t_label_opt: null,
    t_paid: false,
    t_ref: randomUUID(),
    t_remind_at: Temporal.Instant.from("2026-03-01T09:00:00Z"),
    t_staff_id: "staff-a",
    t_starts_at: Temporal.Instant.from("2026-03-02T10:00:00.123Z"),
    t_state: status,
  };
}

const concurrencyCases = conformanceCases.filter((c) =>
  c.tags.includes("concurrency")
);

const probe: TxProbe<Tx> = {
  async count() {
    const rows = await database.db.query(
      database.db.sql.public.test_probe.select("id").build()
    );

    return rows.length;
  },
  async write(tx) {
    await tx.execute(
      tx.sql.public.test_probe.insert([{ id: randomUUID() }]).build()
    );
  },
};

/** Empty `schema`'s tables and the probe's, outside Prisma. */
async function truncate(schema: AnySchema): Promise<void> {
  const { tables } = schema.names;

  // The Plugin tables by physical name: availability()'s and blocks()' are the 0.6 rule and Block tables.
  const names = new Set([
    `"${tables.booking}"`,
    ...Object.keys(tablesOf(schema.plugins)).map(
      (t) => `"${physicalTable(schema, t)}"`
    ),
    "test_probe",
  ]);

  await database.pool.query(`truncate ${[...names].join(", ")}`);
}

/** `hour`:00 UTC on Monday 3 June 2030. */
function at(hour: number): Temporal.Instant {
  return Temporal.Instant.from("2030-06-03T00:00:00Z").add({ hours: hour });
}

/** Add `schema`'s backstop, as a developer would through `prisma migration new`'s raw SQL. */
async function applyBackstop(schema: AnySchema): Promise<void> {
  for (const statement of backstopSql(schema)) {
    await database.pool.query(statement);
  }
}

/** Drop `schema`'s backstop. */
async function dropBackstop(schema: AnySchema): Promise<void> {
  await database.pool.query(
    `alter table ${schema.names.tables.booking} drop constraint ${noOverlapConstraint(schema)}`
  );
}

/** A unit statement that raises `code` from the database. */
function raise(tx: Tx, code: "40001" | "P0001") {
  return code === "40001"
    ? tx.raw
        .sql`do $$ begin raise exception 'test' using errcode = '40001'; end $$`
        .affectedCount()
        .build()
    : tx.raw
        .sql`do $$ begin raise exception 'test' using errcode = 'P0001'; end $$`
        .affectedCount()
        .build();
}

/** Register the Conformance Suite and the negative control for one schema, each case on emptied tables. */
function suite<S extends AnySchema>(
  schema: S,
  resources: TestAdapterParams<S, Tx>["resources"]
): void {
  const params: TestAdapterParams<S, Tx> = {
    groups: {
      backstop: true,
      retry: { transient: () => ({ code: "40001" }) },
      tx: probe,
    },
    makeAdapter: () => prismaAdapter(database.db),
    reset: async () => {
      await truncate(schema);
    },
    resources,
    schema,
  };

  describe(schema.names.tables.booking, () => {
    describe("with the backstop", () => {
      beforeAll(async () => {
        await applyBackstop(schema);
      });

      afterAll(async () => {
        await dropBackstop(schema);
      });

      testAdapter(params);
    });

    // Negative control: without the lock each concurrency case must fail, or the suite can't catch a missing lock.
    // Run without the backstop, which would refuse the overlap a missing lock lets through and so mask it.
    // Cases skipped for this schema are left out too, so a failure there would prove nothing.
    it.fails.each(concurrencyCases.filter((c) => runsOn(c, schema)))(
      "[lock off] $name",
      async (c) => {
        await expect(
          runCase(c, {
            ...params,
            makeAdapter: () =>
              createPrismaAdapter(database.db, { lock: false }),
          })
        ).resolves.toBeUndefined();
      }
    );
  });
}

/** The Prisma Adapter's own tests, on the database the spike's contract built. */
function adapterTests(): void {
  describe(prismaAdapter, () => {
    suite(textIdSchema, textIdResources);
    suite(uuidIdSchema, uuidIdResources);
    // No `block`: no Block table exists for it, and none is needed.
    suite(integerIdSchema, integerIdResources);
    suite(recordsSchema, recordsResources);

    it("a driver error gives AdapterError with the Prisma error as cause", async () => {
      await truncate(uuidIdSchema);

      const table = uuidIdSchema.names.tables.booking;

      await database.pool.query(`
        create function fasti_test_fail() returns trigger language plpgsql
        as $$ begin raise exception 'test' using errcode = 'P0001'; end $$`);
      await database.pool.query(
        `create trigger fasti_test_fail before insert on ${table} for each row execute function fasti_test_fail()`
      );

      try {
        const scheduler = createScheduler({
          adapter: prismaAdapter(database.db),
          policies: [],
          schema: uuidIdSchema,
        });

        const start = Temporal.Instant.from("2030-06-03T09:00:00Z");

        await scheduler.availability.set({
          resourceId: uuidIdResources[0],
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

        const result = await scheduler.book({
          end: start.add({ hours: 1 }),
          resourceId: uuidIdResources[0],
          start,
        });

        assert(!result.ok, "expected an error");
        expect(result.error).toMatchObject({
          _tag: "AdapterError",
          cause: {
            cause: { sqlState: "P0001" },
            message: "prismaAdapter: insertBooking failed",
          },
        });
      } finally {
        await database.pool.query(
          `drop trigger fasti_test_fail on ${table}; drop function fasti_test_fail()`
        );
      }
    });

    describe("references: the foreign key to the developer's Resource table", () => {
      const visits = integerIdSchema.names.tables.booking;
      const c = integerIdSchema.names.columns.booking;

      /** Insert a Booking for `staffId` straight into the table, past the Adapter. */
      async function insertVisit(staffId: number): Promise<void> {
        await database.pool.query(
          `insert into ${visits} (${c.id}, ${c.resourceId}, ${c.start}, ${c.end}, ${c.status})
           values (gen_random_uuid(), $1, now(), now() + interval '1 hour', '1')`,
          [staffId]
        );
      }

      it("rejects a Booking for a Resource that doesn't exist", async () => {
        await truncate(integerIdSchema);

        await expect(insertVisit(999)).rejects.toMatchObject({
          code: "23503",
        });
      });

      it("rejects deleting a Resource that still has Bookings: ON DELETE RESTRICT", async () => {
        await truncate(integerIdSchema);
        await insertVisit(integerIdResources[0]);

        try {
          // restrict_violation: RESTRICT's own code; NO ACTION would give 23503.
          await expect(
            database.pool.query("delete from test_staff where id = $1", [
              integerIdResources[0],
            ])
          ).rejects.toMatchObject({ code: "23001" });
        } finally {
          await truncate(integerIdSchema);
        }
      });
    });

    // Each Adapter gets its own spelling: a uuid's spellings are one Resource, so they must share the lock.
    it.each([
      {
        drizzleId: textIdResources[0],
        prismaId: textIdResources[0],
        schema: textIdSchema,
      },
      {
        drizzleId: uuidIdResources[0],
        prismaId: `{${uuidIdResources[0].toUpperCase()}}`,
        schema: uuidIdSchema,
      },
    ])(
      "units through the Drizzle Postgres Adapter ($drizzleId) and the Prisma Adapter ($prismaId) on one Resource never interleave",
      async ({ drizzleId, prismaId, schema }) => {
        const viaDrizzle = drizzleAdapter(drizzle({ client: database.pool }))(
          schema
        );

        const viaPrisma = prismaAdapter(database.db)(schema);
        const log: string[] = [];

        /** A unit that logs its entry and exit, with time between for another unit to slip in. */
        async function logged(name: string): Promise<void> {
          log.push(`enter ${name}`);
          await sleep(2);
          log.push(`exit ${name}`);
        }

        await Promise.all(
          Array.from({ length: 10 }, async (_, i) => {
            await Promise.all([
              viaDrizzle.withResourceLock(drizzleId, async () => {
                await logged(`drizzle ${i}`);
              }),
              viaPrisma.withResourceLock(prismaId, async () => {
                await logged(`prisma ${i}`);
              }),
            ]);
          })
        );

        expect(log).toHaveLength(40);

        for (let i = 0; i < log.length; i += 2) {
          expect(log[i + 1]).toBe(log[i]?.replace("enter", "exit"));
        }
      }
    );

    it("an overlap the backstop refuses names fasti's constraint on Prisma's error", async () => {
      await truncate(textIdSchema);
      await applyBackstop(textIdSchema);

      try {
        // Open Question 4: Prisma's SqlQueryError carries `constraint`, so only fasti's counts as a conflict.
        await expect(
          database.db.transaction(async (tx) => {
            await tx.execute(
              booking(tx)
                .insert([row(randomUUID(), "T_CONFIRMED")])
                .build()
            );
            await tx.execute(
              booking(tx)
                .insert([row(randomUUID(), "T_CONFIRMED")])
                .build()
            );
          })
        ).rejects.toMatchObject({
          constraint: noOverlapConstraint(textIdSchema),
          sqlState: "23P01",
        });
      } finally {
        await dropBackstop(textIdSchema);
      }
    });

    describe("transient errors (ADR 008)", () => {
      const [roomA, roomB] = uuidIdResources;
      const start = Temporal.Instant.from("2030-06-03T09:00:00Z");
      const slot = { end: start.add({ hours: 1 }), start };

      beforeEach(async () => {
        await truncate(uuidIdSchema);

        const scheduler = createScheduler({
          adapter: prismaAdapter(database.db),
          policies: [],
          schema: uuidIdSchema,
        });

        for (const resourceId of uuidIdResources) {
          await scheduler.availability.set({
            resourceId,
            rules: [
              {
                exceptions: [],
                recurrence: {
                  daysOfWeek: [1],
                  frequency: "weekly",
                  interval: 1,
                },
                timeWindow: {
                  end: Temporal.PlainTime.from("17:00"),
                  start: Temporal.PlainTime.from("09:00"),
                },
                timezone: "UTC",
              },
            ],
          });
        }
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it("two `also` writes through tx that deadlock both commit on retry", async () => {
        const scheduler = createScheduler({
          adapter: prismaAdapter(database.db),
          policies: [],
          schema: uuidIdSchema,
        });

        const rows = [randomUUID(), randomUUID()] as const;

        await database.pool.query(
          "insert into test_probe (id) values ($1), ($2)",
          [...rows]
        );

        // Both units hold their first row before either asks for its second: a deadlock.
        let arrived = 0;
        const bothHold = Promise.withResolvers<undefined>();

        /** An `also` that locks the probe rows in this order through `tx`. */
        function lockInOrder(first: string, second: string) {
          return async ({ tx }: { readonly tx: Tx }) => {
            await tx.execute(
              tx.raw
                .sql`select 1 from test_probe where id = ${first}::uuid for update`
                .affectedCount()
                .build()
            );
            arrived += 1;

            if (arrived === 2) {
              bothHold.resolve(undefined);
            }

            await bothHold.promise;
            await tx.execute(
              tx.raw
                .sql`select 1 from test_probe where id = ${second}::uuid for update`
                .affectedCount()
                .build()
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

        const reads = prismaAdapter(database.db)(uuidIdSchema);

        for (const result of results) {
          await expect(
            reads.getBooking(unwrap(result).id)
          ).resolves.not.toBeNull();
        }
      });

      it("a unit that always fails with 40001 rejects after 3 attempts", async () => {
        let attempts = 0;
        const adapter = prismaAdapter(database.db)(uuidIdSchema);

        await expect(
          adapter.withResourceLock(roomA, async ({ tx }) => {
            attempts += 1;
            await tx.execute(raise(tx, "40001"));
          })
        ).rejects.toMatchObject({ sqlState: "40001" });
        expect(attempts).toBe(3);
      });

      it("a non-transient error isn't retried", async () => {
        let attempts = 0;
        const adapter = prismaAdapter(database.db)(uuidIdSchema);

        await expect(
          adapter.withResourceLock(roomA, async ({ tx }) => {
            attempts += 1;
            await tx.execute(raise(tx, "P0001"));
          })
        ).rejects.toMatchObject({ sqlState: "P0001" });
        expect(attempts).toBe(1);
      });

      it("through the Framework, 40001 from fasti's own verb is an AdapterError after 3 transactions", async () => {
        const table = uuidIdSchema.names.tables.booking;

        await database.pool.query(`
          create function fasti_test_fail() returns trigger language plpgsql
          as $$ begin raise exception 'test' using errcode = '40001'; end $$`);
        await database.pool.query(
          `create trigger fasti_test_fail before insert on ${table} for each row execute function fasti_test_fail()`
        );

        try {
          const transaction = vi.spyOn(database.db, "transaction");

          const scheduler = createScheduler({
            adapter: prismaAdapter(database.db),
            policies: [],
            schema: uuidIdSchema,
          });

          const result = await scheduler.book({ ...slot, resourceId: roomA });

          assert(!result.ok, "expected an error");
          expect(result.error).toMatchObject({
            _tag: "AdapterError",
            cause: {
              cause: { sqlState: "40001" },
              message: "prismaAdapter: insertBooking failed",
            },
          });
          expect(transaction).toHaveBeenCalledTimes(3);
        } finally {
          await database.pool.query(
            `drop trigger fasti_test_fail on ${table}; drop function fasti_test_fail()`
          );
        }
      });
    });

    describe("reschedule with the backstop", () => {
      const schema = uuidIdSchema;
      const [room] = uuidIdResources;

      beforeAll(async () => {
        await applyBackstop(schema);
      });

      afterAll(async () => {
        await dropBackstop(schema);
      });

      it("gives SlotConflict when the backstop catches an outside write the lock missed", async () => {
        await truncate(schema);

        const inner = prismaAdapter(database.db);
        const plain = createScheduler({ adapter: inner, policies: [], schema });

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
        const adapter = defineAdapter<Tx, "records">((s) => {
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
          adapter,
          policies: [],
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
}

describe.skipIf(url === undefined)("Prisma on Postgres", () => {
  beforeAll(async () => {
    // SAFETY: skipIf leaves this block unrun when url is undefined.
    database = await prismaTestDatabase(url ?? "", contract);
    await database.pool.query(
      `insert into test_staff (id) values ${integerIdResources.map((id) => `(${id})`).join(", ")}`
    );
  });

  afterAll(async () => {
    await database?.drop();
  });

  describe("on a database whose default isolation is repeatable read", () => {
    let strict: typeof database;

    beforeAll(async () => {
      const strictUrl = new URL(url ?? "");

      strictUrl.searchParams.set(
        "options",
        "-c default_transaction_isolation=repeatable\\ read"
      );
      strict = await prismaTestDatabase(strictUrl.toString(), contract);
    });

    afterAll(async () => {
      await strict?.drop();
    });

    it.each(concurrencyCases.filter((c) => runsOn(c, textIdSchema)))(
      "$name",
      async (c) => {
        await expect(
          runCase(c, {
            // No backstop: it would mask a lock that doesn't hold.
            groups: { backstop: false, retry: null, tx: null },
            makeAdapter: () => prismaAdapter(strict.db),
            reset: async () => {
              const names = textIdSchema.names.tables;

              await strict.pool.query(
                `truncate "${names.booking}", "${names.availabilityRule}", "${names.block}"`
              );
            },
            resources: textIdResources,
            schema: textIdSchema,
          })
        ).resolves.toBeUndefined();
      }
    );
  });

  describe("spike: renamed tables through tx.sql", () => {
    it("inserts and selects a Booking on a table named at runtime", async () => {
      const id = randomUUID();

      const [inserted, selected] = await database.db.transaction(async (tx) => {
        const t = booking(tx);

        return [
          await query(
            tx,
            t.insert([row(id, "T_CONFIRMED")]).returning("t_booking_id")
          ),
          await query(
            tx,
            t
              .select(
                "t_booking_id",
                "t_staff_id",
                "t_starts_at",
                "t_label_opt"
              )
              .where((f, fns) => fns.eq(ref(f, col.id), id))
          ),
        ];
      });

      expect(inserted).toStrictEqual([{ t_booking_id: id }]);
      expect(selected).toHaveLength(1);
      expect(selected[0]).toMatchObject({
        t_booking_id: id,
        t_label_opt: null,
        t_staff_id: "staff-a",
      });
      // A Temporal.Instant, to the millisecond.
      expect(String(selected[0]?.["t_starts_at"])).toBe(
        "2026-03-02T10:00:00.123Z"
      );
    });

    it("updates with compare-and-set and returning: a stale expected row changes nothing", async () => {
      const id = randomUUID();

      /** Move the Booking to `to` only while it still is `from` with no `labelOpt`. */
      function casPlan(tx: Tx, from: string, to: string) {
        return booking(tx)
          .update({ t_state: to })
          .where((f, fns) =>
            fns.and(
              fns.eq(ref(f, col.id), id),
              fns.eq(ref(f, col.status), from),
              fns.eq(ref(f, col.labelOpt), null)
            )
          )
          .returning("t_booking_id", "t_state");
      }

      const [changed, stale] = await database.db.transaction(async (tx) => {
        await tx.execute(
          booking(tx)
            .insert([row(id, "T_CONFIRMED")])
            .build()
        );

        return [
          await query(tx, casPlan(tx, "T_CONFIRMED", "T_VOID")),
          await query(tx, casPlan(tx, "T_CONFIRMED", "T_VOID")),
        ];
      });

      expect(changed).toStrictEqual([{ t_booking_id: id, t_state: "T_VOID" }]);
      expect(stale).toStrictEqual([]);
    });

    it("rejects a Status that isn't a stored value: the CHECK is in the database", async () => {
      await expect(
        database.db.transaction(
          async (tx) =>
            await tx.execute(
              booking(tx)
                .insert([row(randomUUID(), "UNKNOWN")])
                .build()
            )
        )
      ).rejects.toThrow(/check constraint/iu);
    });
  });

  adapterTests();
});
