import type { Booking } from "../core/types.js";

/**
 * Maps user-defined statuses to the required `isBlocking` flag.
 *
 * Every returned booking has `isBlocking` set: by `blocking` if the status
 * matches, by `nonBlocking` if it matches, otherwise by `default`.
 *
 * @example
 * const bookings = withBlockingFlag(rawBookings, {
 *   blocking: ["CONFIRMED", "PENDING"],
 *   nonBlocking: ["CANCELLED", "MISSED"],
 *   default: "blocking",
 * });
 */
export function withBlockingFlag(
  bookings: Omit<Booking, "isBlocking">[],
  mapping: {
    blocking?: string[];
    nonBlocking?: string[];
    default: "blocking" | "nonBlocking";
  }
): Booking[] {
  const blockingSet = new Set(mapping.blocking);
  const nonBlockingSet = new Set(mapping.nonBlocking);
  const defaultIsBlocking = mapping.default === "blocking";

  return bookings.map((b) => {
    let isBlocking: boolean;
    if (b.status !== undefined && blockingSet.has(b.status)) {
      isBlocking = true;
    } else if (b.status !== undefined && nonBlockingSet.has(b.status)) {
      isBlocking = false;
    } else {
      isBlocking = defaultIsBlocking;
    }
    return { ...b, isBlocking };
  });
}
