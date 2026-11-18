import { randomUUID } from "node:crypto";

import { defineContract } from "@prisma/orm-postgres/contract-builder";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { textIdSchema } from "../test-utils/conformance-schemas.js";
import { postgresUrl } from "../test-utils/postgres.js";
import { prismaTestDatabase } from "../test-utils/prisma.js";
import { prismaModels } from "./models.js";

const url = postgresUrl();

const contract = defineContract({}, (helpers) => ({
  models: prismaModels(textIdSchema, helpers),
}));

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

describe.skipIf(url === undefined)(
  "Prisma spike: renamed tables through tx.sql",
  () => {
    beforeAll(async () => {
      // SAFETY: skipIf leaves this block unrun when url is undefined.
      database = await prismaTestDatabase(url ?? "", contract);
    });

    afterAll(async () => {
      await database?.drop();
    });

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
  }
);
