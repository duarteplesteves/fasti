import { DAY_MS } from "./day-offset.js";
import { occursOn } from "./recurrence.js";
import type { AvailabilityRule } from "./types.js";

/**
 * The start of `date` in UTC: how this module and its callers count dates.
 *
 * @returns The milliseconds since the epoch.
 */
export function utcMidnightMs(date: Temporal.PlainDate): number {
  return date.toZonedDateTime("UTC").epochMilliseconds;
}

/**
 * The date whose UTC midnight is `midnight`.
 *
 * @returns The date.
 */
export function dateAt(midnight: number): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(midnight)
    .toZonedDateTimeISO("UTC")
    .toPlainDate();
}

/** The dates a rule occurs on, as UTC midnights in epoch milliseconds. */
export interface RuleDates {
  /** No date before this one; `-Infinity` without `effectiveFrom`. */
  readonly first: number;
  /** No date after this one; `Infinity` without `effectiveTo`. */
  readonly last: number;
  /** Whether the rule occurs on the date, given its UTC midnight. */
  readonly includes: (midnight: number) => boolean;
}

/** A number per ISO date, cheaper to make from a PlainDate than its UTC midnight. */
function dateKey(year: number, month: number, day: number): number {
  return (year * 16 + month) * 32 + day;
}

/**
 * `date`'s `dateKey`, whatever its calendar.
 *
 * @returns The key.
 */
function keyOf(date: Temporal.PlainDate): number {
  const iso =
    date.calendarId === "iso8601" ? date : date.withCalendar("iso8601");

  return dateKey(iso.year, iso.month, iso.day);
}

/**
 * `rule`'s dates: its effective dates, recurrence and exceptions. The only place that decides them.
 *
 * @returns The dates, for any range.
 */
export function ruleDates(rule: AvailabilityRule): RuleDates {
  const { effectiveFrom, effectiveTo, exceptions = [], recurrence } = rule;

  const first = effectiveFrom
    ? utcMidnightMs(effectiveFrom)
    : Number.NEGATIVE_INFINITY;

  const last = effectiveTo
    ? utcMidnightMs(effectiveTo)
    : Number.POSITIVE_INFINITY;

  const firstDay = effectiveFrom ? first / DAY_MS : undefined;

  // Built on first use: many rules never reach a date that needs it.
  let keys: Set<number> | undefined;

  function isException(midnight: number): boolean {
    if (exceptions.length === 0) {
      return false;
    }

    keys ??= new Set(exceptions.map(keyOf));

    const date = new Date(midnight);

    return keys.has(
      dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
    );
  }

  return {
    first,
    includes: (midnight) =>
      midnight >= first &&
      midnight <= last &&
      occursOn(recurrence, midnight / DAY_MS, firstDay) &&
      !isException(midnight),
    last,
  };
}
