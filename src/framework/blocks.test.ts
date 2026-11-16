import { assert, describe, expect, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import type { Result } from "../core/result.js";
import { column, createScheduler, defineSchema } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { unwrap } from "../test-utils/results.js";

const schema = defineSchema({
  block: {
    fields: {
      note: { required: false, type: column.text() },
      reason: { required: true, type: column.text() },
    },
  },
});

const room = "room-a";

/** UUIDv7 (RFC 9562): version nibble 7, variant bits 10. */
const uuidV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** `hours` from 09:00 UTC Monday 3 June 2030, as an Instant. */
function at(hours: number): Temporal.Instant {
  return Temporal.Instant.from("2030-06-03T09:00:00Z").add({
    minutes: hours * 60,
  });
}

/** The error of a failed result; fails the test if it is ok. */
function errorOf<E>(result: Result<unknown, E>): E {
  assert(!result.ok, "expected an error");

  return result.error;
}

/** A verb that must never be called. */
// oxlint-disable-next-line require-await -- a verb must return a promise.
async function refuse(): Promise<never> {
  throw new Error("no Adapter call expected");
}

/** Every verb refuses: any Adapter call fails the test. */
const spyAdapter = defineAdapter<undefined, "blocks">(() => ({
  getBlock: refuse,
  getBooking: refuse,
  getRules: refuse,
  listBlocks: refuse,
  listBookings: refuse,
  withResourceLock: refuse,
}));

/** A scheduler over a fresh memory Adapter, with weekday availability so `book` works. */
async function fresh() {
  const adapter = memoryAdapter();
  const scheduler = createScheduler({ adapter, schema });

  unwrap(
    await scheduler.availability.set({
      resourceId: room,
      rules: [
        {
          recurrence: {
            daysOfWeek: [1, 2, 3, 4, 5],
            frequency: "weekly",
            interval: 1,
          },
          timeWindow: {
            end: Temporal.PlainTime.from("17:00"),
            start: Temporal.PlainTime.from("09:00"),
          },
          timezone: "UTC",
        },
      ],
    })
  );

  return { adapter, scheduler };
}

const reason = { fields: { reason: "maintenance" } } as const;

describe("blocks.create and blocks.list", () => {
  it("round-trips a Block with its Developer Fields and a UUIDv7 id", async () => {
    const { scheduler } = await fresh();

    const block = unwrap(
      await scheduler.blocks.create({
        end: at(2),
        fields: { note: "boiler", reason: "maintenance" },
        resourceId: room,
        start: at(1),
      })
    );

    const { id, ...rest } = block;

    expect(id).toMatch(uuidV7);
    expect(rest).toStrictEqual({
      end: at(2),
      note: "boiler",
      reason: "maintenance",
      resourceId: room,
      start: at(1),
    });
    expect(
      unwrap(
        await scheduler.blocks.list({
          from: at(0),
          resourceId: room,
          to: at(8),
        })
      )
    ).toStrictEqual([block]);
  });

  it("stores an unset optional Developer Field as null", async () => {
    const { scheduler } = await fresh();

    const block = unwrap(
      await scheduler.blocks.create({
        ...reason,
        end: at(2),
        resourceId: room,
        start: at(1),
      })
    );

    expect(block.note).toBeNull();
  });

  it("refuses end <= start as InvalidParams at end, before any Adapter call", async () => {
    const scheduler = createScheduler({ adapter: spyAdapter, schema });

    for (const end of [at(1), at(0)]) {
      // oxlint-disable-next-line no-await-in-loop -- two independent cases, in order.
      const result = await scheduler.blocks.create({
        ...reason,
        end,
        resourceId: room,
        start: at(1),
      });

      expect(errorOf(result)).toMatchObject({
        _tag: "InvalidParams",
        issues: [{ path: ["end"] }],
      });
    }
  });

  it("refuses an overlap with a blocking Booking as SlotConflict of kind booking", async () => {
    const { scheduler } = await fresh();

    const first = unwrap(
      await scheduler.book({ end: at(2), resourceId: room, start: at(1) })
    );

    const second = unwrap(
      await scheduler.book({ end: at(4), resourceId: room, start: at(3) })
    );

    const result = await scheduler.blocks.create({
      ...reason,
      end: at(3.5),
      resourceId: room,
      start: at(1.5),
    });

    expect(errorOf(result)).toStrictEqual({
      _tag: "SlotConflict",
      conflicts: [
        { end: at(2), id: first.id, kind: "booking", start: at(1) },
        { end: at(4), id: second.id, kind: "booking", start: at(3) },
      ],
    });
    expect(
      unwrap(
        await scheduler.blocks.list({
          from: at(0),
          resourceId: room,
          to: at(8),
        })
      )
    ).toStrictEqual([]);
  });

  it("accepts a cancelled Booking, touching edges, another Block and the past", async () => {
    const { scheduler } = await fresh();

    const cancelled = unwrap(
      await scheduler.book({ end: at(2), resourceId: room, start: at(1) })
    );

    unwrap(await scheduler.cancel({ id: cancelled.id }));
    unwrap(
      await scheduler.book({ end: at(4), resourceId: room, start: at(3) })
    );

    const ranges = [
      // Over the cancelled Booking.
      [at(1), at(2)],
      // Touching the booked one on both sides.
      [at(2), at(3)],
      [at(4), at(5)],
      // Over the first Block.
      [at(1), at(2)],
      // In the past.
      [Temporal.Instant.from("2001-01-01T00:00:00Z"), at(-100_000)],
    ] as const;

    for (const [start, end] of ranges) {
      // oxlint-disable-next-line no-await-in-loop -- in order: each case sees the Blocks before it.
      const block = await scheduler.blocks.create({
        ...reason,
        end,
        resourceId: room,
        start,
      });

      expect(block.ok).toBeTruthy();
    }
  });

  it("lists by start, includes a Block that starts before `from`, and ignores other Resources", async () => {
    const { scheduler } = await fresh();

    async function create(start: number, end: number, resourceId = room) {
      return unwrap(
        await scheduler.blocks.create({
          ...reason,
          end: at(end),
          resourceId,
          start: at(start),
        })
      );
    }

    const late = await create(5, 6);
    const early = await create(1, 3);
    const straddling = await create(-2, 1.5);

    await create(2, 3, "room-b");
    // Ends exactly at `from`: half-open, so out.
    await create(-3, 0);

    expect(
      unwrap(
        await scheduler.blocks.list({
          from: at(0),
          resourceId: room,
          to: at(8),
        })
      )
    ).toStrictEqual([straddling, early, late]);
  });

  it("refuses to <= from as InvalidParams at to, before any Adapter call", async () => {
    const scheduler = createScheduler({ adapter: spyAdapter, schema });

    const result = await scheduler.blocks.list({
      from: at(1),
      resourceId: room,
      to: at(1),
    });

    expect(errorOf(result)).toMatchObject({
      _tag: "InvalidParams",
      issues: [{ path: ["to"] }],
    });
  });

  it("an insertBlock that rejects gives AdapterError, and the unit rolls back", async () => {
    const inner = memoryAdapter();
    const boom = new Error("boom");

    // Writes the Block, then fails: only a rollback leaves the store empty.
    const adapter = defineAdapter<undefined, "blocks">((s) => {
      const raw = inner(s);

      return {
        ...raw,
        withResourceLock: async (id, work) =>
          await raw.withResourceLock(
            id,
            async (locked) =>
              await work({
                ...locked,
                insertBlock: async (block) => {
                  await locked.insertBlock(block);
                  throw boom;
                },
              })
          ),
      };
    });

    const scheduler = createScheduler({ adapter, schema });

    const result = await scheduler.blocks.create({
      ...reason,
      end: at(2),
      resourceId: room,
      start: at(1),
    });

    expect(errorOf(result)).toMatchObject({
      _tag: "AdapterError",
      cause: boom,
    });
    expect(
      unwrap(
        await scheduler.blocks.list({
          from: at(0),
          resourceId: room,
          to: at(8),
        })
      )
    ).toStrictEqual([]);
  });
});
