import { test } from "@fast-check/vitest";
/* eslint-disable vitest/no-standalone-expect */
import { describe, expect } from "vitest";

import {
  arbAvailabilityRule,
  arbBooking,
  arbDateRange,
  arbDuration,
  arbResourceId,
} from "../test-utils/arbitraries.js";
import { propConfig } from "../test-utils/prop-config.js";
import { findFreeSlots } from "./find-free-slots.js";

describe(`${findFreeSlots.name} (property)`, () => {
  test.prop(
    [
      arbAvailabilityRule(),
      arbResourceId(),
      arbBooking(),
      arbBooking(),
      arbDuration(),
      arbDateRange(),
    ],
    propConfig
  )(
    "no returned slot overlaps any blocking booking",
    (rule, resourceId, b1, b2, duration, range) => {
      const finalRule = { ...rule, resourceId };
      const finalB1 = { ...b1, resourceId };
      const finalB2 = { ...b2, resourceId };

      const slots = findFreeSlots({
        bookings: [finalB1, finalB2],
        duration,
        from: range.from,
        options: { interval: duration },
        resourceId,
        rules: [finalRule],
        to: range.to,
      });

      for (const slot of slots) {
        const slotStart = slot.start.toInstant();
        const slotEnd = slot.end.toInstant();

        for (const booking of [finalB1, finalB2]) {
          if (!booking.isBlocking) {
            continue;
          }

          const overlaps =
            Temporal.Instant.compare(slotStart, booking.end) < 0 &&
            Temporal.Instant.compare(booking.start, slotEnd) < 0;

          expect(overlaps).toBeFalsy();
        }
      }
    }
  );

  test.prop(
    [
      arbAvailabilityRule(),
      arbResourceId(),
      arbBooking(),
      arbDuration(),
      arbDateRange(),
    ],
    propConfig
  )(
    "adding a non-blocking booking never reduces the number of free slots",
    (rule, resourceId, nonBlocking, duration, range) => {
      const finalRule = { ...rule, resourceId };

      const finalNonBlocking = {
        ...nonBlocking,
        isBlocking: false,
        resourceId,
      };

      const slotsWithout = findFreeSlots({
        bookings: [],
        duration,
        from: range.from,
        options: { interval: duration },
        resourceId,
        rules: [finalRule],
        to: range.to,
      });

      const slotsWith = findFreeSlots({
        bookings: [finalNonBlocking],
        duration,
        from: range.from,
        options: { interval: duration },
        resourceId,
        rules: [finalRule],
        to: range.to,
      });

      expect(slotsWith.length).toBeGreaterThanOrEqual(slotsWithout.length);
    }
  );
});
