import { fitsInSomeWindow, windowsFor } from "./availability.js";
import { checkInstantRange, checkResourceInputs } from "./checks.js";
import { overlapsBlockingBooking } from "./detect-conflicts.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import type { AvailabilityRule, Booking } from "./types.js";

/** One proposed `slot` on one Resource, checked against its rules and Bookings. */
export interface IsSlotValidParams<Id extends string = string> {
  resourceId: string;
  slot: { start: Temporal.Instant; end: Temporal.Instant };
  rules: readonly AvailabilityRule[];
  bookings: readonly Booking<Id>[];
  /** Leave this Booking out of the overlap check, e.g. the one being rescheduled. */
  excludeBookingId?: NoInfer<Id>;
}

/**
 * Whether `slot` fits inside an availability window and overlaps no blocking Booking.
 *
 * @returns `true` when `slot` is bookable, or `InvalidParams` when a rule, Booking or `slot` is malformed.
 */
export function isSlotValid<Id extends string = string>(
  params: IsSlotValidParams<Id>
): Result<boolean, InvalidParams> {
  const { bookings, excludeBookingId, resourceId, rules, slot } = params;

  const issues = [
    ...checkInstantRange(slot, ["slot"]),
    ...checkResourceInputs({ bookings, resourceId, rules }),
  ];

  return checked(
    issues,
    () =>
      fitsInSomeWindow(windowsFor(rules, slot), slot) &&
      !overlapsBlockingBooking(bookings, slot, excludeBookingId)
  );
}
