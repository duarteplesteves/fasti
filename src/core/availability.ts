import { compareTimes, exactTime } from "./exact-time.js";
import type { MsRange } from "./exact-time.js";
import { ruleWindows } from "./rule-windows.js";
import type { RuleWindow } from "./rule-windows.js";
import type { AvailabilityRule, InstantRange } from "./types.js";
import { DAY_MS } from "./zone-clock.js";

/**
 * The dates whose windows could meet `[startMs, endMs)`, as days since the epoch.
 * A day either side of the UTC dates covers every rule timezone's local dates.
 *
 * @returns The first and last date, both included.
 */
function datesAround({ endMs, startMs }: MsRange) {
  return {
    first: Math.floor(startMs / DAY_MS) - 1,
    last: Math.floor(endMs / DAY_MS) + 1,
  };
}

/**
 * The windows `rules` open around `range`, rounded inwards to milliseconds.
 *
 * @returns The open windows, possibly overlapping.
 */
export function availableWindows(
  rules: readonly AvailabilityRule[],
  range: InstantRange
): MsRange[] {
  const { first, last } = datesAround({
    endMs: range.end.epochMilliseconds,
    startMs: range.start.epochMilliseconds,
  });

  return ruleWindows(rules)(first, last).map(({ end, start }) => ({
    endMs: end.ms,
    startMs: start.ns > 0 ? start.ms + 1 : start.ms,
  }));
}

/** Longer than any window: a window is one local day, under 26 hours even across a DST change. */
const LONGEST_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Prepares `rules` once, to ask about any slots in any order. Slots share each date's windows, so each date opens once.
 *
 * @returns Whether a slot fits fully inside one window, exact to the nanosecond. One too long for any window opens no dates.
 */
export function windowFit(
  rules: readonly AvailabilityRule[]
): (slot: InstantRange) => boolean {
  const windowsIn = ruleWindows(rules);
  const byDay = new Map<number, readonly RuleWindow[]>();

  function windowsOn(day: number): readonly RuleWindow[] {
    const windows = byDay.get(day) ?? windowsIn(day, day);

    byDay.set(day, windows);

    return windows;
  }

  return (slot) => {
    const start = exactTime(slot.start);
    const end = exactTime(slot.end);

    if (end.ms - start.ms > LONGEST_WINDOW_MS) {
      return false;
    }

    const { first, last } = datesAround({ endMs: end.ms, startMs: start.ms });

    for (let day = first; day <= last; day += 1) {
      if (
        windowsOn(day).some(
          (w) =>
            compareTimes(w.start, start) <= 0 && compareTimes(end, w.end) <= 0
        )
      ) {
        return true;
      }
    }

    return false;
  };
}
