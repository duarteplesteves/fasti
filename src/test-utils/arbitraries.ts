import {
  array,
  boolean,
  constant,
  constantFrom,
  integer,
  oneof,
  option,
  record,
  string,
  tuple,
  uniqueArray,
} from "fast-check";
import type { Arbitrary } from "fast-check";

import type { AvailabilityRule, Booking } from "../core/types.js";

const timezones = [
  "Europe/Lisbon",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Pacific/Apia",
  "Pacific/Auckland",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Tehran",
  "Australia/Sydney",
  "Australia/Adelaide",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Antarctica/Troll",
  "Pacific/Chatham",
  "America/St_Johns",
  "Asia/Kathmandu",
  "Pacific/Norfolk",
  "Pacific/Marquesas",
] as const;

export function arbTimezone(): Arbitrary<string> {
  return constantFrom(...timezones);
}

function arbPlainTime(): Arbitrary<Temporal.PlainTime> {
  return record({
    hour: integer({ max: 23, min: 0 }),
    millisecond: integer({ max: 999, min: 0 }),
    minute: integer({ max: 59, min: 0 }),
    second: integer({ max: 59, min: 0 }),
  }).map(({ hour, millisecond, minute, second }) =>
    Temporal.PlainTime.from({
      hour,
      millisecond,
      minute,
      second,
    })
  );
}

function arbPlainDate(
  yearMin: number,
  yearMax: number
): Arbitrary<Temporal.PlainDate> {
  return record({
    day: integer({ max: 28, min: 1 }),
    month: integer({ max: 12, min: 1 }),
    year: integer({ max: yearMax, min: yearMin }),
  }).map(({ day, month, year }) =>
    Temporal.PlainDate.from({ day, month, year })
  );
}

function arbInstantInRange(
  from: Temporal.Instant,
  to: Temporal.Instant
): Arbitrary<Temporal.Instant> {
  const fromMs = from.epochMilliseconds;
  const toMs = to.epochMilliseconds;

  return integer({ max: toMs - fromMs, min: 0 }).map((offset) =>
    Temporal.Instant.fromEpochMilliseconds(fromMs + offset)
  );
}

export function arbDaysOfWeek(): Arbitrary<number[]> {
  return tuple(
    boolean(),
    boolean(),
    boolean(),
    boolean(),
    boolean(),
    boolean(),
    boolean()
  ).map((flags) => {
    const days: number[] = [];

    for (let i = 0; i < 7; i += 1) {
      if (flags[i]) {
        days.push(i + 1);
      }
    }

    return days.length === 0 ? [1] : days;
  });
}

export function arbAvailabilityRule(opts?: {
  resourceId?: string;
  timezone?: string;
}): Arbitrary<AvailabilityRule> {
  return record({
    _daysOfWeek: arbDaysOfWeek(),
    _effectiveFrom: arbPlainDate(2020, 2030),
    _effectiveTo: arbPlainDate(2020, 2030),
    _endTime: arbPlainTime(),
    _interval: integer({ max: 6, min: 1 }),
    _startTime: arbPlainTime(),
    _timezone: arbTimezone(),
  })
    .chain(
      ({
        _daysOfWeek,
        _effectiveFrom,
        _effectiveTo,
        _endTime,
        _interval,
        _startTime,
        _timezone,
      }) => {
        if (Temporal.PlainTime.compare(_startTime, _endTime) >= 0) {
          return constant(null);
        }

        const wrapUseEffectiveFrom = boolean();
        const wrapUseEffectiveTo = boolean();

        return record({
          useEffectiveFrom: wrapUseEffectiveFrom,
          useEffectiveTo: wrapUseEffectiveTo,
        }).map(({ useEffectiveFrom, useEffectiveTo }) => {
          const resourceId =
            opts?.resourceId ??
            `res-${_startTime.toString().replaceAll(":", "")}-${Math.random().toString(36).slice(2, 6)}`;

          const timezone = opts?.timezone ?? _timezone;

          const sortedEffective = [_effectiveFrom, _effectiveTo].toSorted(
            Temporal.PlainDate.compare
          );

          const [earlier, later] = sortedEffective;

          const rule: AvailabilityRule = {
            recurrence: {
              daysOfWeek: _daysOfWeek,
              frequency: "weekly",
              interval: _interval,
            },
            resourceId,
            timeWindow: {
              end: _endTime,
              start: _startTime,
            },
            timezone,
          };

          if (useEffectiveFrom && earlier) {
            rule.effectiveFrom = earlier;
          }

          if (useEffectiveTo && later) {
            rule.effectiveTo = later;
          }

          return rule;
        });
      }
    )
    .filter((r): r is AvailabilityRule => r !== null);
}

