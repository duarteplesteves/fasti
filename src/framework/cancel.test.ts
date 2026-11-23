import { assert, describe, expect, expectTypeOf, it } from "vitest";

import type { Adapter } from "../adapter/contract.js";
import type { BookingId } from "../core/types.js";
import { createScheduler } from "../index.js";
import type {
  AdapterError,
  BookingNotFound,
  CancelError,
  InvalidParams,
  TransitionNotDeclared,
} from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import {
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { replaceRules } from "../testing/plugin-stores.js";
import { mintBookingId } from "./booking-id.js";

const schema = uuidIdSchema;
const [room] = uuidIdResources;

// Monday 3 June 2030, 10:00–11:00 Lisbon (UTC+1).
const start = Temporal.Instant.from("2030-06-03T09:00:00Z");
const end = Temporal.Instant.from("2030-06-03T10:00:00Z");

const weekdays = {
  exceptions: [],
  recurrence: { daysOfWeek: [1, 2, 3, 4, 5], frequency: "weekly", interval: 1 },
  timeWindow: {
    end: Temporal.PlainTime.from("17:00"),
    start: Temporal.PlainTime.from("09:00"),
  },
  timezone: "Europe/Lisbon",
} as const;

/** Wrap `inner` so each locked `updateBooking` goes through `update` first. */
function wrapUpdates(
  inner: Adapter<undefined, "records">,
  update: (call: number) => "pass" | "changed"
): Adapter<undefined, "records"> {
  let calls = 0;

  return (s) => {
    const bound = inner(s);

    return {
      ...bound,
      withResourceLock: async (resourceId, work) =>
        await bound.withResourceLock(
          resourceId,
          async (locked) =>
            await work({
              ...locked,
              updateBooking: async (params) => {
                calls += 1;

                return update(calls) === "changed"
                  ? { ok: false, reason: "changed" }
                  : await locked.updateBooking(params);
              },
            })
        ),
    };
  };
}

async function bookedScheduler(adapter: Adapter<undefined, "records">) {
  await adapter(schema).withResourceLock(room, async (locked) => {
    await replaceRules(locked, { resourceId: room, rules: [weekdays] });
  });

  const scheduler = createScheduler({ policies: [], adapter, schema });
  const booked = await scheduler.book({ end, resourceId: room, start });

  assert(booked.ok, "expected the seed booking to succeed");

  return { booking: booked.value, scheduler };
}

describe("cancel", () => {
  it("cancels a booked Booking and frees its slot", async () => {
    const { booking, scheduler } = await bookedScheduler(memoryAdapter());

    await expect(scheduler.cancel({ id: booking.id })).resolves.toStrictEqual({
      ok: true,
      value: {
        alreadyCancelled: false,
        booking: { ...booking, status: "cancelled" },
      },
    });

    const again = await scheduler.book({ end, resourceId: room, start });

    expect(again.ok).toBeTruthy();
  });

  it("is idempotent: a repeat writes nothing", async () => {
    const updates: number[] = [];

    const adapter = wrapUpdates(memoryAdapter(), (call) => {
      updates.push(call);

      return "pass";
    });

    const { booking, scheduler } = await bookedScheduler(adapter);

    await scheduler.cancel({ id: booking.id });

    expect(updates).toStrictEqual([1]);
    await expect(scheduler.cancel({ id: booking.id })).resolves.toStrictEqual({
      ok: true,
      value: {
        alreadyCancelled: true,
        booking: { ...booking, status: "cancelled" },
      },
    });
    expect(updates).toStrictEqual([1]);
  });

  it("gives BookingNotFound for an unknown id", async () => {
    const scheduler = createScheduler({
      policies: [],
      adapter: memoryAdapter(),
      schema,
    });

    const id = mintBookingId();

    await expect(scheduler.cancel({ id })).resolves.toStrictEqual({
      error: { _tag: "BookingNotFound", id },
      ok: false,
    });
  });

  it("retries when an outside write changed the row between read and write", async () => {
    const adapter = wrapUpdates(memoryAdapter(), (call) =>
      call === 1 ? "changed" : "pass"
    );

    const { booking, scheduler } = await bookedScheduler(adapter);

    await expect(scheduler.cancel({ id: booking.id })).resolves.toStrictEqual({
      ok: true,
      value: {
        alreadyCancelled: false,
        booking: { ...booking, status: "cancelled" },
      },
    });
  });

  it("fails with exactly InvalidParams, BookingNotFound, TransitionNotDeclared or AdapterError", () => {
    expectTypeOf<CancelError<typeof schema>>().toEqualTypeOf<
      | InvalidParams
      | BookingNotFound
      | TransitionNotDeclared<"booked" | "cancelled">
      | AdapterError
    >();
    expectTypeOf<BookingNotFound>().toEqualTypeOf<{
      readonly _tag: "BookingNotFound";
      readonly id: BookingId;
    }>();
  });
});
