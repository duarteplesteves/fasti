import type { Booking } from "./types.js";

export interface DetectConflictsParams {
  resourceId: string;
  candidate: { start: Temporal.Instant; end: Temporal.Instant };
  bookings: Booking[];
}

export function detectConflicts(params: DetectConflictsParams): Booking[] {
  const { bookings, candidate, resourceId } = params;

  for (const b of bookings) {
    if (b.resourceId !== resourceId) {
      throw new Error(
        `Invalid input: booking '${b.id}' has resourceId '${b.resourceId}' but params.resourceId is '${resourceId}'.`
      );
    }
  }

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
