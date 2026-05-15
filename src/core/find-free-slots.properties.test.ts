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

describe(`${findFreeSlots.name} (property)`, () => {
  test.prop(
    [
      arbAvailabilityRule(),
      arbResourceId(),
      arbBooking(),
      arbBooking(),
      arbDuration(),
    ],
    { timeout: 30_000 }
  )(
    "no returned slot overlaps any blocking booking",
    (rule, resourceId, b1, b2, duration) => {
      const finalRule = { ...rule, resourceId };
      const finalB1 = { ...b1, resourceId };
      const finalB2 = { ...b2, resourceId };

      const from = Temporal.Instant.from("2024-09-01T00:00:00Z");
      const to = Temporal.Instant.from("2024-09-14T00:00:00Z");

      const slots = findFreeSlots({
        bookings: [finalB1, finalB2],
        duration,
        from,
        options: { interval: duration },
        resourceId,
        rules: [finalRule],
        to,
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
    [arbAvailabilityRule(), arbResourceId(), arbBooking(), arbDuration()],
    { timeout: 30_000 }
  )(
    "adding a non-blocking booking never reduces the number of free slots",
    (rule, resourceId, nonBlocking, duration) => {
      const finalRule = { ...rule, resourceId };
      const finalNonBlocking = {
        ...nonBlocking,
        isBlocking: false,
        resourceId,
      };

      const from = Temporal.Instant.from("2024-09-01T00:00:00Z");
      const to = Temporal.Instant.from("2024-09-14T00:00:00Z");

      const slotsWithout = findFreeSlots({
        bookings: [],
        duration,
        from,
        options: { interval: duration },
        resourceId,
        rules: [finalRule],
        to,
      });

      const slotsWith = findFreeSlots({
        bookings: [finalNonBlocking],
        duration,
        from,
        options: { interval: duration },
        resourceId,
        rules: [finalRule],
        to,
      });

      expect(slotsWith.length).toBeGreaterThanOrEqual(slotsWithout.length);
    }
  );
});
