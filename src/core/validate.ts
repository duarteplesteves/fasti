import { Temporal } from "@js-temporal/polyfill";

import type { AvailabilityRule } from "./types.js";

export function validateRule(rule: AvailabilityRule): void {
  const isEndAfterStart =
    Temporal.PlainTime.compare(rule.timeWindow.start, rule.timeWindow.end) < 0;

  if (!isEndAfterStart) {
    throw new Error(
      `Invalid rule: timeWindow.start (${rule.timeWindow.start.toString()}) must be before timeWindow.end (${rule.timeWindow.end.toString()}). Cross-day windows are not supported in v0.1; split into two rules.`
    );
  }

  if (
    rule.effectiveFrom &&
    rule.effectiveTo &&
    Temporal.PlainDate.compare(rule.effectiveTo, rule.effectiveFrom) < 0
  ) {
    throw new Error(
      `Invalid rule: effectiveTo (${rule.effectiveTo.toString()}) must be on or after effectiveFrom (${rule.effectiveFrom.toString()}).`
    );
  }

  const { daysOfWeek, interval } = rule.recurrence;

  if (daysOfWeek.length === 0) {
    throw new Error("Invalid rule: daysOfWeek must be non-empty.");
  }

  for (const d of daysOfWeek) {
    if (!Number.isInteger(d) || d < 1 || d > 7) {
      throw new Error(
        `Invalid rule: daysOfWeek values must be integers in 1–7, got ${d}.`
      );
    }
  }

  if (new Set(daysOfWeek).size !== daysOfWeek.length) {
    throw new Error(
      `Invalid rule: daysOfWeek must not contain duplicates, got [${daysOfWeek.join(", ")}].`
    );
  }

  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error(
      `Invalid rule: recurrence.interval must be an integer ≥ 1, got ${interval}.`
    );
  }
}
