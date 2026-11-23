import { describe, expect, it } from "vitest";

import { issuePaths, unwrap } from "../test-utils/results.js";
import {
  MAX_DURATION_MINUTES,
  MAX_EXCEPTIONS,
  MAX_EXPAND_DAYS,
  MAX_GRID_TIMES,
  MAX_RULES,
  checkInstantRange,
  checkRule,
  checkRules,
} from "./checks.js";
import { expandRules } from "./expand-rules.js";
import { findFreeSlots } from "./find-free-slots.js";
import type { AvailabilityRule } from "./types.js";

const rule: AvailabilityRule = {
  recurrence: { daysOfWeek: [1, 3], frequency: "weekly", interval: 1 },
  resourceId: "doc-1",
  timeWindow: {
    end: Temporal.PlainTime.from("17:00"),
    start: Temporal.PlainTime.from("09:00"),
  },
  timezone: "Europe/Lisbon",
};

function date(s: string) {
  return Temporal.PlainDate.from(s);
}

function instant(s: string) {
  return Temporal.Instant.from(s);
}

function exceptions(n: number) {
  return Array.from({ length: n }, (_, i) =>
    date("2030-01-01").add({ days: i })
  );
}

const from = instant("2030-06-03T00:00:00Z");

function search(minutes: number, duration = 30) {
  return findFreeSlots({
    bookings: [],
    duration,
    from,
    interval: 1,
    relax: ["availability"],
    resourceId: "doc-1",
    rules: [],
    timezone: "UTC",
    to: from.add({ minutes }),
  });
}

describe("the supported years, 0001–9999 (ADR 019)", () => {
  it("accepts a range from the first instant of 0001 to the last of 9999", () => {
    expect(
      checkInstantRange(
        {
          end: instant("9999-12-31T23:59:59.999999999Z"),
          start: instant("0001-01-01T00:00:00Z"),
        },
        []
      )
    ).toStrictEqual([]);
  });

  it.each([
    ["start", "-000001-12-31T23:59:59Z", "2030-01-01T00:00:00Z"],
    ["end", "2030-01-01T00:00:00Z", "+010000-01-01T00:00:00Z"],
  ])("refuses a range whose %s is outside them", (path, start, end) => {
    expect(
      checkInstantRange({ end: instant(end), start: instant(start) }, [])
    ).toStrictEqual([
      {
        message: `${instant(path === "start" ? start : end).toString()} is outside the supported years 0001–9999.`,
        path: [path],
      },
    ]);
  });

  it("accepts a rule's dates in 0001 and 9999, and refuses them beyond", () => {
    expect(
      checkRule({
        ...rule,
        effectiveFrom: date("0001-01-01"),
        effectiveTo: date("9999-12-31"),
        exceptions: [date("9999-12-31")],
      })
    ).toStrictEqual([]);

    expect(
      checkRule({
        ...rule,
        effectiveFrom: date("0000-12-31"),
        effectiveTo: date("+010000-01-01"),
        exceptions: [date("+275760-09-13")],
      }).map((i) => i.path)
    ).toStrictEqual([["effectiveFrom"], ["effectiveTo"], ["exceptions", 0]]);
  });

  it("refuses expandRules beyond them, without throwing", () => {
    expect(
      issuePaths(
        expandRules({
          from: date("-271821-04-19"),
          rules: [rule],
          to: date("+275760-09-13"),
        })
      )
    ).toStrictEqual([["from"], ["to"]]);
  });

  it("refuses a search beyond them", () => {
    expect(
      issuePaths(
        findFreeSlots({
          bookings: [],
          duration: 30,
          from: instant("+010000-01-01T00:00:00Z"),
          interval: 15,
          resourceId: "doc-1",
          rules: [],
          timezone: "UTC",
          to: instant("+010000-01-02T00:00:00Z"),
        })
      )
    ).toStrictEqual([["from"], ["to"]]);
  });
});

describe("the limits on work (ADR 019)", () => {
  it(`searches ${MAX_GRID_TIMES} Grid times, and refuses one more`, () => {
    expect(unwrap(search(MAX_GRID_TIMES))).toHaveLength(MAX_GRID_TIMES);

    const over = search(MAX_GRID_TIMES + 1);

    expect(over).toStrictEqual({
      error: {
        _tag: "InvalidParams",
        issues: [
          {
            message:
              "Search covers 10,001 Grid times; the limit is 10,000. Split it into smaller ranges.",
            path: ["to"],
          },
        ],
      },
      ok: false,
    });
  });

  it(`takes a duration of ${MAX_DURATION_MINUTES} minutes, and refuses longer or unsafe ones`, () => {
    expect(search(60, MAX_DURATION_MINUTES).ok).toBeTruthy();
    expect(issuePaths(search(60, MAX_DURATION_MINUTES + 1))).toStrictEqual([
      ["duration"],
    ]);
    expect(issuePaths(search(60, Number.MAX_SAFE_INTEGER))).toStrictEqual([
      ["duration"],
    ]);
    expect(issuePaths(search(60, Number.MAX_SAFE_INTEGER + 2))).toStrictEqual([
      ["duration"],
    ]);
  });

  it(`expands ${MAX_EXPAND_DAYS} days, and refuses one more`, () => {
    const start = date("2030-01-01");

    expect(
      expandRules({
        from: start,
        rules: [rule],
        to: start.add({ days: MAX_EXPAND_DAYS - 1 }),
      }).ok
    ).toBeTruthy();
    expect(
      issuePaths(
        expandRules({
          from: start,
          rules: [rule],
          to: start.add({ days: MAX_EXPAND_DAYS }),
        })
      )
    ).toStrictEqual([["to"]]);
  });

  it(`checks ${MAX_RULES} rules, and refuses one more`, () => {
    expect(
      checkRules(Array.from({ length: MAX_RULES }, () => rule))
    ).toStrictEqual([]);
    expect(
      checkRules(Array.from({ length: MAX_RULES + 1 }, () => rule))
    ).toStrictEqual([
      { message: "Got 101 rules; the limit is 100.", path: ["rules"] },
    ]);
  });

  it(`takes ${MAX_EXCEPTIONS} exceptions on a rule, and refuses one more`, () => {
    expect(
      checkRule({ ...rule, exceptions: exceptions(MAX_EXCEPTIONS) })
    ).toStrictEqual([]);
    expect(
      checkRule({ ...rule, exceptions: exceptions(MAX_EXCEPTIONS + 1) }).map(
        (i) => i.path
      )
    ).toStrictEqual([["exceptions"]]);
  });
});
