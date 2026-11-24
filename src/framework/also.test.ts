import { setTimeout as sleep } from "node:timers/promises";

import { assert, describe, expect, expectTypeOf, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import type { Result } from "../core/result.js";
import type {
  AvailabilityViolation,
  BlockId,
  BookingId,
} from "../core/types.js";
import {
  availability,
  blocks,
  column,
  createScheduler,
  defineSchema,
} from "../index.js";
import type {
  BookError,
  Booking,
  PolicyViolation,
  CancelError,
  CancelValue,
  Scheduler,
  Vetoed,
} from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { uuidIdResources } from "../test-utils/conformance-schemas.js";
import { unwrap } from "../test-utils/results.js";

/** UUID ids, Blocks, and one Transition besides cancel's, so every write Action exists. */
const schema = defineSchema({
  plugins: [availability(), blocks({ fields: {} })],
  booking: {
    statuses: { inProgress: { blocking: true } },
    transitions: { booked: ["inProgress"] },
  },
  resource: { idType: column.uuid() },
});

const [room] = uuidIdResources;

// Monday 3 June 2030, 10:00–11:00 Lisbon (UTC+1).
const start = Temporal.Instant.from("2030-06-03T09:00:00Z");
const end = Temporal.Instant.from("2030-06-03T10:00:00Z");

/** A later slot on the same Monday, 14:00–15:00 Lisbon. */
const later = {
  end: Temporal.Instant.from("2030-06-03T14:00:00Z"),
  start: Temporal.Instant.from("2030-06-03T13:00:00Z"),
};

const weekdays = {
  exceptions: [],
  recurrence: { daysOfWeek: [1, 2, 3, 4, 5], frequency: "weekly", interval: 1 },
  timeWindow: {
    end: Temporal.PlainTime.from("17:00"),
    start: Temporal.PlainTime.from("09:00"),
  },
  timezone: "Europe/Lisbon",
} as const;

/** An `also` context as a test records it: on the memory Adapter, every one has `now` and an undefined `tx`. */
interface SeenContext {
  readonly now: Temporal.Instant;
  readonly tx: undefined;
}

/** Check `now` is an Instant, then compare the whole context, `tx` and `now` included. */
function expectContext<C extends SeenContext>(
  seen: readonly C[],
  expected: Omit<C, "now" | "tx">
) {
  expect(seen).toHaveLength(1);
  const [ctx] = seen;

  expect(ctx?.now).toBeInstanceOf(Temporal.Instant);
  expect(ctx).toStrictEqual({ ...expected, now: ctx?.now, tx: undefined });
}

async function setup() {
  const adapter = memoryAdapter();
  const scheduler = createScheduler({ policies: [], adapter, schema });

  unwrap(
    await scheduler.availability.set({ resourceId: room, rules: [weekdays] })
  );

  return { reads: adapter(schema), scheduler };
}

describe("also on book", () => {
  it("runs after the write with { tx, booking, now } and returns the Booking with `also`", async () => {
    const { scheduler } = await setup();
    const seen: SeenContext[] = [];

    const result = await scheduler.book({
      also: (ctx) => {
        seen.push(ctx);

        return { ok: true, value: "audited" };
      },
      end,
      resourceId: room,
      start,
    });

    const { also, ...booking } = unwrap(result);

    expect(also).toBe("audited");
    expect(booking.status).toBe("booked");
    expectContext(seen, { booking });
  });

  it("gets the `now` read at the start of the unit, before the write", async () => {
    const raw = memoryAdapter();

    unwrap(
      await createScheduler({
        policies: [],
        adapter: raw,
        schema,
      }).availability.set({
        resourceId: room,
        rules: [weekdays],
      })
    );

    let beforeInsert = 0;

    const slowInsert = defineAdapter<undefined, "records">((s) => {
      const inner = raw(s);

      return {
        ...inner,
        withResourceLock: async (id, work) =>
          await inner.withResourceLock(
            id,
            async (locked) =>
              await work({
                ...locked,
                insertBooking: async (booking) => {
                  beforeInsert = Date.now();
                  await sleep(20);

                  return await locked.insertBooking(booking);
                },
              })
          ),
      };
    });

    const result = await createScheduler({
      policies: [],
      adapter: slowInsert,
      schema,
    }).book({
      also: ({ now }) => ({ ok: true, value: now }),
      end,
      resourceId: room,
      start,
    });

    expect(unwrap(result).also.epochMilliseconds).toBeLessThanOrEqual(
      beforeInsert
    );
  });

  it("treats `also: undefined` as no `also`, as the Effect form does", async () => {
    const { scheduler } = await setup();

    // A variable gets past the excess-property check, so this type-checks.
    const params = { also: undefined, end, resourceId: room, start };
    const booked = await scheduler.book(params);

    expect(unwrap(booked)).not.toHaveProperty("also");
  });

  it("rolls the Booking back on a veto and returns Vetoed with the reason", async () => {
    const { reads, scheduler } = await setup();
    const ids: BookingId[] = [];

    const result = await scheduler.book({
      also: ({ booking }) => {
        ids.push(booking.id);

        return { error: "over quota", ok: false };
      },
      end,
      resourceId: room,
      start,
    });

    expect(result).toStrictEqual({
      error: { _tag: "Vetoed", reason: "over quota" },
      ok: false,
    });

    const [id] = ids;

    assert(id !== undefined, "expected `also` to have run");
    await expect(reads.getBooking(id)).resolves.toBeNull();
  });

  it("rejects with what `also` throws, sync or async, and stores nothing", async () => {
    const { reads, scheduler } = await setup();
    const thrown = new Error("audit table is down");
    const ids: BookingId[] = [];

    await expect(
      scheduler.book({
        also: ({ booking }) => {
          ids.push(booking.id);

          throw thrown;
        },
        end,
        resourceId: room,
        start,
      })
    ).rejects.toBe(thrown);

    await expect(
      scheduler.book({
        also: async ({ booking }) => {
          ids.push(booking.id);
          await Promise.resolve();

          throw thrown;
        },
        end,
        resourceId: room,
        start,
      })
    ).rejects.toBe(thrown);

    expect(ids).toHaveLength(2);
    await expect(
      Promise.all(ids.map(async (id) => await reads.getBooking(id)))
    ).resolves.toStrictEqual([null, null]);
  });

  it("never calls `also` when book is refused", async () => {
    const { scheduler } = await setup();

    unwrap(await scheduler.book({ end, resourceId: room, start }));
    let alsoCalls = 0;

    const result = await scheduler.book({
      also: () => {
        alsoCalls += 1;

        return { ok: true, value: null };
      },
      end,
      resourceId: room,
      start,
    });

    expect(result.ok ? null : result.error._tag).toBe("SlotConflict");
    expect(alsoCalls).toBe(0);
  });
});

/** A memory Adapter with `weekdays` that records why each unit rejected, as a transient-retry Adapter would classify it. */
async function recordingRejections() {
  const inner = memoryAdapter();
  const reasons: unknown[] = [];

  unwrap(
    await createScheduler({
      adapter: inner,
      policies: [],
      schema,
    }).availability.set({ resourceId: room, rules: [weekdays] })
  );

  const adapter = defineAdapter<undefined, "records">((s) => {
    const bound = inner(s);

    return {
      ...bound,
      withResourceLock: async (resourceId, work) => {
        try {
          return await bound.withResourceLock(resourceId, work);
        } catch (error) {
          reasons.push(error);

          throw error;
        }
      },
    };
  });

  return { adapter, reasons };
}

describe("what the Adapter sees when a unit fails", () => {
  it("gets what `also` threw, so it can classify it", async () => {
    const { adapter, reasons } = await recordingRejections();
    const scheduler = createScheduler({ policies: [], adapter, schema });
    const thrown = new Error("deadlock detected");

    await expect(
      scheduler.book({
        also: () => {
          throw thrown;
        },
        end,
        resourceId: room,
        start,
      })
    ).rejects.toBe(thrown);
    expect(reasons).toStrictEqual([thrown]);
  });

  it("gets the original rejection behind an AdapterError", async () => {
    const { adapter, reasons } = await recordingRejections();
    const driverError = new Error("serialization failure");

    const failing = defineAdapter<undefined, "records">((s) => {
      const bound = adapter(s);

      return {
        ...bound,
        withResourceLock: async (resourceId, work) =>
          await bound.withResourceLock(
            resourceId,
            async (locked) =>
              await work({
                ...locked,
                listRecords: async () => await Promise.reject(driverError),
              })
          ),
      };
    });

    const result = await createScheduler({
      policies: [],
      adapter: failing,
      schema,
    }).book({
      end,
      resourceId: room,
      start,
    });

    assert(
      !result.ok && result.error._tag === "AdapterError",
      "expected an AdapterError"
    );
    expect(result.error.cause).toBe(driverError);
    expect(reasons).toStrictEqual([driverError]);
  });

  it("gets neither a veto's reason nor fasti's expected failures", async () => {
    const { adapter, reasons } = await recordingRejections();
    const scheduler = createScheduler({ policies: [], adapter, schema });

    const result = await scheduler.book({
      also: () => ({ error: "no", ok: false }),
      end,
      resourceId: room,
      start,
    });

    expect(result.ok).toBeFalsy();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBeInstanceOf(Error);
  });
});

type Seeded = Awaited<ReturnType<typeof seeded>>;

/** `setup` plus one Booking and one Block, and the rules as stored. */
async function seeded() {
  const { reads, scheduler } = await setup();

  const booking = unwrap(
    await scheduler.book({ end, resourceId: room, start })
  );

  const block = unwrap(
    await scheduler.blocks.create({ ...later, resourceId: room })
  );

  const rules = unwrap(await scheduler.availability.get({ resourceId: room }));

  return { block, booking, reads, rules, scheduler };
}

/** The id of a Block the Action created next to the seeded one, or the seeded one's when there is none. */
async function newestBlockId({ block, scheduler }: Seeded): Promise<BlockId> {
  const listed = unwrap(
    await scheduler.blocks.list({
      from: later.start,
      resourceId: room,
      to: later.end,
    })
  );

  return listed.find((b) => b.id !== block.id)?.id ?? block.id;
}

/** One write Action under test: how to call it with `also`, the context it must get, its value, and that a veto left the seed alone. */
interface AlsoCase {
  readonly name: string;
  readonly run: (
    seed: Seeded,
    also: (ctx: SeenContext) => Result<string, string>
  ) => Promise<Result<object, unknown>>;
  /** `minted` is the id of a Block the Action created, if any. */
  readonly context: (seed: Seeded, minted: BlockId) => object;
  /** The value without `also`. */
  readonly value: (seed: Seeded, minted: BlockId) => object;
  readonly unchanged: (seed: Seeded) => Promise<void>;
}

const newRule = {
  ...weekdays,
  timeWindow: {
    end: Temporal.PlainTime.from("12:00"),
    start: Temporal.PlainTime.from("08:00"),
  },
};

const longer = { end: later.end.add({ minutes: 30 }), start: later.start };

/** A free slot on the seeded Monday, 11:00–12:00 Lisbon. */
const free = {
  end: Temporal.Instant.from("2030-06-03T11:00:00Z"),
  start: Temporal.Instant.from("2030-06-03T10:00:00Z"),
};

const cases: readonly AlsoCase[] = [
  {
    context: ({ booking }) => ({
      booking: { ...booking, ...free },
      previous: booking,
    }),
    name: "reschedule",
    run: async ({ booking, scheduler }, also) =>
      await scheduler.reschedule({ ...free, also, id: booking.id }),
    unchanged: async ({ booking, reads }) => {
      await expect(reads.getBooking(booking.id)).resolves.toStrictEqual(
        booking
      );
    },
    value: ({ booking }) => ({ ...booking, ...free }),
  },
  {
    context: ({ booking }) => ({
      booking: { ...booking, status: "inProgress" },
      previous: booking,
    }),
    name: "transition",
    run: async ({ booking, scheduler }, also) =>
      await scheduler.transition({
        also,
        from: "booked",
        id: booking.id,
        to: "inProgress",
      }),
    unchanged: async ({ booking, reads }) => {
      await expect(reads.getBooking(booking.id)).resolves.toStrictEqual(
        booking
      );
    },
    value: ({ booking }) => ({ ...booking, status: "inProgress" }),
  },
  {
    context: ({ booking }) => ({
      booking: { ...booking, status: "cancelled" },
      previous: booking,
    }),
    name: "cancel",
    run: async ({ booking, scheduler }, also) =>
      await scheduler.cancel({ also, id: booking.id }),
    unchanged: async ({ booking, reads }) => {
      await expect(reads.getBooking(booking.id)).resolves.toStrictEqual(
        booking
      );
    },
    value: ({ booking }) => ({
      alreadyCancelled: false,
      booking: { ...booking, status: "cancelled" },
    }),
  },
  {
    context: ({ rules }) => ({
      previous: rules,
      resourceId: room,
      rules: [{ ...newRule, exceptions: [] }],
    }),
    name: "availability.set",
    run: async ({ scheduler }, also) =>
      await scheduler.availability.set({
        also,
        resourceId: room,
        rules: [newRule],
      }),
    unchanged: async ({ rules, scheduler }) => {
      await expect(
        scheduler.availability.get({ resourceId: room })
      ).resolves.toStrictEqual({ ok: true, value: rules });
    },
    value: () => ({ rules: [{ ...newRule, exceptions: [] }] }),
  },
  {
    context: (_seed, minted) => ({
      block: { ...later, id: minted, resourceId: room },
    }),
    name: "blocks.create",
    run: async ({ scheduler }, also) =>
      await scheduler.blocks.create({ ...later, also, resourceId: room }),
    unchanged: async (seed) => {
      await expect(newestBlockId(seed)).resolves.toBe(seed.block.id);
    },
    value: (_seed, minted) => ({ ...later, id: minted, resourceId: room }),
  },
  {
    context: ({ block }) => ({
      block: { ...block, ...longer },
      previous: block,
    }),
    name: "blocks.update",
    run: async ({ block, scheduler }, also) =>
      await scheduler.blocks.update({ ...longer, also, id: block.id }),
    unchanged: async ({ block, reads }) => {
      await expect(reads.getRecord("block", block.id)).resolves.toStrictEqual(
        block
      );
    },
    value: ({ block }) => ({ ...block, ...longer }),
  },
  {
    context: ({ block }) => ({ previous: block }),
    name: "blocks.delete",
    run: async ({ block, scheduler }, also) =>
      await scheduler.blocks.delete({ also, id: block.id }),
    unchanged: async ({ block, reads }) => {
      await expect(reads.getRecord("block", block.id)).resolves.toStrictEqual(
        block
      );
    },
    // void, so the value is `also` alone.
    value: () => ({}),
  },
];

describe.each(cases)("also on $name", (c) => {
  it("gets exactly its context keys plus tx and now, and returns its value with `also`", async () => {
    const seed = await seeded();
    const seen: SeenContext[] = [];

    const result = await c.run(seed, (ctx) => {
      seen.push(ctx);

      return { ok: true, value: "done" };
    });

    const minted = await newestBlockId(seed);

    expectContext(seen, c.context(seed, minted));
    expect(result).toStrictEqual({
      ok: true,
      value: { ...c.value(seed, minted), also: "done" },
    });
  });

  it("rolls its own write back on a veto", async () => {
    const seed = await seeded();

    const result = await c.run(seed, () => ({ error: "no", ok: false }));

    expect(result).toStrictEqual({
      error: { _tag: "Vetoed", reason: "no" },
      ok: false,
    });
    await c.unchanged(seed);
  });
});

describe("also when nothing changes", () => {
  it("skips `also` on a repeat cancel, whose value has no `also` key", async () => {
    const { booking, scheduler } = await seeded();

    unwrap(await scheduler.cancel({ id: booking.id }));
    let alsoCalls = 0;

    const again = await scheduler.cancel({
      also: () => {
        alsoCalls += 1;

        return { ok: true, value: "done" };
      },
      id: booking.id,
    });

    expect(again).toStrictEqual({
      ok: true,
      value: {
        alreadyCancelled: true,
        booking: { ...booking, status: "cancelled" },
      },
    });
    expect(alsoCalls).toBe(0);
  });

  it("runs `also` on a no-op blocks.update, with block === previous", async () => {
    const { block, scheduler } = await seeded();

    const seen: (SeenContext & {
      readonly block: unknown;
      readonly previous: unknown;
    })[] = [];

    const result = await scheduler.blocks.update({
      also: (ctx) => {
        seen.push(ctx);

        return { ok: true, value: "done" };
      },
      id: block.id,
    });

    expect(result).toStrictEqual({
      ok: true,
      value: { ...block, also: "done" },
    });
    expectContext(seen, { block, previous: block });
    expect(seen[0]?.block).toBe(seen[0]?.previous);
  });
});

type S = typeof schema;

/** Never called: only the types each call resolves to are checked. */
function typedCalls(
  scheduler: Scheduler<S, undefined, readonly []>,
  id: BookingId
) {
  return {
    async: scheduler.book({
      also: async ({ booking }) => {
        await Promise.resolve();

        return booking.id === id
          ? { error: "empty" as const, ok: false as const }
          : { ok: true as const, value: 1 };
      },
      end,
      resourceId: room,
      start,
    }),
    cancelAlso: scheduler.cancel({
      also: ({ previous }) =>
        previous.status === "booked"
          ? { ok: true as const, value: "done" as const }
          : { error: "no" as const, ok: false as const },
      id,
    }),
    plain: scheduler.book({ end, resourceId: room, start }),
    sync: scheduler.book({
      also: ({ booking }) =>
        booking.id === id
          ? { error: "no" as const, ok: false as const }
          : { ok: true as const, value: "yes" as const },
      end,
      resourceId: room,
      start,
    }),
  };
}

type Calls = {
  [K in keyof ReturnType<typeof typedCalls>]: Awaited<
    ReturnType<typeof typedCalls>[K]
  >;
};

type Ok<R> = R extends { readonly ok: true; readonly value: infer V }
  ? V
  : never;

type Err<R> = R extends { readonly ok: false; readonly error: infer E }
  ? E
  : never;

/** `book`'s error with no developer Policies: the `availability()` Plugin's only. */
type BookErr = BookError<S> | PolicyViolation<AvailabilityViolation>;

describe("also types", () => {
  it("adds neither an `also` key nor Vetoed without `also`", () => {
    expectTypeOf<Calls["plain"]>().toEqualTypeOf<Result<Booking<S>, BookErr>>();
  });

  it("accepts a sync and an async `also`, adding its value and veto", () => {
    expectTypeOf<Calls["async"]>().toEqualTypeOf<
      Result<Booking<S> & { readonly also: number }, BookErr | Vetoed<"empty">>
    >();
    expectTypeOf<Ok<Calls["sync"]>>().toEqualTypeOf<
      Booking<S> & { readonly also: "yes" }
    >();
    expectTypeOf<Err<Calls["sync"]>>().toEqualTypeOf<BookErr | Vetoed<"no">>();
  });

  it("types cancel's value as a union: only a write carries `also`", () => {
    expectTypeOf<CancelValue<S>>().toEqualTypeOf<
      | { readonly booking: Booking<S>; readonly alreadyCancelled: true }
      | { readonly booking: Booking<S>; readonly alreadyCancelled: false }
    >();
    expectTypeOf<
      Extract<Ok<Calls["cancelAlso"]>, { alreadyCancelled: true }>
    >().toEqualTypeOf<{
      readonly booking: Booking<S>;
      readonly alreadyCancelled: true;
    }>();
    expectTypeOf<
      Extract<Ok<Calls["cancelAlso"]>, { alreadyCancelled: false }>["also"]
    >().toEqualTypeOf<"done">();
    expectTypeOf<Err<Calls["cancelAlso"]>>().toEqualTypeOf<
      CancelError<S> | Vetoed<"no">
    >();
  });
});
