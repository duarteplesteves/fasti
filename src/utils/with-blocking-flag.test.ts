import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";

import type { Booking } from "../core/types.js";
import { withBlockingFlag } from "./with-blocking-flag.js";

describe(withBlockingFlag, () => {
  const baseBooking: Omit<Booking, "isBlocking"> = {
    end: Temporal.Instant.from("2026-06-09T10:00:00Z"),
    id: "1",
    resourceId: "doc-1",
    start: Temporal.Instant.from("2026-06-09T09:00:00Z"),
  };

  it("marks blocking statuses as blocking", () => {
    const bookings = withBlockingFlag(
      [{ ...baseBooking, status: "CONFIRMED" }],
      { blocking: ["CONFIRMED"], default: "nonBlocking" }
    );
    expect(bookings[0]?.isBlocking).toBeTruthy();
  });

  it("marks non-blocking statuses as non-blocking", () => {
    const bookings = withBlockingFlag(
      [{ ...baseBooking, status: "CANCELLED" }],
      { default: "blocking", nonBlocking: ["CANCELLED"] }
    );
    expect(bookings[0]?.isBlocking).toBeFalsy();
  });

  it("applies default 'blocking' to unmapped statuses", () => {
    const bookings = withBlockingFlag([{ ...baseBooking, status: "UNKNOWN" }], {
      blocking: ["CONFIRMED"],
      default: "blocking",
      nonBlocking: ["CANCELLED"],
    });
    expect(bookings[0]?.isBlocking).toBeTruthy();
  });

  it("applies default 'nonBlocking' to unmapped statuses", () => {
    const bookings = withBlockingFlag([{ ...baseBooking, status: "UNKNOWN" }], {
      blocking: ["CONFIRMED"],
      default: "nonBlocking",
      nonBlocking: ["CANCELLED"],
    });
    expect(bookings[0]?.isBlocking).toBeFalsy();
  });

  it("applies default to bookings without status", () => {
    const bookings = withBlockingFlag([baseBooking], {
      blocking: ["CONFIRMED"],
      default: "blocking",
    });
    expect(bookings[0]?.isBlocking).toBeTruthy();
  });
});
