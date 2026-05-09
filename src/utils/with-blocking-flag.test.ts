import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";

import type { Booking } from "../core/types.js";
import { withBlockingFlag } from "./with-blocking-flag.js";

describe(withBlockingFlag, () => {
  const baseBooking: Booking = {
    end: Temporal.Instant.from("2026-06-09T10:00:00Z"),
    id: "1",
    resourceId: "doc-1",
    start: Temporal.Instant.from("2026-06-09T09:00:00Z"),
  };

  it("marks blocking statuses as blocking", () => {
    const bookings = withBlockingFlag(
      [{ ...baseBooking, status: "CONFIRMED" }],
      { blocking: ["CONFIRMED"] }
    );
    expect(bookings[0].isBlocking).toBeTruthy();
  });

  it("marks non-blocking statuses as non-blocking", () => {
    const bookings = withBlockingFlag(
      [{ ...baseBooking, status: "CANCELLED" }],
      { nonBlocking: ["CANCELLED"] }
    );
    expect(bookings[0].isBlocking).toBeFalsy();
  });

  it("leaves bookings untouched when status is unmapped", () => {
    const bookings = withBlockingFlag([{ ...baseBooking, status: "UNKNOWN" }], {
      blocking: ["CONFIRMED"],
      nonBlocking: ["CANCELLED"],
    });
    expect(bookings[0].isBlocking).toBeUndefined();
  });

  it("leaves bookings without status untouched", () => {
    const bookings = withBlockingFlag([baseBooking], {
      blocking: ["CONFIRMED"],
    });
    expect(bookings[0].isBlocking).toBeUndefined();
  });
});
