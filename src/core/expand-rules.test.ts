import { describe, expect, it } from "vitest";

import { unwrap, issuePaths } from "../test-utils/results.js";
import { expandRules, expandRulesUnchecked } from "./expand-rules.js";
import { findFreeSlots } from "./find-free-slots.js";
import type { AvailabilityRule } from "./types.js";

/** The windows of a daily `start`–`end` rule on `date`, as `start → end` wall-clock times. */
function windowsOn(
  date: string,
  timezone: string,
  [start, end]: readonly [string, string]
) {
  const day = Temporal.PlainDate.from(date);

  const windows = unwrap(
    expandRules({
      from: day,
      rules: [
        {
          recurrence: {
            daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
            frequency: "weekly",
            interval: 1,
          },
          resourceId: "doc-1",
          timeWindow: {
            end: Temporal.PlainTime.from(end),
            start: Temporal.PlainTime.from(start),
          },
          timezone,
        },
      ],
      to: day,
    })
  );

  return windows.map(
    (w) =>
      `${w.start.toPlainTime().toString()} → ${w.end.toPlainTime().toString()}`
  );
}

/** The dates a rule with `fields` opens in `[from, to]`. */
function datesOf(fields: Partial<AvailabilityRule>, from: string, to: string) {
  const windows = unwrap(
    expandRules({
      from: Temporal.PlainDate.from(from),
      rules: [
        {
          recurrence: {
            daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
            frequency: "weekly",
            interval: 1,
          },
          resourceId: "doc-1",
          timeWindow: {
            end: Temporal.PlainTime.from("17:00"),
            start: Temporal.PlainTime.from("09:00"),
          },
          timezone: "UTC",
          ...fields,
        },
      ],
      to: Temporal.PlainDate.from(to),
    })
  );

  return windows.map((w) => w.start.toPlainDate().toString());
}

function weekly(daysOfWeek: readonly number[], interval = 1) {
  return { daysOfWeek, frequency: "weekly", interval } as const;
}

