import { test } from "@fast-check/vitest";
import { array, constantFrom, integer, record } from "fast-check";
import { describe, expect } from "vitest";

import {
  arbAroundClockChange,
  arbAvailabilityRule,
  arbBooking,
  arbBookingIn,
  arbBookingsToExclude,
  arbDateRange,
  arbDuration,
  arbInterval,
  arbResourceId,
  arbRulesForResource,
  arbTimezone,
} from "../test-utils/arbitraries.js";
import { propConfig } from "../test-utils/prop-config.js";
import { unwrap } from "../test-utils/results.js";
import { findFreeSlots } from "./find-free-slots.js";
import { isSlotValid } from "./is-slot-valid.js";
import type { AvailabilityRule, Booking } from "./types.js";

/** Slots for `rule` and `booking` on one grid, all on the rule's resource. */
function slotsIn(
  grid: {
    rule: AvailabilityRule;
    booking: Booking;
    duration: number;
    interval: number;
    timezone: string;
  },
  from: Temporal.Instant,
  to: Temporal.Instant
) {
  const { booking, duration, interval, rule, timezone } = grid;

  return unwrap(
    findFreeSlots({
      bookings: [{ ...booking, resourceId: rule.resourceId }],
      duration,
      from,
      interval,
      resourceId: rule.resourceId,
      rules: [rule],
      timezone,
      to,
    })
  );
}

/** `slotsIn`, relaxing availability. */
function relaxedSlotsIn(
  grid: Parameters<typeof slotsIn>[0],
  from: Temporal.Instant,
  to: Temporal.Instant
) {
  const { booking, duration, interval, rule, timezone } = grid;

  return unwrap(
    findFreeSlots({
      bookings: [{ ...booking, resourceId: rule.resourceId }],
      duration,
      from,
      interval,
      relax: ["availability"],
      resourceId: rule.resourceId,
      rules: [rule],
      timezone,
      to,
    })
  );
}

const arbGrid = arbAvailabilityRule().chain((rule) =>
  arbBooking().chain((booking) =>
    arbDuration().chain((duration) =>
      arbInterval().chain((interval) =>
        arbTimezone().map((timezone) => ({
          booking,
          duration,
          interval,
          rule,
          timezone,
        }))
      )
    )
  )
);

const day = 24 * 60 * 60 * 1000;

/** A grid and a range of at most a day with the booking inside it: relaxed queries return every grid slot, so ranges stay short. */
const arbRelaxed = arbGrid.chain((grid) =>
  arbDateRange().chain(({ from, to }) => {
    const range = {
      from,
      to: Temporal.Instant.fromEpochMilliseconds(
        Math.min(to.epochMilliseconds, from.epochMilliseconds + day)
      ),
    };

    return arbBookingIn(range, grid.rule.resourceId).map((booking) => ({
      grid: { ...grid, booking },
      range,
    }));
  })
);

/** Up to two days from a generated range's start, with up to 5 Bookings starting inside it, on `r1`. */
const arbShortCase = arbDateRange().chain(({ from, to }) => {
  const twoDays = from.add({ hours: 48 });

  const range = {
    from,
    to: Temporal.Instant.compare(to, twoDays) < 0 ? to : twoDays,
  };

  return arbBookingsToExclude(range, "r1").map(({ bookings }) => ({
    bookings,
    range,
  }));
});

const arbNanoseconds = constantFrom(-1_000_000, -500, -1, 0, 1, 500, 1_000_000);

/** A range `first` to `first + steps` Grid steps into a day, each edge nudged by some nanoseconds. */
const arbNearGrid = record({
  endNs: arbNanoseconds,
  first: integer({ max: 20, min: 1 }),
  startNs: arbNanoseconds,
  steps: integer({ max: 3, min: 1 }),
});

/** A day's Grid with Bookings and windows whose edges sit on or just off Grid boundaries, in a search from `date`'s midnight. */
const arbNearGridCase = record({
  bookings: array(arbNearGrid, { maxLength: 3, minLength: 1 }),
  date: constantFrom("1969-12-30", "2024-03-31", "2024-10-27", "2026-05-12"),
  interval: constantFrom(30, 60),
  timezone: arbTimezone(),
  windows: array(arbNearGrid, { maxLength: 3, minLength: 1 }),
}).map(({ bookings, date, interval, timezone, windows }) => {
  const midnight = Temporal.PlainDate.from(date).toZonedDateTime(timezone);

  /** `steps` Grid steps and `ns` nanoseconds after midnight. */
  function instantAt(steps: number, ns: number) {
    return midnight
      .add({ minutes: steps * interval })
      .add({ nanoseconds: ns })
      .toInstant();
  }

  function timeAt(steps: number, ns: number) {
    return new Temporal.PlainTime()
      .add({ minutes: steps * interval })
      .add({ nanoseconds: ns });
  }

  return {
    bookings: bookings.map((b, i) => ({
      end: instantAt(b.first + b.steps, b.endNs),
      id: `b${i}`,
      isBlocking: true,
      resourceId: "r1",
      start: instantAt(b.first, b.startNs),
    })),
    from: midnight.toInstant(),
    interval,
    resourceId: "r1",
    rules: windows.map((w): AvailabilityRule => ({
      recurrence: {
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        frequency: "weekly",
        interval: 1,
      },
      resourceId: "r1",
      timeWindow: {
        end: timeAt(w.first + w.steps, w.endNs),
        start: timeAt(w.first, w.startNs),
      },
      timezone,
    })),
    timezone,
    to: midnight.add({ days: 1 }).toInstant(),
  };
});

