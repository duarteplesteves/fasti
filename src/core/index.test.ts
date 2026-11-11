import { describe, expect, it } from "vitest";

import { findFreeSlots, isSlotValid, withBlockingFlag } from "./index.js";
import type { AvailabilityRule, Booking, Slot } from "./index.js";

describe("public API surface", () => {
  it("composes withBlockingFlag → findFreeSlots → isSlotValid round-trip via the fasti/core entry", () => {
    const tuesday9to17: AvailabilityRule = {
      recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const rawBookings = [
      {
        end: Temporal.Instant.from("2026-05-12T10:00:00Z"),
        id: "b1",
        resourceId: "doc-1",
        start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
      },
    ];

    const bookings: Booking[] = withBlockingFlag(rawBookings, {
      default: "blocking",
    });

    const slots: Slot[] = findFreeSlots({
      bookings,
      duration: 60,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      resourceId: "doc-1",
      rules: [tuesday9to17],
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    });

    expect(slots).not.toHaveLength(0);

    for (const slot of slots) {
      const valid = isSlotValid({
        bookings,
        resourceId: "doc-1",
        rules: [tuesday9to17],
        slot: { end: slot.end.toInstant(), start: slot.start.toInstant() },
      });

      expect(valid).toBeTruthy();
    }
  });
});
