import { availableWindows } from "./availability.js";
import {
  MAX_DURATION_MINUTES,
  MAX_GRID_TIMES,
  checkInstant,
  checkPositiveInteger,
  checkResourceInputs,
  checkTimeZone,
} from "./checks.js";
import type { CheckIssue } from "./checks.js";
import { DAY_MS, dayOffsets } from "./day-offset.js";
import { checked } from "./result.js";
import type { InvalidParams, Result } from "./result.js";
import type {
  AvailabilityRule,
  AvailabilityViolation,
  Booking,
  CorePolicy,
  CoreViolations,
  InstantRange,
  Slot,
} from "./types.js";

/** A search for `duration`-minute Slots on one Resource, starting on the Grid in `[from, to)`. */
export interface FindFreeSlotsParams<
  R extends readonly CorePolicy[] = readonly CorePolicy[],
  Id extends string = string,
> {
  resourceId: string;
  rules: readonly AvailabilityRule[];
  bookings: readonly Booking<Id>[];
  duration: number;
  from: Temporal.Instant;
  to: Temporal.Instant;
  /** Leave this Booking out of the overlap check, e.g. the one being rescheduled. */
  excludeBookingId?: NoInfer<Id>;
  /** Grid step in whole minutes, counted from local midnight in `timezone`. */
  interval: number;
  /** IANA timezone whose local midnight anchors the grid; slots are zoned in it. */
  timezone: string;
  /** Policies to relax: a slot breaking only these is returned, tagged in `waived`. */
  relax?: R;
}

const outsideAvailability: AvailabilityViolation = {
  detail: {},
  policy: "availability",
};

/** A half-open `[startMs, endMs)` range in epoch milliseconds. */
interface MsRange {
  readonly startMs: number;
  readonly endMs: number;
}

// Core inputs may be finer than a millisecond; Grid times never are. So rounding a Booking outwards, a window
// inwards and a search's `from` and `to` up compares with a Grid time exactly as the unrounded Instants would.

/**
 * `instant` in epoch milliseconds, rounded down (before 1970 too).
 *
 * @returns The milliseconds; throws a `TypeError` when `instant` isn't an Instant, as `undefined` milliseconds would break the sweep and free a blocked time.
 */
function floorToMs(instant: Temporal.Instant): number {
  const ms = instant.epochMilliseconds;

  if (!Number.isFinite(ms)) {
    throw new TypeError(`Expected a Temporal.Instant, got ${String(instant)}.`);
  }

  return ms;
}

/**
 * `instant` in epoch milliseconds, rounded up.
 *
 * @returns The milliseconds; throws as `floorToMs` does.
 */
function ceilToMs(instant: Temporal.Instant): number {
  return (
    floorToMs(instant) + (instant.epochNanoseconds % 1_000_000n === 0n ? 0 : 1)
  );
}

/**
 * The local midnight of `instant`'s date in `timezone`, as if it were UTC.
 *
 * @returns The milliseconds since the epoch.
 */
function localMidnightMs(instant: Temporal.Instant, timezone: string): number {
  return instant
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toZonedDateTime("UTC").epochMilliseconds;
}

/**
 * The first occurrence of a local time in `timezone`.
 *
 * @param localMs - The local time as if it were UTC, in epoch milliseconds.
 * @returns Its epoch milliseconds, or `undefined` when it falls in a DST gap.
 */
function firstOccurrenceMs(
  localMs: number,
  timezone: string
): number | undefined {
  const local = Temporal.Instant.fromEpochMilliseconds(localMs)
    .toZonedDateTimeISO("UTC")
    .toPlainDateTime();

  const zoned = local.toZonedDateTime(timezone, { disambiguation: "earlier" });

  return zoned.toPlainDateTime().equals(local)
    ? zoned.epochMilliseconds
    : undefined;
}

/**
 * The grid starts in `[from, to)`: local midnight in `timezone` plus whole `interval`s (ADR 014).
 * A time in a DST gap is dropped; a repeated time is its first occurrence (ADR 005).
 *
 * @returns Each grid start in epoch milliseconds, strictly increasing.
 */