/** The Grid by definition (ADR 005, ADR 014), one Temporal conversion per Grid time: the reference for the Grid `findFreeSlots` computes as numbers. */
function referenceGrid({
  from,
  interval,
  timezone,
  to,
}: {
  from: Temporal.Instant;
  interval: number;
  timezone: string;
  to: Temporal.Instant;
}): Temporal.ZonedDateTime[] {
  const starts: Temporal.ZonedDateTime[] = [];
  const lastDate = to.toZonedDateTimeISO(timezone).toPlainDate();

  for (
    let date = from.toZonedDateTimeISO(timezone).toPlainDate();
    Temporal.PlainDate.compare(date, lastDate) <= 0;
    date = date.add({ days: 1 })
  ) {
    for (let minutes = 0; minutes < 24 * 60; minutes += interval) {
      const local = date.toPlainDateTime().add({ minutes });

      const start = local.toZonedDateTime(timezone, {
        disambiguation: "earlier",
      });

      const instant = start.toInstant();

      if (
        start.toPlainDateTime().equals(local) &&
        Temporal.Instant.compare(instant, from) >= 0 &&
        Temporal.Instant.compare(instant, to) < 0
      ) {
        starts.push(start);
      }
    }
  }

  return starts;
}

/** Asserts that a search returns exactly the Grid slots `isSlotValid` accepts. */
function expectAgreesWithIsSlotValid(
  params: Parameters<typeof findFreeSlots>[0]
) {
  const { bookings, resourceId, rules } = params;

  // With no Bookings and availability relaxed, every Grid slot.
  const grid = unwrap(
    findFreeSlots({ ...params, bookings: [], relax: ["availability"] })
  );

  const expected = grid.filter(({ end, start }) =>
    unwrap(
      isSlotValid({
        bookings,
        resourceId,
        rules,
        slot: { end: end.toInstant(), start: start.toInstant() },
      })
    )
  );

  expect(
    unwrap(findFreeSlots(params)).map((s) => s.start.toString())
  ).toStrictEqual(expected.map((s) => s.start.toString()));
}

