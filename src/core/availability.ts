import { DAY_MS, dayOffsets } from "./day-offset.js";
import { clipped, expandRulesUnchecked, msOfDay } from "./expand-rules.js";
import { ceilToMs, floorToMs } from "./ms-range.js";
import type { MsRange } from "./ms-range.js";
import { dateOf, prepareRules } from "./rule-dates.js";
import type { AvailabilityRule, InstantRange } from "./types.js";

/** The windows some rules open on the dates from `first` to `last`, both included and given as days since the epoch. */
export type OpenWindows = (first: number, last: number) => MsRange[];

/**
 * Prepares `rules` once, to ask for their windows on any dates in any order.
 *
 * @returns The lookup. A window is rounded inwards to milliseconds; one lost to a DST gap ends at or before its start, so holds no slot.
 */
export function openWindows(rules: readonly AvailabilityRule[]): OpenWindows {
  const prepared = prepareRules(rules).map(({ datesIn, rule }) => {
    const { end, start } = rule.timeWindow;
    const isSubMs = start.microsecond > 0 || start.nanosecond > 0;

    return {
      datesIn,
      endMs: msOfDay(end),
      rule,
      startMs: msOfDay(start) + (isSubMs ? 1 : 0),
    };
  });

  const offsetsByZone = new Map<string, ReturnType<typeof dayOffsets>>();

  return (first, last) => {
    const windows: MsRange[] = [];

    for (const { datesIn, endMs, rule, startMs } of prepared) {
      for (const day of datesIn(first, last)) {
        const midnight = day * DAY_MS;
        const { timeWindow, timezone } = rule;
        let offsetOf = offsetsByZone.get(timezone);

        if (offsetOf === undefined) {
          offsetOf = dayOffsets(timezone, midnight);
          offsetsByZone.set(timezone, offsetOf);
        }

        const offsetMs = offsetOf(midnight);

        // Only a day the clocks change needs Temporal.
        if (offsetMs === undefined) {
          const date = dateOf(day);
          const start = clipped(date, timeWindow.start, timezone);
          const end = clipped(date, timeWindow.end, timezone);

          windows.push({
            endMs: floorToMs(end.toInstant()),
            startMs: ceilToMs(start.toInstant()),
          });
        } else {
          windows.push({
            endMs: midnight + endMs - offsetMs,
            startMs: midnight + startMs - offsetMs,
          });
        }
      }
    }

    return windows;
  };
}

/**
 * `instant`'s UTC date.
 *
 * @returns The days since the epoch.
 */
function utcDay(instant: Temporal.Instant): number {
  return Math.floor(instant.epochMilliseconds / DAY_MS);
}

/**
 * The windows `rules` open around `range`.
 *
 * @returns The open windows, possibly overlapping.
 */
export function availableWindows(
  rules: readonly AvailabilityRule[],
  range: InstantRange
): MsRange[] {
  // ±1 day around the UTC dates covers every rule timezone's local dates.
  return openWindows(rules)(utcDay(range.start) - 1, utcDay(range.end) + 1);
}

/** Longer than any window: a window is one local day, under 26 hours even across a DST change. */
const LONGEST_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Whether `slot` is too long for any window to hold, so a slot of any length expands at most a few dates.
 *
 * @returns `true` when no window could hold `slot`.
 */
function isTooLong(slot: InstantRange): boolean {
  return (
    slot.end.epochMilliseconds - slot.start.epochMilliseconds >
    LONGEST_WINDOW_MS
  );
}

/**
 * The windows that could hold `slot`.
 * `byDate` caches each UTC date's windows, by days since the epoch: pass one Map across slots over the same `open`, so each date opens once.
 *
 * @returns The open windows around `slot`, or none when `slot` is too long for any window to hold.
 */
export function windowsFor(
  open: OpenWindows,
  slot: InstantRange,
  byDate: Map<number, readonly MsRange[]>
): MsRange[] {
  if (isTooLong(slot)) {
    return [];
  }

  const windows: MsRange[] = [];
  const last = utcDay(slot.end) + 1;

  // ±1 day around the UTC dates covers every rule timezone's local dates, as in `availableWindows`.
  for (let day = utcDay(slot.start) - 1; day <= last; day += 1) {
    let cached = byDate.get(day);

    if (cached === undefined) {
      cached = open(day, day);
      byDate.set(day, cached);
    }

    windows.push(...cached);
  }

  return windows;
}

/**
 * Whether `range`, rounded outwards to milliseconds, fits fully inside one of `windows`. Exact for a range of whole milliseconds.
 *
 * @returns `true` when one window contains all of `range`.
 */
export function fitsInSomeWindow(
  windows: readonly MsRange[],
  range: InstantRange
): boolean {
  const startMs = floorToMs(range.start);
  const endMs = ceilToMs(range.end);

  return windows.some((w) => w.startMs <= startMs && endMs <= w.endMs);
}

/**
 * Whether `slot` fits fully inside one of the windows `rules` open, exact to the nanosecond: slots and rule times may both be finer than a millisecond.
 *
 * @returns `true` when one window contains all of `slot`.
 */
export function fitsExactly(
  rules: readonly AvailabilityRule[],
  slot: InstantRange
): boolean {
  if (isTooLong(slot)) {
    return false;
  }

  // ±1 day around the UTC dates covers every rule timezone's local dates.
  return expandRulesUnchecked({
    from: dateOf(utcDay(slot.start) - 1),
    rules: prepareRules(rules),
    to: dateOf(utcDay(slot.end) + 1),
  }).some(
    (w) =>
      Temporal.Instant.compare(w.start.toInstant(), slot.start) <= 0 &&
      Temporal.Instant.compare(slot.end, w.end.toInstant()) <= 0
  );
}
