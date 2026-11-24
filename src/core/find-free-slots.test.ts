import { describe, expect, it } from "vitest";

import { unwrap, issuePaths } from "../test-utils/results.js";
import { findFreeSlots } from "./find-free-slots.js";
import type { AvailabilityRule, Booking } from "./types.js";

/** A blocking Booking on 2026-05-12, `start` and `end` as UTC "HH:MM". */
function blockingAt(id: string, start: string, end: string): Booking {
  return {
    end: Temporal.Instant.from(`2026-05-12T${end}:00Z`),
    id,
    isBlocking: true,
    resourceId: "doc-1",
    start: Temporal.Instant.from(`2026-05-12T${start}:00Z`),
  };
}

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

  it("drops every slot under a long booking, even after a shorter one nested inside it ends", () => {
    // 09:00–13:00 Lisbon, and 10:00–10:30 inside it: 11:00 and 12:00 stay blocked.

    const slots = unwrap(
      findFreeSlots({
        bookings: [
          blockingAt("long", "08:00", "12:00"),
          blockingAt("short", "09:00", "09:30"),
        ],
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
      "13:00:00",
      "14:00:00",
      "15:00:00",
      "16:00:00",
    ]);
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
      ["to"],
      ["rules", 1, "timezone"],
      ["rules", 1, "resourceId"],
      ["bookings", 0, "end"],
    ]);
  });
});

