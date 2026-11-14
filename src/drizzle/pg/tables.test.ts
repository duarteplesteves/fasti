import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { column } from "../../schema/column.js";
import { defineSchema } from "../../schema/define-schema.js";
import { bookingTable } from "./index.js";

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
