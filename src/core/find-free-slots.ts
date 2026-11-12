import {
  checkOrder,
  checkPositiveInteger,
  checkResourceInputs,
  checkTimeZone,
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
  /** Leave this Booking out of the overlap check, e.g. the one being rescheduled. */
  excludeBookingId?: string;
  /** Grid step in whole minutes, counted from local midnight in `timezone`. */
  interval: number;
  /** IANA timezone whose local midnight anchors the grid; slots are zoned in it. */
  timezone: string;
}

/** `minutes` after midnight on `date`, or undefined in a DST gap; a repeated time is its first occurrence (ADR 005). */
function gridTime(
  date: Temporal.PlainDate,
  minutes: number,
  timezone: string
): Temporal.ZonedDateTime | undefined {
  const local = date.toPlainDateTime().add({ minutes });
  const zoned = local.toZonedDateTime(timezone, { disambiguation: "earlier" });

  return zoned.toPlainDateTime().equals(local) ? zoned : undefined;
}

function findFreeSlotsUnchecked(params: FindFreeSlotsParams): Slot[] {
  const { duration, from, interval, resourceId, rules, timezone, to } = params;

  // ±1 day covers every rule timezone's dates that overlap [from, to).
  const windows = expandRulesUnchecked({
    from: from.toZonedDateTimeISO("UTC").toPlainDate().subtract({ days: 1 }),
    rules,
    to: to.toZonedDateTimeISO("UTC").toPlainDate().add({ days: 1 }),
  }).map((w) => ({ end: w.end.toInstant(), start: w.start.toInstant() }));

  const lastDate = to.toZonedDateTimeISO(timezone).toPlainDate();
  const slots: Slot[] = [];

  for (
    let date = from.toZonedDateTimeISO(timezone).toPlainDate();
    Temporal.PlainDate.compare(date, lastDate) <= 0;
    date = date.add({ days: 1 })
  ) {
    for (let minutes = 0; minutes < 24 * 60; minutes += interval) {
      const start = gridTime(date, minutes, timezone);

      if (start === undefined) {
        continue;
      }

      const startInstant = start.toInstant();
      const endInstant = startInstant.add({ minutes: duration });

      const available =
        Temporal.Instant.compare(startInstant, from) >= 0 &&
        Temporal.Instant.compare(startInstant, to) < 0 &&
        windows.some(
          (w) =>
            Temporal.Instant.compare(w.start, startInstant) <= 0 &&
            Temporal.Instant.compare(endInstant, w.end) <= 0
        );

      if (
        available &&
        detectConflictsUnchecked({
          ...params,
          candidate: { end: endInstant, start: startInstant },
        }).length === 0
      ) {
        slots.push({
          end: endInstant.toZonedDateTimeISO(timezone),
          resourceId,
          start,
        });
      }
    }
  }

  return slots;
}

export function findFreeSlots(
  params: FindFreeSlotsParams
): Result<Slot[], InvalidParams> {
  const {
    bookings,
    duration,
    from,
    interval,
    resourceId,
    rules,
    timezone,
    to,
  } = params;

  const issues = [
    ...checkPositiveInteger(duration, ["duration"]),
    ...checkPositiveInteger(interval, ["interval"]),
    ...checkTimeZone(timezone, ["timezone"]),
    ...checkResourceInputs({ bookings, resourceId, rules }),
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
