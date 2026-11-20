import { describe, expectTypeOf, it } from "vitest";

import { column, defineSchema } from "../index.js";
import type {
  // oxlint-disable-next-line typescript/no-deprecated -- the alias under test.
  ActionTarget,
  BookingActionName,
  HookTarget,
  PolicyTarget,
  WriteActionName,
} from "../index.js";

const withBlocks = defineSchema({
  block: { fields: {} },
  booking: {
    statuses: { inProgress: { blocking: true } },
    transitions: { booked: ["inProgress"] },
  },
  resource: { idType: column.uuid() },
});

const withoutBlocks = defineSchema({});

describe("target names", () => {
  it("BookingActionName is the three Booking Actions, and ActionTarget is it", () => {
    expectTypeOf<BookingActionName>().toEqualTypeOf<
      "book" | "reschedule" | "cancel"
    >();
    // oxlint-disable-next-line typescript/no-deprecated -- the alias under test.
    expectTypeOf<ActionTarget>().toEqualTypeOf<BookingActionName>();
  });

  it("WriteActionName has blocks.* only when the schema has block", () => {
    expectTypeOf<WriteActionName<typeof withBlocks>>().toEqualTypeOf<
      | BookingActionName
      | "availability.set"
      | "blocks.create"
      | "blocks.update"
      | "blocks.delete"
    >();
    expectTypeOf<WriteActionName<typeof withoutBlocks>>().toEqualTypeOf<
      BookingActionName | "availability.set"
    >();
  });

  it("HookTarget is every write Action and Transition edge; Policy targets are a subset", () => {
    expectTypeOf<HookTarget<typeof withBlocks>>().toExtend<
      WriteActionName<typeof withBlocks> | { readonly to: string }
    >();
    expectTypeOf<"blocks.delete">().toExtend<HookTarget<typeof withBlocks>>();
    expectTypeOf<{ from: "booked"; to: "inProgress" }>().toExtend<
      HookTarget<typeof withBlocks>
    >();
    expectTypeOf<"blocks.delete">().not.toExtend<
      HookTarget<typeof withoutBlocks>
    >();
    expectTypeOf<PolicyTarget<typeof withBlocks>>().toExtend<
      HookTarget<typeof withBlocks>
    >();
  });
});
