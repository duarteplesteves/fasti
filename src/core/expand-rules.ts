import { MAX_EXPAND_DAYS, checkDate, checkRules } from "./checks.js";
import { compareTimes } from "./exact-time.js";
import type { ExactTime } from "./exact-time.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import { epochDay } from "./rule-dates.js";
import { ruleWindows } from "./rule-windows.js";
import type { AvailabilityRule, ExpandedWindow } from "./types.js";

/** Rules to expand over every date in `[from, to]`, both ends included. */
export interface ExpandRulesParams {
  rules: readonly AvailabilityRule[];
  from: Temporal.PlainDate;
  to: Temporal.PlainDate;
}

/**
 * `time` in `timezone` and `calendar`.
 *
 * @returns The zoned time.
 */
function zoned(
  { ms, ns }: ExactTime,
  timezone: string,
  calendar: string
): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .add({ nanoseconds: ns })
    .toZonedDateTimeISO(timezone)
    .withCalendar(calendar);
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

  const dateIssues = [...checkDate(from, ["from"]), ...checkDate(to, ["to"])];
  const issues = [...checkRules(rules), ...dateIssues];

  if (dateIssues.length === 0) {
    const days = from.until(to).days + 1;

    if (days < 1) {
      issues.push({
        message: `to (${to.toString()}) must be on or after from (${from.toString()}).`,
        path: ["to"],
      });
    } else if (days > MAX_EXPAND_DAYS) {
      issues.push({
        message: `The range covers ${days} days; the limit is ${MAX_EXPAND_DAYS}. Split it into smaller ranges.`,
        path: ["to"],
      });
    }
  }

  return checked(issues, () =>
    ruleWindows(rules)(epochDay(from), epochDay(to))
      .toSorted(
        (a, b) =>
          compareTimes(a.start, b.start) ||
          a.rule.resourceId.localeCompare(b.rule.resourceId)
      )
      .map(({ end, rule: { resourceId, timezone }, start }) => ({
        end: zoned(end, timezone, from.calendarId),
        resourceId,
        start: zoned(start, timezone, from.calendarId),
      }))
  );
}
