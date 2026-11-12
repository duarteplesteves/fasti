import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import type { Booking } from "./types.js";

/**
 * Maps user-defined statuses to the required `isBlocking` flag.
 *
 * Every returned booking has `isBlocking` set: by `blocking` if the status
 * matches, by `nonBlocking` if it matches, otherwise by `default`. A status
 * listed in both is reported as invalid.
 *
 * @example
 * const result = withBlockingFlag(rawBookings, {
 *   blocking: ["CONFIRMED", "PENDING"],
 *   nonBlocking: ["CANCELLED", "MISSED"],
 *   default: "blocking",
 * });
 */
export function withBlockingFlag<Id extends string = string>(
  bookings: readonly Omit<Booking<Id>, "isBlocking">[],
  mapping: {
    blocking?: readonly string[];
    nonBlocking?: readonly string[];
    default: "blocking" | "nonBlocking";
  }
): Result<Booking<Id>[], InvalidParams> {
  const blockingSet = new Set(mapping.blocking);
  const nonBlockingSet = new Set(mapping.nonBlocking);
  const defaultIsBlocking = mapping.default === "blocking";

  const issues = (mapping.nonBlocking ?? []).flatMap((status, j) =>
    blockingSet.has(status)
      ? [
          {
            message: `Status "${status}" is listed in both mapping.blocking and mapping.nonBlocking.`,
            path: ["mapping", "nonBlocking", j],
          },
        ]
      : []
  );

  return checked(issues, () =>
    bookings.map((b) => {
      let isBlocking: boolean;

      if (b.status !== undefined && blockingSet.has(b.status)) {
        isBlocking = true;
      } else if (b.status !== undefined && nonBlockingSet.has(b.status)) {
        isBlocking = false;
      } else {
        isBlocking = defaultIsBlocking;
      }

      return { ...b, isBlocking };
    })
  );
}
