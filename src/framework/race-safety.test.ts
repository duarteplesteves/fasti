/* eslint-disable vitest/no-standalone-expect */
import { test } from "@fast-check/vitest";
import { array, nat } from "fast-check";
import { describe, expect, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import { createScheduler } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import {
  arbAvailabilityRule,
  arbBookingIn,
  arbDateRange,
  arbDuration,
  arbInterval,
  arbTimezone,
} from "../test-utils/arbitraries.js";
import {
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { propConfig } from "../test-utils/prop-config.js";
import { unwrap } from "../test-utils/results.js";
import { mintBookingId } from "./booking-id.js";

const schema = uuidIdSchema;
const [room] = uuidIdResources;

/** Weekdays 09:00–17:00 in Lisbon (UTC+1 in June). */
const weekdays = {
  exceptions: [],
  recurrence: { daysOfWeek: [1, 2, 3, 4, 5], frequency: "weekly", interval: 1 },
  timeWindow: {
    end: Temporal.PlainTime.from("17:00"),
    start: Temporal.PlainTime.from("09:00"),
  },
  timezone: "Europe/Lisbon",
} as const;

/** Monday 3 June 2030, 10:00–11:00 Lisbon. */
const start = Temporal.Instant.from("2030-06-03T09:00:00Z");
const end = Temporal.Instant.from("2030-06-03T10:00:00Z");

/** A memory Adapter with `weekdays` stored for `room`. */
async function seeded() {
  const adapter = memoryAdapter();

  await adapter(schema).withResourceLock(room, async (locked) => {
    await locked.replaceRules({ resourceId: room, rules: [weekdays] });
  });

  return adapter;
}

describe("race safety", () => {
  it("reports a write the lock missed, caught by the backstop, as SlotConflict with the re-read Booking", async () => {
    const inner = await seeded();

    const outside = {
      end,
      id: mintBookingId(),
      resourceId: room,
      start,
      status: "booked",
    } as const;

    await inner(schema).withResourceLock(room, async (locked) => {
      await locked.insertBooking(outside);
    });

    // Plays an outside write landing after the unit's first read: hidden from it, then caught by the backstop.
    const adapter = defineAdapter<undefined>((s) => {
      const raw = inner(s);

      return {
        ...raw,
        withResourceLock: async (id, work) =>
          await raw.withResourceLock(id, async (locked) => {
            let reads = 0;

            return await work({
              ...locked,
              insertBooking: async () =>
                await Promise.resolve({ ok: false, reason: "conflict" }),
              listBookings: async (q) => {
                reads += 1;

                return reads === 1 ? [] : await locked.listBookings(q);
              },
            });
          }),
      };
    });

    const result = await createScheduler({ adapter, schema }).book({
      end,
      resourceId: room,
      start,
    });

    expect(result).toStrictEqual({
      error: {
        _tag: "SlotConflict",
        conflicts: [{ end, id: outside.id, kind: "booking", start }],
      },
      ok: false,
    });
  });

  it.each([1, 2, 3])(
    "lets exactly 1 of 20 parallel bookings of one slot through (run %i)",
    async () => {
      const scheduler = createScheduler({ adapter: await seeded(), schema });

      const results = await Promise.all(
        Array.from(
          { length: 20 },
          async () => await scheduler.book({ end, resourceId: room, start })
        )
      );

      const tags = results.map((r) => (r.ok ? "ok" : r.error._tag));

      expect(tags.filter((t) => t === "ok")).toHaveLength(1);
      expect(tags.filter((t) => t === "SlotConflict")).toHaveLength(19);
    }
  );

  test.prop(
    [
      array(arbAvailabilityRule(), { maxLength: 3, minLength: 1 }),
      arbDateRange().chain((range) =>
        array(arbBookingIn(range, room), { maxLength: 5 }).map((bookings) => ({
          bookings,
          range,
        }))
      ),
      arbDuration(),
      arbInterval(),
      arbTimezone(),
      nat(),
    ],
    propConfig
  )(
    "books any slot findSlots returns",
    async (rules, { bookings, range }, duration, interval, timezone, pick) => {
      const adapter = memoryAdapter();

      await adapter(schema).withResourceLock(room, async (locked) => {
        await locked.replaceRules({
          resourceId: room,
          rules: rules.map(({ resourceId: _, ...r }) => ({
            ...r,
            exceptions: [],
          })),
        });

        // Seed only states the Framework can reach: blocking Bookings never overlap (the Invariant).
        const kept: typeof bookings = [];

        for (const b of bookings) {
          const clash = kept.some(
            (k) =>
              k.isBlocking &&
              b.isBlocking &&
              Temporal.Instant.compare(k.start, b.end) < 0 &&
              Temporal.Instant.compare(b.start, k.end) < 0
          );

          if (!clash) {
            kept.push(b);
          }
        }

        await Promise.all(
          kept.map(async (b) => {
            const inserted = await locked.insertBooking({
              end: b.end,
              id: mintBookingId(),
              resourceId: room,
              start: b.start,
              status: b.isBlocking ? "booked" : "cancelled",
            });

            expect(inserted).toStrictEqual({ ok: true });
          })
        );
      });

      const scheduler = createScheduler({ adapter, schema });

      const slots = unwrap(
        await scheduler.findSlots({
          duration,
          from: range.from,
          interval,
          resourceId: room,
          timezone,
          to: range.to,
        })
      );

      const slot = slots[pick % Math.max(slots.length, 1)];

      if (slot === undefined) {
        return;
      }

      const result = await scheduler.book({
        end: slot.end.toInstant(),
        resourceId: room,
        start: slot.start.toInstant(),
      });

      expect(result).toMatchObject({ ok: true });
    }
  );
});
