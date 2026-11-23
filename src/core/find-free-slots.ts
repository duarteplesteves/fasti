import { availableWindows, fitsInSomeWindow } from "./availability.js";
import {
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
 * The search params' issues: whole-minute `duration` and `interval`, an IANA `timezone`, `from < to`. Internal; the Framework checks these before any Adapter call.
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
  return [
    ...checkPositiveInteger(duration, ["duration"]),
    ...checkPositiveInteger(interval, ["interval"]),
    ...checkTimeZone(timezone, ["timezone"]),
    ...(Temporal.Instant.compare(from, to) < 0
      ? []
      : [
          {
            message: `to (${to.toString()}) must be after from (${from.toString()}).`,
            path: ["to"],
          },
        ]),
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
