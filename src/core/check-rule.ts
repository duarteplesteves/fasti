import type { Issue } from "./result.js";
import type { AvailabilityRule } from "./types.js";

export type Path = readonly (string | number)[];

/** IANA names only: fixed offsets like "+01:00" don't follow DST. */
export function checkTimeZone(timeZone: string, path: Path): Issue[] {
  let canonical: string;

  try {
    canonical = new Temporal.ZonedDateTime(0n, timeZone).timeZoneId;
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }

    return [
      {
        message: `Unknown timezone "${timeZone}". Use an IANA name such as "Europe/Lisbon".`,
        path,
      },
    ];
  }

  return canonical.startsWith("+") || canonical.startsWith("-")
    ? [
        {
          message: `Timezone "${timeZone}" is a fixed offset, which doesn't follow daylight saving. Use an IANA name such as "Europe/Lisbon".`,
          path,
        },
      ]
    : [];
}

/** Every problem with `rule`, with paths relative to the rule. Empty when valid. */
export function checkRule(rule: AvailabilityRule): readonly Issue[] {
  const issues: Issue[] = [];
  const { timeWindow, effectiveFrom, effectiveTo } = rule;
  const { daysOfWeek, interval } = rule.recurrence;

  if (Temporal.PlainTime.compare(timeWindow.start, timeWindow.end) >= 0) {
    issues.push({
      message: `timeWindow.end (${timeWindow.end.toString()}) must be after timeWindow.start (${timeWindow.start.toString()}). Cross-day windows are not supported; split into two rules.`,
      path: ["timeWindow", "end"],
    });
  }

  if (
    effectiveFrom &&
    effectiveTo &&
    Temporal.PlainDate.compare(effectiveTo, effectiveFrom) < 0
  ) {
    issues.push({
      message: `effectiveTo (${effectiveTo.toString()}) must be on or after effectiveFrom (${effectiveFrom.toString()}).`,
      path: ["effectiveTo"],
    });
  }

  if (daysOfWeek.length === 0) {
    issues.push({
      message: "daysOfWeek must not be empty.",
      path: ["recurrence", "daysOfWeek"],
    });
  }

  const seen = new Set<number>();

  for (const [i, day] of daysOfWeek.entries()) {
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      issues.push({
        message: `daysOfWeek values must be integers in 1–7 (1 = Monday), got ${day}.`,
        path: ["recurrence", "daysOfWeek", i],
      });
    } else if (seen.has(day)) {
      issues.push({
        message: `daysOfWeek must not repeat a day, got ${day} again.`,
        path: ["recurrence", "daysOfWeek", i],
      });
    }

    seen.add(day);
  }

  if (!Number.isInteger(interval) || interval < 1) {
    issues.push({
      message: `recurrence.interval must be an integer ≥ 1, got ${interval}.`,
      path: ["recurrence", "interval"],
    });
  }

  issues.push(...checkTimeZone(rule.timezone, ["timezone"]));

  return issues;
}
