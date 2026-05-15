import { test } from "@fast-check/vitest";
/* eslint-disable vitest/no-standalone-expect */
import { Temporal } from "@js-temporal/polyfill";
import { describe, expect } from "vitest";

import {
  arbAvailabilityRule,
  arbBooking,
  arbDuration,
  arbResourceId,
} from "../test-utils/arbitraries.js";
import { findFreeSlots } from "./find-free-slots.js";
import { isSlotValid } from "./is-slot-valid.js";

describe("composition", () => {
  test.prop(
    [arbAvailabilityRule(), arbResourceId(), arbBooking(), arbDuration()],
    { timeout: 30_000 }
  )(
    "every slot from findFreeSlots passes isSlotValid",
    (rule, resourceId, booking, duration) => {
      const finalRule = { ...rule, resourceId };
      const finalBooking = { ...booking, resourceId };

      const from = Temporal.Instant.from("2024-09-01T00:00:00Z");
      const to = Temporal.Instant.from("2024-09-14T00:00:00Z");

      const slots = findFreeSlots({
        bookings: [finalBooking],
        duration,
        from,
        options: { interval: duration },
        resourceId,
        rules: [finalRule],
        to,
      });

      for (const slot of slots) {
        expect(
          isSlotValid({
            bookings: [finalBooking],
            resourceId,
            rules: [finalRule],
            slot: {
              end: slot.end.toInstant(),
              start: slot.start.toInstant(),
            },
          })
        ).toBeTruthy();
      }
    }
  );
});
