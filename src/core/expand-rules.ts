import { MAX_EXPAND_DAYS, checkDate, checkRules } from "./checks.js";
import { DAY_MS } from "./day-offset.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import { dateOf, epochDay, prepareRules } from "./rule-dates.js";
import type { PreparedRule } from "./rule-dates.js";
import type { AvailabilityRule, ExpandedWindow } from "./types.js";

/** Rules to expand over every date in `[from, to]`, both ends included. */
export interface ExpandRulesParams {
  rules: readonly AvailabilityRule[];
  from: Temporal.PlainDate;
  to: Temporal.PlainDate;
}

/**
 * The wall-clock time of `zoned` as milliseconds, as if it were UTC.
 *
 * @returns The milliseconds since the epoch of that wall-clock time.
 */
function localMs(zoned: Temporal.ZonedDateTime): number {
  return zoned.epochMilliseconds + zoned.offsetNanoseconds / 1_000_000;
}

/**
 * How far into a day `time` is.
 *
 * @returns The whole milliseconds since midnight.
 */
export function msOfDay(time: Temporal.PlainTime): number {
  return (
    ((time.hour * 60 + time.minute) * 60 + time.second) * 1000 +
    time.millisecond
  );
}

/**
 * `time` on `date` in `timeZone`; a time in a spring-forward gap is the moment the clocks jump (ADR 005).
 *
 * @returns The zoned time, at its first occurrence when it repeats.
 */
export function clipped(
  date: Temporal.PlainDate,
  time: Temporal.PlainTime,
  timeZone: string
): Temporal.ZonedDateTime {
  const local = date.toPlainDateTime(time);

  const zoned = local.toZonedDateTime(timeZone, {
    disambiguation: "earlier",
  });

  // In a gap, `earlier` lands before the jump, which is then the next transition.
  return zoned.toPlainDateTime().equals(local)
    ? zoned
    : (zoned.getTimeZoneTransition("next") ?? zoned);
}

/**
 * `expandRules` without checks, for Core functions that already checked their params.
 *
 * @returns The expanded windows, sorted by start then `resourceId`.
 */
export function expandRulesUnchecked(
  params: Pick<ExpandRulesParams, "from" | "to"> & {
    readonly rules: readonly PreparedRule[];
  }
): ExpandedWindow[] {
  const { from, rules, to } = params;
  const windows: ExpandedWindow[] = [];
  const first = epochDay(from);
  const last = epochDay(to);

  for (const { datesIn, rule } of rules) {
    const startMs = msOfDay(rule.timeWindow.start);
    const endMs = msOfDay(rule.timeWindow.end);

    for (const day of datesIn(first, last)) {
      const midnight = day * DAY_MS;
      const date = dateOf(day).withCalendar(from.calendarId);

      let start = date.toZonedDateTime({
        plainTime: rule.timeWindow.start,
        timeZone: rule.timezone,
      });

      let end = date.toZonedDateTime({
        plainTime: rule.timeWindow.end,
        timeZone: rule.timezone,
      });

      // Temporal moved an edge that falls in a gap. Compared as numbers: this runs for every window, the clipping almost never.
      if (
        localMs(start) !== midnight + startMs ||
        localMs(end) !== midnight + endMs
      ) {
        start = clipped(date, rule.timeWindow.start, rule.timezone);
        end = clipped(date, rule.timeWindow.end, rule.timezone);

        // A window wholly in a gap clips to nothing.
        if (Temporal.ZonedDateTime.compare(start, end) >= 0) {
          continue;
        }
      }

      windows.push({ end, resourceId: rule.resourceId, start });
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
    expandRulesUnchecked({ from, rules: prepareRules(rules), to })
  );
}
