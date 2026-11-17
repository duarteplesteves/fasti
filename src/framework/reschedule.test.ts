/* eslint-disable vitest/no-standalone-expect */
import { test } from "@fast-check/vitest";
import { array, nat } from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import type { Adapter } from "../adapter/contract.js";
import type { BookingId } from "../core/types.js";
import { createScheduler } from "../index.js";
import type {
  AdapterError,
  BookingNotFound,
  InvalidParams,
  PolicyViolation,
  RescheduleError,
  SlotConflict,
  StatusMismatch,
} from "../index.js";
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
const [room, otherRoom] = uuidIdResources;

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

/** `hour`:`minute` Lisbon on Monday 3 June 2030, as an Instant. */
function at(hour: number, minute = 0): Temporal.Instant {
  return Temporal.Instant.from("2030-06-03T00:00:00+01:00").add({
    hours: hour,
    minutes: minute,
  });
}

/** A scheduler over `adapter` with weekday availability on `room`, and a 14:00–15:00 Booking there. */
async function seeded(adapter: Adapter<undefined, "blocks"> = memoryAdapter()) {
  const scheduler = createScheduler({ adapter, schema });

  unwrap(
    await scheduler.availability.set({ resourceId: room, rules: [weekdays] })
  );

  const booking = unwrap(
    await scheduler.book({ end: at(15), resourceId: room, start: at(14) })
  );

  return { booking, reads: adapter(schema), scheduler };
}

/** Every verb of an Adapter that must never be called. */
async function refuse(): Promise<never> {
  return await Promise.reject(new Error("no Adapter call expected"));
}

/** Wrap `inner`, recording the Resource of every `withResourceLock`. */
function spyingLocks(inner: Adapter<undefined, "blocks">) {
  const locks: string[] = [];

  const adapter = defineAdapter<undefined, "blocks">((s) => {
    const raw = inner(s);

    return {
      ...raw,
      withResourceLock: async (id, work) => {
        locks.push(String(id));

        return await raw.withResourceLock(id, work);
      },
    };
  });

  return { adapter, locks };
}