function* gridStarts(
  from: Temporal.Instant,
  to: Temporal.Instant,
  interval: number,
  timezone: string
): Generator<number> {
  const fromMs = ceilToMs(from);
  const toMs = ceilToMs(to);
  const firstMidnight = localMidnightMs(from, timezone);
  const lastMidnight = localMidnightMs(to, timezone);
  const offsetOf = dayOffsets(timezone, firstMidnight);

  for (
    let midnight = firstMidnight;
    midnight <= lastMidnight;
    midnight += DAY_MS
  ) {
    const offsetMs = offsetOf(midnight);

    for (let minutes = 0; minutes < 24 * 60; minutes += interval) {
      const localMs = midnight + minutes * 60_000;

      // Only a day the clocks change needs Temporal.
      const startMs =
        offsetMs === undefined
          ? firstOccurrenceMs(localMs, timezone)
          : localMs - offsetMs;

      if (startMs !== undefined && startMs >= fromMs && startMs < toMs) {
        yield startMs;
      }
    }
  }
}

function byStart(a: MsRange, b: MsRange): number {
  return a.startMs - b.startMs;
}

/**
 * A forward-only overlap check: call the result with ranges whose start and end never decrease, as the Grid's are.
 * Each Booking is visited once across all calls, not once per call.
 *
 * @returns Whether a range overlaps a blocking Booking other than `excludeBookingId`.
 */
function blockedSweep<Id extends string>(
  bookings: readonly Booking<Id>[],
  excludeBookingId: Id | undefined
): (range: MsRange) => boolean {
  const sorted = bookings
    .flatMap((b) =>
      b.isBlocking && b.id !== excludeBookingId
        ? [{ endMs: ceilToMs(b.end), startMs: floorToMs(b.start) }]
        : []
    )
    .toSorted(byStart);

  let next = 0;
  // The latest end among the Bookings that start before the current range ends.
  let reach = Number.NEGATIVE_INFINITY;

  return ({ endMs, startMs }) => {
    for (; next < sorted.length; next += 1) {
      const booking = sorted[next];

      if (booking === undefined || booking.startMs >= endMs) {
        break;
      }

      reach = Math.max(reach, booking.endMs);
    }

    // Half-open: a Booking that starts before `endMs` overlaps iff it ends after `startMs`.
    return startMs < reach;
  };
}

/**
 * A forward-only `fitsInSomeWindow`: call the result with ranges whose start and end never decrease.
 * Each window is visited once across all calls.
 *
 * @returns Whether a range fits fully inside one of `windows`.
 */
function fitsSweep(
  windows: readonly InstantRange[]
): (range: MsRange) => boolean {
  const sorted = windows
    .map((w) => ({ endMs: floorToMs(w.end), startMs: ceilToMs(w.start) }))
    .toSorted(byStart);

  let next = 0;
  // The latest end among the windows that start at or before the current range starts.
  let reach = Number.NEGATIVE_INFINITY;

  return ({ endMs, startMs }) => {
    for (; next < sorted.length; next += 1) {
      const window = sorted[next];

      if (window === undefined || window.startMs > startMs) {
        break;
      }

      reach = Math.max(reach, window.endMs);
    }

    return endMs <= reach;
  };
}

/**
 * The Grid times in `[from, to)` whose range overlaps no blocking Booking except `excludeBookingId`: the search before any Policy. Internal; not exported from the Core's entry.
 *
 * @returns The free Grid times' ranges in start order. They aren't zoned yet, as most Grid times never become a Slot.
 */
export function freeGridSlots({
  bookings,
  duration,
  excludeBookingId,
  from,
  interval,
  timezone,
  to,
}: Pick<
  FindFreeSlotsParams,
  | "bookings"
  | "duration"
  | "excludeBookingId"
  | "from"
  | "interval"
  | "timezone"
  | "to"
>): MsRange[] {
  const slots: MsRange[] = [];
  const durationMs = duration * 60_000;
  const blocked = blockedSweep(bookings, excludeBookingId);

  for (const startMs of gridStarts(from, to, interval, timezone)) {
    const slot = { endMs: startMs + durationMs, startMs };

    if (!blocked(slot)) {
      slots.push(slot);
    }
  }

  return slots;
}

