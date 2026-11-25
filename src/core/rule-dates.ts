import { occursOn } from "./recurrence.js";
import type { AvailabilityRule } from "./types.js";
import { DAY_MS } from "./zone-clock.js";

/**
 * `date`, whatever its calendar, as days since the epoch: how this module and its callers count dates.
 *
 * @returns The whole days, negative before 1970.
 */
export function epochDay(date: Temporal.PlainDate): number {
  const iso =
    date.calendarId === "iso8601" ? date : date.withCalendar("iso8601");

  // 8,000 years later and back, whole 400-year cycles: `Date.UTC` reads years 0 to 99 as 1900 to 1999, and year 1 of some calendars is before -5000.
  return Date.UTC(iso.year + 8000, iso.month - 1, iso.day) / DAY_MS - 2_921_940;
}

/** The dates a rule occurs on from `first` to `last`, both included, in order; all in days since the epoch. */
export type RuleDates = (first: number, last: number) => readonly number[];

/**
 * `rule`'s dates: its effective dates, recurrence and exceptions. The only place that decides them.
 *
 * @returns The lookup, for any number of ranges: it reads the exceptions once.
 */
export function ruleDates(rule: AvailabilityRule): RuleDates {
  const { effectiveFrom, effectiveTo, exceptions = [], recurrence } = rule;
  const from = effectiveFrom && epochDay(effectiveFrom);
  const to = effectiveTo && epochDay(effectiveTo);

  // Built on first use: many rules never reach a date that needs it.
  let closed: Set<number> | undefined;

  return (first, last) => {
    const dates: number[] = [];

    // Only the dates the rule is in effect, so a long range costs a short-lived rule nothing.
    const start = Math.max(first, from ?? first);
    const end = Math.min(last, to ?? last);

    for (let day = start; day <= end; day += 1) {
      if (occursOn(recurrence, day, from)) {
        closed ??= new Set(exceptions.map(epochDay));

        if (!closed.has(day)) {
          dates.push(day);
        }
      }
    }

    return dates;
  };
}
