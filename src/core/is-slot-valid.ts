import { detectConflicts } from "./detect-conflicts.js";
import { expandRules } from "./expand-rules.js";
import type { AvailabilityRule, Booking } from "./types.js";

export interface IsSlotValidParams {
  resourceId: string;
  slot: { start: Temporal.Instant; end: Temporal.Instant };
  rules: AvailabilityRule[];
  bookings: Booking[];
}

export function isSlotValid(params: IsSlotValidParams): boolean {
  const { bookings, resourceId, rules, slot } = params;

  for (const r of rules) {
    if (r.resourceId !== resourceId) {
      throw new Error(
        `Invalid input: rule has resourceId '${r.resourceId}' but params.resourceId is '${resourceId}'.`
      );
    }
  }

  // Pad the expansion range by ±1 day to cover any rule timezone vs slot UTC mismatch.
  const slotStartUtc = slot.start.toZonedDateTimeISO("UTC");
  const slotEndUtc = slot.end.toZonedDateTimeISO("UTC");
  const expansionFrom = slotStartUtc.toPlainDate().subtract({ days: 1 });
  const expansionTo = slotEndUtc.toPlainDate().add({ days: 1 });

  const windows = expandRules({
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

  const conflicts = detectConflicts({
    bookings,
    candidate: slot,
    resourceId,
  });

  return conflicts.length === 0;
}
