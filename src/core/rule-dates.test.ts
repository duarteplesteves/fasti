import { describe, expect, it } from "vitest";

import { DAY_MS } from "./day-offset.js";
import { dateOf, epochDay } from "./rule-dates.js";

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
  ])(
    "counts the days to %s in any calendar, and dateOf reads them back",
    (text) => {
      const date = Temporal.PlainDate.from(text);
      const days = date.toZonedDateTime("UTC").epochMilliseconds / DAY_MS;

      expect(epochDay(date)).toBe(days);
      expect(epochDay(date.withCalendar("buddhist"))).toBe(days);
      expect(dateOf(days).toString()).toBe(date.toString());
    }
  );
});
