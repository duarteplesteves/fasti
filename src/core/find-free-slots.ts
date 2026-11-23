import { availableWindows } from "./availability.js";
import {
  MAX_DURATION_MINUTES,
  MAX_GRID_TIMES,
  checkInstant,
  checkPositiveInteger,
  checkResourceInputs,
  checkTimeZone,
} from "./checks.js";
import type { CheckIssue } from "./checks.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import type {
  AvailabilityRule,
  AvailabilityViolation,
  Booking,
  CorePolicy,
  CoreViolations,
  InstantRange,
  Slot,
} from "./types.js";

/** A search for `duration`-minute Slots on one Resource, starting on the Grid in `[from, to)`. */
export interface FindFreeSlotsParams<
  R extends readonly CorePolicy[] = readonly CorePolicy[],
  Id extends string = string,
> {
  resourceId: string;
  rules: readonly AvailabilityRule[];
  bookings: readonly Booking<Id>[];
  duration: number;
  from: Temporal.Instant;
  to: Temporal.Instant;
  /** Leave this Booking out of the overlap check, e.g. the one being rescheduled. */
  excludeBookingId?: NoInfer<Id>;
  /** Grid step in whole minutes, counted from local midnight in `timezone`. */
  interval: number;
  /** IANA timezone whose local midnight anchors the grid; slots are zoned in it. */
  timezone: string;
  /** Policies to relax: a slot breaking only these is returned, tagged in `waived`. */
  relax?: R;
}

const outsideAvailability: AvailabilityViolation = {
  detail: {},
  policy: "availability",
};

/**
 * The grid starts in `[from, to)`: local midnight in `timezone` plus whole `interval`s (ADR 014).
 * A time in a DST gap is dropped; a repeated time is its first occurrence (ADR 005).
 *
 * @returns Each grid start, in order, zoned in `timezone`.
 */
function* gridStarts(
  from: Temporal.Instant,
  to: Temporal.Instant,
  interval: number,
  timezone: string
): Generator<Temporal.ZonedDateTime> {
  const lastDate = to.toZonedDateTimeISO(timezone).toPlainDate();

  for (
    let date = from.toZonedDateTimeISO(timezone).toPlainDate();
    Temporal.PlainDate.compare(date, lastDate) <= 0;
    date = date.add({ days: 1 })
  ) {
    for (let minutes = 0; minutes < 24 * 60; minutes += interval) {
      const local = date.toPlainDateTime().add({ minutes });

      const start = local.toZonedDateTime(timezone, {
        disambiguation: "earlier",
      });

      const instant = start.toInstant();

      if (
        start.toPlainDateTime().equals(local) &&
        Temporal.Instant.compare(instant, from) >= 0 &&
        Temporal.Instant.compare(instant, to) < 0
      ) {
        yield start;
      }
    }
  }
}

function byStart(a: InstantRange, b: InstantRange): number {
  return Temporal.Instant.compare(a.start, b.start);
}

function later(a: Temporal.Instant | null, b: Temporal.Instant) {
  return a === null || Temporal.Instant.compare(a, b) < 0 ? b : a;
}

/**
 * A forward-only overlap check: call the result with ranges whose start and end never decrease, as the Grid's are.
 * Each Booking is visited once across all calls, not once per call.
 *
 * @returns Whether a range overlaps a blocking Booking other than `excludeBookingId`.
 */
function blockedSweep<Id extends string>(
  bookings: readonly Booking<Id>[],
  excludeBookingId: Id | undefined
): (range: InstantRange) => boolean {
  const sorted = bookings
    .filter((b) => b.isBlocking && b.id !== excludeBookingId)
    .toSorted(byStart);

  let next = 0;
  // The latest end among the Bookings that start before the current range ends.
  let reach: Temporal.Instant | null = null;

  return ({ end, start }) => {
    for (; next < sorted.length; next += 1) {
      const booking = sorted[next];

      if (
        booking === undefined ||
        Temporal.Instant.compare(booking.start, end) >= 0
      ) {
        break;
      }

      reach = later(reach, booking.end);
    }

    // Half-open: a Booking that starts before `end` overlaps iff it ends after `start`.
    return reach !== null && Temporal.Instant.compare(start, reach) < 0;
  };
}

/**
 * A forward-only `fitsInSomeWindow`: call the result with ranges whose start and end never decrease.
 * Each window is visited once across all calls.
 *
 * @returns Whether a range fits fully inside one of `windows`.
 */
function fitsSweep(
  windows: readonly InstantRange[]
): (range: InstantRange) => boolean {
  const sorted = windows.toSorted(byStart);

  let next = 0;
  // The latest end among the windows that start at or before the current range starts.
  let reach: Temporal.Instant | null = null;

  return ({ end, start }) => {
    for (; next < sorted.length; next += 1) {
      const window = sorted[next];

      if (
        window === undefined ||
        Temporal.Instant.compare(window.start, start) > 0
      ) {
        break;
      }

      reach = later(reach, window.end);
    }

    return reach !== null && Temporal.Instant.compare(end, reach) <= 0;
  };
}

