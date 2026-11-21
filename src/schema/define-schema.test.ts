import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  BookingRecord,
  ResourceIdOf,
  StatusOf,
} from "../adapter/records.js";
import { column } from "./column.js";
import type { AnyColumn, Column } from "./column.js";
import { defineSchema } from "./define-schema.js";
import type { BaseStatus, InitialOf } from "./define-schema.js";

describe(defineSchema, () => {
  it("resolves defaults: text ids, logical names, the two base Statuses", () => {
    expect(defineSchema({})).toStrictEqual({
      block: null,
      booking: { fields: {} },
      names: {
        columns: {
          availabilityRule: {
            effectiveFrom: "effectiveFrom",
            effectiveTo: "effectiveTo",
            exceptions: "exceptions",
            id: "id",
            recurrence: "recurrence",
            resourceId: "resourceId",
            timezone: "timezone",
            windowEnd: "windowEnd",
            windowStart: "windowStart",
          },
          block: {
            end: "end",
            id: "id",
            resourceId: "resourceId",
            start: "start",
          },
          booking: {
            end: "end",
            id: "id",
            resourceId: "resourceId",
            start: "start",
            status: "status",
          },
        },
        tables: {
          availabilityRule: "availabilityRule",
          block: "block",
          booking: "booking",
        },
      },
      initial: ["booked"],
      plugins: [],
      resource: { idType: { kind: "text" } },
      statuses: {
        booked: { blocking: true, stored: "booked" },
        cancelled: { blocking: false, stored: "cancelled" },
      },
      transitions: { booked: ["cancelled"], cancelled: [] },
    });
  });

  it("throws when two Statuses share a stored value (I6)", () => {
    expect(() =>
      // @ts-expect-error two Statuses share "X"
      defineSchema({ names: { statuses: { booked: "X", cancelled: "X" } } })
    ).toThrow(/stored value "X"/u);
    expect(() =>
      // @ts-expect-error `cancelled` already stores "cancelled"
      defineSchema({ names: { statuses: { booked: "cancelled" } } })
    ).toThrow(/stored value "cancelled"/u);
    expect(() =>
      defineSchema({
        booking: { statuses: { paid: { blocking: true } } },
        // @ts-expect-error `paid` already stores "paid"
        names: { statuses: { booked: "paid" } },
      })
    ).toThrow(/stored value "paid"/u);
  });

  it("resolves declared Statuses, with booked → cancelled always present and initial defaulting to booked", () => {
    const schema = defineSchema({
      booking: { statuses: { paid: { blocking: true } } },
      names: { statuses: { paid: "PAID" } },
    });

    expect(schema.statuses.paid).toStrictEqual({
      blocking: true,
      stored: "PAID",
    });
    expect(schema.transitions).toStrictEqual({
      booked: ["cancelled"],
      cancelled: [],
      paid: [],
    });
    expect(schema.initial).toStrictEqual(["booked"]);
  });

  it("resolves declared Transitions and initial Statuses", () => {
    const schema = defineSchema({
      booking: {
        initial: ["booked", "request"],
        statuses: {
          request: { blocking: false },
          visit: { blocking: true },
        },
        transitions: {
          booked: ["visit", "cancelled"],
          cancelled: ["booked"],
          request: ["booked"],
        },
      },
    });

    expect(schema.transitions).toStrictEqual({
      booked: ["visit", "cancelled"],
      cancelled: ["booked"],
      request: ["booked"],
      visit: [],
    });
    expect(schema.initial).toStrictEqual(["booked", "request"]);
  });

  it("throws on a redeclared base Status, an unknown Status in transitions or initial, or an empty initial", () => {
    expect(() =>
      defineSchema({
        // @ts-expect-error `booked` is a base Status
        booking: { statuses: { booked: { blocking: false } } },
      })
    ).toThrow(/"booked" is a base Status/u);
    expect(() =>
      // @ts-expect-error `paid` isn't a Status
      defineSchema({ booking: { transitions: { paid: ["booked"] } } })
    ).toThrow(/`transitions` names "paid"/u);
    expect(() =>
      // @ts-expect-error `paid` isn't a Status
      defineSchema({ booking: { transitions: { booked: ["paid"] } } })
    ).toThrow(/`transitions` names "paid"/u);
    expect(() =>
      // @ts-expect-error `paid` isn't a Status
      defineSchema({ booking: { initial: ["paid"] } })
    ).toThrow(/`initial` names "paid"/u);
    expect(() =>
      // @ts-expect-error `initial` can't be empty
      defineSchema({ booking: { initial: [] } })
    ).toThrow(/at least one Status/u);
  });

  it("throws on a declared Status without `blocking` (plain JS)", () => {
    expect(() =>
      // @ts-expect-error `blocking` is required
      defineSchema({ booking: { statuses: { paid: {} } } })
    ).toThrow(/Status "paid" needs `blocking/u);
  });

  it("throws on a Booking or Block Developer Field named `also`", () => {
    expect(() =>
      defineSchema({
        booking: {
          // @ts-expect-error `also` is reserved
          fields: { also: { required: false, type: column.text() } },
        },
      })
    ).toThrow(/Booking Developer Field can't be named "also"/u);
    expect(() =>
      defineSchema({
        block: {
          // @ts-expect-error `also` is reserved
          fields: { also: { required: false, type: column.text() } },
        },
      })
    ).toThrow(/Block Developer Field can't be named "also"/u);
  });

  it("throws on a Booking Developer Field named `waived`", () => {
    expect(() =>
      defineSchema({
        booking: {
          // @ts-expect-error `waived` is reserved
          fields: { waived: { required: false, type: column.text() } },
        },
      })
    ).toThrow(/Booking Developer Field can't be named "waived"/u);
  });

  it("throws when two columns or tables share a physical name", () => {
    expect(() =>
      defineSchema({
        booking: {
          fields: { notes: { required: false, type: column.text() } },
        },
        names: { columns: { booking: { start: "notes" } } },
      })
    ).toThrow(/column name "notes"/u);
    expect(() =>
      defineSchema({
        names: { columns: { availabilityRule: { windowEnd: "windowStart" } } },
      })
    ).toThrow(/column name "windowStart"/u);
    expect(() =>
      defineSchema({
        names: { tables: { availabilityRule: "x", booking: "x" } },
      })
    ).toThrow(/table name "x"/u);
  });

  it("resolves `block` with its fields and default names, renamed where asked", () => {
    const fields = { reason: { required: true, type: column.text() } };

    const schema = defineSchema({
      block: { fields },
      names: {
        columns: { block: { reason: "why", start: "starts_at" } },
        tables: { block: "time_off" },
      },
    });

    expect(schema.block).toStrictEqual({ fields });
    expect(schema.names.tables.block).toBe("time_off");
    expect(schema.names.columns.block).toStrictEqual({
      end: "end",
      id: "id",
      reason: "why",
      resourceId: "resourceId",
      start: "starts_at",
    });
    expect(defineSchema({ block: { fields: {} } }).block).toStrictEqual({
      fields: {},
    });
  });

  it("throws on a Block table or column name that collides only when `block` is declared", () => {
    const names = { tables: { block: "booking" } };

    expect(() => defineSchema({ names })).not.toThrow();
    expect(() =>
      defineSchema({ names: { columns: { block: { end: "start" } } } })
    ).not.toThrow();
    expect(() => defineSchema({ block: { fields: {} }, names })).toThrow(
      /table name "booking"/u
    );
    expect(() =>
      defineSchema({
        block: { fields: {} },
        names: { columns: { block: { end: "start" } } },
      })
    ).toThrow(/column name "start"/u);
  });

  it("names a Developer Field called `constructor` after itself", () => {
    const schema = defineSchema({
      booking: {
        fields: { constructor: { required: true, type: column.text() } },
      },
      // @ts-expect-error TS sees the inherited Object#constructor; JS callers still reach this
      names: { columns: { booking: { start: "starts_at" } } },
    });

    expect(schema.names.columns.booking.constructor).toBe("constructor");
  });

  it("names Developer Field columns logically unless renamed", () => {
    const schema = defineSchema({
      booking: {
        fields: {
          notes: { required: false, type: column.text() },
          paid: { required: true, type: column.boolean() },
        },
      },
      names: { columns: { booking: { paid: "is_paid", start: "starts_at" } } },
    });

    expect(schema.names.columns.booking).toStrictEqual({
      end: "end",
      id: "id",
      notes: "notes",
      paid: "is_paid",
      resourceId: "resourceId",
      start: "starts_at",
      status: "status",
    });
  });
});

describe("schema types", () => {
  type StaffId = number & { readonly __brand: "StaffId" };

  it("adopts a branded id type", () => {
    const schema = defineSchema({
      resource: { idType: column.integer<StaffId>() },
    });

    expectTypeOf<ResourceIdOf<typeof schema>>().toEqualTypeOf<StaffId>();
    const plain = defineSchema({});

    expectTypeOf<ResourceIdOf<typeof plain>>().toEqualTypeOf<string>();
  });

  it("types an optional Developer Field as T | null and a required one as T", () => {
    const schema = defineSchema({
      booking: {
        fields: {
          notes: { required: false, type: column.text() },
          paid: { required: true, type: column.boolean() },
        },
      },
    });

    expectTypeOf<BookingRecord<typeof schema>["notes"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<
      BookingRecord<typeof schema>["paid"]
    >().toEqualTypeOf<boolean>();
  });

  it("rejects a Developer Field named after a Booking column", () => {
    expect(() =>
      defineSchema({
        booking: {
          // @ts-expect-error `start` is a Booking column
          fields: { start: { required: true, type: column.instant() } },
        },
      })
    ).not.toThrow();
  });

  it("rejects a Block Developer Field named after a Block column", () => {
    expect(() =>
      defineSchema({
        block: {
          // @ts-expect-error `end` is a Block column
          fields: { end: { required: true, type: column.instant() } },
        },
      })
    ).not.toThrow();
  });

  it("keeps logical names when physical names change", () => {
    const schema = defineSchema({
      names: {
        columns: { booking: { start: "starts_at" } },
        statuses: { booked: "CONFIRMED" },
        tables: { booking: "appointments" },
      },
    });

    expectTypeOf<StatusOf<typeof schema>>().toEqualTypeOf<BaseStatus>();
    expectTypeOf<keyof typeof schema.names.columns.booking>().toEqualTypeOf<
      "id" | "resourceId" | "start" | "end" | "status"
    >();
    expectTypeOf<
      BookingRecord<typeof schema>["start"]
    >().toEqualTypeOf<Temporal.Instant>();
  });

  it("types declared Statuses, the resolved Transitions and the initial Statuses", () => {
    const schema = defineSchema({
      booking: {
        initial: ["booked", "request"],
        statuses: {
          paid: { blocking: true },
          request: { blocking: false },
        },
        transitions: { booked: ["paid"], request: ["booked"] },
      },
    });

    expectTypeOf<StatusOf<typeof schema>>().toEqualTypeOf<
      BaseStatus | "paid" | "request"
    >();
    expectTypeOf<(typeof schema.transitions.booked)[number]>().toEqualTypeOf<
      "paid" | "cancelled"
    >();
    expectTypeOf<
      (typeof schema.transitions.paid)[number]
    >().toEqualTypeOf<never>();
    expectTypeOf<InitialOf<typeof schema>>().toEqualTypeOf<
      "booked" | "request"
    >();
    const base = defineSchema({});

    expectTypeOf<InitialOf<typeof base>>().toEqualTypeOf<"booked">();
    expectTypeOf(base.transitions).toEqualTypeOf<{
      readonly booked: readonly "cancelled"[];
      readonly cancelled: readonly never[];
    }>();
  });

  it("rejects renaming a column that doesn't exist", () => {
    expect(() =>
      defineSchema({
        // @ts-expect-error `notes` is not a Booking column or Developer Field
        names: { columns: { booking: { notes: "n" } } },
      })
    ).not.toThrow();
  });

  it("rejects a hand-built column whose type doesn't match its kind", () => {
    expectTypeOf<Column<"boolean", string>>().not.toExtend<AnyColumn>();
    expectTypeOf<Column<"integer", StaffId>>().toExtend<AnyColumn>();
  });
});
