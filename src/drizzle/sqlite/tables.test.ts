import {
  getTableConfig,
  integer,
  SQLiteDialect,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { definePlugin } from "../../framework/plugin.js";
import { column } from "../../schema/column.js";
import { defineSchema } from "../../schema/define-schema.js";
import { bookingTable, recordTables } from "./index.js";

type StaffId = number & { readonly __brand: "StaffId" };

const staff = sqliteTable("staff", {
  id: integer().primaryKey(),
  slug: text(),
});

/** Each column as [name, SQL type, Drizzle column type, NOT NULL, primary key]. */
function columnsOf(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table).columns.map((c) => [
    c.name,
    c.getSQLType(),
    c.columnType,
    c.notNull,
    c.primary,
  ]);
}

describe("bookingTable references (type tests: the @ts-expect-error lines are the assertions)", () => {
  it("type-checks a column that holds the Resource id type, brand included", () => {
    const schema = defineSchema({
      resource: { idType: column.integer<StaffId>() },
    });

    expect(() =>
      bookingTable(schema, { references: () => staff.id })
    ).not.toThrow();
  });

  it("does not type-check a text column for an integer idType", () => {
    const schema = defineSchema({
      resource: { idType: column.integer() },
    });

    expect(() =>
      // @ts-expect-error a text column can't hold an integer Resource id
      bookingTable(schema, { references: () => staff.slug })
    ).not.toThrow();
  });

  it("does not type-check an integer column for a text idType", () => {
    const schema = defineSchema({});

    expect(() =>
      // @ts-expect-error an integer column can't hold a text Resource id
      bookingTable(schema, { references: () => staff.id })
    ).not.toThrow();
  });
});

describe(bookingTable, () => {
  const schema = defineSchema({
    booking: {
      fields: {
        paid: { required: true, type: column.boolean() },
        ref: { required: false, type: column.uuid() },
        remindAt: { required: false, type: column.instant() },
        seats: { required: true, type: column.integer() },
      },
    },
    names: {
      columns: { booking: { id: "booking_id", start: "starts_at" } },
      tables: { booking: "appointments" },
    },
  });

  it("applies the physical names and column kinds, Instants as integer milliseconds", () => {
    const table = bookingTable(schema);

    expect(getTableConfig(table).name).toBe("appointments");
    expect(columnsOf(table)).toStrictEqual([
      ["booking_id", "text", "SQLiteText", true, true],
      ["resourceId", "text", "SQLiteText", true, false],
      ["starts_at", "integer", "SQLiteTimestamp", true, false],
      ["end", "integer", "SQLiteTimestamp", true, false],
      ["status", "text", "SQLiteText", true, false],
      ["paid", "integer", "SQLiteBoolean", true, false],
      ["ref", "text", "SQLiteText", false, false],
      ["remindAt", "integer", "SQLiteTimestamp", false, false],
      ["seats", "integer", "SQLiteInteger", true, false],
    ]);
    expect(
      getTableConfig(table).columns.find((c) => c.name === "starts_at")
    ).toMatchObject({ mode: "timestamp_ms" });
    expect(getTableConfig(table).foreignKeys).toHaveLength(0);
  });

  it("lists every stored Status in the CHECK constraint", () => {
    const withStatuses = defineSchema({
      booking: {
        statuses: {
          paid: { blocking: true },
          request: { blocking: false },
        },
      },
      names: { statuses: { paid: "PAID" } },
    });

    const [check] = getTableConfig(bookingTable(withStatuses)).checks;
    const query = check && new SQLiteDialect().sqlToQuery(check.value);

    expect(query?.sql).toBe(
      `"booking"."status" in ('booked', 'cancelled', 'PAID', 'request')`
    );
  });

  it("adds a foreign key with ON DELETE RESTRICT when given references", () => {
    const [fk] = getTableConfig(
      bookingTable(
        defineSchema({ resource: { idType: column.integer<StaffId>() } }),
        { references: () => staff.id }
      )
    ).foreignKeys;

    expect(fk?.reference().foreignTable).toBe(staff);
    expect(fk?.onDelete).toBe("restrict");
  });
});

describe(recordTables, () => {
  it("stores dates, times, JSON and dates lists as text; the id keeps its default (R4), the range only when timed", () => {
    const schema = defineSchema({
      plugins: [
        definePlugin({
          actions: {},
          name: "shifts",
          tables: {
            shift: {
              columns: {
                days: { required: true, type: column.dates() },
                on: { required: false, type: column.date() },
                rule: { required: true, type: column.json() },
                until: { required: true, type: column.time() },
              },
              timed: true,
            },
            tag: { columns: {}, timed: false },
          },
        }),
      ],
    });

    const { shift, tag } = recordTables(schema);

    expect(columnsOf(shift)).toStrictEqual([
      ["id", "text", "SQLiteText", true, true],
      ["resourceId", "text", "SQLiteText", true, false],
      ["start", "integer", "SQLiteTimestamp", true, false],
      ["end", "integer", "SQLiteTimestamp", true, false],
      ["days", "text", "SQLiteTextJson", true, false],
      ["on", "text", "SQLiteText", false, false],
      ["rule", "text", "SQLiteTextJson", true, false],
      ["until", "text", "SQLiteText", true, false],
    ]);
    expect(getTableConfig(shift).columns[0]?.defaultFn).toBeDefined();
    expect(columnsOf(tag).map(([name]) => name)).toStrictEqual([
      "id",
      "resourceId",
    ]);
  });
});
