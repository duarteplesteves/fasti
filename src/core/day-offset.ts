/** The milliseconds in a 24-hour day. */
export const DAY_MS = 86_400_000;

/** A stretch of time, `[startMs, endMs)` in epoch milliseconds, over which a timezone keeps one offset. */
interface Stretch {
  readonly startMs: number;
  readonly endMs: number;
  readonly offsetMs: number;
}

/**
 * The stretch from `startMs` to `timezone`'s next clock change.
 *
 * @returns The stretch; it ends at infinity when the clocks never change again.
 */
function stretchFrom(startMs: number, timezone: string): Stretch {
  const start =
    Temporal.Instant.fromEpochMilliseconds(startMs).toZonedDateTimeISO(
      timezone
    );

  return {
    endMs:
      start.getTimeZoneTransition("next")?.epochMilliseconds ??
      Number.POSITIVE_INFINITY,
    offsetMs: start.offsetNanoseconds / 1_000_000,
    startMs,
  };
}

/**
 * A lookup of `timezone`'s UTC offset by day. Give each local midnight as if it were UTC, in epoch milliseconds, in any
 * order; `firstMidnight` is the first. Going forward is cheap, going back starts over.
 *
 * @returns A day's offset in milliseconds, or `undefined` when the clocks change that day, so no one offset holds.
 */
export function dayOffsets(
  timezone: string,
  firstMidnight: number
): (midnight: number) => number | undefined {
  // Far enough back that the first stretch's start, which is no clock change, never falls in a day asked for.
  let stretch = stretchFrom(firstMidnight - 4 * DAY_MS, timezone);
  let previous = firstMidnight;

  return (midnight) => {
    // Going back within a stretch would miss a repeated midnight's first occurrence.
    if (midnight < previous) {
      stretch = stretchFrom(midnight - 4 * DAY_MS, timezone);
    }

    previous = midnight;

    // Under the old offset, so a midnight the old stretch still reaches keeps its first occurrence.
    while (midnight - stretch.offsetMs >= stretch.endMs) {
      stretch = stretchFrom(stretch.endMs, timezone);
    }

    const { endMs, offsetMs, startMs } = stretch;
    const dayStart = midnight - offsetMs;

    // A day that starts before its stretch lost its midnight to a gap.
    return dayStart >= startMs && dayStart + DAY_MS <= endMs
      ? offsetMs
      : undefined;
  };
}
