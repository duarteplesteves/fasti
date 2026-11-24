import { MAX_EXPAND_DAYS, checkDate, checkRules } from "./checks.js";
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

/** A UTC day, and so a step of `midnight` in `expandRulesUnchecked`. */
const DAY_MS = 86_400_000;

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
function msOfDay(time: Temporal.PlainTime): number {
  return (
    ((time.hour * 60 + time.minute) * 60 + time.second) * 1000 +
    time.millisecond
  );
}

/**
 * The start of `date` in UTC.
 *
 * @returns The milliseconds since the epoch.
 */
function utcMidnightMs(date: Temporal.PlainDate): number {
  return date.toZonedDateTime("UTC").epochMilliseconds;
}

/**
 * `time` on `date` in `timeZone`; a time in a spring-forward gap is the moment the clocks jump (ADR 005).
 *
 * @returns The zoned time, at its first occurrence when it repeats.
 */
function clipped(
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
  params: ExpandRulesParams
): ExpandedWindow[] {
  const { from, rules, to } = params;
  const windows: ExpandedWindow[] = [];
  const fromMidnight = utcMidnightMs(from);

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
    const startMs = msOfDay(rule.timeWindow.start);
    const endMs = msOfDay(rule.timeWindow.end);

    // `date`'s midnight as `localMs` counts, one step back: the loop steps it first.
    let midnight =
      (first === from ? fromMidnight : utcMidnightMs(first)) - DAY_MS;

    for (
      let date = first;
      Temporal.PlainDate.compare(date, last) <= 0;
      date = date.add({ days: 1 })
    ) {
      midnight += DAY_MS;

      // Most rules have no exceptions, so most dates need no string.
      if (
        occursOn(rule.recurrence, date, rule.effectiveFrom) &&
        !(exceptions.size > 0 && exceptions.has(date.toString()))
      ) {
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

  return checked(issues, () => expandRulesUnchecked(params));
}