describe("reschedule", () => {
  it("moves a Booking on its Resource, keeping its id and Status", async () => {
    const { booking, reads, scheduler } = await seeded();
    const moved = { ...booking, end: at(11), start: at(10) };

    await expect(
      scheduler.reschedule({ end: at(11), id: booking.id, start: at(10) })
    ).resolves.toStrictEqual({ ok: true, value: moved });
    await expect(reads.getBooking(booking.id)).resolves.toStrictEqual(moved);
  });

  it("moves 14:00–15:00 to 14:30–15:30: no conflict with itself", async () => {
    const { booking, scheduler } = await seeded();

    await expect(
      scheduler.reschedule({
        end: at(15, 30),
        id: booking.id,
        start: at(14, 30),
      })
    ).resolves.toStrictEqual({
      ok: true,
      value: { ...booking, end: at(15, 30), start: at(14, 30) },
    });
  });

  it("gives SlotConflict over another Booking, and leaves the Booking where it was", async () => {
    const { booking, reads, scheduler } = await seeded();

    const other = unwrap(
      await scheduler.book({ end: at(11), resourceId: room, start: at(10) })
    );

    await expect(
      scheduler.reschedule({ end: at(11), id: booking.id, start: at(10) })
    ).resolves.toStrictEqual({
      error: {
        _tag: "SlotConflict",
        conflicts: [
          { end: at(11), id: other.id, kind: "booking", start: at(10) },
        ],
      },
      ok: false,
    });
    await expect(reads.getBooking(booking.id)).resolves.toStrictEqual(booking);
  });

  it("gives SlotConflict with kind block over a Block", async () => {
    const { booking, scheduler } = await seeded();

    const block = unwrap(
      await scheduler.blocks.create({
        end: at(11),
        resourceId: room,
        start: at(10),
      })
    );

    await expect(
      scheduler.reschedule({ end: at(11), id: booking.id, start: at(10) })
    ).resolves.toStrictEqual({
      error: {
        _tag: "SlotConflict",
        conflicts: [
          { end: at(11), id: block.id, kind: "block", start: at(10) },
        ],
      },
      ok: false,
    });
  });

  it("gives PolicyViolation outside availability, and SlotConflict alone when both", async () => {
    const { booking, scheduler } = await seeded();

    await expect(
      scheduler.reschedule({ end: at(19), id: booking.id, start: at(18) })
    ).resolves.toStrictEqual({
      error: {
        _tag: "PolicyViolation",
        violations: [{ detail: {}, policy: "availability" }],
      },
      ok: false,
    });

    const other = unwrap(
      await scheduler.book({ end: at(17), resourceId: room, start: at(16) })
    );

    await expect(
      scheduler.reschedule({ end: at(17, 30), id: booking.id, start: at(16) })
    ).resolves.toStrictEqual({
      error: {
        _tag: "SlotConflict",
        conflicts: [
          { end: at(17), id: other.id, kind: "booking", start: at(16) },
        ],
      },
      ok: false,
    });
  });

  it("moves to another Resource under one lock, on the destination, where its Bookings and rules apply", async () => {
    const { adapter, locks } = spyingLocks(memoryAdapter());
    const { booking, reads, scheduler } = await seeded(adapter);

    // The destination has no rules yet.
    await expect(
      scheduler.reschedule({
        end: at(15),
        id: booking.id,
        resourceId: otherRoom,
        start: at(14),
      })
    ).resolves.toMatchObject({ error: { _tag: "PolicyViolation" } });

    unwrap(
      await scheduler.availability.set({
        resourceId: otherRoom,
        rules: [weekdays],
      })
    );

    const there = unwrap(
      await scheduler.book({
        end: at(11),
        resourceId: otherRoom,
        start: at(10),
      })
    );

    await expect(
      scheduler.reschedule({
        end: at(11),
        id: booking.id,
        resourceId: otherRoom,
        start: at(10),
      })
    ).resolves.toMatchObject({
      error: { _tag: "SlotConflict", conflicts: [{ id: there.id }] },
    });

    locks.length = 0;

    const moved = { ...booking, resourceId: otherRoom };

    await expect(
      scheduler.reschedule({
        end: at(15),
        id: booking.id,
        resourceId: otherRoom,
        start: at(14),
      })
    ).resolves.toStrictEqual({ ok: true, value: moved });
    expect(locks).toStrictEqual([otherRoom]);
    await expect(reads.getBooking(booking.id)).resolves.toStrictEqual(moved);
  });

  it("gives StatusMismatch for a cancelled Booking", async () => {
    const { booking, scheduler } = await seeded();

    unwrap(await scheduler.cancel({ id: booking.id }));

    await expect(
      scheduler.reschedule({ end: at(11), id: booking.id, start: at(10) })
    ).resolves.toStrictEqual({
      error: { _tag: "StatusMismatch", id: booking.id, status: "cancelled" },
      ok: false,
    });
  });

  it("gives BookingNotFound for an unknown id", async () => {
    const { scheduler } = await seeded();
    const id = mintBookingId();

    await expect(
      scheduler.reschedule({ end: at(11), id, start: at(10) })
    ).resolves.toStrictEqual({
      error: { _tag: "BookingNotFound", id },
      ok: false,
    });
  });

  it("gives InvalidParams for end <= start before any Adapter call", async () => {
    const refusing = defineAdapter<undefined, "blocks">(() => ({
      getBlock: refuse,
      getBooking: refuse,
      getRules: refuse,
      listBlocks: refuse,
      listBookings: refuse,
      withResourceLock: refuse,
    }));

    const result = await createScheduler({
      adapter: refusing,
      schema,
    }).reschedule({ end: at(10), id: mintBookingId(), start: at(10) });

    expect(result).toMatchObject({
      error: { _tag: "InvalidParams", issues: [{ path: ["end"] }] },
    });
  });

  it("retries when a cancel lands between its reads, then gives StatusMismatch", async () => {
    const inner = memoryAdapter();
    const { booking, scheduler } = await seeded(inner);
    let locks = 0;

    unwrap(
      await scheduler.availability.set({
        resourceId: otherRoom,
        rules: [weekdays],
      })
    );

    // Plays a cancel on the source Resource, which a move locking only the destination doesn't exclude.
    const adapter = defineAdapter<undefined, "blocks">((s) => {
      const raw = inner(s);

      return {
        ...raw,
        withResourceLock: async (id, work) => {
          locks += 1;

          if (locks > 1) {
            return await raw.withResourceLock(id, work);
          }

          unwrap(
            await createScheduler({ adapter: inner, schema }).cancel({
              id: booking.id,
            })
          );

          return await raw.withResourceLock(
            id,
            async (locked) =>
              await work({
                ...locked,
                // The locked read ran before the cancel committed.
                // SAFETY: `s` is `schema`, so `booking` is its record.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the bound schema is generic here.
                getBooking: async () => await Promise.resolve(booking as never),
              })
          );
        },
      };
    });

    await expect(
      createScheduler({ adapter, schema }).reschedule({
        end: at(15),
        id: booking.id,
        resourceId: otherRoom,
        start: at(14),
      })
    ).resolves.toStrictEqual({
      error: { _tag: "StatusMismatch", id: booking.id, status: "cancelled" },
      ok: false,
    });
    expect(locks).toBe(2);
  });

  it.each([1, 2, 3])(
    "lets exactly one of a reschedule and a book into one free slot (run %i)",
    async () => {
      const { booking, scheduler } = await seeded();

      const results = await Promise.all([
        scheduler.reschedule({ end: at(11), id: booking.id, start: at(10) }),
        scheduler.book({ end: at(11), resourceId: room, start: at(10) }),
      ]);

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(
        results.filter((r) => !r.ok && r.error._tag === "SlotConflict")
      ).toHaveLength(1);
    }
  );

  test.prop(
    [
      array(arbAvailabilityRule(), { maxLength: 3, minLength: 1 }),
      arbDateRange().chain((range) =>
        array(arbBookingIn(range, room), { maxLength: 5, minLength: 1 }).map(
          (bookings) => ({ bookings, range })
        )
      ),
      arbDuration(),
      arbInterval(),
      arbTimezone(),
      nat(),
    ],
    propConfig
  )(
    "accepts any slot findSlots({ excludeBookingId }) returns for that Booking",
    async (rules, { bookings, range }, duration, interval, timezone, pick) => {
      const adapter = memoryAdapter();
      const ids: BookingId[] = [];

      await adapter(schema).withResourceLock(room, async (locked) => {
        await locked.replaceRules({
          resourceId: room,
          rules: rules.map(({ resourceId: _, ...r }) => ({
            ...r,
            exceptions: [],
          })),
        });

        // Seed only states the Framework can reach: blocking Bookings never overlap, and the first one blocks.
        const kept: typeof bookings = [];

        for (const [i, b] of bookings.entries()) {
          const blocking = i === 0 || b.isBlocking;

          const clash = kept.some(
            (k) =>
              k.isBlocking &&
              blocking &&
              Temporal.Instant.compare(k.start, b.end) < 0 &&
              Temporal.Instant.compare(b.start, k.end) < 0
          );

          if (!clash) {
            kept.push({ ...b, isBlocking: blocking });
          }
        }

        for (const b of kept) {
          const id = mintBookingId();

          ids.push(id);
          // oxlint-disable-next-line no-await-in-loop -- in order, so ids[0] is the blocking one.
          await locked.insertBooking({
            end: b.end,
            id,
            resourceId: room,
            start: b.start,
            status: b.isBlocking ? "booked" : "cancelled",
          });
        }
      });

      const [moving] = ids;
      const scheduler = createScheduler({ adapter, schema });

      if (moving === undefined) {
        return;
      }

      const slots = unwrap(
        await scheduler.findSlots({
          duration,
          excludeBookingId: moving,
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

      const result = await scheduler.reschedule({
        end: slot.end.toInstant(),
        id: moving,
        start: slot.start.toInstant(),
      });

      expect(result).toMatchObject({ ok: true });
    }
  );

  it("fails with exactly its error union", () => {
    expectTypeOf<RescheduleError<typeof schema>>().toEqualTypeOf<
      | InvalidParams
      | BookingNotFound
      | StatusMismatch<"booked" | "cancelled">
      | SlotConflict
      | PolicyViolation
      | AdapterError
    >();
  });
});
