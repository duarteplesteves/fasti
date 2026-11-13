import { checkRules } from "./checks.js";
import { occursOn } from "./recurrence.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import type { AvailabilityRule, ExpandedWindow } from "./types.js";

/** Rules to expand over every date in `[from, to]`, both ends included. */
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
    let cursor = from;

    while (Temporal.PlainDate.compare(cursor, to) <= 0) {
      const date = cursor;

      const beforeEffective =
        !!rule.effectiveFrom &&
        Temporal.PlainDate.compare(date, rule.effectiveFrom) < 0;

      const afterEffective =
        !!rule.effectiveTo &&
        Temporal.PlainDate.compare(date, rule.effectiveTo) > 0;

      const isException = rule.exceptions?.some((e) => e.equals(date)) ?? false;

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

/**
 * One ExpandedWindow per rule per matching date in `[from, to]`, in each rule's
 * timezone: unmerged, multi-resource, sorted by start then `resourceId`.
 */
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
