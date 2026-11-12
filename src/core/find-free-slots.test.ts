import { describe, expect, it } from "vitest";

import { unwrap, issuePaths } from "../test-utils/results.js";
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
    const slots = unwrap(
      findFreeSlots({
        bookings: [],
        duration: 60,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        interval: 60,
        resourceId: "doc-1",
        rules: [tuesday9to17],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    );

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

    const slots = unwrap(
      findFreeSlots({
        bookings: [blocking],
        duration: 60,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        interval: 60,
        resourceId: "doc-1",
        rules: [tuesday9to17],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    );

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

    const slots = unwrap(
      findFreeSlots({
        bookings: [nonBlocking],
        duration: 60,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        interval: 60,
        resourceId: "doc-1",
        rules: [tuesday9to17],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    );

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

    const slots = unwrap(
      findFreeSlots({
        bookings: [blocking],
        duration: 60,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        interval: 60,
        resourceId: "doc-1",
        rules: [tuesday9to17],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    );

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

    const slots = unwrap(
      findFreeSlots({
        bookings: [before, after],
        duration: 60,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        interval: 60,
        resourceId: "doc-1",
        rules: [tuesday9to17],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    );

    expect(slots.map((s) => s.start.toPlainTime().toString())).toContain(
      "10:00:00"
    );
  });

  describe("clipping to [from, to)", () => {
    const monday9to12Utc: AvailabilityRule = {
      recurrence: { daysOfWeek: [1], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("12:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "UTC",
    };

    it("returns no slots when none start inside the range (#19)", () => {
      expect(
        unwrap(
          findFreeSlots({
            bookings: [],
            duration: 60,
            from: Temporal.Instant.from("2026-11-16T10:30:00Z"),
            interval: 60,
            resourceId: "doc-1",
            rules: [monday9to12Utc],
            timezone: "UTC",
            to: Temporal.Instant.from("2026-11-16T10:45:00Z"),
          })
        )
      ).toStrictEqual([]);
    });

    it("returns no slots on to's date when to is its midnight", () => {
      // 2026-05-11 is a Monday; the rule fires Monday and Tuesday 09–17 Lisbon.
      const slots = unwrap(
        findFreeSlots({
          bookings: [],
          duration: 60,
          from: Temporal.Instant.from(
            "2026-05-11T00:00:00+01:00[Europe/Lisbon]"
          ),
          interval: 60,
          resourceId: "doc-1",
          rules: [
            {
              ...tuesday9to17,
              recurrence: {
                daysOfWeek: [1, 2],
                frequency: "weekly",
                interval: 1,
              },
            },
          ],
          timezone: "Europe/Lisbon",
          to: Temporal.Instant.from("2026-05-12T00:00:00+01:00[Europe/Lisbon]"),
        })
      );

      expect(slots.map((s) => s.start.toPlainDate().toString())).toStrictEqual(
        Array.from({ length: 8 }, () => "2026-05-11")
      );
    });
  });

  describe("grid from local midnight", () => {
    it("finds slots for a rule in another timezone, zoned in the query's", () => {
      // Tokyo 09:00–10:00 = 00:00–01:00 UTC = 01:00–02:00 Lisbon (WEST).
      const slots = unwrap(
        findFreeSlots({
          bookings: [],
          duration: 30,
          from: Temporal.Instant.from(
            "2026-05-12T00:00:00+01:00[Europe/Lisbon]"
          ),
          interval: 30,
          resourceId: "doc-1",
          rules: [
            {
              ...tuesday9to17,
              timeWindow: {
                end: Temporal.PlainTime.from("10:00"),
                start: Temporal.PlainTime.from("09:00"),
              },
              timezone: "Asia/Tokyo",
            },
          ],
          timezone: "Europe/Lisbon",
          to: Temporal.Instant.from("2026-05-13T00:00:00+01:00[Europe/Lisbon]"),
        })
      );

      expect(slots.map((s) => s.start.toString())).toStrictEqual([
        "2026-05-12T01:00:00+01:00[Europe/Lisbon]",
        "2026-05-12T01:30:00+01:00[Europe/Lisbon]",
      ]);
    });

    it("overlaps 30-minute slots on a 15-minute grid", () => {
      const slots = unwrap(
        findFreeSlots({
          bookings: [],
          duration: 30,
          from: Temporal.Instant.from(
            "2026-05-12T00:00:00+01:00[Europe/Lisbon]"
          ),
          interval: 15,
          resourceId: "doc-1",
          rules: [
            {
              ...tuesday9to17,
              timeWindow: {
                end: Temporal.PlainTime.from("10:00"),
                start: Temporal.PlainTime.from("09:00"),
              },
            },
          ],
          timezone: "Europe/Lisbon",
          to: Temporal.Instant.from("2026-05-13T00:00:00+01:00[Europe/Lisbon]"),
        })
      );

      expect(
        slots.map((s) => [
          s.start.toPlainTime().toString(),
          s.end.toPlainTime().toString(),
        ])
      ).toStrictEqual([
        ["09:00:00", "09:30:00"],
        ["09:15:00", "09:45:00"],
        ["09:30:00", "10:00:00"],
      ]);
    });

    it("starts a 09:10 rule's slots at 09:15 on a 15-minute grid", () => {
      const slots = unwrap(
        findFreeSlots({
          bookings: [],
          duration: 30,
          from: Temporal.Instant.from(
            "2026-05-12T00:00:00+01:00[Europe/Lisbon]"
          ),
          interval: 15,
          resourceId: "doc-1",
          rules: [
            {
              ...tuesday9to17,
              timeWindow: {
                end: Temporal.PlainTime.from("10:00"),
                start: Temporal.PlainTime.from("09:10"),
              },
            },
          ],
          timezone: "Europe/Lisbon",
          to: Temporal.Instant.from("2026-05-13T00:00:00+01:00[Europe/Lisbon]"),
        })
      );

      expect(slots.map((s) => s.start.toPlainTime().toString())).toStrictEqual([
        "09:15:00",
        "09:30:00",
      ]);
    });
  });

  it("reports a rule's resourceId does not match params.resourceId", () => {
    const stray: AvailabilityRule = { ...tuesday9to17, resourceId: "doc-2" };
    expect(
      issuePaths(
        findFreeSlots({
          bookings: [],
          duration: 60,
          from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
          interval: 60,
          resourceId: "doc-1",
          rules: [stray],
          timezone: "Europe/Lisbon",
          to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
        })
      )
    ).toStrictEqual([["rules", 0, "resourceId"]]);
  });

  it("reports a booking's resourceId does not match params.resourceId", () => {
    const stray: Booking = {
      end: Temporal.Instant.from("2026-05-12T10:00:00Z"),
      id: "b1",
      isBlocking: true,
      resourceId: "doc-2",
      start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
    };

    expect(
      issuePaths(
        findFreeSlots({
          bookings: [stray],
          duration: 60,
          from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
          interval: 60,
          resourceId: "doc-1",
          rules: [tuesday9to17],
          timezone: "Europe/Lisbon",
          to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
        })
      )
    ).toStrictEqual([["bookings", 0, "resourceId"]]);
  });

  it("reports duration is not a positive integer", () => {
    expect(
      issuePaths(
        findFreeSlots({
          bookings: [],
          duration: 0,
          from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
          interval: 60,
          resourceId: "doc-1",
          rules: [tuesday9to17],
          timezone: "Europe/Lisbon",
          to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
        })
      )
    ).toStrictEqual([["duration"]]);

    expect(
      issuePaths(
        findFreeSlots({
          bookings: [],
          duration: 1.5,
          from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
          interval: 60,
          resourceId: "doc-1",
          rules: [tuesday9to17],
          timezone: "Europe/Lisbon",
          to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
        })
      )
    ).toStrictEqual([["duration"]]);
  });

  it("uses only the first occurrence of the repeated fall-back hour", () => {
    // 2026-10-25 Europe/Lisbon: clocks go back 02:00 → 01:00, so 01:00 and 01:30 happen twice.
    // Window 01:00 WEST–03:00 WET is three real hours; the grid visits 01:00 and 01:30 once.
    const sundayFallback: AvailabilityRule = {
      recurrence: { daysOfWeek: [7], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("03:00"),
        start: Temporal.PlainTime.from("01:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const slots = unwrap(
      findFreeSlots({
        bookings: [],
        duration: 60,
        from: Temporal.Instant.from("2026-10-25T00:00:00+01:00[Europe/Lisbon]"),
        interval: 30,
        resourceId: "doc-1",
        rules: [sundayFallback],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-10-26T00:00:00Z"),
      })
    );

    expect(slots.map((s) => s.start.toString())).toStrictEqual([
      "2026-10-25T01:00:00+01:00[Europe/Lisbon]",
      "2026-10-25T01:30:00+01:00[Europe/Lisbon]",
      "2026-10-25T02:00:00+00:00[Europe/Lisbon]",
    ]);
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

    const slots = unwrap(
      findFreeSlots({
        bookings: [],
        duration: 60,
        from: Temporal.Instant.from("2026-03-29T00:00:00Z"),
        interval: 60,
        resourceId: "doc-1",
        rules: [sundayEarly],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-03-30T00:00:00Z"),
      })
    );

    const wallClockStarts = slots.map((s) => s.start.toPlainTime().toString());
    expect(wallClockStarts).not.toContain("01:00:00");
    expect(wallClockStarts).toStrictEqual(["00:00:00", "02:00:00", "03:00:00"]);
  });

  it("uses interval as the candidate cadence when smaller than duration", () => {
    // 8-hour window, 60-min slots, but candidates every 15 min ⇒ 29 candidates.
    // (window 09:00–17:00 = 480 min; latest 60-min start is 16:00; 16*4 + 1 = 29).
    const slots = unwrap(
      findFreeSlots({
        bookings: [],
        duration: 60,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        interval: 15,
        resourceId: "doc-1",
        rules: [tuesday9to17],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    );

    expect(slots).toHaveLength(29);
    expect(slots[0]?.start.toPlainTime().toString()).toBe("09:00:00");
    expect(slots[1]?.start.toPlainTime().toString()).toBe("09:15:00");
    expect(slots.at(-1)?.start.toPlainTime().toString()).toBe("16:00:00");
  });

  it("respects interval when larger than duration (sparse grid)", () => {
    // 30-min slots on a 2-hour grid from midnight: 10, 12, 14, 16 fit in 09:00–17:00.
    const slots = unwrap(
      findFreeSlots({
        bookings: [],
        duration: 30,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        interval: 120,
        resourceId: "doc-1",
        rules: [tuesday9to17],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    );

    expect(slots.map((s) => s.start.toPlainTime().toString())).toStrictEqual([
      "10:00:00",
      "12:00:00",
      "14:00:00",
      "16:00:00",
    ]);
  });

  it("drops a trailing slot whose end overflows the window by default", () => {
    // Window 09:00–17:00. Duration 90 min, interval 60 min.
    // 16:00 + 90 = 17:30 → overflows window end.
    const slots = unwrap(
      findFreeSlots({
        bookings: [],
        duration: 90,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        interval: 60,
        resourceId: "doc-1",
        rules: [tuesday9to17],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    );

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

  it("returns no slots when the rule does not fire in the range", () => {
    // Range is a single Wednesday; the rule only fires on Tuesdays.
    const slots = unwrap(
      findFreeSlots({
        bookings: [],
        duration: 60,
        from: Temporal.Instant.from("2026-05-13T00:00:00Z"),
        interval: 60,
        resourceId: "doc-1",
        rules: [tuesday9to17],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-05-14T00:00:00Z"),
      })
    );

    expect(slots).toStrictEqual([]);
  });

  it("dedupes identical slots produced by two overlapping rules", () => {
    // Two rules with the same window produce the same grid; result must be deduped.
    const duplicate: AvailabilityRule = { ...tuesday9to17 };

    const slots = unwrap(
      findFreeSlots({
        bookings: [],
        duration: 60,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        interval: 60,
        resourceId: "doc-1",
        rules: [tuesday9to17, duplicate],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    );

    expect(slots).toHaveLength(8);
  });

  it("reports from is not strictly before to", () => {
    const same = Temporal.Instant.from("2026-05-12T00:00:00Z");
    expect(
      issuePaths(
        findFreeSlots({
          bookings: [],
          duration: 60,
          from: same,
          interval: 60,
          resourceId: "doc-1",
          rules: [tuesday9to17],
          timezone: "Europe/Lisbon",
          to: same,
        })
      )
    ).toStrictEqual([["to"]]);
  });

  describe("excludeBookingId", () => {
    // 10:00–11:00 Lisbon = 09:00–10:00 UTC.
    const booked: Booking = {
      end: Temporal.Instant.from("2026-05-12T10:00:00Z"),
      id: "b1",
      isBlocking: true,
      resourceId: "doc-1",
      start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
    };

    const params = {
      bookings: [booked],
      duration: 60,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      interval: 60,
      resourceId: "doc-1",
      rules: [tuesday9to17],
      timezone: "Europe/Lisbon",
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    };

    it("shows the excluded booking's own time as a free slot", () => {
      const included = unwrap(findFreeSlots(params));

      const excluded = unwrap(
        findFreeSlots({ ...params, excludeBookingId: "b1" })
      );

      expect(
        included.map((s) => s.start.toPlainTime().toString())
      ).not.toContain("10:00:00");
      expect(excluded.map((s) => s.start.toPlainTime().toString())).toContain(
        "10:00:00"
      );
    });

    it("accepts an id that matches no booking", () => {
      expect(
        unwrap(findFreeSlots({ ...params, excludeBookingId: "nope" }))
      ).toHaveLength(7);
    });
  });
});

describe(`${findFreeSlots.name} issues`, () => {
  const rule: AvailabilityRule = {
    recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
    resourceId: "doc-1",
    timeWindow: {
      end: Temporal.PlainTime.from("17:00"),
      start: Temporal.PlainTime.from("09:00"),
    },
    timezone: "Europe/Lisbon",
  };

  const base = {
    bookings: [],
    duration: 60,
    from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
    interval: 60,
    resourceId: "doc-1",
    rules: [rule],
    timezone: "Europe/Lisbon",
    to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
  };

  it.each(["Europe/Lisbn", "+01:00"])("reports timezone %s", (timezone) => {
    expect(issuePaths(findFreeSlots({ ...base, timezone }))).toStrictEqual([
      ["timezone"],
    ]);
  });

  it.each([0, -30, 1.5])("reports interval %s", (interval) => {
    expect(issuePaths(findFreeSlots({ ...base, interval }))).toStrictEqual([
      ["interval"],
    ]);
  });

  it("reports params, rule and booking issues together, with rule paths under rules", () => {
    const result = findFreeSlots({
      ...base,
      bookings: [
        {
          end: Temporal.Instant.from("2026-05-12T09:00:00Z"),
          id: "b1",
          isBlocking: true,
          resourceId: "doc-1",
          start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
        },
      ],
      duration: 0,
      from: base.to,
      interval: -1,
      rules: [rule, { ...rule, resourceId: "doc-2", timezone: "+01:00" }],
      to: base.from,
    });

    expect(issuePaths(result)).toStrictEqual([
      ["duration"],
      ["interval"],
      ["rules", 1, "timezone"],
      ["rules", 1, "resourceId"],
      ["bookings", 0, "end"],
      ["to"],
    ]);
  });
});
