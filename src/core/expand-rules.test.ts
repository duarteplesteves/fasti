import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";

import { expandRules } from "./expand-rules.js";
import type { AvailabilityRule } from "./types.js";

describe(expandRules, () => {
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

    const result = expandRules({
      from: Temporal.PlainDate.from("2026-05-11"),
      rules: [rule],
      to: Temporal.PlainDate.from("2026-05-13"),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.resourceId).toBe("doc-1");
    expect(result[0]?.start.toString()).toBe(
      Temporal.ZonedDateTime.from("2026-05-12T09:00[Europe/Lisbon]").toString()
    );
    expect(result[0]?.end.toString()).toBe(
      Temporal.ZonedDateTime.from("2026-05-12T17:00[Europe/Lisbon]").toString()
    );
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

    const result = expandRules({
      from: Temporal.PlainDate.from("2026-05-11"),
      rules: [rule],
      to: Temporal.PlainDate.from("2026-05-13"),
    });

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

    const result = expandRules({
      from: Temporal.PlainDate.from("2026-05-04"),
      rules: [rule],
      to: Temporal.PlainDate.from("2026-05-26"),
    });

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

    const result = expandRules({
      from: Temporal.PlainDate.from("2026-05-05"),
      rules: [rule],
      to: Temporal.PlainDate.from("2026-05-19"),
    });

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

    const result = expandRules({
      from: Temporal.PlainDate.from("2026-05-05"),
      // Intentionally reversed input order — engine must sort.
      rules: [ruleB, ruleA],
      to: Temporal.PlainDate.from("2026-05-12"),
    });

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

    const result = expandRules({
      from: Temporal.PlainDate.from("2026-05-12"),
      rules: [morning, afternoon],
      to: Temporal.PlainDate.from("2026-05-12"),
    });

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

    const result = expandRules({
      from: Temporal.PlainDate.from("2026-05-12"),
      rules: [ruleLisbon, ruleNewYork],
      to: Temporal.PlainDate.from("2026-05-12"),
    });

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

    const result = expandRules({
      from: Temporal.PlainDate.from("2026-03-29"),
      rules: [rule],
      to: Temporal.PlainDate.from("2026-03-29"),
    });

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

    const result = expandRules({
      from: Temporal.PlainDate.from("2026-10-25"),
      rules: [rule],
      to: Temporal.PlainDate.from("2026-10-25"),
    });

    const [window] = result;
    if (!window) {
      throw new Error("expected one window");
    }
    expect(window.start.until(window.end, { largestUnit: "hours" }).hours).toBe(
      5
    );
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

    it("throws when timeWindow.start equals timeWindow.end", () => {
      const rule: AvailabilityRule = {
        ...baseRule,
        timeWindow: {
          end: Temporal.PlainTime.from("09:00"),
          start: Temporal.PlainTime.from("09:00"),
        },
      };
      expect(() =>
        expandRules({
          from: Temporal.PlainDate.from("2026-05-12"),
          rules: [rule],
          to: Temporal.PlainDate.from("2026-05-12"),
        })
      ).toThrow(/timeWindow\.start/u);
    });

    it("throws when effectiveTo is before effectiveFrom", () => {
      const rule: AvailabilityRule = {
        ...baseRule,
        effectiveFrom: Temporal.PlainDate.from("2026-06-01"),
        effectiveTo: Temporal.PlainDate.from("2026-05-01"),
      };
      expect(() =>
        expandRules({
          from: Temporal.PlainDate.from("2026-05-12"),
          rules: [rule],
          to: Temporal.PlainDate.from("2026-05-12"),
        })
      ).toThrow(/effectiveTo/u);
    });

    it("throws when daysOfWeek is empty", () => {
      const rule: AvailabilityRule = {
        ...baseRule,
        recurrence: { daysOfWeek: [], frequency: "weekly", interval: 1 },
      };
      expect(() =>
        expandRules({
          from: Temporal.PlainDate.from("2026-05-12"),
          rules: [rule],
          to: Temporal.PlainDate.from("2026-05-12"),
        })
      ).toThrow(/daysOfWeek/u);
    });

    it.each([0, 8, -1, 1.5])(
      "throws when daysOfWeek contains invalid value %s",
      (value) => {
        const rule: AvailabilityRule = {
          ...baseRule,
          recurrence: { daysOfWeek: [value], frequency: "weekly", interval: 1 },
        };
        expect(() =>
          expandRules({
            from: Temporal.PlainDate.from("2026-05-12"),
            rules: [rule],
            to: Temporal.PlainDate.from("2026-05-12"),
          })
        ).toThrow(/daysOfWeek/u);
      }
    );

    it("throws when daysOfWeek contains duplicates", () => {
      const rule: AvailabilityRule = {
        ...baseRule,
        recurrence: { daysOfWeek: [2, 2], frequency: "weekly", interval: 1 },
      };
      expect(() =>
        expandRules({
          from: Temporal.PlainDate.from("2026-05-12"),
          rules: [rule],
          to: Temporal.PlainDate.from("2026-05-12"),
        })
      ).toThrow(/daysOfWeek/u);
    });

    it.each([0, -1, 1.5])(
      "throws when recurrence.interval is invalid (%s)",
      (value) => {
        const rule: AvailabilityRule = {
          ...baseRule,
          recurrence: { daysOfWeek: [2], frequency: "weekly", interval: value },
        };
        expect(() =>
          expandRules({
            from: Temporal.PlainDate.from("2026-05-12"),
            rules: [rule],
            to: Temporal.PlainDate.from("2026-05-12"),
          })
        ).toThrow(/recurrence\.interval/u);
      }
    );

    it("throws when params.from is after params.to", () => {
      expect(() =>
        expandRules({
          from: Temporal.PlainDate.from("2026-05-13"),
          rules: [baseRule],
          to: Temporal.PlainDate.from("2026-05-12"),
        })
      ).toThrow(/from/u);
    });

    it("allows params.from equal to params.to (single-day query)", () => {
      const result = expandRules({
        from: Temporal.PlainDate.from("2026-05-12"),
        rules: [baseRule],
        to: Temporal.PlainDate.from("2026-05-12"),
      });
      expect(result).toHaveLength(1);
    });

    it("throws when timeWindow.start is after timeWindow.end", () => {
      const rule: AvailabilityRule = {
        ...baseRule,
        timeWindow: {
          end: Temporal.PlainTime.from("09:00"),
          start: Temporal.PlainTime.from("22:00"),
        },
      };
      expect(() =>
        expandRules({
          from: Temporal.PlainDate.from("2026-05-12"),
          rules: [rule],
          to: Temporal.PlainDate.from("2026-05-12"),
        })
      ).toThrow(/timeWindow\.start/u);
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

    const result = expandRules({
      from: Temporal.PlainDate.from("2026-05-11"),
      rules: [rule],
      to: Temporal.PlainDate.from("2026-05-13"),
    });

    expect(result).toStrictEqual([]);
  });
});
