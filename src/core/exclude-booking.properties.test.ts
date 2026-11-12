/* eslint-disable vitest/no-standalone-expect */
import { test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import {
  arbBookingIn,
  arbBookingsToExclude,
  arbDateRange,
  arbDuration,
  arbRulesForResource,
} from "../test-utils/arbitraries.js";
import { propConfig } from "../test-utils/prop-config.js";
import { detectConflicts } from "./detect-conflicts.js";
import { findFreeSlots } from "./find-free-slots.js";
import { isSlotValid } from "./is-slot-valid.js";
import type { AvailabilityRule } from "./types.js";

const resourceId = "r1";

// A date range with excludable bookings and a candidate inside it.
const arbCase = arbDateRange().chain((range) =>
  arbBookingsToExclude(range, resourceId).chain(
    ({ bookings, excludeBookingId }) =>
      arbBookingIn(range, resourceId).map((candidate) => ({
        bookings,
        candidate,
        excludeBookingId,
        range,
        // The same bookings with the excluded one removed.
        remaining: bookings.filter((b) => b.id !== excludeBookingId),
      }))
  )
);

// Open all day, every day, so most candidates fit and the overlap check decides.
const alwaysOpen: AvailabilityRule = {
  recurrence: {
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    frequency: "weekly",
    interval: 1,
  },
  resourceId,
  timeWindow: {
    end: Temporal.PlainTime.from("23:59:59.999"),
    start: Temporal.PlainTime.from("00:00"),
  },
  timezone: "UTC",
};

describe("excludeBookingId (property)", () => {
  test.prop(
    [arbCase, arbRulesForResource(resourceId), arbDuration()],
    propConfig
  )(
    "findFreeSlots: excluding a booking equals removing it",
    ({ bookings, excludeBookingId, range, remaining }, rules, duration) => {
      const params = {
        duration,
        from: range.from,
        resourceId,
        rules,
        to: range.to,
      };

      expect(
        findFreeSlots({ ...params, bookings, excludeBookingId })
      ).toStrictEqual(findFreeSlots({ ...params, bookings: remaining }));
    }
  );

  test.prop([arbCase], propConfig)(
    "isSlotValid: excluding a booking equals removing it",
    ({ bookings, candidate, excludeBookingId, remaining }) => {
      const rules = [alwaysOpen];
      const slot = { end: candidate.end, start: candidate.start };

      expect(
        isSlotValid({ bookings, excludeBookingId, resourceId, rules, slot })
      ).toStrictEqual(
        isSlotValid({ bookings: remaining, resourceId, rules, slot })
      );
    }
  );

  test.prop([arbCase], propConfig)(
    "detectConflicts: excluding a booking equals removing it",
    ({ bookings, candidate, excludeBookingId, remaining }) => {
      expect(
        detectConflicts({ bookings, candidate, excludeBookingId, resourceId })
      ).toStrictEqual(
        detectConflicts({ bookings: remaining, candidate, resourceId })
      );
    }
  );
});