export function arbRulesForResource(
  resourceId: string
): Arbitrary<AvailabilityRule[]> {
  return array(arbAvailabilityRule({ resourceId }), {
    maxLength: 3,
    minLength: 1,
  });
}

export function arbBooking(opts?: {
  isBlocking?: boolean;
  resourceId?: string;
}): Arbitrary<Booking> {
  const rangeFrom = Temporal.Instant.from("2020-01-01T00:00:00Z");
  const rangeTo = Temporal.Instant.from("2030-01-01T00:00:00Z");

  return record({
    _durationMs: integer({ max: 7 * 24 * 60 * 60 * 1000, min: 1 }),
    _isBlocking: boolean(),
    _start: arbInstantInRange(rangeFrom, rangeTo),
  })
    .chain(({ _durationMs, _isBlocking, _start }) => {
      const end = _start.add({ milliseconds: _durationMs });

      if (Temporal.Instant.compare(end, rangeTo) >= 0) {
        return constant(null);
      }

      return record({
        _id: string({ maxLength: 12, minLength: 1 }),
        _status: option(string({ maxLength: 12, minLength: 1 })),
      }).map(({ _id, _status }) => {
        const booking: Booking = {
          end,
          id: _id,
          isBlocking: opts?.isBlocking ?? _isBlocking,
          resourceId: opts?.resourceId ?? "booking-res",
          start: _start,
        };

        if (_status !== null) {
          booking.status = _status;
        }

        return booking;
      });
    })
    .filter((b): b is Booking => b !== null);
}

/** A booking on `resourceId` starting inside `range`, lasting up to 4 hours. */
export function arbBookingIn(
  range: { from: Temporal.Instant; to: Temporal.Instant },
  resourceId: string
): Arbitrary<Booking> {
  return record({
    durationMs: integer({ max: 4 * 60 * 60 * 1000, min: 1 }),
    id: constantFrom("b1", "b2", "b3", "b4", "b5"),
    isBlocking: boolean(),
    start: arbInstantInRange(range.from, range.to),
  }).map(({ durationMs, id, isBlocking, start }) => ({
    end: start.add({ milliseconds: durationMs }),
    id,
    isBlocking,
    resourceId,
    start,
  }));
}

/** Bookings with distinct ids inside `range`, and an id to exclude: one of theirs, or one matching none. */
export function arbBookingsToExclude(
  range: { from: Temporal.Instant; to: Temporal.Instant },
  resourceId: string
): Arbitrary<{ bookings: Booking[]; excludeBookingId: string }> {
  return uniqueArray(arbBookingIn(range, resourceId), {
    maxLength: 5,
    selector: (b) => b.id,
  }).chain((bookings) =>
    constantFrom(...bookings.map((b) => b.id), "missing").map(
      (excludeBookingId) => ({ bookings, excludeBookingId })
    )
  );
}

export function arbTimeRange(): Arbitrary<{
  from: Temporal.Instant;
  to: Temporal.Instant;
}> {
  return record({
    _from: arbInstantInRange(
      Temporal.Instant.from("2020-01-01T00:00:00Z"),
      Temporal.Instant.from("2030-06-01T00:00:00Z")
    ),
    _to: integer({ max: 365 * 24 * 60 * 60 * 1000, min: 1 }),
  }).map(({ _from, _to }) => ({
    from: _from,
    to: _from.add({ milliseconds: _to }),
  }));
}

export function arbResourceId(): Arbitrary<string> {
  return string({ maxLength: 8, minLength: 1 }).map((s) => `res-${s}`);
}

export function arbDuration(): Arbitrary<number> {
  return integer({ max: 240, min: 5 });
}

/** A grid step in minutes, including ones that don't divide a day. */
export function arbInterval(): Arbitrary<number> {
  return integer({ max: 240, min: 5 });
}

const dstDates = [
  Temporal.PlainDate.from("2024-03-10"),
  Temporal.PlainDate.from("2024-03-31"),
  Temporal.PlainDate.from("2024-10-27"),
  Temporal.PlainDate.from("2024-11-03"),
  Temporal.PlainDate.from("2025-03-09"),
  Temporal.PlainDate.from("2025-03-30"),
  Temporal.PlainDate.from("2025-10-26"),
  Temporal.PlainDate.from("2025-11-02"),
];

const maxWeekRangeMs = 4 * 7 * 24 * 60 * 60 * 1000;

