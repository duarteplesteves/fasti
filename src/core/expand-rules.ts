import { Temporal } from "@js-temporal/polyfill";

import type { ExpandRulesParams, ExpandedWindow } from "./types.js";
import { validateRule } from "./validate.js";

export function expandRules(params: ExpandRulesParams): ExpandedWindow[] {
  const { rules, from, to } = params;

  if (Temporal.PlainDate.compare(from, to) > 0) {
    throw new Error(
      `Invalid range: from (${from.toString()}) must be on or before to (${to.toString()}).`
    );
  }

  const windows: ExpandedWindow[] = [];

  for (const rule of rules) {
    validateRule(rule);

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
