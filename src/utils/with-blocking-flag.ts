import type { Booking } from "../core/types.js";

/**
 * Maps user-defined statuses to the `isBlocking` flag.
 *
 * @example
 * const bookings = withBlockingFlag(rawBookings, {
 *   blocking: ["CONFIRMED", "PENDING"],
 *   nonBlocking: ["CANCELLED", "MISSED"],
 * });
 */
export function withBlockingFlag(
  bookings: Booking[],
  mapping: {
    blocking?: string[];
    nonBlocking?: string[];
  }
): Booking[] {
  const blockingSet = new Set(mapping.blocking);
  const nonBlockingSet = new Set(mapping.nonBlocking);

  return bookings.map((b) => {
    if (b.status === undefined) {
      return b;
    }

    let isBlocking: boolean | undefined;

    if (blockingSet.has(b.status)) {
      isBlocking = true;
    } else if (nonBlockingSet.has(b.status)) {
      isBlocking = false;
    }

    if (isBlocking === undefined) {
      return b;
    }

    return { ...b, isBlocking };
  });
}
