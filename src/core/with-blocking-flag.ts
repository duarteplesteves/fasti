import type { CheckIssue } from "./checks.js";
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
 * ```ts
 * const result = withBlockingFlag(rawBookings, {
 *   blocking: ["CONFIRMED", "PENDING"],
 *   nonBlocking: ["CANCELLED", "MISSED"],
 *   default: "blocking",
 * });
 * ```
 */
export function withBlockingFlag<Id extends string = string>(
  bookings: readonly Omit<Booking<Id>, "isBlocking">[],
  mapping: {
    blocking?: readonly string[];
    nonBlocking?: readonly string[];
    default: "blocking" | "nonBlocking";
  }
): Result<Booking<Id>[], InvalidParams> {
  const isBlockingByStatus = new Map<string, boolean>(
    (mapping.blocking ?? []).map((status) => [status, true])
  );

  const issues: CheckIssue[] = [];

  for (const [j, status] of (mapping.nonBlocking ?? []).entries()) {
    if (isBlockingByStatus.get(status) === true) {
      issues.push({
        message: `Status "${status}" is listed in both mapping.blocking and mapping.nonBlocking.`,
        path: ["mapping", "nonBlocking", j],
      });
    } else {
      isBlockingByStatus.set(status, false);
    }
  }

  const fallback = mapping.default === "blocking";

  return checked(issues, () =>
    bookings.map((b) => ({
      ...b,
      isBlocking:
        b.status === undefined
          ? fallback
          : (isBlockingByStatus.get(b.status) ?? fallback),
    }))
  );
}
