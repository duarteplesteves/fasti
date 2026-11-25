/** A half-open `[startMs, endMs)` range in epoch milliseconds. */
export interface MsRange {
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
export function floorToMs(instant: Temporal.Instant): number {
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
export function ceilToMs(instant: Temporal.Instant): number {
  return (
    floorToMs(instant) + (instant.epochNanoseconds % 1_000_000n === 0n ? 0 : 1)
  );
}

/** A moment, exact: whole epoch milliseconds, and the nanoseconds past them. */
export interface ExactTime {
  readonly ms: number;
  readonly ns: number;
}

/**
 * `instant` as an ExactTime.
 *
 * @returns The time; throws as `floorToMs` does.
 */
export function exactTime(instant: Temporal.Instant): ExactTime {
  const ms = floorToMs(instant);

  return { ms, ns: Number(instant.epochNanoseconds - BigInt(ms) * 1_000_000n) };
}

/**
 * Which of two times comes first.
 *
 * @returns Negative when `a` does, positive when `b` does, 0 when they are equal.
 */
export function compareTimes(a: ExactTime, b: ExactTime): number {
  return a.ms - b.ms || a.ns - b.ns;
}
