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

/**
 * `expandRules` without checks, for Core functions that already checked their params.
 *
 * @returns The expanded windows, sorted by start then `resourceId`.
 */
export function expandRulesUnchecked(
  params: ExpandRulesParams
): ExpandedWindow[] {
  const { from, rules, to } = params;
  const windows: ExpandedWindow[] = [];

  for (const rule of rules) {
    // Only the dates the rule is in effect, so a long range costs a short-lived rule nothing.
    const first =
      rule.effectiveFrom &&
      Temporal.PlainDate.compare(rule.effectiveFrom, from) > 0
        ? rule.effectiveFrom
        : from;

    const last =
      rule.effectiveTo && Temporal.PlainDate.compare(rule.effectiveTo, to) < 0
        ? rule.effectiveTo
        : to;

    const exceptions = new Set(rule.exceptions?.map((e) => e.toString()));

    for (
      let date = first;
      Temporal.PlainDate.compare(date, last) <= 0;
      date = date.add({ days: 1 })
    ) {
      if (
        !exceptions.has(date.toString()) &&
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
 *
 * @returns The expanded windows, or `InvalidParams` when a rule is malformed or `from` is after `to`.
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
