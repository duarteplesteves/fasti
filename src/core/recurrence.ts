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
 * Weeks count from the Monday of `effectiveFrom`; without it every week is on.
 *
 * @returns `true` when `date`'s weekday is listed and its week is one of every `interval`.
 */
function occursOnWeekly(
  recurrence: WeeklyRecurrence,
  date: Temporal.PlainDate,
  effectiveFrom: Temporal.PlainDate | undefined
): boolean {
  const weekIndex =
    effectiveFrom === undefined
      ? 0
      : date
          .subtract({ days: date.dayOfWeek - 1 })
          .since(
            effectiveFrom.subtract({ days: effectiveFrom.dayOfWeek - 1 }),
            {
              largestUnit: "days",
            }
          ).days / 7;

  return (
    weekIndex % recurrence.interval === 0 &&
    recurrence.daysOfWeek.includes(date.dayOfWeek)
  );
}

/**
 * Whether `recurrence` puts the rule on `date`.
 *
 * @returns `true` when the rule occurs on `date`.
 */
export function occursOn(
  recurrence: Recurrence,
  date: Temporal.PlainDate,
  effectiveFrom: Temporal.PlainDate | undefined
): boolean {
  switch (recurrence.frequency) {
    case "weekly": {
      return occursOnWeekly(recurrence, date, effectiveFrom);
    }

    default: {
      // A new Recurrence member fails to compile here until it is handled.
      const unhandled: never = recurrence.frequency;

      return unhandled;
    }
  }
}
