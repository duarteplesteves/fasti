import { assert, describe, expect, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import type { Adapter, LockedAdapter } from "../adapter/contract.js";
import type { BookingId } from "../core/types.js";
import { createScheduler } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import {
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { unwrap } from "../test-utils/results.js";

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

/** Monday 3 June 2030, 10:00–11:00 Lisbon: the seeded Booking. */
const seededSlot = {
  end: Temporal.Instant.from("2030-06-03T10:00:00Z"),
  start: Temporal.Instant.from("2030-06-03T09:00:00Z"),
};

/** Monday 3 June 2030, 14:00–15:00 Lisbon: free. */
const freeSlot = {
  end: Temporal.Instant.from("2030-06-03T14:00:00Z"),
  start: Temporal.Instant.from("2030-06-03T13:00:00Z"),
};

/** The original rejection every broken Adapter uses. */
const boom = new Error("boom");

// oxlint-disable-next-line require-await -- a verb must return a promise.
async function reject(): Promise<never> {
  throw boom;
}

/** A memory Adapter with `weekdays` and one Booking on `room`. */
async function seeded() {
  const adapter = memoryAdapter();

  unwrap(
    await createScheduler({ policies: [], adapter, schema }).availability.set({
      resourceId: room,
      rules: [weekdays],
    })
  );

  const booking = unwrap(
    await createScheduler({ policies: [], adapter, schema }).book({
      ...seededSlot,
      resourceId: room,
    })
  );

  return { adapter, booking };
}

type Inner = Adapter<undefined, "blocks">;

/** Every verb rejects, inside and outside the lock; the lock itself works. */
function rejectingVerbs(inner: Inner) {
  return defineAdapter<undefined, "blocks">((s) => {
    const raw = inner(s);

    return {
      getBlock: reject,
      getBooking: reject,
      getRules: reject,
      listBlocks: reject,
      listBookings: reject,
      withResourceLock: async (id, work) =>
        await raw.withResourceLock(
          id,
          async (locked) =>
            await work({
              ...locked,
              getBlock: reject,
              getBooking: reject,
              getRules: reject,
              insertBlock: reject,
              insertBooking: reject,
              listBlocks: reject,
              listBookings: reject,
              replaceRules: reject,
              updateBooking: reject,
            })
        ),
    };
  });
}

/** Taking the lock rejects before the work runs. */
function lockRejects(inner: Inner) {
  return defineAdapter<undefined, "blocks">((s) => ({
    ...inner(s),
    withResourceLock: reject,
  }));
}

/** The work resolves, then committing rejects. */
function commitRejects(inner: Inner) {
  return defineAdapter<undefined, "blocks">((s) => {
    const raw = inner(s);

    return {
      ...raw,
      withResourceLock: async (id, work) => {
        await raw.withResourceLock(id, work);

        throw boom;
      },
    };
  });
}

/** One call per Action, each valid enough to reach the Adapter. */
const actions = {
  "availability.get": async (adapter: Inner) =>
    await createScheduler({ policies: [], adapter, schema }).availability.get({
      resourceId: room,
    }),
  "availability.set": async (adapter: Inner) =>
    await createScheduler({ policies: [], adapter, schema }).availability.set({
      resourceId: room,
      rules: [weekdays],
    }),
  book: async (adapter: Inner) =>
    await createScheduler({ policies: [], adapter, schema }).book({
      ...freeSlot,
      resourceId: room,
    }),
  cancel: async (adapter: Inner, id: BookingId) =>
    await createScheduler({ policies: [], adapter, schema }).cancel({ id }),
  findSlots: async (adapter: Inner) =>
    await createScheduler({ policies: [], adapter, schema }).findSlots({
      duration: 60,
      from: freeSlot.start,
      interval: 30,
      resourceId: room,
      timezone: "Europe/Lisbon",
      to: freeSlot.end,
    }),
};

/** The Actions that take the Resource Lock. */
const locking = ["availability.set", "book", "cancel"] as const;

/** Every Action. */
const allActions = [...locking, "availability.get", "findSlots"] as const;

describe("failure handling", () => {
  describe.each([
    ["a rejecting verb", rejectingVerbs, allActions],
    ["a lock that rejects before the work", lockRejects, locking],
    ["a commit failure", commitRejects, locking],
  ] as const)("%s", (_, broken, names) => {
    it.each(names)(
      "%s gives AdapterError with the original cause",
      async (name) => {
        const { adapter, booking } = await seeded();
        const result = await actions[name](broken(adapter), booking.id);

        assert(!result.ok, "expected an error");
        expect(result.error).toMatchObject({
          _tag: "AdapterError",
          cause: boom,
        });
      }
    );
  });

  it("a listBookings that breaks the contract makes book reject, and stores nothing", async () => {
    const { adapter } = await seeded();

    const broken = defineAdapter<undefined, "blocks">((s) => {
      const raw = adapter(s);

      return {
        ...raw,
        withResourceLock: async (id, work) =>
          await raw.withResourceLock(
            id,
            async (locked) =>
              await work({
                ...locked,
                // SAFETY: the contract violation under test.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
                listBookings: async () => await Promise.resolve({} as never),
              } satisfies LockedAdapter<typeof s, undefined>)
          ),
      };
    });

    // A defect, not the Adapter failing: `.map` on a non-array throws a TypeError.
    await expect(actions.book(broken)).rejects.toBeInstanceOf(TypeError);
    await expect(
      adapter(schema).listBookings({
        overlapping: { from: freeSlot.start, to: freeSlot.end },
        resourceId: room,
      })
    ).resolves.toStrictEqual([]);
  });

  it("an insertBooking that rejects gives AdapterError, and the slot stays free", async () => {
    const { adapter } = await seeded();

    const broken = defineAdapter<undefined, "blocks">((s) => {
      const raw = adapter(s);

      return {
        ...raw,
        withResourceLock: async (id, work) =>
          await raw.withResourceLock(
            id,
            async (locked) =>
              await work({
                ...locked,
                // Writes, then fails: only a rollback keeps the slot free.
                insertBooking: async (booking) => {
                  await locked.insertBooking(booking);

                  throw boom;
                },
              })
          ),
      };
    });

    const result = await actions.book(broken);

    assert(!result.ok, "expected an error");
    expect(result.error).toMatchObject({ _tag: "AdapterError", cause: boom });

    const slots = unwrap(await actions.findSlots(adapter));

    expect(slots.map((s) => s.start.toInstant())).toContainEqual(
      freeSlot.start
    );
  });
});
