/** The milliseconds in a 24-hour day. */
export const DAY_MS = 86_400_000;

/** A stretch of time, `[startMs, endMs)` in epoch milliseconds, over which a timezone keeps one offset. */
export interface Stretch {
  readonly startMs: number;
  readonly endMs: number;
  readonly offsetMs: number;
}

/** A Stretch joined to those either side of it, as far as they have been read. */
interface LinkedStretch extends Stretch {
  readonly previous: LinkedStretch | undefined;
  next: LinkedStretch | undefined;
}

/**
 * The stretch from `startMs` to `timezone`'s next clock change.
 *
 * @returns The stretch; it ends at infinity when the clocks never change again.
 */
function stretchFrom(
  startMs: number,
  timezone: string,
  previous?: LinkedStretch
): LinkedStretch {
  const start =
    Temporal.Instant.fromEpochMilliseconds(startMs).toZonedDateTimeISO(
      timezone
    );

  return {
    endMs:
      start.getTimeZoneTransition("next")?.epochMilliseconds ??
      Number.POSITIVE_INFINITY,
    next: undefined,
    offsetMs: start.offsetNanoseconds / 1_000_000,
    previous,
    startMs,
  };
}

/** Whether `stretch` ends after the clocks show `localMs`. */
function reaches(stretch: Stretch, localMs: number): boolean {
  return localMs - stretch.offsetMs < stretch.endMs;
}

/**
 * A timezone's clock: the stretch that first reaches a local time, given as if it were UTC, in epoch milliseconds.
 * The time is `localMs - offsetMs`, at its first occurrence when it repeats. Before `startMs`, the clocks jump over
 * it, and `startMs` is the moment they do (ADR 005).
 */
export type ZoneClock = (localMs: number) => Stretch;

/**
 * `timezone`'s clock, for local times in any order; one near the last is cheap.
 *
 * @returns The clock.
 */
export function zoneClock(timezone: string): ZoneClock {
  let current: LinkedStretch | undefined;
  let earliest = Number.POSITIVE_INFINITY;

  return (localMs) => {
    // The first stretch's start is no clock change, so it stays well before any time asked for.
    if (current === undefined || localMs < earliest) {
      earliest = localMs - 2 * DAY_MS;
      current = stretchFrom(earliest - 2 * DAY_MS, timezone);
    }

    while (current.previous && reaches(current.previous, localMs)) {
      current = current.previous;
    }

    while (!reaches(current, localMs)) {
      current.next ??= stretchFrom(current.endMs, timezone, current);
      current = current.next;
    }

    return current;
  };
}