function findFreeSlotsUnchecked(
  params: FindFreeSlotsParams
): Slot<AvailabilityViolation>[] {
  const { from, relax, resourceId, rules, timezone, to } = params;

  const relaxAvailability = relax?.includes("availability") ?? false;
  const fits = fitsSweep(availableWindows(rules, { end: to, start: from }));

  return freeGridSlots(params).flatMap((slot) => {
    const available = fits(slot);

    return available || relaxAvailability
      ? [
          {
            end: Temporal.Instant.fromEpochMilliseconds(
              slot.endMs
            ).toZonedDateTimeISO(timezone),
            resourceId,
            start: Temporal.Instant.fromEpochMilliseconds(
              slot.startMs
            ).toZonedDateTimeISO(timezone),
            waived: available ? [] : [outsideAvailability],
          },
        ]
      : [];
  });
}

/**
 * The search params' issues: whole-minute `duration` and `interval`, an IANA `timezone`, `from < to`,
 * all within ADR 019's limits. Internal; the Framework checks these before any Adapter call.
 *
 * @returns The issues, empty when the search is valid.
 */
export function checkSearch({
  duration,
  from,
  interval,
  timezone,
  to,
}: Pick<
  FindFreeSlotsParams,
  "duration" | "from" | "interval" | "timezone" | "to"
>): CheckIssue[] {
  const durationIssues = checkPositiveInteger(duration, ["duration"]);
  const intervalIssues = checkPositiveInteger(interval, ["interval"]);

  const rangeIssues = [
    ...checkInstant(from, ["from"]),
    ...checkInstant(to, ["to"]),
  ];

  if (rangeIssues.length === 0 && Temporal.Instant.compare(from, to) >= 0) {
    rangeIssues.push({
      message: `to (${to.toString()}) must be after from (${from.toString()}).`,
      path: ["to"],
    });
  }

  // The Grid restarts each midnight, so it has whole Grid times a day, at least one. A DST day counts as 24 hours:
  // an estimate, off by at most an hour's Grid times a day.
  const gridTimes =
    intervalIssues.length === 0 && rangeIssues.length === 0
      ? Math.ceil(
          ((to.epochMilliseconds - from.epochMilliseconds) *
            Math.ceil(1440 / interval)) /
            DAY_MS
        )
      : 0;

  return [
    ...durationIssues,
    ...(durationIssues.length === 0 && duration > MAX_DURATION_MINUTES
      ? [
          {
            message: `duration is ${duration} minutes; the limit is ${MAX_DURATION_MINUTES} (31 days).`,
            path: ["duration"],
          },
        ]
      : []),
    ...intervalIssues,
    ...checkTimeZone(timezone, ["timezone"]),
    ...rangeIssues,
    ...(gridTimes > MAX_GRID_TIMES
      ? [
          {
            message: `Search covers ${gridTimes.toLocaleString("en-US")} Grid times; the limit is ${MAX_GRID_TIMES.toLocaleString("en-US")}. Split it into smaller ranges.`,
            path: ["to"],
          },
        ]
      : []),
  ];
}

/**
 * The Grid starts whose slot overlaps no blocking Booking and fits availability.
 * With `relax: ["availability"]`, slots outside it are kept and marked `waived`.
 *
 * @returns The free Slots in start order, or `InvalidParams` when a rule, Booking or search param is malformed.
 */
export function findFreeSlots<
  const R extends readonly CorePolicy[] = [],
  Id extends string = string,
>(
  params: FindFreeSlotsParams<R, Id>
): Result<Slot<CoreViolations[R[number]]>[], InvalidParams> {
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
    ...checkSearch({ duration, from, interval, timezone, to }),
    ...checkResourceInputs({ bookings, resourceId, rules }),
  ];

  // SAFETY: an availability violation is only added when R contains "availability".
  return checked(
    issues,
    () => findFreeSlotsUnchecked(params) as Slot<CoreViolations[R[number]]>[]
  );
}
