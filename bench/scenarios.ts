// The searches the benchmarks run, all within ADR 019's limits.
import type { AvailabilityRule, Booking } from "../src/core/types.js";

/** The one Resource every scenario searches. */
export const RESOURCE = "resource-1";

const TIMEZONE = "Europe/Lisbon";
const FROM = Temporal.Instant.from("2026-11-24T00:00:00Z");
const QUARTER_HOUR_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The shape of a rule set. */
interface RuleSetParams {
  /** How many rules: one is every weekday, more take a weekday each, mornings and afternoons alternating. */
  readonly count: number;
  /** Exception dates per rule, every other day from 2026-01-01, so half the days stay open. */
  readonly exceptions?: number;
  /** Weeks between occurrences; every week by default. */
  readonly interval?: number;
}

/**
 * A rule set for {@link RESOURCE}.
 *
 * @returns The rules.
 */
export function ruleSet({
  count,
  exceptions = 0,
  interval = 1,
}: RuleSetParams): readonly AvailabilityRule[] {
  return Array.from({ length: count }, (_rule, i) => ({
    // Only a rule that skips weeks needs a week to count from.
    ...(interval > 1 && {
      effectiveFrom: Temporal.PlainDate.from("2026-01-05"),
    }),
    exceptions: Array.from({ length: exceptions }, (_date, k) =>
      Temporal.PlainDate.from("2026-01-01").add({ days: k * 2 })
    ),
    recurrence: {
      daysOfWeek: count === 1 ? [1, 2, 3, 4, 5] : [(i % 7) + 1],
      frequency: "weekly",
      interval,
    },
    resourceId: RESOURCE,
    timeWindow: {
      end: Temporal.PlainTime.from(i % 2 === 0 ? "13:00" : "18:00"),
      start: Temporal.PlainTime.from(i % 2 === 0 ? "09:00" : "14:00"),
    },
    timezone: TIMEZONE,
  }));
}

/**
 * `count` half-hour Bookings spread evenly over `days`, starting on the quarter hour; one in ten doesn't block.
 *
 * @returns The Bookings.
 */
function spread(count: number, days: number): readonly Booking[] {
  const step = Math.floor((days * DAY_MS) / count);

  return Array.from({ length: count }, (_booking, i) => {
    const ms = FROM.epochMilliseconds + i * step;

    const start = Temporal.Instant.fromEpochMilliseconds(
      ms - (ms % QUARTER_HOUR_MS)
    );

    return {
      end: start.add({ minutes: 30 }),
      id: `booking-${i}`,
      isBlocking: i % 10 !== 0,
      resourceId: RESOURCE,
      start,
    };
  });
}

/** What differs between scenarios. */
interface ScenarioParams {
  readonly name: string;
  readonly days: number;
  readonly interval: number;
  readonly duration: number;
  readonly rules: readonly AvailabilityRule[];
  readonly bookings: number;
  /** How many slots the search finds: a benchmark asserts it, so it can't time a search that went wrong. */
  readonly slots: number;
}

function scenario({
  bookings,
  days,
  duration,
  interval,
  name,
  rules,
  slots,
}: ScenarioParams) {
  return {
    name,
    search: {
      bookings: spread(bookings, days),
      duration,
      from: FROM,
      interval,
      resourceId: RESOURCE,
      rules,
      timezone: TIMEZONE,
      to: FROM.add({ minutes: Math.round(days * 24 * 60) }),
    },
    slots,
  };
}

/** The searches, smallest first. */
export const scenarios = [
  scenario({
    bookings: 8,
    days: 1,
    duration: 30,
    interval: 15,
    name: "day, 15 min, 1 rule, 8 Bookings",
    rules: ruleSet({ count: 1 }),
    slots: 10,
  }),
  scenario({
    bookings: 30,
    days: 7,
    duration: 30,
    interval: 15,
    name: "week, 15 min, 5 rules, 30 Bookings",
    rules: ruleSet({ count: 5 }),
    slots: 65,
  }),
  scenario({
    bookings: 120,
    days: 30,
    duration: 60,
    interval: 30,
    name: "month, 30 min, 10 rules, 120 Bookings",
    rules: ruleSet({ count: 10 }),
    slots: 274,
  }),
  scenario({
    bookings: 120,
    days: 30,
    duration: 30,
    interval: 15,
    name: "month, 15 min, 10 rules, 120 Bookings",
    rules: ruleSet({ count: 10 }),
    slots: 609,
  }),
  scenario({
    bookings: 400,
    days: 90,
    duration: 30,
    interval: 15,
    name: "quarter, 15 min, 10 rules, 400 Bookings",
    rules: ruleSet({ count: 10 }),
    slots: 1672,
  }),
  scenario({
    bookings: 1500,
    days: 365,
    duration: 60,
    interval: 60,
    name: "year, 60 min, 10 rules, 1,500 Bookings",
    rules: ruleSet({ count: 10 }),
    slots: 1684,
  }),
  scenario({
    bookings: 30,
    // 9,936 Grid times; the limit is 10,000.
    days: 6.9,
    duration: 30,
    interval: 1,
    name: "week, 1 min (near the Grid limit), 5 rules, 30 Bookings",
    rules: ruleSet({ count: 5 }),
    slots: 848,
  }),
  scenario({
    bookings: 1500,
    days: 365,
    duration: 60,
    interval: 60,
    name: "year, 60 min, 100 rules, 1,500 Bookings",
    rules: ruleSet({ count: 100 }),
    slots: 2361,
  }),
  scenario({
    bookings: 120,
    days: 30,
    duration: 30,
    interval: 15,
    name: "month, 15 min, 10 rules × 1,000 exceptions, 120 Bookings",
    rules: ruleSet({ count: 10, exceptions: 1000 }),
    slots: 303,
  }),
  scenario({
    bookings: 500,
    days: 365,
    duration: 60,
    interval: 60,
    name: "year, 60 min, 20 biweekly rules, 500 Bookings",
    rules: ruleSet({ count: 20, interval: 2 }),
    slots: 1368,
  }),
  scenario({
    bookings: 20_000,
    days: 1,
    duration: 60,
    interval: 60,
    name: "day, 60 min, 10 rules, 20,000 Bookings (none free)",
    rules: ruleSet({ count: 10 }),
    slots: 0,
  }),
];
