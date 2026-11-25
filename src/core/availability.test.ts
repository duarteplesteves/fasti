import { describe, expect, it, vi } from "vitest";

import { windowFit } from "./availability.js";

/** Asks twice about a slot of `hours`, and counts the dates opened: `daysOfWeek` is read once for each. */
function askedFor(hours: number) {
  const daysOfWeek = [1, 2, 3, 4, 5, 6, 7];
  const reads = vi.spyOn(daysOfWeek, "includes");
  const start = Temporal.Instant.from("2026-01-01T00:00Z");

  const fits = windowFit([
    {
      recurrence: { daysOfWeek, frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "UTC",
    },
  ]);

  const slot = { end: start.add({ hours }), start };

  return {
    answers: [fits(slot), fits(slot)],
    reads: reads.mock.calls.length,
  };
}

describe(windowFit, () => {
  it("opens no dates for a slot too long for any window to hold", () => {
    expect(askedFor(49)).toStrictEqual({ answers: [false, false], reads: 0 });
  });

  it("opens each date once, however many slots ask for it", () => {
    // 2025-12-31 to 2026-01-04.
    expect(askedFor(48)).toStrictEqual({ answers: [false, false], reads: 5 });
  });
});
