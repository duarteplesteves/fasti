import { describe, expect, it } from "vitest";

import { findFreeSlots } from "./find-free-slots.js";
import type { AvailabilityRule, Booking } from "./types.js";

describe(findFreeSlots, () => {
  const tuesday9to17: AvailabilityRule = {
    recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
    resourceId: "doc-1",
    timeWindow: {
      end: Temporal.PlainTime.from("17:00"),
      start: Temporal.PlainTime.from("09:00"),
    },
    timezone: "Europe/Lisbon",
  };

  it("emits a grid of hourly slots inside a single rule with no bookings", () => {
    // 2026-05-12 is a Tuesday. 09:00 Lisbon (WEST, UTC+1) = 08:00 UTC. 17:00 = 16:00 UTC.
    // Hourly duration: slots at 09, 10, 11, 12, 13, 14, 15, 16 Lisbon = 8 slots.
    const slots = findFreeSlots({
      bookings: [],
      duration: 60,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      resourceId: "doc-1",
      rules: [tuesday9to17],
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    });

    expect(slots.map((s) => s.start.toPlainTime().toString())).toStrictEqual([
      "09:00:00",
      "10:00:00",
      "11:00:00",
      "12:00:00",
      "13:00:00",
      "14:00:00",
      "15:00:00",
      "16:00:00",
    ]);
  });

  it("drops the slot when a blocking booking equals it exactly", () => {
    // 10:00 Lisbon = 09:00 UTC. 11:00 Lisbon = 10:00 UTC.
    const blocking: Booking = {
      end: Temporal.Instant.from("2026-05-12T10:00:00Z"),
      id: "b1",
      isBlocking: true,
      resourceId: "doc-1",
      start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
    };

    const slots = findFreeSlots({
      bookings: [blocking],
      duration: 60,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      resourceId: "doc-1",
      rules: [tuesday9to17],
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    });

    expect(slots.map((s) => s.start.toPlainTime().toString())).not.toContain(
      "10:00:00"
    );
    expect(slots).toHaveLength(7);
  });

  it("keeps the slot when only a non-blocking booking overlaps", () => {
    const nonBlocking: Booking = {
      end: Temporal.Instant.from("2026-05-12T10:00:00Z"),
      id: "b1",
      isBlocking: false,
      resourceId: "doc-1",
      start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
    };

    const slots = findFreeSlots({
      bookings: [nonBlocking],
      duration: 60,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      resourceId: "doc-1",
      rules: [tuesday9to17],
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    });

    expect(slots).toHaveLength(8);
    expect(slots.map((s) => s.start.toPlainTime().toString())).toContain(
      "10:00:00"
    );
  });

  it("drops a slot that partially overlaps a blocking booking", () => {
    // Slot at 10:00 Lisbon = 09:00–10:00 UTC. Booking 09:30–09:45 UTC overlaps.
    const blocking: Booking = {
      end: Temporal.Instant.from("2026-05-12T09:45:00Z"),
      id: "b1",
      isBlocking: true,
      resourceId: "doc-1",
      start: Temporal.Instant.from("2026-05-12T09:30:00Z"),
    };

    const slots = findFreeSlots({
      bookings: [blocking],
      duration: 60,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      resourceId: "doc-1",
      rules: [tuesday9to17],
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    });

    expect(slots.map((s) => s.start.toPlainTime().toString())).not.toContain(
      "10:00:00"
    );
    expect(slots).toHaveLength(7);
  });

  it("keeps a slot when a blocking booking only touches its boundary", () => {
    // Slot at 10:00 Lisbon = 09:00–10:00 UTC. Booking ends exactly at 09:00 UTC.
    const before: Booking = {
      end: Temporal.Instant.from("2026-05-12T09:00:00Z"),
      id: "b-before",
      isBlocking: true,
      resourceId: "doc-1",
      start: Temporal.Instant.from("2026-05-12T08:30:00Z"),
    };

    // Booking starts exactly at 10:00 UTC (slot ends there).
    const after: Booking = {
      end: Temporal.Instant.from("2026-05-12T10:30:00Z"),
      id: "b-after",
      isBlocking: true,
      resourceId: "doc-1",
      start: Temporal.Instant.from("2026-05-12T10:00:00Z"),
    };

    const slots = findFreeSlots({
      bookings: [before, after],
      duration: 60,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      resourceId: "doc-1",
      rules: [tuesday9to17],
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    });

    expect(slots.map((s) => s.start.toPlainTime().toString())).toContain(
      "10:00:00"
    );
  });

  it("throws when a rule's resourceId does not match params.resourceId", () => {
    const stray: AvailabilityRule = { ...tuesday9to17, resourceId: "doc-2" };
    expect(() =>
      findFreeSlots({
        bookings: [],
        duration: 60,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        resourceId: "doc-1",
        rules: [stray],
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    ).toThrow(/resourceId/u);
  });

  it("throws when a booking's resourceId does not match params.resourceId", () => {
    const stray: Booking = {
      end: Temporal.Instant.from("2026-05-12T10:00:00Z"),
      id: "b1",
      isBlocking: true,
      resourceId: "doc-2",
      start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
    };

    expect(() =>
      findFreeSlots({
        bookings: [stray],
        duration: 60,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        resourceId: "doc-1",
        rules: [tuesday9to17],
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    ).toThrow(/resourceId/u);
  });

  it("throws when duration is not a positive integer", () => {
    expect(() =>
      findFreeSlots({
        bookings: [],
        duration: 0,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        resourceId: "doc-1",
        rules: [tuesday9to17],
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    ).toThrow(/duration/u);

    expect(() =>
      findFreeSlots({
        bookings: [],
        duration: 1.5,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        resourceId: "doc-1",
        rules: [tuesday9to17],
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    ).toThrow(/duration/u);
  });

  it("emits only the first occurrence across a fall-back DST overlap", () => {
    // 2026-10-25 Europe/Lisbon: clocks go back 02:00 → 01:00. 01:30 happens twice.
    // Rule 01:30–03:30 Lisbon on Sunday. Instant-cursor would emit 01:30 WEST and 01:30 WET;
    // policy says keep only the first (WEST) occurrence.
    const sundayFallback: AvailabilityRule = {
      recurrence: { daysOfWeek: [7], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("03:30"),
        start: Temporal.PlainTime.from("01:30"),
      },
      timezone: "Europe/Lisbon",
    };

    const slots = findFreeSlots({
      bookings: [],
      duration: 60,
      from: Temporal.Instant.from("2026-10-25T00:00:00Z"),
      resourceId: "doc-1",
      rules: [sundayFallback],
      to: Temporal.Instant.from("2026-10-26T00:00:00Z"),
    });

    const wallClockStarts = slots.map((s) => s.start.toPlainTime().toString());

    const firstOccurrenceCount = wallClockStarts.filter(
      (t) => t === "01:30:00"
    ).length;

    expect(firstOccurrenceCount).toBe(1);
  });

  it("drops the wall-clock slot that falls in a spring-forward DST gap", () => {
    // 2026-03-29 Europe/Lisbon: clocks jump from 01:00 → 02:00. The 01:00 slot vanishes.
    const sundayEarly: AvailabilityRule = {
      recurrence: { daysOfWeek: [7], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("04:00"),
        start: Temporal.PlainTime.from("00:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const slots = findFreeSlots({
      bookings: [],
      duration: 60,
      from: Temporal.Instant.from("2026-03-29T00:00:00Z"),
      resourceId: "doc-1",
      rules: [sundayEarly],
      to: Temporal.Instant.from("2026-03-30T00:00:00Z"),
    });

    const wallClockStarts = slots.map((s) => s.start.toPlainTime().toString());
    expect(wallClockStarts).not.toContain("01:00:00");
    expect(wallClockStarts).toStrictEqual(["00:00:00", "02:00:00", "03:00:00"]);
  });

  it("uses options.interval as the candidate cadence when smaller than duration", () => {
    // 8-hour window, 60-min slots, but candidates every 15 min ⇒ 29 candidates.
    // (window 09:00–17:00 = 480 min; latest 60-min start is 16:00; 16*4 + 1 = 29).
    const slots = findFreeSlots({
      bookings: [],
      duration: 60,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      options: { interval: 15 },
      resourceId: "doc-1",
      rules: [tuesday9to17],
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    });

    expect(slots).toHaveLength(29);
    expect(slots[0]?.start.toPlainTime().toString()).toBe("09:00:00");
    expect(slots[1]?.start.toPlainTime().toString()).toBe("09:15:00");
    expect(slots.at(-1)?.start.toPlainTime().toString()).toBe("16:00:00");
  });

  it("respects options.interval when larger than duration (sparse grid)", () => {
    // 30-min slots cadenced every 2 hours: 09:00, 11:00, 13:00, 15:00.
    // (window 09:00–17:00; latest 30-min start that fits is 16:30, but cadence skips it.)
    const slots = findFreeSlots({
      bookings: [],
      duration: 30,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      options: { interval: 120 },
      resourceId: "doc-1",
      rules: [tuesday9to17],
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    });

    expect(slots.map((s) => s.start.toPlainTime().toString())).toStrictEqual([
      "09:00:00",
      "11:00:00",
      "13:00:00",
      "15:00:00",
    ]);
  });

  it("drops a trailing slot whose end overflows the window by default", () => {
    // Window 09:00–17:00. Duration 90 min, interval 60 min.
    // 16:00 + 90 = 17:30 → overflows window end.
    const slots = findFreeSlots({
      bookings: [],
      duration: 90,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      options: { interval: 60 },
      resourceId: "doc-1",
      rules: [tuesday9to17],
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    });

    expect(slots.map((s) => s.start.toPlainTime().toString())).toStrictEqual([
      "09:00:00",
      "10:00:00",
      "11:00:00",
      "12:00:00",
      "13:00:00",
      "14:00:00",
      "15:00:00",
    ]);
  });

  it("keeps the overflowing trailing slot when options.allowEndOverflow is true", () => {
    const slots = findFreeSlots({
      bookings: [],
      duration: 90,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      options: { allowEndOverflow: true, interval: 60 },
      resourceId: "doc-1",
      rules: [tuesday9to17],
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    });

    const starts = slots.map((s) => s.start.toPlainTime().toString());
    expect(starts).toContain("16:00:00");
    expect(starts).toHaveLength(8);
  });

  it("returns no slots when the rule does not fire in the range", () => {
    // Range is a single Wednesday; the rule only fires on Tuesdays.
    const slots = findFreeSlots({
      bookings: [],
      duration: 60,
      from: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      resourceId: "doc-1",
      rules: [tuesday9to17],
      to: Temporal.Instant.from("2026-05-14T00:00:00Z"),
    });

    expect(slots).toStrictEqual([]);
  });

  it("dedupes identical slots produced by two overlapping rules", () => {
    // Two rules with the same window produce the same grid; result must be deduped.
    const duplicate: AvailabilityRule = { ...tuesday9to17 };

    const slots = findFreeSlots({
      bookings: [],
      duration: 60,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      resourceId: "doc-1",
      rules: [tuesday9to17, duplicate],
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    });

    expect(slots).toHaveLength(8);
  });

  it("throws when from is not strictly before to", () => {
    const same = Temporal.Instant.from("2026-05-12T00:00:00Z");
    expect(() =>
      findFreeSlots({
        bookings: [],
        duration: 60,
        from: same,
        resourceId: "doc-1",
        rules: [tuesday9to17],
        to: same,
      })
    ).toThrow(/from/u);
  });
});