describe(expandRules, () => {
  it("opens the first and last effective dates, and none outside them", () => {
    expect(
      datesOf(
        {
          effectiveFrom: Temporal.PlainDate.from("2026-05-11"),
          effectiveTo: Temporal.PlainDate.from("2026-05-12"),
        },
        "2026-05-01",
        "2026-05-31"
      )
    ).toStrictEqual(["2026-05-11", "2026-05-12"]);
  });

  it.each([
    [1, "1969-12-29"],
    [2, "1969-12-30"],
    [3, "1969-12-31"],
    [4, "1970-01-01"],
    [5, "1970-01-02"],
    [6, "1970-01-03"],
    [7, "1970-01-04"],
  ])("opens weekday %i on %s, and the week before", (day, date) => {
    const before = Temporal.PlainDate.from(date).subtract({ days: 7 });

    expect(
      datesOf({ recurrence: weekly([day]) }, "1969-12-22", "1970-01-04")
    ).toStrictEqual([before.toString(), date]);
  });

  it("counts weeks from effectiveFrom's Monday before 1970", () => {
    expect(
      datesOf(
        {
          effectiveFrom: Temporal.PlainDate.from("1969-12-03"),
          recurrence: weekly([1, 7], 2),
        },
        "1969-11-24",
        "1970-01-11"
      )
    ).toStrictEqual([
      "1969-12-07",
      "1969-12-15",
      "1969-12-21",
      "1969-12-29",
      "1970-01-04",
    ]);
  });

  it("opens the years 0001, 0099 and 9999, except on exceptions", () => {
    expect(
      datesOf(
        {
          effectiveFrom: Temporal.PlainDate.from("0001-01-01"),
          exceptions: [Temporal.PlainDate.from("0001-01-03")],
          recurrence: weekly([1, 3]),
        },
        "0001-01-01",
        "0001-01-08"
      )
    ).toStrictEqual(["0001-01-01", "0001-01-08"]);

    expect(
      datesOf(
        { exceptions: [Temporal.PlainDate.from("0099-12-30")] },
        "0099-12-29",
        "0099-12-31"
      )
    ).toStrictEqual(["0099-12-29", "0099-12-31"]);

    expect(
      datesOf(
        {
          effectiveTo: Temporal.PlainDate.from("9999-12-31"),
          exceptions: [Temporal.PlainDate.from("9999-12-30")],
        },
        "9999-12-29",
        "9999-12-31"
      )
    ).toStrictEqual(["9999-12-29", "9999-12-31"]);
  });

  it("reads dates in any calendar, and keeps from's", () => {
    expect(
      datesOf(
        {
          effectiveFrom: Temporal.PlainDate.from("2026-05-11"),
          exceptions: [
            Temporal.PlainDate.from("2026-05-12"),
            Temporal.PlainDate.from("2026-05-14[u-ca=buddhist]"),
          ],
        },
        "2026-05-10[u-ca=buddhist]",
        "2026-05-14[u-ca=buddhist]"
      )
    ).toStrictEqual(["2026-05-11[u-ca=buddhist]", "2026-05-13[u-ca=buddhist]"]);
  });

  it("emits one window for a weekly rule that matches one day in range", () => {
    // 2026-05-12 is a Tuesday (ISO weekday 2).
    const rule: AvailabilityRule = {
      recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const result = unwrap(
      expandRules({
        from: Temporal.PlainDate.from("2026-05-11"),
        rules: [rule],
        to: Temporal.PlainDate.from("2026-05-13"),
      })
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.resourceId).toBe("doc-1");
    expect(result[0]?.start.toString()).toBe(
      Temporal.ZonedDateTime.from("2026-05-12T09:00[Europe/Lisbon]").toString()
    );
    expect(result[0]?.end.toString()).toBe(
      Temporal.ZonedDateTime.from("2026-05-12T17:00[Europe/Lisbon]").toString()
    );
  });

  it("walks only a rule's effective dates, however long the range", () => {
    const rule: AvailabilityRule = {
      effectiveFrom: Temporal.PlainDate.from("2026-05-11"),
      effectiveTo: Temporal.PlainDate.from("2026-05-17"),
      exceptions: [Temporal.PlainDate.from("2026-05-13")],
      recurrence: {
        daysOfWeek: [1, 2, 3, 4, 5],
        frequency: "weekly",
        interval: 1,
      },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    // Unchecked: the internal path `windowsFor` takes; a direct call is capped at 366 days.
    const result = expandRulesUnchecked({
      from: Temporal.PlainDate.from("2000-01-01"),
      rules: [rule],
      to: Temporal.PlainDate.from("9999-12-31"),
    });

    expect(result.map((w) => w.start.toPlainDate().toString())).toStrictEqual([
      "2026-05-11",
      "2026-05-12",
      "2026-05-14",
      "2026-05-15",
    ]);
  });

  it("emits no windows when range is entirely before effectiveFrom", () => {
    const rule: AvailabilityRule = {
      effectiveFrom: Temporal.PlainDate.from("2026-06-01"),
      recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const result = unwrap(
      expandRules({
        from: Temporal.PlainDate.from("2026-05-11"),
        rules: [rule],
        to: Temporal.PlainDate.from("2026-05-13"),
      })
    );

    expect(result).toStrictEqual([]);
  });

  it("emits only every Nth week when recurrence.interval > 1", () => {
    // Tuesdays only, every other week, anchored at 2026-05-05 (Tue).
    // Tuesdays in range: 05-05 (week 0), 05-12 (week 1), 05-19 (week 2), 05-26 (week 3).
    // With interval 2: 05-05 and 05-19 emit; 05-12 and 05-26 skip.
    const rule: AvailabilityRule = {
      effectiveFrom: Temporal.PlainDate.from("2026-05-05"),
      recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 2 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const result = unwrap(
      expandRules({
        from: Temporal.PlainDate.from("2026-05-04"),
        rules: [rule],
        to: Temporal.PlainDate.from("2026-05-26"),
      })
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.start.toPlainDate().toString()).toBe("2026-05-05");
    expect(result[1]?.start.toPlainDate().toString()).toBe("2026-05-19");
  });

  it("excludes dates listed in exceptions", () => {
    const rule: AvailabilityRule = {
      exceptions: [Temporal.PlainDate.from("2026-05-12")],
      recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const result = unwrap(
      expandRules({
        from: Temporal.PlainDate.from("2026-05-05"),
        rules: [rule],
        to: Temporal.PlainDate.from("2026-05-19"),
      })
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.start.toPlainDate().toString()).toBe("2026-05-05");
    expect(result[1]?.start.toPlainDate().toString()).toBe("2026-05-19");
  });

  it("emits flat output across multiple resources, sorted by start then resourceId", () => {
    const ruleA: AvailabilityRule = {
      recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const ruleB: AvailabilityRule = { ...ruleA, resourceId: "doc-2" };

    const result = unwrap(
      expandRules({
        from: Temporal.PlainDate.from("2026-05-05"),
        // Intentionally reversed input order — engine must sort.
        rules: [ruleB, ruleA],
        to: Temporal.PlainDate.from("2026-05-12"),
      })
    );

    expect(
      result.map((w) => `${w.resourceId}@${w.start.toPlainDate().toString()}`)
    ).toStrictEqual([
      "doc-1@2026-05-05",
      "doc-2@2026-05-05",
      "doc-1@2026-05-12",
      "doc-2@2026-05-12",
    ]);
  });

  it("emits both windows when two rules cover the same resource same day", () => {
    const morning: AvailabilityRule = {
      recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("12:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const afternoon: AvailabilityRule = {
      ...morning,
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("14:00"),
      },
    };

    const result = unwrap(
      expandRules({
        from: Temporal.PlainDate.from("2026-05-12"),
        rules: [morning, afternoon],
        to: Temporal.PlainDate.from("2026-05-12"),
      })
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.start.toString()).toBe(
      Temporal.ZonedDateTime.from("2026-05-12T09:00[Europe/Lisbon]").toString()
    );
    expect(result[1]?.start.toString()).toBe(
      Temporal.ZonedDateTime.from("2026-05-12T14:00[Europe/Lisbon]").toString()
    );
  });

  it("anchors each window in its rule's own timezone", () => {
    const ruleLisbon: AvailabilityRule = {
      recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
      resourceId: "doc-LX",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const ruleNewYork: AvailabilityRule = {
      ...ruleLisbon,
      resourceId: "doc-NY",
      timezone: "America/New_York",
    };

    const result = unwrap(
      expandRules({
        from: Temporal.PlainDate.from("2026-05-12"),
        rules: [ruleLisbon, ruleNewYork],
        to: Temporal.PlainDate.from("2026-05-12"),
      })
    );

    expect(result).toHaveLength(2);
    // Lisbon 09:00 (UTC+1 in May) = 08:00 UTC, sorts before NY 09:00 (UTC-4) = 13:00 UTC.
    expect(result[0]?.resourceId).toBe("doc-LX");
    expect(result[0]?.start.timeZoneId).toBe("Europe/Lisbon");
    expect(result[1]?.resourceId).toBe("doc-NY");
    expect(result[1]?.start.timeZoneId).toBe("America/New_York");
  });

  it("anchors window endpoints correctly across DST spring-forward", () => {
    // 2026-03-29 is spring-forward day in Europe/Lisbon: 01:00 WET → 02:00 WEST.
    // ISO weekday for Sunday is 7. Wall-clock 00:00–04:00 spans the 1-hour gap;
    // real elapsed time is 3 hours, not 4.
    const rule: AvailabilityRule = {
      recurrence: { daysOfWeek: [7], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("04:00"),
        start: Temporal.PlainTime.from("00:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const result = unwrap(
      expandRules({
        from: Temporal.PlainDate.from("2026-03-29"),
        rules: [rule],
        to: Temporal.PlainDate.from("2026-03-29"),
      })
    );

    const [window] = result;

    if (!window) {
      throw new Error("expected one window");
    }

    expect(window.start.toString()).toBe(
      Temporal.ZonedDateTime.from("2026-03-29T00:00[Europe/Lisbon]").toString()
    );
    expect(window.end.toString()).toBe(
      Temporal.ZonedDateTime.from("2026-03-29T04:00[Europe/Lisbon]").toString()
    );
    expect(window.start.until(window.end, { largestUnit: "hours" }).hours).toBe(
      3
    );
  });

  it("anchors window endpoints correctly across DST fall-back", () => {
    // 2026-10-25 is fall-back day in Europe/Lisbon: 02:00 WEST → 01:00 WET.
    // Wall-clock 00:00–04:00 contains the repeated hour 01:00–02:00;
    // real elapsed time is 5 hours, not 4.
    const rule: AvailabilityRule = {
      recurrence: { daysOfWeek: [7], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("04:00"),
        start: Temporal.PlainTime.from("00:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const result = unwrap(
      expandRules({
        from: Temporal.PlainDate.from("2026-10-25"),
        rules: [rule],
        to: Temporal.PlainDate.from("2026-10-25"),
      })
    );

    const [window] = result;

    if (!window) {
      throw new Error("expected one window");
    }

    expect(window.start.until(window.end, { largestUnit: "hours" }).hours).toBe(
      5
    );
  });

  describe("a window with an edge in a spring-forward gap (ADR 005)", () => {
    // Lisbon jumps 01:00 → 02:00 on 2026-03-29, Cairo 00:00 → 01:00 on 2026-04-24, New York 02:00 → 03:00 on 2026-03-08.
    it.each([
      [
        "2026-03-29",
        "Europe/Lisbon",
        "00:30",
        "01:30",
        ["00:30:00 → 02:00:00"],
      ],
      [
        "2026-03-29",
        "Europe/Lisbon",
        "01:30",
        "02:15",
        ["02:00:00 → 02:15:00"],
      ],
      ["2026-03-29", "Europe/Lisbon", "01:00", "01:30", []],
      ["2026-03-29", "Europe/Lisbon", "01:00", "02:00", []],
      [
        "2026-03-29",
        "Europe/Lisbon",
        "00:30",
        "01:00",
        ["00:30:00 → 02:00:00"],
      ],
      [
        "2026-03-29",
        "Europe/Lisbon",
        "02:00",
        "03:00",
        ["02:00:00 → 03:00:00"],
      ],
      ["2026-04-24", "Africa/Cairo", "00:30", "01:30", ["01:00:00 → 01:30:00"]],
      ["2026-04-24", "Africa/Cairo", "00:15", "00:45", []],
      [
        "2026-03-08",
        "America/New_York",
        "01:30",
        "02:30",
        ["01:30:00 → 03:00:00"],
      ],
      // Samoa skipped the whole of 2011-12-30.
      ["2011-12-30", "Pacific/Apia", "09:00", "17:00", []],
    ])(
      "%s in %s: %s–%s is clipped to the times that exist",
      (date, timezone, start, end, expected) => {
        expect(windowsOn(date, timezone, [start, end])).toStrictEqual(expected);
      }
    );

    it("opens no Slot outside the rule's wall-clock times", () => {
      const slots = unwrap(
        findFreeSlots({
          bookings: [],
          duration: 15,
          from: Temporal.Instant.from("2026-03-29T00:00:00Z"),
          interval: 15,
          resourceId: "doc-1",
          rules: [
            {
              recurrence: { daysOfWeek: [7], frequency: "weekly", interval: 1 },
              resourceId: "doc-1",
              timeWindow: {
                end: Temporal.PlainTime.from("01:30"),
                start: Temporal.PlainTime.from("00:30"),
              },
              timezone: "Europe/Lisbon",
            },
          ],
          timezone: "Europe/Lisbon",
          to: Temporal.Instant.from("2026-03-30T00:00:00Z"),
        })
      );

      expect(slots.map((s) => s.start.toPlainTime().toString())).toStrictEqual([
        "00:30:00",
        "00:45:00",
      ]);
    });
  });

  describe("validation", () => {
    const baseRule: AvailabilityRule = {
      recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    it("reports timeWindow.start equals timeWindow.end", () => {
      const rule: AvailabilityRule = {
        ...baseRule,
        timeWindow: {
          end: Temporal.PlainTime.from("09:00"),
          start: Temporal.PlainTime.from("09:00"),
        },
      };

      expect(
        issuePaths(
          expandRules({
            from: Temporal.PlainDate.from("2026-05-12"),
            rules: [rule],
            to: Temporal.PlainDate.from("2026-05-12"),
          })
        )
      ).toStrictEqual([["rules", 0, "timeWindow", "end"]]);
    });

    it("reports effectiveTo is before effectiveFrom", () => {
      const rule: AvailabilityRule = {
        ...baseRule,
        effectiveFrom: Temporal.PlainDate.from("2026-06-01"),
        effectiveTo: Temporal.PlainDate.from("2026-05-01"),
      };

      expect(
        issuePaths(
          expandRules({
            from: Temporal.PlainDate.from("2026-05-12"),
            rules: [rule],
            to: Temporal.PlainDate.from("2026-05-12"),
          })
        )
      ).toStrictEqual([["rules", 0, "effectiveTo"]]);
    });

    it("reports daysOfWeek is empty", () => {
      const rule: AvailabilityRule = {
        ...baseRule,
        recurrence: { daysOfWeek: [], frequency: "weekly", interval: 1 },
      };

      expect(
        issuePaths(
          expandRules({
            from: Temporal.PlainDate.from("2026-05-12"),
            rules: [rule],
            to: Temporal.PlainDate.from("2026-05-12"),
          })
        )
      ).toStrictEqual([["rules", 0, "recurrence", "daysOfWeek"]]);
    });

    it.each([0, 8, -1, 1.5])(
      "reports daysOfWeek contains invalid value %s",
      (value) => {
        const rule: AvailabilityRule = {
          ...baseRule,
          recurrence: { daysOfWeek: [value], frequency: "weekly", interval: 1 },
        };

        expect(
          issuePaths(
            expandRules({
              from: Temporal.PlainDate.from("2026-05-12"),
              rules: [rule],
              to: Temporal.PlainDate.from("2026-05-12"),
            })
          )
        ).toStrictEqual([["rules", 0, "recurrence", "daysOfWeek", 0]]);
      }
    );

    it("reports daysOfWeek contains duplicates", () => {
      const rule: AvailabilityRule = {
        ...baseRule,
        recurrence: { daysOfWeek: [2, 2], frequency: "weekly", interval: 1 },
      };

      expect(
        issuePaths(
          expandRules({
            from: Temporal.PlainDate.from("2026-05-12"),
            rules: [rule],
            to: Temporal.PlainDate.from("2026-05-12"),
          })
        )
      ).toStrictEqual([["rules", 0, "recurrence", "daysOfWeek", 1]]);
    });

    it.each([0, -1, 1.5])(
      "reports recurrence.interval is invalid (%s)",
      (value) => {
        const rule: AvailabilityRule = {
          ...baseRule,
          recurrence: { daysOfWeek: [2], frequency: "weekly", interval: value },
        };

        expect(
          issuePaths(
            expandRules({
              from: Temporal.PlainDate.from("2026-05-12"),
              rules: [rule],
              to: Temporal.PlainDate.from("2026-05-12"),
            })
          )
        ).toStrictEqual([["rules", 0, "recurrence", "interval"]]);
      }
    );

    it("reports params.from is after params.to", () => {
      expect(
        issuePaths(
          expandRules({
            from: Temporal.PlainDate.from("2026-05-13"),
            rules: [baseRule],
            to: Temporal.PlainDate.from("2026-05-12"),
          })
        )
      ).toStrictEqual([["to"]]);
    });

    it("allows params.from equal to params.to (single-day query)", () => {
      const result = unwrap(
        expandRules({
          from: Temporal.PlainDate.from("2026-05-12"),
          rules: [baseRule],
          to: Temporal.PlainDate.from("2026-05-12"),
        })
      );

      expect(result).toHaveLength(1);
    });

    it("reports timeWindow.start is after timeWindow.end", () => {
      const rule: AvailabilityRule = {
        ...baseRule,
        timeWindow: {
          end: Temporal.PlainTime.from("09:00"),
          start: Temporal.PlainTime.from("22:00"),
        },
      };

      expect(
        issuePaths(
          expandRules({
            from: Temporal.PlainDate.from("2026-05-12"),
            rules: [rule],
            to: Temporal.PlainDate.from("2026-05-12"),
          })
        )
      ).toStrictEqual([["rules", 0, "timeWindow", "end"]]);
    });
  });

  it("emits no windows when range is entirely after effectiveTo", () => {
    const rule: AvailabilityRule = {
      effectiveTo: Temporal.PlainDate.from("2026-04-30"),
      recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const result = unwrap(
      expandRules({
        from: Temporal.PlainDate.from("2026-05-11"),
        rules: [rule],
        to: Temporal.PlainDate.from("2026-05-13"),
      })
    );

    expect(result).toStrictEqual([]);
  });
});

describe(`${expandRules.name} issues`, () => {
  it("reports issues from every rule, prefixed by the rule's index", () => {
    const rule: AvailabilityRule = {
      recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const result = expandRules({
      from: Temporal.PlainDate.from("2026-05-13"),
      rules: [
        { ...rule, timezone: "Nowhere/Land" },
        rule,
        { ...rule, recurrence: { ...rule.recurrence, daysOfWeek: [] } },
      ],
      to: Temporal.PlainDate.from("2026-05-12"),
    });

    expect(issuePaths(result)).toStrictEqual([
      ["rules", 0, "timezone"],
      ["rules", 2, "recurrence", "daysOfWeek"],
      ["to"],
    ]);
  });
});
