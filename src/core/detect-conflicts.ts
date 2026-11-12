import { checkBookings, checkInstantRange } from "./checks.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import type { Booking } from "./types.js";

export interface DetectConflictsParams {
  resourceId: string;
  candidate: { start: Temporal.Instant; end: Temporal.Instant };
  bookings: readonly Booking[];
}

/** `detectConflicts` without checks, for Core functions that already checked their params. */
export function detectConflictsUnchecked(
  params: Omit<DetectConflictsParams, "resourceId">
): Booking[] {
  const { bookings, candidate } = params;

  return bookings
    .filter((b) => {
      if (!b.isBlocking) {
        return false;
      }

      // Half-open intervals [start, end): overlap iff a.start < b.end AND b.start < a.end.
      const startsBeforeBookingEnds =
        Temporal.Instant.compare(candidate.start, b.end) < 0;

      const bookingStartsBeforeCandidateEnds =
        Temporal.Instant.compare(b.start, candidate.end) < 0;

      return startsBeforeBookingEnds && bookingStartsBeforeCandidateEnds;
    })
    .toSorted((a, b) => Temporal.Instant.compare(a.start, b.start));
}

export function detectConflicts(
  params: DetectConflictsParams
): Result<Booking[], InvalidParams> {
  const issues = [
    ...checkInstantRange(params.candidate, ["candidate"]),
    ...checkBookings(params.bookings, params.resourceId),
  ];

  return checked(issues, () => detectConflictsUnchecked(params));
}
