import { checkRules } from "./checks.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import type {
  AvailabilityRule,
  ExpandedWindow,
  Recurrence,
  WeeklyRecurrence,
} from "./types.js";

export interface ExpandRulesParams {
  rules: readonly AvailabilityRule[];
  from: Temporal.PlainDate;
  to: Temporal.PlainDate;
}

/** Weeks count from the Monday of `effectiveFrom`; without it every week is on. */
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

function occursOn(
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

/** `expandRules` without checks, for Core functions that already checked their params. */
export function expandRulesUnchecked(
  params: ExpandRulesParams
): ExpandedWindow[] {
  const { from, rules, to } = params;
  const windows: ExpandedWindow[] = [];

  for (const rule of rules) {
    let cursor = from;

    while (Temporal.PlainDate.compare(cursor, to) <= 0) {
      const date = cursor;

      const beforeEffective =
        !!rule.effectiveFrom &&
        Temporal.PlainDate.compare(date, rule.effectiveFrom) < 0;

      const afterEffective =
        !!rule.effectiveTo &&
        Temporal.PlainDate.compare(date, rule.effectiveTo) > 0;

      const isException = rule.exceptions?.some((e) => e.equals(date));

      if (
        !beforeEffective &&
        !afterEffective &&
        !isException &&
        occursOn(rule.recurrence, date, rule.effectiveFrom)
      ) {
        windows.push({
          end: date.toZonedDateTime({
            plainTime: rule.timeWindow.end,
            timeZone: rule.timezone,
          }),
          resourceId: rule.resourceId,
          start: date.toZonedDateTime({
            plainTime: rule.timeWindow.start,
            timeZone: rule.timezone,
          }),
        });
      }

      cursor = cursor.add({ days: 1 });
    }
  }

  windows.sort((a, b) => {
    const startCmp = Temporal.ZonedDateTime.compare(a.start, b.start);

    if (startCmp !== 0) {
      return startCmp;
    }

    return a.resourceId.localeCompare(b.resourceId);
  });

  return windows;
}

export function expandRules(
  params: ExpandRulesParams
): Result<ExpandedWindow[], InvalidParams> {
  const { from, rules, to } = params;

  const issues = [
    ...checkRules(rules),
    ...(Temporal.PlainDate.compare(from, to) > 0
      ? [
          {
            message: `to (${to.toString()}) must be on or after from (${from.toString()}).`,
            path: ["to"],
          },
        ]
      : []),
  ];

  return checked(issues, () => expandRulesUnchecked(params));
}
