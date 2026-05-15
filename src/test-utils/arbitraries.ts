import { Temporal } from "@js-temporal/polyfill";
import {
  boolean,
  constant,
  constantFrom,
  integer,
  option,
  record,
  string,
  tuple,
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
