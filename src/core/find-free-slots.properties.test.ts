/* eslint-disable vitest/no-standalone-expect */
import { test } from "@fast-check/vitest";
import { integer } from "fast-check";
import { describe, expect } from "vitest";

import {
  arbAvailabilityRule,
  arbBooking,
  arbBookingIn,
  arbDateRange,
  arbDuration,
  arbInterval,
  arbResourceId,
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

describe(`${findFreeSlots.name} (property)`, () => {
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
