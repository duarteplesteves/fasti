import {
  getTableConfig,
  integer,
  PgDialect,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { definePlugin } from "../../framework/plugin.js";
import { column } from "../../schema/column.js";
import { defineSchema } from "../../schema/define-schema.js";
import {
  backstopSql,
  blockTable,
  bookingTable,
  recordTables,
} from "./index.js";

type StaffId = number & { readonly __brand: "StaffId" };

const staff = pgTable("staff", { id: integer().primaryKey(), slug: text() });

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

describe(blockTable, () => {
  const schema = defineSchema({
    block: {
      fields: {
        note: { required: false, type: column.text() },
        reason: { required: true, type: column.text() },
      },
    },
    names: {
      columns: {
        block: {
          end: "ends_at",
          id: "off_id",
          reason: "why",
          resourceId: "staff_id",
          start: "starts_at",
        },
      },
      tables: { block: "time_off" },
    },
    resource: { idType: column.integer<StaffId>() },
  });

  it("applies the physical names and column types", () => {
    const config = getTableConfig(blockTable(schema));

    expect(config.name).toBe("time_off");
    expect(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull])
    ).toStrictEqual([
      ["off_id", "uuid", true],
      ["staff_id", "integer", true],
      ["starts_at", "timestamp (3) with time zone", true],
      ["ends_at", "timestamp (3) with time zone", true],
      ["note", "text", false],
      ["why", "text", true],
    ]);
    expect(config.primaryKeys).toHaveLength(0);
    expect(
      config.columns.find((c) => c.name === "off_id")?.primary
    ).toBeTruthy();
    expect(config.foreignKeys).toHaveLength(0);
  });

  it("adds a foreign key with ON DELETE RESTRICT when given references", () => {
    const [fk] = getTableConfig(
      blockTable(schema, { references: () => staff.id })
    ).foreignKeys;

    expect(fk?.reference().foreignTable).toBe(staff);
    expect(fk?.onDelete).toBe("restrict");
  });

  it("does not type-check on a schema without block", () => {
    expect(() =>
      // @ts-expect-error a schema without `block` has no Block table
      blockTable(defineSchema({}))
    ).toThrow(TypeError);
  });
});

describe(recordTables, () => {
  const plugin = definePlugin({
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
      tag: {
        columns: { label: { required: true, type: column.text() } },
        timed: false,
      },
    },
  });

  const schema = defineSchema({
    plugins: [plugin],
    resource: { idType: column.integer<StaffId>() },
  });

  it("builds one table per Plugin table: a database id default (R4), the range only when timed", () => {
    const { shift, tag } = recordTables(schema, { references: () => staff.id });
    const shiftConfig = getTableConfig(shift);

    expect(
      shiftConfig.columns.map((c) => [
        c.name,
        `${c.getSQLType()}${"[]".repeat(c.dimensions ?? 0)}`,
        c.notNull,
      ])
    ).toStrictEqual([
      ["id", "uuid", true],
      ["resourceId", "integer", true],
      ["start", "timestamp (3) with time zone", true],
      ["end", "timestamp (3) with time zone", true],
      ["days", "date[]", true],
      ["on", "date", false],
      ["rule", "jsonb", true],
      ["until", "time", true],
    ]);
    expect(shiftConfig.columns[0]?.default).toBeDefined();
    expect(shiftConfig.foreignKeys[0]?.reference().foreignTable).toBe(staff);
    expect(getTableConfig(tag).columns.map((c) => c.name)).toStrictEqual([
      "id",
      "resourceId",
      "label",
    ]);
  });
});

describe("declared Statuses in the database guards", () => {
  const schema = defineSchema({
    booking: {
      statuses: {
        paid: { blocking: true },
        request: { blocking: false },
      },
    },
    names: { statuses: { paid: "PAID" } },
  });

  it("lists a declared Status in the CHECK constraint", () => {
    const [check] = getTableConfig(bookingTable(schema)).checks;
    const query = check && new PgDialect().sqlToQuery(check.value);

    expect(query?.sql).toBe(
      `"booking"."status" in ('booked', 'cancelled', 'PAID', 'request')`
    );
  });

  it("lists a declared blocking Status, and only those, in backstopSql", () => {
    expect(backstopSql(schema)[1]).toMatch(
      /where \("status" in \('booked', 'PAID'\)\)$/u
    );
  });
});
