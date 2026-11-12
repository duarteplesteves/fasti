import { expandRulesUnchecked } from "./expand-rules.js";
import type { AvailabilityRule, InstantRange } from "./types.js";

/** The windows `rules` open around `range`, as instants. */
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

/** Whether `range` fits fully inside one of `windows`. */
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
