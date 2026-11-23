import { test } from "@fast-check/vitest";
import { array, nat, tuple } from "fast-check";
import { describe, expect, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import { createScheduler, definePolicy } from "../index.js";
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
import { mintBlockId } from "./plugins/blocks.js";

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

  unwrap(
    await createScheduler({ adapter, policies: [], schema }).availability.set({
      resourceId: room,
      rules: [weekdays],
    })
  );

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
    const adapter = defineAdapter<undefined, "records">((s) => {
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

    const result = await createScheduler({
      policies: [],
      adapter,
      schema,
    }).book({
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
      const scheduler = createScheduler({
        policies: [],
        adapter: await seeded(),
        schema,
      });

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

  it.each([1, 2, 3])(
    "lets exactly 3 of 20 parallel bookings on one day through a max-3-per-day Policy (run %i)",
    async () => {
      const day = {
        from: start.subtract({ hours: 1 }),
        to: start.add({ hours: 8 }),
      };

      const maxThreePerDay = definePolicy(schema, {
        appliesTo: ["book"],
        check: (_candidate, count: number) => (count >= 3 ? { count } : null),
        load: async ({ reads, resourceId }) => {
          const today = await reads.listBookings({
            overlapping: day,
            resourceId,
          });

          return today.length;
        },
        name: "maxThreePerDay",
      });

      const scheduler = createScheduler({
        adapter: await seeded(),
        policies: [maxThreePerDay],
        schema,
      });

      // 20 disjoint 15-minute slots from 10:00 Lisbon, so only the Policy can refuse.
      const results = await Promise.all(
        Array.from(
          { length: 20 },
          async (_, i) =>
            await scheduler.book({
              end: start.add({ minutes: 15 * i + 15 }),
              resourceId: room,
              start: start.add({ minutes: 15 * i }),
            })
        )
      );

      const tags = results.map((r) => (r.ok ? "ok" : r.error._tag));

      expect(tags.filter((t) => t === "ok")).toHaveLength(3);
      expect(tags.filter((t) => t === "PolicyViolation")).toHaveLength(17);
    }
  );

  test.prop(
    [
      array(arbAvailabilityRule(), { maxLength: 3, minLength: 1 }),
      arbDateRange().chain((range) =>
        tuple(
          array(arbBookingIn(range, room), { maxLength: 5 }),
          array(arbBookingIn(range, room), { maxLength: 3 })
        ).map(([bookings, blocks]) => ({ blocks, bookings, range }))
      ),
      arbDuration(),
      arbInterval(),
      arbTimezone(),
      nat(),
    ],
    propConfig
  )(
    "books any slot findSlots returns, around random Bookings and Blocks",
    async (
      rules,
      { blocks, bookings, range },
      duration,
      interval,
      timezone,
      pick
    ) => {
      const adapter = memoryAdapter();

      unwrap(
        await createScheduler({
          adapter,
          policies: [],
          schema,
        }).availability.set({
          resourceId: room,
          rules: rules.map(({ resourceId: _, ...r }) => ({
            ...r,
            exceptions: [],
          })),
        })
      );

      await adapter(schema).withResourceLock(room, async (locked) => {
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

        // Blocks may overlap anything stored outside fasti; they only take time away.
        await Promise.all(
          blocks.map(async (b) => {
            await locked.insertRecord("block", {
              end: b.end,
              id: mintBlockId(),
              resourceId: room,
              start: b.start,
            });
          })
        );
      });

      const scheduler = createScheduler({ policies: [], adapter, schema });

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
