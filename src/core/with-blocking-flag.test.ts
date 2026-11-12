import { describe, expect, it } from "vitest";

import { issuePaths, unwrap } from "../test-utils/results.js";
import type { Booking } from "./types.js";
import { withBlockingFlag } from "./with-blocking-flag.js";

describe(withBlockingFlag, () => {
  const baseBooking: Omit<Booking, "isBlocking"> = {
    end: Temporal.Instant.from("2026-06-09T10:00:00Z"),
    id: "1",
    resourceId: "doc-1",
    start: Temporal.Instant.from("2026-06-09T09:00:00Z"),
  };

  it("marks blocking statuses as blocking", () => {
    const bookings = unwrap(
      withBlockingFlag([{ ...baseBooking, status: "CONFIRMED" }], {
        blocking: ["CONFIRMED"],
        default: "nonBlocking",
      })
    );

    expect(bookings[0]?.isBlocking).toBeTruthy();
  });

  it("marks non-blocking statuses as non-blocking", () => {
    const bookings = unwrap(
      withBlockingFlag([{ ...baseBooking, status: "CANCELLED" }], {
        default: "blocking",
        nonBlocking: ["CANCELLED"],
      })
    );

    expect(bookings[0]?.isBlocking).toBeFalsy();
  });

  it("applies default 'blocking' to unmapped statuses", () => {
    const bookings = unwrap(
      withBlockingFlag([{ ...baseBooking, status: "UNKNOWN" }], {
        blocking: ["CONFIRMED"],
        default: "blocking",
        nonBlocking: ["CANCELLED"],
      })
    );

    expect(bookings[0]?.isBlocking).toBeTruthy();
  });

  it("applies default 'nonBlocking' to unmapped statuses", () => {
    const bookings = unwrap(
      withBlockingFlag([{ ...baseBooking, status: "UNKNOWN" }], {
        blocking: ["CONFIRMED"],
        default: "nonBlocking",
        nonBlocking: ["CANCELLED"],
      })
    );

    expect(bookings[0]?.isBlocking).toBeFalsy();
  });

  it("applies default to bookings without status", () => {
    const bookings = unwrap(
      withBlockingFlag([baseBooking], {
        blocking: ["CONFIRMED"],
        default: "blocking",
      })
    );

    expect(bookings[0]?.isBlocking).toBeTruthy();
  });
});

describe(`${withBlockingFlag.name} issues`, () => {
  it("reports each status listed in both blocking and nonBlocking", () => {
    const result = withBlockingFlag([], {
      blocking: ["CONFIRMED", "PENDING"],
      default: "blocking",
      nonBlocking: ["CANCELLED", "PENDING", "CONFIRMED"],
    });

    expect(issuePaths(result)).toStrictEqual([
      ["mapping", "nonBlocking", 1],
      ["mapping", "nonBlocking", 2],
    ]);
  });

  it("accepts readonly frozen inputs and doesn't mutate them", () => {
    const raw = Object.freeze([
      Object.freeze({
        end: Temporal.Instant.from("2026-06-09T10:00:00Z"),
        id: "1",
        resourceId: "doc-1",
        start: Temporal.Instant.from("2026-06-09T09:00:00Z"),
        status: "CONFIRMED",
      }),
    ]);

    const mapping = {
      blocking: ["CONFIRMED"],
      default: "nonBlocking",
    } as const;

    expect(unwrap(withBlockingFlag(raw, mapping))).toStrictEqual([
      { ...raw[0], isBlocking: true },
    ]);
    expect(raw[0]).not.toHaveProperty("isBlocking");
  });
});
