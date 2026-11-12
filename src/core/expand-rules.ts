import { checkOrder } from "./check-rule.js";
import { checkRules } from "./checks.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import type { AvailabilityRule, ExpandedWindow } from "./types.js";

export interface ExpandRulesParams {
  rules: readonly AvailabilityRule[];
  from: Temporal.PlainDate;
  to: Temporal.PlainDate;
}

/** `expandRules` without checks, for Core functions that already checked their params. */
export function expandRulesUnchecked(
  params: ExpandRulesParams
): ExpandedWindow[] {
  const { from, rules, to } = params;
  const windows: ExpandedWindow[] = [];

  for (const rule of rules) {
    const weekAnchor = rule.effectiveFrom?.subtract({
      days: rule.effectiveFrom.dayOfWeek - 1,
    });

    let cursor = from;

    while (Temporal.PlainDate.compare(cursor, to) <= 0) {
      const date = cursor;

      const beforeEffective =
        !!rule.effectiveFrom &&
        Temporal.PlainDate.compare(date, rule.effectiveFrom) < 0;

      const afterEffective =
        !!rule.effectiveTo &&
        Temporal.PlainDate.compare(date, rule.effectiveTo) > 0;

      const dateMonday = date.subtract({ days: date.dayOfWeek - 1 });

      const weekIndex =
        weekAnchor === undefined
          ? 0
          : dateMonday.since(weekAnchor, { largestUnit: "days" }).days / 7;

      const onIntervalWeek = weekIndex % rule.recurrence.interval === 0;
      const isException = rule.exceptions?.some((e) => e.equals(date));

      if (
        !beforeEffective &&
        !afterEffective &&
        onIntervalWeek &&
        !isException &&
        rule.recurrence.daysOfWeek.includes(date.dayOfWeek)
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
    ...checkOrder(
      Temporal.PlainDate.compare,
      { label: "from", value: from },
      { label: "to", value: to },
      "onOrAfter",
      ["to"]
    ),
  ];

  return checked(issues, () => expandRulesUnchecked(params));
}
