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

/**
 * The windows that could hold `slot`, so a slot of any length expands at most a few dates.
 *
 * @returns The open windows around `slot`, or none when `slot` is too long for any window to hold.
 */
export function windowsFor(
  rules: readonly AvailabilityRule[],
  slot: InstantRange
): InstantRange[] {
  return slot.end.epochMilliseconds - slot.start.epochMilliseconds >
    LONGEST_WINDOW_MS
    ? []
    : availableWindows(rules, slot);
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
