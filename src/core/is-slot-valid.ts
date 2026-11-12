import {
  checkBookings,
  checkInstantRange,
  checkRules,
  checkSameResource,
} from "./checks.js";
import { detectConflictsUnchecked } from "./detect-conflicts.js";
import { expandRulesUnchecked } from "./expand-rules.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import type { AvailabilityRule, Booking } from "./types.js";

export interface IsSlotValidParams {
  resourceId: string;
  slot: { start: Temporal.Instant; end: Temporal.Instant };
  rules: readonly AvailabilityRule[];
  bookings: readonly Booking[];
}

function isSlotValidUnchecked(params: IsSlotValidParams): boolean {
  const { bookings, rules, slot } = params;

  // Pad the expansion range by ±1 day to cover any rule timezone vs slot UTC mismatch.
  const slotStartUtc = slot.start.toZonedDateTimeISO("UTC");
  const slotEndUtc = slot.end.toZonedDateTimeISO("UTC");
  const expansionFrom = slotStartUtc.toPlainDate().subtract({ days: 1 });
  const expansionTo = slotEndUtc.toPlainDate().add({ days: 1 });

  const windows = expandRulesUnchecked({
    from: expansionFrom,
    rules,
    to: expansionTo,
  });

  const fitsInSomeWindow = windows.some((w) => {
    const windowStart = w.start.toInstant();
    const windowEnd = w.end.toInstant();

    return (
      Temporal.Instant.compare(slot.start, windowStart) >= 0 &&
      Temporal.Instant.compare(slot.end, windowEnd) <= 0
    );
  });

  if (!fitsInSomeWindow) {
    return false;
  }

  return detectConflictsUnchecked({ bookings, candidate: slot }).length === 0;
}

export function isSlotValid(
  params: IsSlotValidParams
): Result<boolean, InvalidParams> {
  const { bookings, resourceId, rules, slot } = params;

  const issues = [
    ...checkInstantRange(slot, ["slot"]),
    ...checkRules(rules),
    ...checkSameResource(rules, "rules", resourceId),
    ...checkBookings(bookings, resourceId),
  ];

  return checked(issues, () => isSlotValidUnchecked(params));
}
