import { describe, expect, it } from "vitest";

import { detectConflicts } from "./detect-conflicts.js";
import type { Booking } from "./types.js";

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

describe(detectConflicts, () => {
  const candidate = {
    end: Temporal.Instant.from("2026-05-12T10:00:00Z"),
    start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
  };

  it("returns a blocking booking that fully contains the candidate", () => {
    const booking: Booking = {
      end: Temporal.Instant.from("2026-05-12T10:00:00Z"),
      id: "b1",
      isBlocking: true,
      resourceId: "doc-1",
      start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
    };

    const result = detectConflicts({
      bookings: [booking],
      candidate: {
        end: Temporal.Instant.from("2026-05-12T09:45:00Z"),
        start: Temporal.Instant.from("2026-05-12T09:30:00Z"),
      },
      resourceId: "doc-1",
    });

    expect(result).toStrictEqual([booking]);
  });

  it("returns an empty array when bookings is empty", () => {
    expect(
      detectConflicts({ bookings: [], candidate, resourceId: "doc-1" })
    ).toStrictEqual([]);
  });

  it("filters out non-blocking bookings even when they overlap", () => {
    const nonBlocking = bookingAt(
      "b1",
      "2026-05-12T09:00:00Z",
      "2026-05-12T10:00:00Z",
      false
    );

    expect(
      detectConflicts({
        bookings: [nonBlocking],
        candidate,
        resourceId: "doc-1",
      })
    ).toStrictEqual([]);
  });

  it("does not flag bookings that touch only at the boundary (half-open)", () => {
    const touchAtStart = bookingAt(
      "b1",
      "2026-05-12T08:00:00Z",
      "2026-05-12T09:00:00Z",
      true
    );

    const touchAtEnd = bookingAt(
      "b2",
      "2026-05-12T10:00:00Z",
      "2026-05-12T11:00:00Z",
      true
    );

    expect(
      detectConflicts({
        bookings: [touchAtStart, touchAtEnd],
        candidate,
        resourceId: "doc-1",
      })
    ).toStrictEqual([]);
  });

  it("returns multiple blocking bookings sorted ascending by start", () => {
    const later = bookingAt(
      "later",
      "2026-05-12T09:30:00Z",
      "2026-05-12T10:30:00Z",
      true
    );

    const earlier = bookingAt(
      "earlier",
      "2026-05-12T08:30:00Z",
      "2026-05-12T09:30:00Z",
      true
    );

    const result = detectConflicts({
      bookings: [later, earlier],
      candidate,
      resourceId: "doc-1",
    });

    expect(result.map((b) => b.id)).toStrictEqual(["earlier", "later"]);
  });

  it("excludes bookings entirely outside the candidate range", () => {
    const before = bookingAt(
      "b1",
      "2026-05-12T07:00:00Z",
      "2026-05-12T08:00:00Z",
      true
    );

    const after = bookingAt(
      "b2",
      "2026-05-12T11:00:00Z",
      "2026-05-12T12:00:00Z",
      true
    );

    expect(
      detectConflicts({
        bookings: [before, after],
        candidate,
        resourceId: "doc-1",
      })
    ).toStrictEqual([]);
  });

  it("flags partial overlaps at start, middle, and end", () => {
    const overlapStart = bookingAt(
      "start",
      "2026-05-12T08:30:00Z",
      "2026-05-12T09:30:00Z",
      true
    );

    const overlapMiddle = bookingAt(
      "middle",
      "2026-05-12T09:15:00Z",
      "2026-05-12T09:45:00Z",
      true
    );

    const overlapEnd = bookingAt(
      "end",
      "2026-05-12T09:30:00Z",
      "2026-05-12T10:30:00Z",
      true
    );

    const result = detectConflicts({
      bookings: [overlapEnd, overlapMiddle, overlapStart],
      candidate,
      resourceId: "doc-1",
    });

    expect(result.map((b) => b.id)).toStrictEqual(["start", "middle", "end"]);
  });

  it("throws when a booking's resourceId does not match params.resourceId", () => {
    const stray = bookingAt(
      "b1",
      "2026-05-12T09:00:00Z",
      "2026-05-12T10:00:00Z",
      true
    );

    const wrongResource: Booking = { ...stray, resourceId: "doc-2" };
    expect(() =>
      detectConflicts({
        bookings: [wrongResource],
        candidate,
        resourceId: "doc-1",
      })
    ).toThrow(/resourceId/u);
  });
});