/**
 * The Grid slots in `[from, to)` that overlap no blocking Booking except `excludeBookingId`: the search before any Policy. Internal; not exported from the Core's entry.
 *
 * @returns The free Grid slots in start order, as zoned start and end.
 */
export function freeGridSlots({
  bookings,
  duration,
  excludeBookingId,
  from,
  interval,
  timezone,
  to,
}: Pick<
  FindFreeSlotsParams,
  | "bookings"
  | "duration"
  | "excludeBookingId"
  | "from"
  | "interval"
  | "timezone"
  | "to"
>): Pick<Slot, "start" | "end">[] {
  const slots: {
    start: Temporal.ZonedDateTime;
    end: Temporal.ZonedDateTime;
  }[] = [];

  const blocked = blockedSweep(bookings, excludeBookingId);

  for (const start of gridStarts(from, to, interval, timezone)) {
    const range = {
      end: start.toInstant().add({ minutes: duration }),
      start: start.toInstant(),
    };

    if (!blocked(range)) {
      slots.push({ end: range.end.toZonedDateTimeISO(timezone), start });
    }
  }

  return slots;
}

function findFreeSlotsUnchecked(
  params: FindFreeSlotsParams
): Slot<AvailabilityViolation>[] {
  const { from, relax, resourceId, rules, to } = params;

  const relaxAvailability = relax?.includes("availability") ?? false;
  const fits = fitsSweep(availableWindows(rules, { end: to, start: from }));

  return freeGridSlots(params).flatMap(({ end, start }) => {
    const available = fits({
      end: end.toInstant(),
      start: start.toInstant(),
    });

    return available || relaxAvailability
      ? [
          {
            end,
            resourceId,
            start,
            waived: available ? [] : [outsideAvailability],
          },
        ]
      : [];
  });
}

/**
 * The search params' issues: whole-minute `duration` and `interval`, an IANA `timezone`, `from < to`,
 * all within ADR 019's limits. Internal; the Framework checks these before any Adapter call.
 *
 * @returns The issues, empty when the search is valid.
 */
export function checkSearch({
  duration,
  from,
  interval,
  timezone,
  to,
}: Pick<
  FindFreeSlotsParams,
  "duration" | "from" | "interval" | "timezone" | "to"
>): CheckIssue[] {
  const durationIssues = checkPositiveInteger(duration, ["duration"]);
  const intervalIssues = checkPositiveInteger(interval, ["interval"]);

  const rangeIssues = [
    ...checkInstant(from, ["from"]),
    ...checkInstant(to, ["to"]),
  ];

  if (rangeIssues.length === 0 && Temporal.Instant.compare(from, to) >= 0) {
    rangeIssues.push({
      message: `to (${to.toString()}) must be after from (${from.toString()}).`,
      path: ["to"],
    });
  }

  // A DST day counts as 24 hours: an estimate, off by at most an hour's Grid times a day.
  const gridTimes =
    intervalIssues.length === 0 && rangeIssues.length === 0
      ? Math.ceil(
          (to.epochMilliseconds - from.epochMilliseconds) / 60_000 / interval
        )
      : 0;

  return [
    ...durationIssues,
    ...(durationIssues.length === 0 && duration > MAX_DURATION_MINUTES
      ? [
          {
            message: `duration is ${duration} minutes; the limit is ${MAX_DURATION_MINUTES} (31 days).`,
            path: ["duration"],
          },
        ]
      : []),
    ...intervalIssues,
    ...checkTimeZone(timezone, ["timezone"]),
    ...rangeIssues,
    ...(gridTimes > MAX_GRID_TIMES
      ? [
          {
            message: `Search covers ${gridTimes.toLocaleString("en-US")} Grid times; the limit is ${MAX_GRID_TIMES.toLocaleString("en-US")}. Split it into smaller ranges.`,
            path: ["to"],
          },
        ]
      : []),
  ];
}

/**
 * The Grid starts whose slot overlaps no blocking Booking and fits availability.
 * With `relax: ["availability"]`, slots outside it are kept and marked `waived`.
 *
 * @returns The free Slots in start order, or `InvalidParams` when a rule, Booking or search param is malformed.
 */
export function findFreeSlots<
  const R extends readonly CorePolicy[] = [],
  Id extends string = string,
>(
  params: FindFreeSlotsParams<R, Id>
): Result<Slot<CoreViolations[R[number]]>[], InvalidParams> {
  const {
    bookings,
    duration,
    from,
    interval,
    resourceId,
    rules,
    timezone,
    to,
  } = params;

  const issues = [
    ...checkSearch({ duration, from, interval, timezone, to }),
    ...checkResourceInputs({ bookings, resourceId, rules }),
  ];

  // SAFETY: an availability violation is only added when R contains "availability".
  return checked(
    issues,
    () => findFreeSlotsUnchecked(params) as Slot<CoreViolations[R[number]]>[]
  );
}
