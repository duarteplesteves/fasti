import { assert, describe, expect, expectTypeOf, it } from "vitest";

import {
  availability,
  blocks,
  createScheduler,
  defineSchema,
} from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { unwrap } from "../test-utils/results.js";
import type { BookParams } from "./book.js";

/** `paid` blocks, `request` doesn't; `book` may create either. */
const schema = defineSchema({
  plugins: [availability(), blocks({ fields: {} })],
  booking: {
    initial: ["booked", "paid", "request"],
    statuses: {
      paid: { blocking: true },
      request: { blocking: false },
    },
  },
});

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

/** `hours` from 09:00 Monday 3 June 2030 Lisbon, as an Instant. */
function at(hours: number): Temporal.Instant {
  return Temporal.Instant.from("2030-06-03T08:00:00Z").add({ hours });
}

/** A scheduler over a fresh memory Adapter, with `weekdays` set for `room`. */
async function seeded() {
  const scheduler = createScheduler({
    policies: [],
    adapter: memoryAdapter(),
    schema,
  });

  unwrap(
    await scheduler.availability.set({ resourceId: "room", rules: [weekdays] })
  );

  return scheduler;
}

const slot = { end: at(2), resourceId: "room", start: at(1) } as const;

describe("developer Statuses", () => {
  it("books in the given initial Status", async () => {
    const scheduler = await seeded();

    const booking = unwrap(await scheduler.book({ ...slot, status: "paid" }));

    expect(booking.status).toBe("paid");
  });

  it("refuses a status outside `initial` (plain JS) as InvalidParams at status", async () => {
    const scheduler = await seeded();

    const result = await scheduler.book({
      ...slot,
      // @ts-expect-error `cancelled` isn't an initial Status
      status: "cancelled",
    });

    assert(!result.ok, "expected an error");
    expect(result.error).toMatchObject({
      _tag: "InvalidParams",
      issues: [{ path: ["status"] }],
    });
  });

  it("a Booking in a declared blocking Status hides its slot and refuses book and blocks.create", async () => {
    const scheduler = await seeded();

    unwrap(await scheduler.book({ ...slot, status: "paid" }));

    const slots = unwrap(
      await scheduler.findSlots({
        duration: 60,
        from: at(0),
        interval: 60,
        resourceId: "room",
        timezone: "Europe/Lisbon",
        to: at(3),
      })
    );

    expect(slots.map((s) => s.start.toInstant())).toStrictEqual([at(0), at(2)]);

    const booked = await scheduler.book({ ...slot, status: "booked" });

    assert(!booked.ok, "expected an error");
    expect(booked.error._tag).toBe("SlotConflict");

    const blocked = await scheduler.blocks.create(slot);

    assert(!blocked.ok, "expected an error");
    expect(blocked.error._tag).toBe("SlotConflict");
  });

  it("a Booking in a declared non-blocking Status doesn't", async () => {
    const scheduler = await seeded();

    unwrap(await scheduler.book({ ...slot, status: "request" }));

    const slots = unwrap(
      await scheduler.findSlots({
        duration: 60,
        from: at(0),
        interval: 60,
        resourceId: "room",
        timezone: "Europe/Lisbon",
        to: at(3),
      })
    );

    expect(slots.map((s) => s.start.toInstant())).toStrictEqual([
      at(0),
      at(1),
      at(2),
    ]);
    unwrap(await scheduler.book({ ...slot, status: "booked" }));
  });

  it("books two non-blocking Bookings on one slot, even over a blocking one, but not outside availability", async () => {
    const scheduler = await seeded();

    unwrap(await scheduler.book({ ...slot, status: "paid" }));
    unwrap(await scheduler.book({ ...slot, status: "request" }));
    unwrap(await scheduler.book({ ...slot, status: "request" }));

    const outside = await scheduler.book({
      end: at(10),
      resourceId: "room",
      start: at(9),
      status: "request",
    });

    assert(!outside.ok, "expected an error");
    expect(outside.error._tag).toBe("PolicyViolation");
  });

  it("types `status`: required with several initial Statuses, absent with one", () => {
    expectTypeOf<BookParams<typeof schema>["status"]>().toEqualTypeOf<
      "booked" | "paid" | "request"
    >();

    const single = defineSchema({
      booking: { statuses: { paid: { blocking: true } } },
    });

    expectTypeOf<BookParams<typeof single>>().not.toHaveProperty("status");
    expectTypeOf(slot).not.toExtend<BookParams<typeof schema>>();
    expectTypeOf(slot).toExtend<BookParams<typeof single>>();
  });
});
