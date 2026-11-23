import { expandRulesUnchecked } from "./expand-rules.js";
import type { AvailabilityRule, InstantRange } from "./types.js";

/**
 * The windows `rules` open around `range`, as instants.
 *
 * @returns The open windows, possibly overlapping.
 */
export function availableWindows(
  rules: readonly AvailabilityRule[],
  range: InstantRange
): InstantRange[] {
  // ±1 day around the UTC dates covers every rule timezone's local dates.
  return expandRulesUnchecked({
    from: range.start
      .toZonedDateTimeISO("UTC")
      .toPlainDate()
      .subtract({ days: 1 }),
    rules,
    to: range.end.toZonedDateTimeISO("UTC").toPlainDate().add({ days: 1 }),
  }).map((w) => ({ end: w.end.toInstant(), start: w.start.toInstant() }));
}

/** Longer than any window: a window is one local day, under 26 hours even across a DST change. */
const LONGEST_WINDOW_MS = 48 * 60 * 60 * 1000;

/** A UTC day: the cache key in `windowsFor` is days since the epoch. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The windows that could hold `slot`, so a slot of any length expands at most a few dates.
 * `byDate` caches each UTC date's windows, by days since the epoch: pass one Map across slots over the same `rules`, so each date expands once.
 *
 * @returns The open windows around `slot`, or none when `slot` is too long for any window to hold.
 */
export function windowsFor(
  rules: readonly AvailabilityRule[],
  slot: InstantRange,
  byDate: Map<number, readonly InstantRange[]>
): InstantRange[] {
  if (
    slot.end.epochMilliseconds - slot.start.epochMilliseconds >
    LONGEST_WINDOW_MS
  ) {
    return [];
  }

  const windows: InstantRange[] = [];
  const first = Math.floor(slot.start.epochMilliseconds / DAY_MS);
  const last = Math.floor(slot.end.epochMilliseconds / DAY_MS);

  // ±1 day around the UTC dates covers every rule timezone's local dates, as in `availableWindows`.
  for (let day = first - 1; day <= last + 1; day += 1) {
    let cached = byDate.get(day);

    if (cached === undefined) {
      const date = Temporal.Instant.fromEpochMilliseconds(day * DAY_MS)
        .toZonedDateTimeISO("UTC")
        .toPlainDate();

      cached = expandRulesUnchecked({ from: date, rules, to: date }).map(
        (w) => ({ end: w.end.toInstant(), start: w.start.toInstant() })
      );
      byDate.set(day, cached);
    }

    windows.push(...cached);
  }

  return windows;
}

/**
 * Whether `range` fits fully inside one of `windows`.
 *
 * @returns `true` when one window contains all of `range`.
 */
export function fitsInSomeWindow(
  windows: readonly InstantRange[],
  range: InstantRange
): boolean {
  return windows.some(
    (w) =>
      Temporal.Instant.compare(w.start, range.start) <= 0 &&
      Temporal.Instant.compare(range.end, w.end) <= 0
  );
}
