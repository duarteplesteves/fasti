import { assert, describe, expect, expectTypeOf, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import type { Adapter, LockedAdapter } from "../adapter/contract.js";
import type { Result } from "../core/result.js";
import type { BlockId, BookingId } from "../core/types.js";
import {
  availability,
  blocks,
  column,
  createScheduler,
  defineSchema,
} from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import type { AnySchema } from "../schema/define-schema.js";
import { unwrap } from "../test-utils/results.js";
import { mintBookingId } from "./booking-id.js";
import type { ConflictOf } from "./occupancy.js";
import { mintBlockId } from "./plugins/blocks.js";

const schema = defineSchema({
  plugins: [
    availability(),
    blocks({
      fields: {
        note: { required: false, type: column.text() },
        reason: { required: true, type: column.text() },
      },
    }),
  ],
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
const spyAdapter = defineAdapter<undefined, "records">(() => ({
  getRecord: refuse,
  getBooking: refuse,
  listBookings: refuse,
  listRecords: refuse,
  withResourceLock: refuse,
}));

/** Wrap `inner` so each locked unit of work sees `overrides(locked)` over its verbs. */
function wrapLocked(
  inner: Adapter<undefined, "records">,
  overrides: <S extends AnySchema>(
    locked: LockedAdapter<S, undefined, "records">
  ) => Partial<LockedAdapter<S, undefined, "records">>
): Adapter<undefined, "records"> {
  return defineAdapter<undefined, "records">((s) => {
    const raw = inner(s);

    return {
      ...raw,
      withResourceLock: async (id, work) =>
        await raw.withResourceLock(
          id,
          async (locked) => await work({ ...locked, ...overrides(locked) })
        ),
    };
  });
}

/** A scheduler over a fresh memory Adapter, with weekday availability so `book` works. */
async function fresh() {
  const adapter = memoryAdapter();
  const scheduler = createScheduler({ policies: [], adapter, schema });

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
    const scheduler = createScheduler({
      policies: [],
      adapter: spyAdapter,
      schema,
    });

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
    const scheduler = createScheduler({
      policies: [],
      adapter: spyAdapter,
      schema,
    });

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

  it("an insertRecord that rejects gives AdapterError, and the unit rolls back", async () => {
    const inner = memoryAdapter();
    const boom = new Error("boom");

    // Writes the Block, then fails: only a rollback leaves the store empty.
    const adapter = defineAdapter<undefined, "records">((s) => {
      const raw = inner(s);

      return {
        ...raw,
        withResourceLock: async (id, work) =>
          await raw.withResourceLock(
            id,
            async (locked) =>
              await work({
                ...locked,
                insertRecord: async (table, record) => {
                  await locked.insertRecord(table, record);
                  throw boom;
                },
              })
          ),
      };
    });

    const scheduler = createScheduler({ policies: [], adapter, schema });

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

/** Create a Block on `resourceId` over `[at(start), at(end))`. */
async function createBlockAt(
  scheduler: Awaited<ReturnType<typeof fresh>>["scheduler"],
  start: number,
  end: number,
  resourceId = room
) {
  return unwrap(
    await scheduler.blocks.create({
      ...reason,
      end: at(end),
      resourceId,
      start: at(start),
    })
  );
}

describe("Blocks occupy time", () => {
  it("refuses a book over a Block as SlotConflict of kind block", async () => {
    const { scheduler } = await fresh();
    const blocked = await createBlockAt(scheduler, 1, 2);

    const result = await scheduler.book({
      end: at(2.5),
      resourceId: room,
      start: at(1.5),
    });

    expect(errorOf(result)).toStrictEqual({
      _tag: "SlotConflict",
      conflicts: [{ end: at(2), id: blocked.id, kind: "block", start: at(1) }],
    });
  });

  it("reports a Block outside availability as SlotConflict, not PolicyViolation", async () => {
    const { scheduler } = await fresh();
    // 17:00–19:00 UTC: past the 09:00–17:00 window.
    const blocked = await createBlockAt(scheduler, 8, 10);

    const result = await scheduler.book({
      end: at(9),
      resourceId: room,
      start: at(8),
    });

    expect(errorOf(result)).toStrictEqual({
      _tag: "SlotConflict",
      conflicts: [{ end: at(10), id: blocked.id, kind: "block", start: at(8) }],
    });
  });

  it("sorts a conflict mixing Bookings and Blocks by start, then id", async () => {
    const { scheduler } = await fresh();
    const x = await createBlockAt(scheduler, 0, 1);
    const y = await createBlockAt(scheduler, 0, 1);

    const booked = unwrap(
      await scheduler.book({ end: at(2), resourceId: room, start: at(1) })
    );

    const z = await createBlockAt(scheduler, 2, 3);

    // Same start: the id breaks the tie.
    const [first, second] = x.id < y.id ? [x, y] : [y, x];

    const result = await scheduler.book({
      end: at(2.5),
      resourceId: room,
      start: at(0.5),
    });

    expect(errorOf(result)).toStrictEqual({
      _tag: "SlotConflict",
      conflicts: [
        { end: at(1), id: first.id, kind: "block", start: at(0) },
        { end: at(1), id: second.id, kind: "block", start: at(0) },
        { end: at(2), id: booked.id, kind: "booking", start: at(1) },
        { end: at(3), id: z.id, kind: "block", start: at(2) },
      ],
    });
  });

  it("ignores Blocks on another Resource", async () => {
    const { scheduler } = await fresh();

    await createBlockAt(scheduler, 1, 2, "room-b");

    const result = await scheduler.book({
      end: at(2),
      resourceId: room,
      start: at(1),
    });

    expect(result).toMatchObject({ ok: true });
  });

  it("narrows a Conflict on kind to its id type", () => {
    expectTypeOf<
      Extract<ConflictOf<typeof schema>, { kind: "block" }>["id"]
    >().toEqualTypeOf<BlockId>();
    expectTypeOf<
      Extract<ConflictOf<typeof schema>, { kind: "booking" }>["id"]
    >().toEqualTypeOf<BookingId>();
  });

  it("re-reads Blocks when the backstop catches what the lock missed", async () => {
    const { adapter: inner } = await fresh();

    const hidden = {
      end: at(2),
      id: mintBlockId(),
      note: null,
      reason: "outside",
      resourceId: room,
      start: at(1),
    };

    await inner(schema).withResourceLock(room, async (locked) => {
      await locked.insertRecord("block", hidden);
    });

    // Hides the Block from the unit's first read, then plays the backstop refusing the insert.
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
              listRecords: async (table, q) => {
                reads += 1;

                return reads === 1 ? [] : await locked.listRecords(table, q);
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
      end: at(2),
      resourceId: room,
      start: at(1),
    });

    expect(errorOf(result)).toStrictEqual({
      _tag: "SlotConflict",
      conflicts: [{ end: at(2), id: hidden.id, kind: "block", start: at(1) }],
    });
  });

  it("findSlots hides a slot that overlaps a Block", async () => {
    const { scheduler } = await fresh();

    const query = {
      duration: 60,
      from: at(0),
      interval: 60,
      resourceId: room,
      timezone: "UTC",
      to: at(3),
    };

    await createBlockAt(scheduler, 1.5, 2);

    const slots = unwrap(await scheduler.findSlots(query));

    expect(slots.map((s) => s.start.toInstant())).toStrictEqual([at(0), at(2)]);
  });

  it("makes no Block read on a schema without blocks(), and books any free time without availability()", async () => {
    const plain = defineSchema({});
    const inner = memoryAdapter();

    const adapter = defineAdapter<undefined, "records">((s) => ({
      ...inner(s),
      getRecord: refuse,
      listRecords: refuse,
      withResourceLock: async (id, work) =>
        await inner(s).withResourceLock(
          id,
          async (locked) =>
            await work({ ...locked, getRecord: refuse, listRecords: refuse })
        ),
    }));

    const scheduler = createScheduler({ policies: [], adapter, schema: plain });

    await expect(
      scheduler.book({ end: at(2), resourceId: room, start: at(1) })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      scheduler.findSlots({
        duration: 60,
        from: at(0),
        interval: 60,
        resourceId: room,
        timezone: "UTC",
        to: at(3),
      })
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("blocks.update", () => {
  it("moves a Block, keeping its Resource and fields", async () => {
    const { scheduler } = await fresh();
    const block = await createBlockAt(scheduler, 1, 2);

    const moved = unwrap(
      await scheduler.blocks.update({ end: at(4), id: block.id, start: at(3) })
    );

    expect(moved).toStrictEqual({ ...block, end: at(4), start: at(3) });
    expect(
      unwrap(
        await scheduler.blocks.list({
          from: at(0),
          resourceId: room,
          to: at(8),
        })
      )
    ).toStrictEqual([moved]);
  });

  it("merges fields, leaving the others as they were", async () => {
    const { scheduler } = await fresh();

    const block = unwrap(
      await scheduler.blocks.create({
        end: at(2),
        fields: { note: "boiler", reason: "maintenance" },
        resourceId: room,
        start: at(1),
      })
    );

    const renamed = unwrap(
      await scheduler.blocks.update({
        fields: { reason: "repair" },
        id: block.id,
      })
    );

    expect(renamed).toStrictEqual({ ...block, reason: "repair" });

    const both = unwrap(
      await scheduler.blocks.update({
        end: at(5),
        fields: { note: null },
        id: block.id,
        start: at(4),
      })
    );

    expect(both).toStrictEqual({
      ...block,
      end: at(5),
      note: null,
      reason: "repair",
      start: at(4),
    });
    expect(
      unwrap(
        await scheduler.blocks.list({
          from: at(0),
          resourceId: room,
          to: at(8),
        })
      )
    ).toStrictEqual([both]);
  });

  it("refuses end <= start as InvalidParams at end, before any Adapter call", async () => {
    const scheduler = createScheduler({
      policies: [],
      adapter: spyAdapter,
      schema,
    });

    const result = await scheduler.blocks.update({
      end: at(1),
      id: mintBlockId(),
      start: at(1),
    });

    expect(errorOf(result)).toMatchObject({
      _tag: "InvalidParams",
      issues: [{ path: ["end"] }],
    });
  });

  it("refuses an unknown id as BlockNotFound", async () => {
    const { scheduler } = await fresh();
    const id = mintBlockId();

    expect(
      errorOf(await scheduler.blocks.update({ ...reason, id }))
    ).toStrictEqual({ _tag: "BlockNotFound", id });
  });

  it("refuses a move onto a blocking Booking as SlotConflict, leaving the Block where it was", async () => {
    const { scheduler } = await fresh();
    const block = await createBlockAt(scheduler, 1, 2);

    const booked = unwrap(
      await scheduler.book({ end: at(4), resourceId: room, start: at(3) })
    );

    const result = await scheduler.blocks.update({
      end: at(3.5),
      id: block.id,
      start: at(2.5),
    });

    expect(errorOf(result)).toStrictEqual({
      _tag: "SlotConflict",
      conflicts: [{ end: at(4), id: booked.id, kind: "booking", start: at(3) }],
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

  it("doesn't re-check overlap on a fields-only update", async () => {
    const { adapter, scheduler } = await fresh();
    const block = await createBlockAt(scheduler, 1, 2);

    // Written outside fasti, so it overlaps the Block (ADR 016 accepts this).
    await adapter(schema).withResourceLock(room, async (locked) => {
      await locked.insertBooking({
        end: at(2),
        id: mintBookingId(),
        resourceId: room,
        start: at(1),
        status: "booked",
      });
    });

    expect(
      unwrap(
        await scheduler.blocks.update({
          fields: { reason: "repair" },
          id: block.id,
        })
      )
    ).toStrictEqual({ ...block, reason: "repair" });
  });

  it("writes nothing when the update changes nothing", async () => {
    const { adapter: inner, scheduler: seed } = await fresh();
    const block = await createBlockAt(seed, 1, 2);

    const scheduler = createScheduler({
      policies: [],
      adapter: wrapLocked(inner, () => ({ updateRecord: refuse })),
      schema,
    });

    for (const params of [
      { id: block.id },
      { ...reason, end: at(2), id: block.id, start: at(1) },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- independent cases, in order.
      expect(unwrap(await scheduler.blocks.update(params))).toStrictEqual(
        block
      );
    }
  });

  it("retries when the Block changed between read and write", async () => {
    const { adapter: inner, scheduler: seed } = await fresh();
    const block = await createBlockAt(seed, 1, 2);
    let calls = 0;

    const scheduler = createScheduler({
      policies: [],
      adapter: wrapLocked(inner, (locked) => ({
        updateRecord: async (table, params) => {
          calls += 1;

          return calls === 1
            ? { ok: false, reason: "changed" }
            : await locked.updateRecord(table, params);
        },
      })),
      schema,
    });

    expect(
      unwrap(
        await scheduler.blocks.update({
          end: at(4),
          id: block.id,
          start: at(3),
        })
      )
    ).toStrictEqual({ ...block, end: at(4), start: at(3) });
    expect(calls).toBe(2);
  });
});

describe("blocks.delete", () => {
  it("frees the time, so a book over the old range succeeds", async () => {
    const { scheduler } = await fresh();
    const block = await createBlockAt(scheduler, 1, 2);

    unwrap(await scheduler.blocks.delete({ id: block.id }));

    expect(
      unwrap(
        await scheduler.blocks.list({
          from: at(0),
          resourceId: room,
          to: at(8),
        })
      )
    ).toStrictEqual([]);
    await expect(
      scheduler.book({ end: at(2), resourceId: room, start: at(1) })
    ).resolves.toMatchObject({ ok: true });
  });

  it("refuses an unknown id as BlockNotFound", async () => {
    const { scheduler } = await fresh();
    const id = mintBlockId();

    expect(errorOf(await scheduler.blocks.delete({ id }))).toStrictEqual({
      _tag: "BlockNotFound",
      id,
    });
  });

  it("gives BlockNotFound when the Adapter reports the Block missing", async () => {
    const { adapter: inner, scheduler: seed } = await fresh();
    const block = await createBlockAt(seed, 1, 2);

    const scheduler = createScheduler({
      policies: [],
      adapter: wrapLocked(inner, () => ({
        deleteRecord: async () =>
          await Promise.resolve({ ok: false, reason: "missing" } as const),
      })),
      schema,
    });

    expect(
      errorOf(await scheduler.blocks.delete({ id: block.id }))
    ).toStrictEqual({ _tag: "BlockNotFound", id: block.id });
  });
});
