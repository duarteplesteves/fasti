import { availableWindows, fitsInSomeWindow } from "./availability.js";
import {
  MAX_DURATION_MINUTES,
  MAX_GRID_TIMES,
  checkInstant,
  checkPositiveInteger,
  checkResourceInputs,
  checkTimeZone,
} from "./checks.js";
import type { CheckIssue } from "./checks.js";
import { overlapsBlockingBooking } from "./detect-conflicts.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import type {
  AvailabilityRule,
  AvailabilityViolation,
  Booking,
  CorePolicy,
  CoreViolations,
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

  for (const start of gridStarts(from, to, interval, timezone)) {
    const range = {
      end: start.toInstant().add({ minutes: duration }),
      start: start.toInstant(),
    };

    if (!overlapsBlockingBooking(bookings, range, excludeBookingId)) {
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
  const windows = availableWindows(rules, { end: to, start: from });

  return freeGridSlots(params).flatMap(({ end, start }) => {
    const available = fitsInSomeWindow(windows, {
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
