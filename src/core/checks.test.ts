import { describe, expect, it } from "vitest";

import { checkRule } from "./checks.js";
import type { AvailabilityRule } from "./types.js";

function rulePaths(rule: AvailabilityRule) {
  return checkRule(rule).map((issue) => issue.path);
}

const valid: AvailabilityRule = {
  recurrence: { daysOfWeek: [1, 3], frequency: "weekly", interval: 1 },
  resourceId: "doc-1",
  timeWindow: {
    end: Temporal.PlainTime.from("17:00"),
    start: Temporal.PlainTime.from("09:00"),
  },
  timezone: "Europe/Lisbon",
};

function withRecurrence(
  recurrence: Partial<AvailabilityRule["recurrence"]>
): AvailabilityRule {
  return { ...valid, recurrence: { ...valid.recurrence, ...recurrence } };
}

describe(checkRule, () => {
  it("returns no issues for a valid rule", () => {
    expect(checkRule(valid)).toStrictEqual([]);
  });

  it.each(["09:00", "08:00"])(
    "reports a window ending at %s that doesn't end after 09:00",
    (end) => {
      const rule = {
        ...valid,
        timeWindow: {
          end: Temporal.PlainTime.from(end),
          start: Temporal.PlainTime.from("09:00"),
        },
      };

      expect(rulePaths(rule)).toStrictEqual([["timeWindow", "end"]]);
    }
  );

  it("reports effectiveTo before effectiveFrom", () => {
    const rule = {
      ...valid,
      effectiveFrom: Temporal.PlainDate.from("2026-06-01"),
      effectiveTo: Temporal.PlainDate.from("2026-05-31"),
    };

    expect(rulePaths(rule)).toStrictEqual([["effectiveTo"]]);
  });

  it("accepts effectiveTo equal to effectiveFrom", () => {
    const day = Temporal.PlainDate.from("2026-06-01");

    expect(
      checkRule({ ...valid, effectiveFrom: day, effectiveTo: day })
    ).toStrictEqual([]);
  });

  it("reports empty daysOfWeek", () => {
    expect(rulePaths(withRecurrence({ daysOfWeek: [] }))).toStrictEqual([
      ["recurrence", "daysOfWeek"],
    ]);
  });

  it.each([0, 8, -1, 1.5, Number.NaN])(
    "reports daysOfWeek value %s at its index",
    (day) => {
      expect(rulePaths(withRecurrence({ daysOfWeek: [2, day] }))).toStrictEqual(
        [["recurrence", "daysOfWeek", 1]]
      );
    }
  );

  it("reports each repeated day at the repeat's index", () => {
    expect(
      rulePaths(withRecurrence({ daysOfWeek: [2, 3, 2, 2] }))
    ).toStrictEqual([
      ["recurrence", "daysOfWeek", 2],
      ["recurrence", "daysOfWeek", 3],
    ]);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "reports recurrence interval %s",
    (interval) => {
      expect(rulePaths(withRecurrence({ interval }))).toStrictEqual([
        ["recurrence", "interval"],
      ]);
    }
  );

  it.each(["Europe/Lisbn", "+01:00", "-05:00", ""])(
    "reports timezone %j",
    (timezone) => {
      expect(rulePaths({ ...valid, timezone })).toStrictEqual([["timezone"]]);
    }
  );

  it.each(["UTC", "europe/lisbon", "Etc/GMT-1", "America/New_York"])(
    "accepts timezone %j",
    (timezone) => {
      expect(checkRule({ ...valid, timezone })).toStrictEqual([]);
    }
  );

  it("reports every problem in one call", () => {
    const rule: AvailabilityRule = {
      effectiveFrom: Temporal.PlainDate.from("2026-06-01"),
      effectiveTo: Temporal.PlainDate.from("2026-05-01"),
      recurrence: { daysOfWeek: [9, 1, 1], frequency: "weekly", interval: 0 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("08:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Mars/Olympus",
    };

    expect(rulePaths(rule)).toStrictEqual(
      expect.arrayContaining([
        ["timeWindow", "end"],
        ["effectiveTo"],
        ["recurrence", "daysOfWeek", 0],
        ["recurrence", "daysOfWeek", 2],
        ["recurrence", "interval"],
        ["timezone"],
      ])
    );
    expect(checkRule(rule)).toHaveLength(6);
  });

  it("skips the duplicate check for out-of-range days", () => {
    expect(rulePaths(withRecurrence({ daysOfWeek: [0, 0] }))).toStrictEqual([
      ["recurrence", "daysOfWeek", 0],
      ["recurrence", "daysOfWeek", 1],
    ]);
  });
});
