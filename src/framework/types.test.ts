import { describe, expectTypeOf, it } from "vitest";

import type { InvalidParams, Result } from "../core/result.js";
import type { BookingId } from "../core/types.js";
import type { Scheduler } from "../index.js";
import { column } from "../schema/column.js";
import { defineSchema } from "../schema/define-schema.js";
import type {
  integerIdSchema,
  textIdSchema,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import type { BookError, BookParams } from "./book.js";
import type { Booking } from "./booking.js";
import type { AdapterError, PolicyViolation, SlotConflict } from "./errors.js";

type StaffId = number & { readonly __brand: "StaffId" };

const brandedSchema = defineSchema({
  resource: { idType: column.integer<StaffId>() },
});

/** Defaults: text ids, no Developer Fields. */
const defaultSchema = defineSchema({});

type NoFields = BookParams<typeof uuidIdSchema>;

type AllOptional = BookParams<typeof integerIdSchema>;

type SomeRequired = BookParams<typeof textIdSchema>;

const instant = Temporal.Instant.from("2030-06-03T09:00:00Z");

const base = { end: instant, resourceId: "staff-a", start: instant } as const;

const required = {
  count: 1,
  label: "",
  paid: true,
  ref: "",
  remindAt: instant,
} as const;

describe("book types", () => {
  it("has no `fields` when the schema declares no Developer Fields", () => {
    expectTypeOf<NoFields>().not.toHaveProperty("fields");
    expectTypeOf<BookParams<typeof defaultSchema>>().not.toHaveProperty(
      "fields"
    );
  });

  it("makes `fields` optional when every Developer Field is optional", () => {
    expectTypeOf({ ...base, resourceId: 1 }).toExtend<AllOptional>();
    expectTypeOf({
      ...base,
      fields: {},
      resourceId: 1,
    }).toExtend<AllOptional>();
    expectTypeOf({
      ...base,
      fields: { note: null },
      resourceId: 1,
    }).toExtend<AllOptional>();
    expectTypeOf({
      ...base,
      fields: { note: 1 },
      resourceId: 1,
    }).not.toExtend<AllOptional>();
  });

  it("requires `fields`, and each required field, when one is required", () => {
    expectTypeOf(base).not.toExtend<SomeRequired>();
    expectTypeOf({ ...base, fields: required }).toExtend<SomeRequired>();
    expectTypeOf({
      ...base,
      fields: { ...required, countOpt: null, labelOpt: "x" },
    }).toExtend<SomeRequired>();
    expectTypeOf({
      ...base,
      fields: { ...required, label: null },
    }).not.toExtend<SomeRequired>();

    const { count: _count, ...missingCount } = required;

    expectTypeOf({
      ...base,
      fields: missingCount,
    }).not.toExtend<SomeRequired>();
  });

  it("types `resourceId` by the schema's idType, brand included", () => {
    expectTypeOf<SomeRequired["resourceId"]>().toEqualTypeOf<string>();
    expectTypeOf<NoFields["resourceId"]>().toEqualTypeOf<string>();
    expectTypeOf<AllOptional["resourceId"]>().toEqualTypeOf<number>();
    expectTypeOf<
      BookParams<typeof brandedSchema>["resourceId"]
    >().toEqualTypeOf<StaffId>();
    expectTypeOf({ ...base, resourceId: 1 }).not.toExtend<
      BookParams<typeof brandedSchema>
    >();
  });

  it("fails with exactly BookError and returns a BookingId", () => {
    expectTypeOf<BookError>().toEqualTypeOf<
      InvalidParams | SlotConflict | PolicyViolation | AdapterError
    >();
    expectTypeOf<
      Scheduler<typeof textIdSchema>["book"]
    >().returns.toEqualTypeOf<
      Promise<Result<Booking<typeof textIdSchema>, BookError>>
    >();
    expectTypeOf<
      Booking<typeof uuidIdSchema>["id"]
    >().toEqualTypeOf<BookingId>();
  });
});
