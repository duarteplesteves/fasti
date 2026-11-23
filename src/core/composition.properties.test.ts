import { test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import {
  arbBooking,
  arbDateRange,
  arbDuration,
  arbInterval,
  arbResourceId,
  arbRulesForResource,
  arbTimezone,
} from "../test-utils/arbitraries.js";
import { propConfig } from "../test-utils/prop-config.js";
import { unwrap } from "../test-utils/results.js";
import { findFreeSlots } from "./find-free-slots.js";
import { isSlotValid } from "./is-slot-valid.js";

describe("composition", () => {
  test.prop(
    [
      arbResourceId(),
      arbRulesForResource(""),
      arbBooking(),
      arbDuration(),
      arbDateRange(),
      arbInterval(),
      arbTimezone(),
    ],
    propConfig
  )(
    "every slot from findFreeSlots passes isSlotValid",
    (resourceId, rules, booking, duration, range, interval, timezone) => {
      const finalRules = rules.map((r) => ({ ...r, resourceId }));
      const finalBooking = { ...booking, resourceId };

      const slots = unwrap(
        findFreeSlots({
          bookings: [finalBooking],
          duration,
          from: range.from,
          interval,
          resourceId,
          rules: finalRules,
          timezone,
          to: range.to,
        })
      );

      for (const slot of slots) {
        expect(
          unwrap(
            isSlotValid({
              bookings: [finalBooking],
              resourceId,
              rules: finalRules,
              slot: {
                end: slot.end.toInstant(),
                start: slot.start.toInstant(),
              },
            })
          )
        ).toBeTruthy();
      }
    }
  );
});
