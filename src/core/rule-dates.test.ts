import { describe, expect, it, vi } from "vitest";

import { epochDay, ruleDates } from "./rule-dates.js";
import { DAY_MS } from "./zone-clock.js";

describe(epochDay, () => {
  // Year 1 of `ethioaa` is ISO year -5492; `Date.UTC` would misread years 0 to 99.
  it.each([
    "-005492-12-31",
    "-000343-02-28",
    "0000-12-31",
    "0001-01-01",
    "0099-12-31",
    "0100-03-01",
    "1969-12-31",
    "1970-01-01",
    "2024-02-29",
    "9999-12-31",
  ])("counts the days to %s in any calendar", (text) => {
    const date = Temporal.PlainDate.from(text);
    const days = date.toZonedDateTime("UTC").epochMilliseconds / DAY_MS;

    expect(epochDay(date)).toBe(days);
    expect(epochDay(date.withCalendar("buddhist"))).toBe(days);
  });
});

describe(ruleDates, () => {
  it("walks only a rule's effective dates, however long the range", () => {
    const daysOfWeek = [1, 2, 3, 4, 5];
    const reads = vi.spyOn(daysOfWeek, "includes");

    const datesIn = ruleDates({
      effectiveFrom: Temporal.PlainDate.from("2026-05-11"),
      effectiveTo: Temporal.PlainDate.from("2026-05-17"),
      exceptions: [Temporal.PlainDate.from("2026-05-13")],
      recurrence: { daysOfWeek, frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    });

    const days = datesIn(
      epochDay(Temporal.PlainDate.from("0001-01-01")),
      epochDay(Temporal.PlainDate.from("9999-12-31"))
    );

    expect(days).toStrictEqual(
      ["2026-05-11", "2026-05-12", "2026-05-14", "2026-05-15"].map((date) =>
        epochDay(Temporal.PlainDate.from(date))
      )
    );
    expect(reads).toHaveBeenCalledTimes(7);
  });
});
