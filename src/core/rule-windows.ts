import { compareTimes } from "./exact-time.js";
import type { ExactTime } from "./exact-time.js";
import { ruleDates } from "./rule-dates.js";
import type { AvailabilityRule } from "./types.js";
import { DAY_MS, zoneClock } from "./zone-clock.js";
import type { ZoneClock } from "./zone-clock.js";

/** The window one rule opens on one date. */
export interface RuleWindow {
  readonly rule: AvailabilityRule;
  readonly start: ExactTime;
  readonly end: ExactTime;
}

/** The windows some rules open on the dates from `first` to `last`, both included and given as days since the epoch. */
export type RuleWindows = (
  first: number,
  last: number
) => readonly RuleWindow[];

/**
 * How far into a day `time` is.
 *
 * @returns The time since midnight.
 */
function timeOfDay(time: Temporal.PlainTime): ExactTime {
  return {
    ms:
      ((time.hour * 60 + time.minute) * 60 + time.second) * 1000 +
      time.millisecond,
    ns: time.microsecond * 1000 + time.nanosecond,
  };
}

/**
 * When `clock` shows `time` on the day whose midnight, as if it were UTC, is `midnight`.
 *
 * @returns The first occurrence, or the moment the clocks jump over it (ADR 005).
 */
function edge(clock: ZoneClock, midnight: number, time: ExactTime): ExactTime {
  const localMs = midnight + time.ms;
  const { offsetMs, startMs } = clock(localMs);
  const ms = localMs - offsetMs;

  return ms < startMs ? { ms: startMs, ns: 0 } : { ms, ns: time.ns };
}

/**
 * Prepares `rules` once, to ask for their windows on any dates in any order. The only place that decides when a window opens.
 *
 * @returns The lookup: each rule's windows in turn, by date. A window wholly in a DST gap is none (ADR 005).
 */
export function ruleWindows(rules: readonly AvailabilityRule[]): RuleWindows {
  // Rules of one timezone share its clock.
  const clocks = new Map<string, ZoneClock>();

  const prepared = rules.map((rule) => {
    const clock = clocks.get(rule.timezone) ?? zoneClock(rule.timezone);

    clocks.set(rule.timezone, clock);

    return {
      clock,
      datesIn: ruleDates(rule),
      end: timeOfDay(rule.timeWindow.end),
      rule,
      start: timeOfDay(rule.timeWindow.start),
    };
  });

  return (first, last) => {
    const windows: RuleWindow[] = [];

    for (const { clock, datesIn, end, rule, start } of prepared) {
      for (const day of datesIn(first, last)) {
        const midnight = day * DAY_MS;

        const window = {
          end: edge(clock, midnight, end),
          rule,
          start: edge(clock, midnight, start),
        };

        if (compareTimes(window.start, window.end) < 0) {
          windows.push(window);
        }
      }
    }

    return windows;
  };
}
