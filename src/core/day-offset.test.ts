import { describe, expect, it } from "vitest";

import { DAY_MS, dayOffsets } from "./day-offset.js";

/** Each date from `first` whose day has no one offset, over `days` days. */
function changeDays(timezone: string, first: string, days: number): string[] {
  const firstMidnight = Date.parse(`${first}T00:00Z`);
  const offsetOf = dayOffsets(timezone, firstMidnight);

  return Array.from(
    { length: days },
    (_, day) => firstMidnight + day * DAY_MS
  ).flatMap((midnight) =>
    offsetOf(midnight) === undefined
      ? [new Date(midnight).toISOString().slice(0, 10)]
      : []
  );
}

describe(dayOffsets, () => {
  // A day wrongly `undefined` costs the Grid time, not correctness, so no search test would notice.
  it("has an offset for every day except those the clocks change", () => {
    expect(changeDays("Europe/Lisbon", "2026-01-01", 730)).toStrictEqual([
      "2026-03-29",
      "2026-10-25",
      "2027-03-28",
      "2027-10-31",
    ]);
  });

  it("has an offset for every day of a timezone whose clocks never change", () => {
    expect(changeDays("Asia/Kolkata", "2026-01-01", 365)).toStrictEqual([]);
  });

  it("has no offset for a day that starts in a gap", () => {
    expect(changeDays("Africa/Cairo", "2026-04-20", 10)).toStrictEqual([
      "2026-04-24",
    ]);
  });

  it("gives a repeated midnight's day the same answer after a later day", () => {
    // The Azores repeat 00:00–01:00 that day: its midnight is the first one, before the change.
    const day = Date.parse("2026-10-25T00:00Z");
    const offsetOf = dayOffsets("Atlantic/Azores", day);

    expect([
      offsetOf(day),
      offsetOf(day + DAY_MS),
      offsetOf(day),
    ]).toStrictEqual([undefined, -60 * 60 * 1000, undefined]);
  });

  it("gives each day its own side of a clock change", () => {
    const hour = 60 * 60 * 1000;
    const first = Date.parse("2026-03-28T00:00Z");
    const offsetOf = dayOffsets("Europe/Berlin", first);

    expect([
      offsetOf(first),
      offsetOf(first + DAY_MS),
      offsetOf(first + 2 * DAY_MS),
    ]).toStrictEqual([hour, undefined, 2 * hour]);
  });
});
