// Everything per `frequency` lives here: a new Recurrence member is handled in this file only.
import type { CheckIssue } from "./checks.js";
import type { Recurrence, WeeklyRecurrence } from "./types.js";

function checkWeeklyRecurrence(recurrence: WeeklyRecurrence): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const { daysOfWeek, interval } = recurrence;

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

  return issues;
}

/**
 * Every problem with `recurrence`, with paths relative to the rule.
 *
 * @returns The issues, empty when `recurrence` is valid.
 */
export function checkRecurrence(recurrence: Recurrence): CheckIssue[] {
  switch (recurrence.frequency) {
    case "weekly": {
      return checkWeeklyRecurrence(recurrence);
    }

    default: {
      // A new Recurrence member fails to compile here until it is handled.
      const unhandled: never = recurrence.frequency;

      return unhandled;
    }
  }
}

/**
 * The ISO weekday of `day`, in days since the epoch. Day 0, 1970-01-01, was a Thursday.
 *
 * @returns 1 (Monday) to 7 (Sunday).
 */
function isoWeekday(day: number): number {
  // `%` is negative before 1970.
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

function mondayOf(day: number): number {
  return day - (isoWeekday(day) - 1);
}

/**
 * Weeks count from the Monday of `effectiveFrom`; without it every week is on.
 *
 * @returns `true` when `day`'s weekday is listed and its week is one of every `interval`.
 */
function occursOnWeekly(
  recurrence: WeeklyRecurrence,
  day: number,
  effectiveFrom: number | undefined
): boolean {
  const weekIndex =
    effectiveFrom === undefined
      ? 0
      : (mondayOf(day) - mondayOf(effectiveFrom)) / 7;

  return (
    weekIndex % recurrence.interval === 0 &&
    recurrence.daysOfWeek.includes(isoWeekday(day))
  );
}

/**
 * Whether `recurrence` puts the rule on `day`. Both dates are days since the epoch.
 *
 * @returns `true` when the rule occurs on `day`.
 */
export function occursOn(
  recurrence: Recurrence,
  day: number,
  effectiveFrom: number | undefined
): boolean {
  switch (recurrence.frequency) {
    case "weekly": {
      return occursOnWeekly(recurrence, day, effectiveFrom);
    }

    default: {
      // A new Recurrence member fails to compile here until it is handled.
      const unhandled: never = recurrence.frequency;

      return unhandled;
    }
  }
}
