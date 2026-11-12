/* eslint-disable vitest/no-standalone-expect */
import { test } from "@fast-check/vitest";
import { array, constantFrom, record } from "fast-check";
import { describe, expect } from "vitest";

import {
  arbAnyBooking,
  arbAnyCount,
  arbAnyInstantRange,
  arbAnyRule,
} from "../test-utils/arbitraries.js";
import { propConfig } from "../test-utils/prop-config.js";
import { detectConflicts } from "./detect-conflicts.js";
import { expandRules } from "./expand-rules.js";
import { findFreeSlots } from "./find-free-slots.js";
import type { FindFreeSlotsParams } from "./find-free-slots.js";
import { isSlotValid } from "./is-slot-valid.js";
import type { Booking } from "./types.js";
import { withBlockingFlag } from "./with-blocking-flag.js";

/** Freezes arrays and plain objects (Temporal values are already immutable), so a mutation throws. */
function deepFreeze<T>(value: T): T {
  if (
    value instanceof Object &&
    (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)
  ) {
    for (const v of Object.values(value)) {
      deepFreeze(v);
    }

    Object.freeze(value);
  }

  return value;
}

function arbRules() {
  return array(arbAnyRule(), { maxLength: 3 });
}

function arbBookings() {
  return array(arbAnyBooking(), { maxLength: 3 });
}

function arbStatuses() {
  return array(constantFrom("A", "B", "C"), { maxLength: 3 });
}

function withoutFlag(b: Booking): Omit<Booking, "isBlocking"> {
  const raw: Omit<Booking, "isBlocking"> & { isBlocking?: boolean } = { ...b };
  delete raw.isBlocking;

  return raw;
}

describe("no Core function throws on any params, and none mutates them", () => {
  test.prop([arbRules(), arbAnyInstantRange()], propConfig)(
    "expandRules",
    (rules, range) => {
      const params = deepFreeze({
        from: range.start.toZonedDateTimeISO("UTC").toPlainDate(),
        rules,
        to: range.end.toZonedDateTimeISO("UTC").toPlainDate(),
      });

      expect([true, false]).toContain(expandRules(params).ok);
    }
  );

  test.prop([arbBookings(), arbAnyInstantRange()], propConfig)(
    "detectConflicts",
    (bookings, candidate) => {
      const params = deepFreeze({ bookings, candidate, resourceId: "r1" });

      expect([true, false]).toContain(detectConflicts(params).ok);
    }
  );

  test.prop([arbRules(), arbBookings(), arbAnyInstantRange()], propConfig)(
    "isSlotValid",
    (rules, bookings, slot) => {
      const params = deepFreeze({ bookings, resourceId: "r1", rules, slot });

      expect([true, false]).toContain(isSlotValid(params).ok);
    }
  );

  test.prop(
    [
      arbRules(),
      arbBookings(),
      arbAnyInstantRange(),
      arbAnyCount(),
      constantFrom(1, 0, 15, -7, 2.5),
      constantFrom("Europe/Lisbon", "UTC", "Europe/Lisbn", "+01:00"),
    ],
    propConfig
  )("findFreeSlots", (rules, bookings, range, duration, interval, timezone) => {
    const params: FindFreeSlotsParams = {
      bookings,
      duration,
      from: range.start,
      interval,
      resourceId: "r1",
      rules,
      timezone,
      to: range.end,
    };

    expect([true, false]).toContain(findFreeSlots(deepFreeze(params)).ok);
  });

  test.prop(
    [
      arbBookings(),
      record({
        blocking: arbStatuses(),
        default: constantFrom("blocking" as const, "nonBlocking" as const),
        nonBlocking: arbStatuses(),
      }),
    ],
    propConfig
  )("withBlockingFlag", (bookings, mapping) => {
    const raw = deepFreeze(bookings.map(withoutFlag));

    expect([true, false]).toContain(
      withBlockingFlag(raw, deepFreeze(mapping)).ok
    );
  });
});