export function arbDateRange(): Arbitrary<{
  from: Temporal.Instant;
  to: Temporal.Instant;
}> {
  return boolean().chain((useDst) => {
    if (useDst) {
      return constantFrom(...dstDates).map((date) => {
        const start = date.toZonedDateTime({
          plainTime: Temporal.PlainTime.from("00:00"),
          timeZone: "UTC",
        });

        return {
          from: start.subtract({ days: 1 }).toInstant(),
          to: start.add({ weeks: 2 }).toInstant(),
        };
      });
    }

    return record({
      _from: arbInstantInRange(
        Temporal.Instant.from("2020-01-01T00:00:00Z"),
        Temporal.Instant.from("2030-06-01T00:00:00Z")
      ),
      _to: integer({ max: maxWeekRangeMs, min: 1 }),
    }).map(({ _from, _to }) => ({
      from: _from,
      to: _from.add({ milliseconds: _to }),
    }));
  });
}

// Arbitraries for any params, valid or not; most draws are valid or nearly so,
// so each bad value also reaches the compute path on its own. Magnitudes are bounded (|n| ≤ 1e6,
// dates 1900–2100) because Temporal overflow is an accepted gap (see checks.ts).

const anyTimezones = [
  "Europe/Lisbon",
  "America/New_York",
  "UTC",
  "europe/lisbon",
  "Europe/Lisbn",
  "+01:00",
  "",
] as const;

export function arbAnyCount(): Arbitrary<number> {
  return oneof(
    integer({ max: 240, min: 1 }),
    integer({ max: 1e6, min: -1e6 }),
    constantFrom(0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY)
  );
}

function arbAnyInstant(): Arbitrary<Temporal.Instant> {
  return arbInstantInRange(
    Temporal.Instant.from("1900-01-01T00:00:00Z"),
    Temporal.Instant.from("2100-01-01T00:00:00Z")
  );
}

/** A start anywhere in 1900–2100 and an end from 3 days before to 14 days after it. */
export function arbAnyInstantRange(): Arbitrary<{
  start: Temporal.Instant;
  end: Temporal.Instant;
}> {
  const day = 24 * 60 * 60 * 1000;

  return record({
    offset: integer({ max: 14 * day, min: -3 * day }),
    start: arbAnyInstant(),
  }).map(({ offset, start }) => ({
    end: start.add({ milliseconds: offset }),
    start,
  }));
}

/** `arb`'s value one draw in four, otherwise null (leave the valid field alone). */
function sometimes<T>(arb: Arbitrary<T>): Arbitrary<T | null> {
  return oneof(
    { arbitrary: constant(null), weight: 3 },
    { arbitrary: arb, weight: 1 }
  );
}

/** A valid rule with each field independently replaced by any value now and then. */
export function arbAnyRule(): Arbitrary<AvailabilityRule> {
  return record({
    base: arbAvailabilityRule({ resourceId: "r1" }),
    daysOfWeek: sometimes(
      array(oneof(integer({ max: 9, min: -1 }), constant(1.5)), {
        maxLength: 8,
      })
    ),
    effectiveFrom: sometimes(arbPlainDate(1900, 2100)),
    effectiveTo: sometimes(arbPlainDate(1900, 2100)),
    exceptions: sometimes(array(arbPlainDate(1900, 2100), { maxLength: 3 })),
    interval: sometimes(arbAnyCount()),
    resourceId: sometimes(constant("r2")),
    timeWindow: sometimes(
      record({ end: arbPlainTime(), start: arbPlainTime() })
    ),
    timezone: sometimes(constantFrom(...anyTimezones)),
  }).map(
    ({
      base,
      daysOfWeek,
      effectiveFrom,
      effectiveTo,
      exceptions,
      interval,
      resourceId,
      timeWindow,
      timezone,
    }) => ({
      ...base,
      recurrence: {
        daysOfWeek: daysOfWeek ?? base.recurrence.daysOfWeek,
        frequency: "weekly",
        interval: interval ?? base.recurrence.interval,
      },
      resourceId: resourceId ?? base.resourceId,
      timeWindow: timeWindow ?? base.timeWindow,
      timezone: timezone ?? base.timezone,
      // Optional fields: only set when drawn, so exactOptionalPropertyTypes holds.
      ...(effectiveFrom !== null && { effectiveFrom }),
      ...(effectiveTo !== null && { effectiveTo }),
      ...(exceptions !== null && { exceptions }),
    })
  );
}

/** A valid booking whose range or resourceId is replaced by any value now and then. */
export function arbAnyBooking(): Arbitrary<Booking> {
  return record({
    base: arbBooking({ resourceId: "r1" }),
    range: sometimes(arbAnyInstantRange()),
    resourceId: sometimes(constant("r2")),
  }).map(({ base, range, resourceId }) => ({
    ...base,
    ...range,
    resourceId: resourceId ?? base.resourceId,
  }));
}
