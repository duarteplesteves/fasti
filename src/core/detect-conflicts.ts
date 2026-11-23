import { checkBookings, checkInstantRange } from "./checks.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import type { Booking, InstantRange } from "./types.js";

/** A `candidate` range on one Resource, checked against its Bookings. */
export interface DetectConflictsParams<Id extends string = string> {
  resourceId: string;
  candidate: { start: Temporal.Instant; end: Temporal.Instant };
  bookings: readonly Booking<Id>[];
  /** Leave this Booking out of the check, e.g. the one being rescheduled. */
  excludeBookingId?: NoInfer<Id>;
}

/**
 * Whether `booking` is blocking, not excluded, and overlaps `range`.
 *
 * @returns `true` when `booking` blocks `range`.
 */
function blocks<Id extends string>(
  booking: Booking<Id>,
  range: InstantRange,
  excludeBookingId: Id | undefined
): boolean {
  // Half-open intervals [start, end): overlap iff a.start < b.end AND b.start < a.end.
  return (
    booking.isBlocking &&
    booking.id !== excludeBookingId &&
    Temporal.Instant.compare(range.start, booking.end) < 0 &&
    Temporal.Instant.compare(booking.start, range.end) < 0
  );
}

/**
 * Whether any Booking but `excludeBookingId` blocks `range`. For Core functions that already checked their params.
 *
 * @returns `true` when some Booking blocks `range`.
 */
export function overlapsBlockingBooking<Id extends string>(
  bookings: readonly Booking<Id>[],
  range: InstantRange,
  excludeBookingId: Id | undefined
): boolean {
  return bookings.some((b) => blocks(b, range, excludeBookingId));
}

/**
 * The blocking Bookings that overlap `candidate`, sorted by start.
 *
 * @returns The conflicting Bookings, empty when there are none, or `InvalidParams` when a Booking or `candidate` is malformed or on another Resource.
 */
export function detectConflicts<Id extends string = string>(
  params: DetectConflictsParams<Id>
): Result<Booking<Id>[], InvalidParams> {
  const { bookings, candidate, excludeBookingId, resourceId } = params;

  const issues = [
    ...checkInstantRange(candidate, ["candidate"]),
    ...checkBookings(bookings, resourceId),
  ];

  return checked(issues, () =>
    bookings
      .filter((b) => blocks(b, candidate, excludeBookingId))
      .toSorted((a, b) => Temporal.Instant.compare(a.start, b.start))
  );
}
