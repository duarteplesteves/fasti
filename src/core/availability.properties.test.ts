import { test } from "@fast-check/vitest";
import { array, constant, integer, oneof, record } from "fast-check";
import { describe, expect } from "vitest";

import {
  arbAroundClockChange,
  arbRuleAround,
} from "../test-utils/arbitraries.js";
import { propConfig } from "../test-utils/prop-config.js";
import { referenceWindows } from "../test-utils/reference-windows.js";
import { unwrap } from "../test-utils/results.js";
import { availableWindows, windowFit } from "./availability.js";
import { ceilToMs, floorToMs } from "./exact-time.js";
import type { MsRange } from "./exact-time.js";
import { expandRules } from "./expand-rules.js";
import type { ExpandedWindow, InstantRange } from "./types.js";

/** The windows that can hold a slot, as sorted strings. */
function sortedRanges(windows: readonly MsRange[]): string[] {
  return windows
    .flatMap((w) => (w.startMs < w.endMs ? [`${w.startMs} ${w.endMs}`] : []))
    .toSorted();
}

function sortedWindows(windows: readonly ExpandedWindow[]): string[] {
  return windows
    .map((w) => `${w.start.toString()} ${w.end.toString()} ${w.resourceId}`)
    .toSorted();
}

/** Which slot to ask about: one from anywhere, or one around the edges of a window. */
const arbSlot = oneof(
  record({
    kind: constant("anywhere" as const),
    minutes: integer({ max: 48 * 60, min: 1 }),
    startMinutes: integer({ max: 80 * 60, min: 0 }),
  }),
  record({
    endNanoseconds: integer({ max: 1, min: -1 }),
    index: integer({ max: 20, min: 0 }),
    kind: constant("window" as const),
    startNanoseconds: integer({ max: 1, min: -1 }),
  })
);

const arbCase = arbAroundClockChange().chain(({ from, timezone, to }) => {
  const date = from.toZonedDateTimeISO("UTC").toPlainDate();

  return record({
    date: constant(date),
    range: constant({ end: to, start: from }),
    rules: array(arbRuleAround(date, timezone), { maxLength: 3, minLength: 1 }),
    slots: array(arbSlot, { maxLength: 3, minLength: 1 }),
  });
});

describe("availability windows around clock changes (property)", () => {
  test.prop([arbCase], propConfig)(
    "availableWindows opens the reference's windows, rounded inwards",
    ({ range, rules }) => {
      const windows = referenceWindows(
        rules,
        range.start
          .toZonedDateTimeISO("UTC")
          .toPlainDate()
          .subtract({ days: 1 }),
        range.end.toZonedDateTimeISO("UTC").toPlainDate().add({ days: 1 })
      );

      expect(sortedRanges(availableWindows(rules, range))).toStrictEqual(
        sortedRanges(
          windows.map((w) => ({
            endMs: floorToMs(w.end.toInstant()),
            startMs: ceilToMs(w.start.toInstant()),
          }))
        )
      );
    }
  );

  test.prop([arbCase], propConfig)(
    "expandRules opens the reference's windows",
    ({ date, rules }) => {
      const from = date.subtract({ days: 1 });
      const to = date.add({ days: 5 });

      expect(
        sortedWindows(unwrap(expandRules({ from, rules, to })))
      ).toStrictEqual(sortedWindows(referenceWindows(rules, from, to)));
    }
  );

  test.prop([arbCase], propConfig)(
    "windowFit holds the slots one of the reference's windows does, in any order",
    ({ date, range, rules, slots }) => {
      // Wider than the dates slots come from: another timezone's window on the next date can hold a slot too.
      const windows = referenceWindows(
        rules,
        date.subtract({ days: 4 }),
        date.add({ days: 8 })
      );

      const near = referenceWindows(
        rules,
        date.subtract({ days: 2 }),
        date.add({ days: 6 })
      );

      const fits = windowFit(rules);

      const asked = slots.flatMap((slot): InstantRange[] => {
        if (slot.kind === "anywhere") {
          const start = range.start.add({ minutes: slot.startMinutes });

          return [{ end: start.add({ minutes: slot.minutes }), start }];
        }

        const window = near[slot.index % near.length];

        return window
          ? [
              {
                end: window.end
                  .toInstant()
                  .add({ nanoseconds: slot.endNanoseconds }),
                start: window.start
                  .toInstant()
                  .add({ nanoseconds: slot.startNanoseconds }),
              },
            ]
          : [];
      });

      expect(asked.map(fits)).toStrictEqual(
        asked.map(({ end, start }) =>
          windows.some(
            (w) =>
              Temporal.Instant.compare(w.start.toInstant(), start) <= 0 &&
              Temporal.Instant.compare(end, w.end.toInstant()) <= 0
          )
        )
      );
    }
  );
});
