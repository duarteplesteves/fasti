import { assert, describe, expect, expectTypeOf, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import type { Adapter } from "../adapter/contract.js";
import {
  availability,
  blocks,
  column,
  createScheduler,
  defineSchema,
} from "../index.js";
import type { Scheduler, TransitionParams } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { uuidIdSchema } from "../test-utils/conformance-schemas.js";
import { unwrap } from "../test-utils/results.js";
import { mintBookingId } from "./booking-id.js";

/** `inProgress` blocks; `noShow` and `done` don't. `inProgress` can't be cancelled. */
const schema = defineSchema({
  plugins: [availability(), blocks({ fields: {} })],
  booking: {
    fields: {
      note: { required: false, type: column.text() },
      remindAt: { required: false, type: column.instant() },
    },
    statuses: {
      done: { blocking: false },
      inProgress: { blocking: true },
      noShow: { blocking: false },
    },
    transitions: {
      booked: ["inProgress", "noShow"],
      cancelled: ["booked"],
      inProgress: ["done"],
    },
  },
});

type Tx = undefined;

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

const slot = { end: at(2), resourceId: "room", start: at(1) } as const;

/** A scheduler over `adapter` with `weekdays` on `room` and one Booking in `slot`. */
async function seeded(adapter: Adapter<Tx, "records"> = memoryAdapter()) {
  const scheduler = createScheduler({ policies: [], adapter, schema });

  unwrap(
    await scheduler.availability.set({ resourceId: "room", rules: [weekdays] })
  );

  const booking = unwrap(
    await scheduler.book({ ...slot, fields: { note: "first" } })
  );

  return { booking, reads: adapter(schema), scheduler };
}

// oxlint-disable-next-line require-await -- a verb must return a promise.
async function reject(): Promise<never> {
  throw new Error("no Adapter call expected");
}

/** A memory Adapter whose unlocked read and lock both reject: any Adapter call shows up as an AdapterError. */
const refusing = defineAdapter<Tx, "records">((s) => ({
  ...memoryAdapter()(s),
  getBooking: reject,
  withResourceLock: reject,
}));

describe("transition", () => {
  it("moves a Booking along a declared Transition and stores it", async () => {
    const { booking, reads, scheduler } = await seeded();

    const moved = await scheduler.transition({
      from: "booked",
      id: booking.id,
      to: "inProgress",
    });

    expect(moved).toStrictEqual({
      ok: true,
      value: { ...booking, status: "inProgress" },
    });
    await expect(reads.getBooking(booking.id)).resolves.toStrictEqual({
      ...booking,
      status: "inProgress",
    });
  });

  it("gives StatusMismatch with the stored Status on a stale `from`, writing nothing", async () => {
    const { booking, reads, scheduler } = await seeded();

    unwrap(
      await scheduler.transition({
        from: "booked",
        id: booking.id,
        to: "noShow",
      })
    );

    await expect(
      scheduler.transition({ from: "booked", id: booking.id, to: "inProgress" })
    ).resolves.toStrictEqual({
      error: { _tag: "StatusMismatch", id: booking.id, status: "noShow" },
      ok: false,
    });
    await expect(reads.getBooking(booking.id)).resolves.toStrictEqual({
      ...booking,
      status: "noShow",
    });
  });

  it("gives BookingNotFound for an unknown id", async () => {
    const { scheduler } = await seeded();
    const id = mintBookingId();

    await expect(
      scheduler.transition({ from: "booked", id, to: "inProgress" })
    ).resolves.toStrictEqual({
      error: { _tag: "BookingNotFound", id },
      ok: false,
    });
  });

  it("gives InvalidParams at `to`, before any Adapter call, for an undeclared pair, `to: cancelled`, or a schema with no edge", async () => {
    const scheduler = createScheduler({
      policies: [],
      adapter: refusing,
      schema,
    });

    // SAFETY: `transition` is always bound; a plain-JS caller can reach it on a schema whose types hide it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
    const bare = createScheduler({
      policies: [],
      adapter: refusing,
      schema: uuidIdSchema,
    }) as Scheduler<typeof uuidIdSchema, Tx, readonly []> &
      Pick<typeof scheduler, "transition">;

    const id = mintBookingId();

    const results = [
      // @ts-expect-error `booked → done` isn't declared
      await scheduler.transition({ from: "booked", id, to: "done" }),
      await scheduler.transition({
        from: "booked",
        id,
        // @ts-expect-error `cancelled` belongs to cancel
        to: "cancelled",
      }),
      await bare.transition({ from: "cancelled", id, to: "booked" }),
    ];

    for (const result of results) {
      expect(result).toMatchObject({
        error: { _tag: "InvalidParams", issues: [{ path: ["to"] }] },
        ok: false,
      });
    }
  });

  it("cancelled → booked refuses an overlap with a newer Booking or a Block, and succeeds when free", async () => {
    const { booking, scheduler } = await seeded();
    const back = { from: "cancelled", id: booking.id, to: "booked" } as const;

    unwrap(await scheduler.cancel({ id: booking.id }));
    const newer = unwrap(await scheduler.book(slot));

    await expect(scheduler.transition(back)).resolves.toStrictEqual({
      error: {
        _tag: "SlotConflict",
        conflicts: [
          { end: slot.end, id: newer.id, kind: "booking", start: slot.start },
        ],
      },
      ok: false,
    });

    unwrap(await scheduler.cancel({ id: newer.id }));
    const block = unwrap(await scheduler.blocks.create(slot));

    await expect(scheduler.transition(back)).resolves.toStrictEqual({
      error: {
        _tag: "SlotConflict",
        conflicts: [
          { end: slot.end, id: block.id, kind: "block", start: slot.start },
        ],
      },
      ok: false,
    });

    unwrap(await scheduler.blocks.delete({ id: block.id }));

    await expect(scheduler.transition(back)).resolves.toStrictEqual({
      ok: true,
      value: booking,
    });
  });

  it("blocking → blocking succeeds though the Booking overlaps itself", async () => {
    const { booking, scheduler } = await seeded();

    expect(
      unwrap(
        await scheduler.transition({
          from: "booked",
          id: booking.id,
          to: "inProgress",
        })
      ).status
    ).toBe("inProgress");
  });

  it("into a non-blocking Status, succeeds over an outside double-booking", async () => {
    const { booking, reads, scheduler } = await seeded();
    const outside = { ...booking, id: mintBookingId() };

    await reads.withResourceLock("room", async (locked) => {
      await locked.insertBooking(outside);
    });

    expect(
      unwrap(
        await scheduler.transition({
          from: "booked",
          id: booking.id,
          to: "noShow",
        })
      ).status
    ).toBe("noShow");
  });

  it("doesn't check availability: succeeds after the rules changed", async () => {
    const { booking, scheduler } = await seeded();

    unwrap(await scheduler.cancel({ id: booking.id }));
    unwrap(await scheduler.availability.set({ resourceId: "room", rules: [] }));

    expect(
      unwrap(
        await scheduler.transition({
          from: "cancelled",
          id: booking.id,
          to: "booked",
        })
      ).status
    ).toBe("booked");
  });

  it("applies a `fields` patch, floors Instants, and keeps fields left out", async () => {
    const { booking, reads, scheduler } = await seeded();
    const remindAt = at(0).add({ microseconds: 1500 });

    const moved = unwrap(
      await scheduler.transition({
        fields: { remindAt },
        from: "booked",
        id: booking.id,
        to: "inProgress",
      })
    );

    const expected = {
      ...booking,
      note: "first",
      remindAt: at(0).add({ milliseconds: 1 }),
      status: "inProgress",
    };

    expect(moved).toStrictEqual(expected);
    await expect(reads.getBooking(booking.id)).resolves.toStrictEqual(expected);
  });

  it("of two concurrent transitions from the same Status, exactly one wins; the other gets StatusMismatch", async () => {
    const { booking, scheduler } = await seeded();

    const results = await Promise.all([
      scheduler.transition({
        from: "booked",
        id: booking.id,
        to: "inProgress",
      }),
      scheduler.transition({ from: "booked", id: booking.id, to: "noShow" }),
    ]);

    const won = results.filter((r) => r.ok);
    const lost = results.filter((r) => !r.ok);

    expect(won).toHaveLength(1);
    assert(won[0]?.ok, "expected a winner");
    expect(lost).toStrictEqual([
      {
        error: {
          _tag: "StatusMismatch",
          id: booking.id,
          status: won[0].value.status,
        },
        ok: false,
      },
    ]);
  });
});

describe("cancel along declared Transitions", () => {
  it("gives TransitionNotDeclared from a Status with no edge to cancelled", async () => {
    const { booking, scheduler } = await seeded();

    unwrap(
      await scheduler.transition({
        from: "booked",
        id: booking.id,
        to: "inProgress",
      })
    );

    await expect(scheduler.cancel({ id: booking.id })).resolves.toStrictEqual({
      error: {
        _tag: "TransitionNotDeclared",
        from: "inProgress",
        id: booking.id,
        to: "cancelled",
      },
      ok: false,
    });
  });

  it("writes a `fields` patch; a repeat with other fields writes nothing", async () => {
    const { booking, reads, scheduler } = await seeded();
    const cancelled = { ...booking, note: "gone", status: "cancelled" };

    await expect(
      scheduler.cancel({ fields: { note: "gone" }, id: booking.id })
    ).resolves.toStrictEqual({
      ok: true,
      value: { alreadyCancelled: false, booking: cancelled },
    });

    await expect(
      scheduler.cancel({ fields: { note: "again" }, id: booking.id })
    ).resolves.toStrictEqual({
      ok: true,
      value: { alreadyCancelled: true, booking: cancelled },
    });
    await expect(reads.getBooking(booking.id)).resolves.toStrictEqual(
      cancelled
    );
  });
});

describe("transition types", () => {
  it("narrows `to` by `from`, and never allows `cancelled`", () => {
    type P = TransitionParams<typeof schema>;

    expectTypeOf<Extract<P, { from: "booked" }>["to"]>().toEqualTypeOf<
      "inProgress" | "noShow"
    >();
    expectTypeOf<
      Extract<P, { from: "cancelled" }>["to"]
    >().toEqualTypeOf<"booked">();
    expectTypeOf<P["from"]>().toEqualTypeOf<
      "booked" | "cancelled" | "inProgress"
    >();
  });

  it("exists exactly when some declared Transition doesn't end in cancelled", () => {
    const onlyStatuses = defineSchema({
      booking: { statuses: { paid: { blocking: true } } },
    });

    const onlyIntoCancelled = defineSchema({
      booking: {
        statuses: { paid: { blocking: true } },
        transitions: { paid: ["cancelled"] },
      },
    });

    const onlyBack = defineSchema({
      booking: { transitions: { cancelled: ["booked"] } },
    });

    expectTypeOf<
      Scheduler<typeof uuidIdSchema, Tx, readonly []>
    >().not.toHaveProperty("transition");
    expectTypeOf<
      Scheduler<typeof onlyStatuses, Tx, readonly []>
    >().not.toHaveProperty("transition");
    expectTypeOf<
      Scheduler<typeof onlyIntoCancelled, Tx, readonly []>
    >().not.toHaveProperty("transition");
    expectTypeOf<Scheduler<typeof onlyBack, Tx, readonly []>>().toHaveProperty(
      "transition"
    );
  });
});