describe("findFreeSlots with relax", () => {
  const tuesday9to17: AvailabilityRule = {
    recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
    resourceId: "doc-1",
    timeWindow: {
      end: Temporal.PlainTime.from("17:00"),
      start: Temporal.PlainTime.from("09:00"),
    },
    timezone: "Europe/Lisbon",
  };

  const tuesday = {
    duration: 60,
    from: Temporal.Instant.from("2026-05-11T23:00:00Z"),
    interval: 60,
    resourceId: "doc-1",
    timezone: "Europe/Lisbon",
    to: Temporal.Instant.from("2026-05-12T23:00:00Z"),
  };

  const outsideHours = { detail: {}, policy: "availability" };

  it("returns every grid slot of the day, tagging the ones outside availability", () => {
    const slots = unwrap(
      findFreeSlots({
        ...tuesday,
        bookings: [],
        relax: ["availability"],
        rules: [tuesday9to17],
      })
    );

    expect(slots).toHaveLength(24);
    expect(slots.map((s) => [s.start.hour, s.waived.length])).toStrictEqual(
      Array.from({ length: 24 }, (_, hour) => [
        hour,
        hour >= 9 && hour < 17 ? 0 : 1,
      ])
    );
    expect(slots[8]?.waived).toStrictEqual([outsideHours]);
  });

  it("tags every grid slot of a Resource with no rules", () => {
    const slots = unwrap(
      findFreeSlots({
        ...tuesday,
        bookings: [],
        relax: ["availability"],
        rules: [],
      })
    );

    expect(slots).toHaveLength(24);
    expect(slots.every((s) => s.waived.length === 1)).toBeTruthy();
  });

  it("still hides a slot overlapping a blocking booking", () => {
    // 07:00–08:00 and 10:00–11:00 Lisbon: one outside hours, one inside.
    const bookings: Booking[] = [
      {
        end: Temporal.Instant.from("2026-05-12T07:00:00Z"),
        id: "b1",
        isBlocking: true,
        resourceId: "doc-1",
        start: Temporal.Instant.from("2026-05-12T06:00:00Z"),
      },
      {
        end: Temporal.Instant.from("2026-05-12T10:00:00Z"),
        id: "b2",
        isBlocking: true,
        resourceId: "doc-1",
        start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
      },
    ];

    const slots = unwrap(
      findFreeSlots({
        ...tuesday,
        bookings,
        relax: ["availability"],
        rules: [tuesday9to17],
      })
    );

    expect(slots.map((s) => s.start.hour)).not.toContain(7);
    expect(slots.map((s) => s.start.hour)).not.toContain(10);
    expect(slots).toHaveLength(22);
  });

  it("returns untagged slots inside availability only, when nothing is relaxed", () => {
    const slots = unwrap(
      findFreeSlots({ ...tuesday, bookings: [], rules: [tuesday9to17] })
    );

    expect(slots.map((s) => s.start.hour)).toStrictEqual([
      9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(slots.every((s) => s.waived.length === 0)).toBeTruthy();
  });
});

describe("findFreeSlots with times finer than a millisecond", () => {
  // Both dates are Tuesdays; epoch milliseconds are negative before 1970.
  describe.each(["2026-05-12", "1969-12-30"])("on %s", (date) => {
    function startsWith({
      booking,
      window = ["09:00", "11:30"],
    }: {
      booking?: readonly [string, string];
      window?: readonly [string, string];
    }) {
      const bookings = booking
        ? [
            {
              end: Temporal.Instant.from(`${date}T${booking[1]}Z`),
              id: "b1",
              isBlocking: true,
              resourceId: "doc-1",
              start: Temporal.Instant.from(`${date}T${booking[0]}Z`),
            },
          ]
        : [];

      return unwrap(
        findFreeSlots({
          bookings,
          duration: 30,
          from: Temporal.Instant.from(`${date}T00:00:00Z`),
          interval: 30,
          resourceId: "doc-1",
          rules: [
            {
              recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
              resourceId: "doc-1",
              timeWindow: {
                end: Temporal.PlainTime.from(window[1]),
                start: Temporal.PlainTime.from(window[0]),
              },
              timezone: "UTC",
            },
          ],
          timezone: "UTC",
          to: Temporal.Instant.from(`${date}T23:00:00Z`),
        })
      ).map((s) => s.start.toPlainTime().toString({ smallestUnit: "minute" }));
    }

    it("refuses the slot a Booking ends just inside", () => {
      expect(
        startsWith({ booking: ["09:00:00", "10:00:00.0000005"] })
      ).toStrictEqual(["10:30", "11:00"]);
    });

    it("refuses the slot a Booking starts just inside", () => {
      expect(
        startsWith({ booking: ["09:59:59.9999995", "10:30:00"] })
      ).toStrictEqual(["09:00", "10:30", "11:00"]);
    });

    it("keeps the slots a Booking stops just short of", () => {
      expect(
        startsWith({ booking: ["10:00:00.0000005", "10:29:59.9999995"] })
      ).toStrictEqual(["09:00", "09:30", "10:30", "11:00"]);
    });

    it("refuses the slot starting just before the window", () => {
      expect(
        startsWith({ window: ["09:00:00.0000005", "11:30"] })
      ).toStrictEqual(["09:30", "10:00", "10:30", "11:00"]);
    });

    it("refuses the slot ending just after the window", () => {
      expect(
        startsWith({ window: ["09:00", "11:29:59.9999995"] })
      ).toStrictEqual(["09:00", "09:30", "10:00", "10:30"]);
    });

    it("refuses a slot holding a Booking shorter than a millisecond", () => {
      expect(
        startsWith({ booking: ["10:00:00.0000002", "10:00:00.0000005"] })
      ).toStrictEqual(["09:00", "09:30", "10:30", "11:00"]);
    });
  });

  it.each(["start", "end"])(
    "throws on a Booking whose %s is an ISO string, rather than free its time",
    (key) => {
      const booking = {
        ...blockingAt("b1", "10:00", "11:00"),
        [key]: key === "start" ? "2026-05-12T10:00Z" : "2026-05-12T11:00Z",
      };

      expect(() =>
        findFreeSlots({
          bookings: [booking],
          duration: 30,
          from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
          interval: 30,
          resourceId: "doc-1",
          rules: [],
          timezone: "UTC",
          to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
        })
      ).toThrow(TypeError);
    }
  );
});
