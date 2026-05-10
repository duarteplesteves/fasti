import { Temporal } from "@js-temporal/polyfill";

import { detectConflicts } from "./detect-conflicts.js";
import { expandRules } from "./expand-rules.js";
import type { AvailabilityRule, Booking, Slot } from "./types.js";

export interface FindFreeSlotsParams {
  resourceId: string;
  rules: AvailabilityRule[];
  bookings: Booking[];
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

export function findFreeSlots(params: FindFreeSlotsParams): Slot[] {
  const { bookings, duration, from, options, resourceId, rules, to } = params;
  const interval = options?.interval ?? duration;
  const allowEndOverflow = options?.allowEndOverflow ?? false;

  if (!Number.isInteger(duration) || duration < 1) {
    throw new Error(
      `Invalid input: duration must be a positive integer (minutes), got ${duration}.`
    );
  }

  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error(
      `Invalid input: options.interval must be a positive integer (minutes), got ${interval}.`
    );
  }

  if (Temporal.Instant.compare(from, to) >= 0) {
    throw new Error(
      `Invalid range: from (${from.toString()}) must be strictly before to (${to.toString()}).`
    );
  }

  for (const r of rules) {
    if (r.resourceId !== resourceId) {
      throw new Error(
        `Invalid input: rule has resourceId '${r.resourceId}' but params.resourceId is '${resourceId}'.`
      );
    }
  }

  const expansionFrom = from.toZonedDateTimeISO("UTC").toPlainDate();
  const expansionTo = to.toZonedDateTimeISO("UTC").toPlainDate();

  const windows = expandRules({
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
        const conflicts = detectConflicts({
          bookings,
          candidate: { end: endInstant, start: startInstant },
          resourceId,
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
