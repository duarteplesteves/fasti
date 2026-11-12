import { describe, expect, it } from "vitest";

import { unwrap, issuePaths } from "../test-utils/results.js";
import { isSlotValid } from "./is-slot-valid.js";
import type { AvailabilityRule, Booking } from "./types.js";

function slotAt(startISO: string, endISO: string) {
  return {
    end: Temporal.Instant.from(endISO),
    start: Temporal.Instant.from(startISO),
  };
}

function bookingAt(
  id: string,
  startISO: string,
  endISO: string,
  isBlocking: boolean
): Booking {
  return {
    end: Temporal.Instant.from(endISO),
    id,
    isBlocking,
    resourceId: "doc-1",
    start: Temporal.Instant.from(startISO),
  };
}

describe(isSlotValid, () => {
  const tuesdayMorning: AvailabilityRule = {
    recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
    resourceId: "doc-1",
    timeWindow: {
      end: Temporal.PlainTime.from("17:00"),
      start: Temporal.PlainTime.from("09:00"),
    },
    timezone: "Europe/Lisbon",
  };

  it("returns true for a slot fully inside a rule with no bookings", () => {
    // 2026-05-12 is a Tuesday. 09:30 Lisbon (WEST, UTC+1) = 08:30 UTC.
    expect(
      unwrap(
        isSlotValid({
          bookings: [],
          resourceId: "doc-1",
          rules: [tuesdayMorning],
          slot: slotAt("2026-05-12T08:30:00Z", "2026-05-12T09:00:00Z"),
        })
      )
    ).toBeTruthy();
  });

  it("returns false when the slot is not on a matching weekday", () => {
    // 2026-05-13 is a Wednesday, rule is Tuesday-only.
    expect(
      unwrap(
        isSlotValid({
          bookings: [],
          resourceId: "doc-1",
          rules: [tuesdayMorning],
          slot: slotAt("2026-05-13T08:30:00Z", "2026-05-13T09:00:00Z"),
        })
      )
    ).toBeFalsy();
  });

  it("returns false when slot exceeds the rule's window by one minute", () => {
    // Rule ends 17:00 Lisbon = 16:00 UTC. Slot ends 16:01 UTC, one minute past.
    expect(
      unwrap(
        isSlotValid({
          bookings: [],
          resourceId: "doc-1",
          rules: [tuesdayMorning],
          slot: slotAt("2026-05-12T15:30:00Z", "2026-05-12T16:01:00Z"),
        })
      )
    ).toBeFalsy();
  });

  it("returns false when a blocking booking overlaps the slot", () => {
    expect(
      unwrap(
        isSlotValid({
          bookings: [
            bookingAt(
              "b1",
              "2026-05-12T08:45:00Z",
              "2026-05-12T09:15:00Z",
              true
            ),
          ],
          resourceId: "doc-1",
          rules: [tuesdayMorning],
          slot: slotAt("2026-05-12T08:30:00Z", "2026-05-12T09:00:00Z"),
        })
      )
    ).toBeFalsy();
  });

  it("returns true when only a non-blocking booking overlaps", () => {
    expect(
      unwrap(
        isSlotValid({
          bookings: [
            bookingAt(
              "b1",
              "2026-05-12T08:45:00Z",
              "2026-05-12T09:15:00Z",
              false
            ),
          ],
          resourceId: "doc-1",
          rules: [tuesdayMorning],
          slot: slotAt("2026-05-12T08:30:00Z", "2026-05-12T09:00:00Z"),
        })
      )
    ).toBeTruthy();
  });

  it("returns false when the slot spans two adjacent windows", () => {
    // Morning rule 09:00–12:00 Lisbon = 08:00–11:00 UTC.
    // Afternoon rule 12:00–17:00 Lisbon = 11:00–16:00 UTC.
    // Slot 10:30–11:30 UTC straddles the 11:00 UTC boundary; fits in neither alone.
    const afternoon: AvailabilityRule = {
      ...tuesdayMorning,
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("12:00"),
      },
    };

    const morningOnly: AvailabilityRule = {
      ...tuesdayMorning,
      timeWindow: {
        end: Temporal.PlainTime.from("12:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
    };

    expect(
      unwrap(
        isSlotValid({
          bookings: [],
          resourceId: "doc-1",
          rules: [morningOnly, afternoon],
          slot: slotAt("2026-05-12T10:30:00Z", "2026-05-12T11:30:00Z"),
        })
      )
    ).toBeFalsy();
  });

  it("reports a rule's resourceId does not match params.resourceId", () => {
    const stray: AvailabilityRule = {
      ...tuesdayMorning,
      resourceId: "doc-2",
    };

    expect(
      issuePaths(
        isSlotValid({
          bookings: [],
          resourceId: "doc-1",
          rules: [stray],
          slot: slotAt("2026-05-12T08:30:00Z", "2026-05-12T09:00:00Z"),
        })
      )
    ).toStrictEqual([["rules", 0, "resourceId"]]);
  });

  it("reports a booking's resourceId does not match params.resourceId", () => {
    const stray: Booking = {
      ...bookingAt("b1", "2026-05-12T08:45:00Z", "2026-05-12T09:15:00Z", true),
      resourceId: "doc-2",
    };

    expect(
      issuePaths(
        isSlotValid({
          bookings: [stray],
          resourceId: "doc-1",
          rules: [tuesdayMorning],
          slot: slotAt("2026-05-12T08:30:00Z", "2026-05-12T09:00:00Z"),
        })
      )
    ).toStrictEqual([["bookings", 0, "resourceId"]]);
  });
});

describe(`${isSlotValid.name} issues`, () => {
  const rule: AvailabilityRule = {
    recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
    resourceId: "doc-1",
    timeWindow: {
      end: Temporal.PlainTime.from("17:00"),
      start: Temporal.PlainTime.from("09:00"),
    },
    timezone: "Europe/Lisbon",
  };

  it("reports a slot whose end isn't after its start", () => {
    const result = isSlotValid({
      bookings: [],
      resourceId: "doc-1",
      rules: [rule],
      slot: slotAt("2026-05-12T09:00:00Z", "2026-05-12T08:30:00Z"),
    });

    expect(issuePaths(result)).toStrictEqual([["slot", "end"]]);
  });

  it("reports an unknown timezone instead of throwing", () => {
    const result = isSlotValid({
      bookings: [],
      resourceId: "doc-1",
      rules: [rule, { ...rule, timezone: "Europe/Lisbn" }],
      slot: slotAt("2026-05-12T08:30:00Z", "2026-05-12T09:00:00Z"),
    });

    expect(issuePaths(result)).toStrictEqual([["rules", 1, "timezone"]]);
  });

  it("reports a booking whose end isn't after its start", () => {
    const result = isSlotValid({
      bookings: [
        bookingAt("b", "2026-05-12T10:00:00Z", "2026-05-12T09:00:00Z", true),
      ],
      resourceId: "doc-1",
      rules: [rule],
      slot: slotAt("2026-05-12T08:30:00Z", "2026-05-12T09:00:00Z"),
    });

    expect(issuePaths(result)).toStrictEqual([["bookings", 0, "end"]]);
  });
});