describe(`${findFreeSlots.name} (property)`, () => {
  test.prop(
    [
      arbShortCase,
      arbRulesForResource("r1"),
      arbDuration(),
      integer({ max: 240, min: 15 }),
      arbTimezone(),
    ],
    propConfig
  )(
    "returns exactly the Grid slots isSlotValid accepts",
    ({ bookings, range }, rules, duration, interval, timezone) => {
      expectAgreesWithIsSlotValid({
        bookings,
        duration,
        from: range.from,
        interval,
        resourceId: "r1",
        rules,
        timezone,
        to: range.to,
      });
    }
  );

  test.prop([arbNearGridCase, integer({ max: 3, min: 1 })], propConfig)(
    "returns exactly the Grid slots isSlotValid accepts, with edges nanoseconds off the Grid",
    (search, steps) => {
      expectAgreesWithIsSlotValid({
        ...search,
        duration: steps * search.interval,
      });
    }
  );

  test.prop(
    [
      arbAvailabilityRule(),
      arbResourceId(),
      arbBooking(),
      arbBooking(),
      arbDuration(),
      arbDateRange(),
    ],
    propConfig
  )(
    "no returned slot overlaps any blocking booking",
    (rule, resourceId, b1, b2, duration, range) => {
      const finalRule = { ...rule, resourceId };
      const finalB1 = { ...b1, resourceId };
      const finalB2 = { ...b2, resourceId };

      const slots = unwrap(
        findFreeSlots({
          bookings: [finalB1, finalB2],
          duration,
          from: range.from,
          interval: duration,
          resourceId,
          rules: [finalRule],
          timezone: "Europe/Lisbon",
          to: range.to,
        })
      );

      for (const slot of slots) {
        const slotStart = slot.start.toInstant();
        const slotEnd = slot.end.toInstant();

        for (const booking of [finalB1, finalB2]) {
          if (!booking.isBlocking) {
            continue;
          }

          const overlaps =
            Temporal.Instant.compare(slotStart, booking.end) < 0 &&
            Temporal.Instant.compare(booking.start, slotEnd) < 0;

          expect(overlaps).toBeFalsy();
        }
      }
    }
  );

  test.prop(
    [
      arbAvailabilityRule(),
      arbResourceId(),
      arbBooking(),
      arbDuration(),
      arbDateRange(),
    ],
    propConfig
  )(
    "adding a non-blocking booking never reduces the number of free slots",
    (rule, resourceId, nonBlocking, duration, range) => {
      const finalRule = { ...rule, resourceId };

      const finalNonBlocking = {
        ...nonBlocking,
        isBlocking: false,
        resourceId,
      };

      const slotsWithout = unwrap(
        findFreeSlots({
          bookings: [],
          duration,
          from: range.from,
          interval: duration,
          resourceId,
          rules: [finalRule],
          timezone: "Europe/Lisbon",
          to: range.to,
        })
      );

      const slotsWith = unwrap(
        findFreeSlots({
          bookings: [finalNonBlocking],
          duration,
          from: range.from,
          interval: duration,
          resourceId,
          rules: [finalRule],
          timezone: "Europe/Lisbon",
          to: range.to,
        })
      );

      expect(slotsWith.length).toBeGreaterThanOrEqual(slotsWithout.length);
    }
  );

  test.prop([arbGrid, arbDateRange()], propConfig)(
    "every slot starts in [from, to)",
    (grid, { from, to }) => {
      for (const slot of slotsIn(grid, from, to)) {
        expect(
          Temporal.Instant.compare(slot.start.toInstant(), from)
        ).toBeGreaterThanOrEqual(0);
        expect(
          Temporal.Instant.compare(slot.start.toInstant(), to)
        ).toBeLessThan(0);
      }
    }
  );

  test.prop([arbGrid, arbDateRange()], propConfig)(
    "every slot starts a whole number of intervals after local midnight",
    (grid, { from, to }) => {
      for (const { start } of slotsIn(grid, from, to)) {
        expect(start.timeZoneId).toBe(grid.timezone);
        expect([
          start.second,
          start.millisecond,
          start.microsecond,
          start.nanosecond,
        ]).toStrictEqual([0, 0, 0, 0]);
        expect((start.hour * 60 + start.minute) % grid.interval).toBe(0);
      }
    }
  );

  test.prop([arbAroundClockChange(), arbInterval()], propConfig)(
    "around a clock change, the Grid is the reference Grid",
    (range, interval) => {
      const slots = unwrap(
        findFreeSlots({
          ...range,
          bookings: [],
          duration: 30,
          interval,
          relax: ["availability"],
          resourceId: "r1",
          rules: [],
        })
      );

      expect(slots.map((s) => s.start.toString())).toStrictEqual(
        referenceGrid({ ...range, interval }).map((start) => start.toString())
      );
    }
  );

  test.prop(
    [
      arbGrid,
      arbDateRange()
        .filter(
          ({ from, to }) => to.epochMilliseconds - from.epochMilliseconds >= 2
        )
        .chain(({ from, to }) =>
          integer({
            max: to.epochMilliseconds - from.epochMilliseconds - 1,
            min: 1,
          }).map((offset) => ({
            from,
            mid: from.add({ milliseconds: offset }),
            to,
          }))
        ),
    ],
    propConfig
  )(
    "[a, c) returns the slots of [a, b) followed by those of [b, c)",
    (grid, { from, mid, to }) => {
      expect(slotsIn(grid, from, to)).toStrictEqual([
        ...slotsIn(grid, from, mid),
        ...slotsIn(grid, mid, to),
      ]);
    }
  );

  test.prop([arbRelaxed], propConfig)(
    "relaxed slots with an empty waived are exactly the unrelaxed slots",
    ({ grid, range: { from, to } }) => {
      expect(
        relaxedSlotsIn(grid, from, to).filter((s) => s.waived.length === 0)
      ).toStrictEqual(slotsIn(grid, from, to));
    }
  );

  test.prop([arbRelaxed], propConfig)(
    "every relaxed slot with a non-empty waived fails isSlotValid",
    ({ grid, range: { from, to } }) => {
      const bookings = [{ ...grid.booking, resourceId: grid.rule.resourceId }];

      for (const slot of relaxedSlotsIn(grid, from, to)) {
        if (slot.waived.length === 0) {
          continue;
        }

        const valid = unwrap(
          isSlotValid({
            bookings,
            resourceId: grid.rule.resourceId,
            rules: [grid.rule],
            slot: { end: slot.end.toInstant(), start: slot.start.toInstant() },
          })
        );

        expect(valid).toBeFalsy();
      }
    }
  );

  test.prop([arbRelaxed], propConfig)(
    "no relaxed slot overlaps a blocking booking",
    ({ grid, range: { from, to } }) => {
      const { booking } = grid;

      for (const slot of relaxedSlotsIn(grid, from, to)) {
        const overlaps =
          booking.isBlocking &&
          Temporal.Instant.compare(slot.start.toInstant(), booking.end) < 0 &&
          Temporal.Instant.compare(booking.start, slot.end.toInstant()) < 0;

        expect(overlaps).toBeFalsy();
      }
    }
  );
});
