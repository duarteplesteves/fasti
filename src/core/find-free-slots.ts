import { checkOrder } from "./check-rule.js";
import {
  checkBookings,
  checkPositiveInteger,
  checkRules,
  checkSameResource,
} from "./checks.js";
import { detectConflictsUnchecked } from "./detect-conflicts.js";
import { expandRulesUnchecked } from "./expand-rules.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import type { AvailabilityRule, Booking, Slot } from "./types.js";

export interface FindFreeSlotsParams {
  resourceId: string;
  rules: readonly AvailabilityRule[];
  bookings: readonly Booking[];
  duration: number;
  from: Temporal.Instant;
  to: Temporal.Instant;
  options?: {
    /** Candidate cadence in minutes. Defaults to `duration`. */
    interval?: number;
    /** Allow a slot whose end exceeds the window end. Defaults to false. */
    allowEndOverflow?: boolean;
  };
}

function findFreeSlotsUnchecked(params: FindFreeSlotsParams): Slot[] {
  const { bookings, duration, from, options, resourceId, rules, to } = params;
  const interval = options?.interval ?? duration;
  const allowEndOverflow = options?.allowEndOverflow ?? false;

  const expansionFrom = from.toZonedDateTimeISO("UTC").toPlainDate();
  const expansionTo = to.toZonedDateTimeISO("UTC").toPlainDate();

  const windows = expandRulesUnchecked({
    from: expansionFrom,
    rules,
    to: expansionTo,
  });

  const slots: Slot[] = [];
  const seen = new Set<string>();

  for (const window of windows) {
    const windowEndInstant = window.end.toInstant();
    let cursor = window.start;

    while (Temporal.ZonedDateTime.compare(cursor, window.end) < 0) {
      const start = cursor;
      const startInstant = start.toInstant();
      const endInstant = startInstant.add({ minutes: duration });

      if (
        !allowEndOverflow &&
        Temporal.Instant.compare(endInstant, windowEndInstant) > 0
      ) {
        break;
      }

      // Dedup by (timezone, wall-clock start): collapses identical-window rules and
      // the second occurrence during a DST fall-back overlap (ADR 005).
      const key = `${start.timeZoneId}|${start.toPlainDateTime().toString()}`;

      if (!seen.has(key)) {
        seen.add(key);

        const conflicts = detectConflictsUnchecked({
          bookings,
          candidate: { end: endInstant, start: startInstant },
        });

        if (conflicts.length === 0) {
          slots.push({
            end: endInstant.toZonedDateTimeISO(window.start.timeZoneId),
            resourceId,
            start,
          });
        }
      }

      cursor = cursor.add({ minutes: interval });
    }
  }

  return slots;
}

export function findFreeSlots(
  params: FindFreeSlotsParams
): Result<Slot[], InvalidParams> {
  const { bookings, duration, from, options, resourceId, rules, to } = params;

  const issues = [
    ...checkPositiveInteger(duration, ["duration"]),
    // Skipped when defaulted from duration: a bad duration is already reported.
    ...(options?.interval === undefined
      ? []
      : checkPositiveInteger(options.interval, ["options", "interval"])),
    ...checkRules(rules),
    ...checkSameResource(rules, "rules", resourceId),
    ...checkBookings(bookings, resourceId),
    ...checkOrder(
      Temporal.Instant.compare,
      { label: "from", value: from },
      { label: "to", value: to },
      "after",
      ["to"]
    ),
  ];

  return checked(issues, () => findFreeSlotsUnchecked(params));
}
