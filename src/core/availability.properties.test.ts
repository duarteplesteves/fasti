import { test } from "@fast-check/vitest";
import { array, constant, integer, record } from "fast-check";
import { describe, expect } from "vitest";

import {
  arbAroundClockChange,
  arbRuleAround,
} from "../test-utils/arbitraries.js";
import { propConfig } from "../test-utils/prop-config.js";
import { unwrap } from "../test-utils/results.js";
import { availableWindows, openWindows, windowsFor } from "./availability.js";
import { expandRules } from "./expand-rules.js";
import { ceilToMs, floorToMs } from "./ms-range.js";
import type { MsRange } from "./ms-range.js";
import type { AvailabilityRule, InstantRange } from "./types.js";

/** The windows that can hold a slot, as sorted strings. */
function sortedWindows(windows: readonly MsRange[]): string[] {
  return windows
    .flatMap((w) => (w.startMs < w.endMs ? [`${w.startMs} ${w.endMs}`] : []))
    .toSorted();
}

/** The windows `expandRules` opens on `range`'s UTC dates and the day either side, rounded inwards. */
function expected(
  rules: readonly AvailabilityRule[],
  range: InstantRange
): string[] {
  const utc = {
    end: range.end.toZonedDateTimeISO("UTC").toPlainDate(),
    start: range.start.toZonedDateTimeISO("UTC").toPlainDate(),
  };

  const windows = unwrap(
    expandRules({
      from: utc.start.subtract({ days: 1 }),
      rules,
      to: utc.end.add({ days: 1 }),
    })
  );

  return sortedWindows(
    windows.map((w) => ({
      endMs: floorToMs(w.end.toInstant()),
      startMs: ceilToMs(w.start.toInstant()),
    }))
  );
}

const arbCase = arbAroundClockChange().chain(({ from, timezone, to }) => {
  const date = from.toZonedDateTimeISO("UTC").toPlainDate();

  return record({
    range: constant({ end: to, start: from }),
    rules: array(arbRuleAround(date, timezone), { maxLength: 3, minLength: 1 }),
    // Slots from anywhere in the range, in any order, up to 48 hours long.
    slots: array(
      record({
        minutes: integer({ max: 48 * 60, min: 1 }),
        startMinutes: integer({ max: 80 * 60, min: 0 }),
      }).map(({ minutes, startMinutes }) => {
        const start = from.add({ minutes: startMinutes });

        return { end: start.add({ minutes }), start };
      }),
      { maxLength: 3, minLength: 1 }
    ),
  });
});

describe("availability windows around clock changes (property)", () => {
  test.prop([arbCase], propConfig)(
    "availableWindows opens what expandRules does",
    ({ range, rules }) => {
      expect(sortedWindows(availableWindows(rules, range))).toStrictEqual(
        expected(rules, range)
      );
    }
  );

  test.prop([arbCase], propConfig)(
    "windowsFor opens what expandRules does, for slots sharing one cache in any order",
    ({ rules, slots }) => {
      const open = openWindows(rules);
      const byDate = new Map<number, readonly MsRange[]>();

      for (const slot of slots) {
        expect(sortedWindows(windowsFor(open, slot, byDate))).toStrictEqual(
          expected(rules, slot)
        );
      }
    }
  );
});
