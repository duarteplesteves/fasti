import { describe, expect, expectTypeOf, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import {
  availability,
  blocks,
  createScheduler,
  defineHook,
  definePolicy,
  defineSchema,
} from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { unwrap } from "../test-utils/results.js";
import { mintBookingId } from "./booking-id.js";
import type { AnyHookOf } from "./hook.js";

/** Blocks, and Transitions besides cancel's, so every write Action and edge exists. */
const schema = defineSchema({
  plugins: [availability(), blocks({ fields: {} })],
  booking: {
    statuses: {
      done: { blocking: false },
      inProgress: { blocking: true },
      noShow: { blocking: false },
    },
    transitions: {
      booked: ["inProgress", "noShow"],
      inProgress: ["done"],
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

const slot = { end: at(2), resourceId: "room", start: at(1) } as const;

/** Types `defineHook`'s `tx` only. */
const adapter = memoryAdapter();

type Hooks = readonly AnyHookOf<typeof schema, undefined>[];

/** A scheduler with rules on `room` and one Booking in `slot`, then `hooks` registered: setup fires none. */
async function seeded(hooks: Hooks, raw = memoryAdapter()) {
  const plain = createScheduler({ adapter: raw, schema });

  unwrap(
    await plain.availability.set({ resourceId: "room", rules: [weekdays] })
  );

  const booking = unwrap(await plain.book(slot));

  const block = unwrap(
    await plain.blocks.create({ end: at(4), resourceId: "room", start: at(3) })
  );

  return {
    block,
    booking,
    scheduler: createScheduler({ adapter: raw, hooks, schema }),
  };
}

/** What every Hook event has. */
interface Seen {
  readonly action: string;
  readonly now: Temporal.Instant;
}

/** One in-transaction and one after-commit Hook on `"*"`, recording what each saw. */
function recorders() {
  const inTx: Seen[] = [];
  const after: Seen[] = [];

  const hooks = [
    defineHook(schema, adapter, {
      appliesTo: "*",
      run: (event) => {
        inTx.push(event);
      },
      when: "inTransaction",
    }),
    defineHook(schema, adapter, {
      appliesTo: "*",
      run: (event) => {
        after.push(event);
      },
      when: "afterCommit",
    }),
  ];

  return { after, hooks, inTx };
}

describe("Hooks on every write Action", () => {
  it.each<{
    readonly name: string;
    readonly write: (
      s: Awaited<ReturnType<typeof seeded>>
    ) => Promise<{ readonly ok: boolean }>;
    readonly context: (
      s: Awaited<ReturnType<typeof seeded>>
    ) => object | Promise<object>;
  }>([
    {
      context: ({ booking }) => ({
        action: "reschedule",
        booking: { ...booking, end: at(3), start: at(2) },
        previous: booking,
      }),
      name: "reschedule",
      write: async ({ booking, scheduler }) =>
        await scheduler.reschedule({
          end: at(3),
          id: booking.id,
          start: at(2),
        }),
    },
    {
      context: ({ booking }) => ({
        action: "cancel",
        booking: { ...booking, status: "cancelled" },
        previous: booking,
      }),
      name: "cancel",
      write: async ({ booking, scheduler }) =>
        await scheduler.cancel({ id: booking.id }),
    },
    {
      context: ({ booking }) => ({
        action: "transition",
        booking: { ...booking, status: "inProgress" },
        previous: booking,
      }),
      name: "transition",
      write: async ({ booking, scheduler }) =>
        await scheduler.transition({
          from: "booked",
          id: booking.id,
          to: "inProgress",
        }),
    },
    {
      context: () => ({
        action: "availability.set",
        previous: [weekdays],
        resourceId: "room",
        rules: [],
      }),
      name: "availability.set, clearing to []",
      write: async ({ scheduler }) =>
        await scheduler.availability.set({ resourceId: "room", rules: [] }),
    },
    {
      context: () => ({
        action: "availability.set",
        previous: [weekdays],
        resourceId: "room",
        rules: [weekdays],
      }),
      name: "availability.set",
      write: async ({ scheduler }) =>
        await scheduler.availability.set({
          resourceId: "room",
          rules: [weekdays],
        }),
    },
    {
      context: async ({ scheduler }) => {
        const listed = unwrap(
          await scheduler.blocks.list({
            from: at(5),
            resourceId: "room",
            to: at(6),
          })
        );

        return { action: "blocks.create", block: listed[0] };
      },
      name: "blocks.create",
      write: async ({ scheduler }) =>
        await scheduler.blocks.create({
          end: at(6),
          resourceId: "room",
          start: at(5),
        }),
    },
    {
      context: ({ block }) => ({
        action: "blocks.update",
        block: { ...block, end: at(5) },
        previous: block,
      }),
      name: "blocks.update",
      write: async ({ block, scheduler }) =>
        await scheduler.blocks.update({
          end: at(5),
          id: block.id,
          start: at(3),
        }),
    },
    {
      context: ({ block }) => ({
        action: "blocks.update",
        block,
        previous: block,
      }),
      name: "a no-op blocks.update",
      write: async ({ block, scheduler }) =>
        await scheduler.blocks.update({ id: block.id }),
    },
    {
      context: ({ block }) => ({ action: "blocks.delete", previous: block }),
      name: "blocks.delete",
      write: async ({ block, scheduler }) =>
        await scheduler.blocks.delete({ id: block.id }),
    },
  ])("$name fires its event with `also`'s context", async (c) => {
    const { after, hooks, inTx } = recorders();
    const s = await seeded(hooks);

    const result = await c.write(s);
    const context = await c.context(s);
    const now = after[0]?.now;

    expect(result).toMatchObject({ ok: true });
    expect(now).toBeInstanceOf(Temporal.Instant);
    expect(after).toStrictEqual([{ ...context, now }]);
    expect(inTx).toStrictEqual([{ ...context, now, tx: undefined }]);
  });
});

/** Which of `hooks`' names ran across a reschedule and two transitions: booked → inProgress → done. */
async function ranAcrossWrites(
  named: readonly (readonly [string, Hooks[number]["appliesTo"]])[]
) {
  const ran: string[] = [];

  const { booking, scheduler } = await seeded(
    named.map(([name, appliesTo]) =>
      defineHook(schema, adapter, {
        appliesTo,
        run: ({ action }) => {
          ran.push(`${name}@${action}`);
        },
        when: "afterCommit",
      })
    )
  );

  unwrap(
    await scheduler.reschedule({ end: at(3), id: booking.id, start: at(2) })
  );
  unwrap(
    await scheduler.transition({
      from: "booked",
      id: booking.id,
      to: "inProgress",
    })
  );
  unwrap(
    await scheduler.transition({
      from: "inProgress",
      id: booking.id,
      to: "done",
    })
  );

  return ran;
}

describe("Hook targets", () => {
  it("match only what they name", async () => {
    const ran = await ranAcrossWrites([
      ["book", ["book"]],
      ["toInProgress", [{ to: "inProgress" }]],
      ["inProgressToDone", [{ from: "inProgress", to: "done" }]],
      ["bookedToNoShow", [{ from: "booked", to: "noShow" }]],
      ["all", "*"],
    ]);

    expect(ran).toStrictEqual([
      "all@reschedule",
      "toInProgress@transition",
      "all@transition",
      "inProgressToDone@transition",
      "all@transition",
    ]);
  });

  it("narrow the event's `action` by `appliesTo`", () => {
    defineHook(schema, adapter, {
      appliesTo: ["book", { to: "done" }],
      run: (event) => {
        expectTypeOf(event.action).toEqualTypeOf<"book" | "transition">();
      },
      when: "afterCommit",
    });
    defineHook(schema, adapter, {
      appliesTo: ["blocks.delete"],
      run: (event) => {
        expectTypeOf(event.action).toEqualTypeOf<"blocks.delete">();
      },
      when: "inTransaction",
    });
  });
});

describe("defineHook's target checks", () => {
  const withoutBlocks = defineSchema({
    booking: {
      statuses: { inProgress: { blocking: true } },
      transitions: { booked: ["inProgress"] },
    },
  });

  it.each<readonly [string, () => object, RegExp]>([
    [
      "an empty appliesTo",
      () =>
        defineHook(schema, adapter, {
          // @ts-expect-error at least one target
          appliesTo: [],
          run: () => {},
          when: "afterCommit",
        }),
      /applies to nothing/u,
    ],
    [
      "an unknown name",
      () =>
        defineHook(schema, adapter, {
          // @ts-expect-error not a write Action
          appliesTo: ["findSlots"],
          run: () => {},
          when: "afterCommit",
        }),
      /findSlots, which isn't a write Action/u,
    ],
    [
      "blocks.* on a schema without block",
      () =>
        defineHook(withoutBlocks, memoryAdapter(), {
          // @ts-expect-error no Blocks on this schema
          appliesTo: ["blocks.create"],
          run: () => {},
          when: "afterCommit",
        }),
      /blocks\.create, but the schema has no block/u,
    ],
    [
      "an undeclared edge",
      () =>
        defineHook(schema, adapter, {
          // @ts-expect-error done → booked isn't declared
          appliesTo: [{ from: "done", to: "booked" }],
          run: () => {},
          when: "afterCommit",
        }),
      /done → booked, which isn't a declared Transition/u,
    ],
    [
      "an edge into cancelled",
      () =>
        defineHook(schema, adapter, {
          // @ts-expect-error cancelled belongs to cancel
          appliesTo: [{ to: "cancelled" }],
          run: () => {},
          when: "afterCommit",
        }),
      /\* → cancelled, which isn't a declared Transition/u,
    ],
  ])("throws on %s", (_, define, message) => {
    expect(define).toThrow(message);
  });

  it("a Policy can't name availability.set or blocks.*", () => {
    expect(() =>
      definePolicy(schema, {
        // @ts-expect-error Policies are Booking-only
        appliesTo: ["availability.set"],
        check: () => null,
        name: "rules",
      })
    ).toThrow(/availability\.set/u);
    expect(() =>
      definePolicy(schema, {
        // @ts-expect-error Policies are Booking-only
        appliesTo: ["blocks.create"],
        check: () => null,
        name: "blocks",
      })
    ).toThrow(/blocks\.create/u);
  });
});

describe("no Hook runs", () => {
  const failing = new Set([
    "Vetoed",
    "SlotConflict",
    "PolicyViolation",
    "InvalidParams",
    "BookingNotFound",
  ]);

  const refuse = definePolicy(schema, {
    appliesTo: ["book"],
    check: () => ({ reason: "closed" }),
    name: "closed",
  });

  /** A scheduler whose one Policy refuses every `book`. */
  function refusingOver(raw: ReturnType<typeof memoryAdapter>, hooks: Hooks) {
    return createScheduler({ adapter: raw, hooks, policies: [refuse], schema });
  }

  it.each<{
    readonly name: string;
    readonly call: (
      s: Awaited<ReturnType<typeof seeded>>,
      refusing: ReturnType<typeof refusingOver>
    ) => Promise<{ readonly ok: boolean }>;
  }>([
    {
      call: async ({ scheduler }) =>
        await scheduler.book({
          ...slot,
          also: () => ({ error: "over quota", ok: false }),
          end: at(6),
          start: at(5),
        }),
      name: "Vetoed",
    },
    {
      call: async ({ scheduler }) => await scheduler.book(slot),
      name: "SlotConflict",
    },
    {
      call: async (_, refusing) =>
        await refusing.book({ ...slot, end: at(6), start: at(5) }),
      name: "PolicyViolation",
    },
    {
      call: async ({ scheduler }) =>
        await scheduler.book({ ...slot, end: at(1), start: at(2) }),
      name: "InvalidParams",
    },
    {
      call: async ({ scheduler }) =>
        await scheduler.transition({
          from: "inProgress",
          id: mintBookingId(),
          to: "done",
        }),
      name: "BookingNotFound",
    },
    {
      call: async ({ booking, scheduler }) =>
        await scheduler.cancel({ id: booking.id }),
      name: "a repeat cancel",
    },
    {
      call: async ({ scheduler }) =>
        await scheduler.findSlots({
          duration: 60,
          from: at(0),
          interval: 30,
          resourceId: "room",
          timezone: "Europe/Lisbon",
          to: at(8),
        }),
      name: "findSlots",
    },
    {
      call: async ({ scheduler }) =>
        await scheduler.availability.get({ resourceId: "room" }),
      name: "availability.get",
    },
    {
      call: async ({ scheduler }) =>
        await scheduler.blocks.list({
          from: at(0),
          resourceId: "room",
          to: at(8),
        }),
      name: "blocks.list",
    },
  ])("on $name", async ({ call, name }) => {
    const raw = memoryAdapter();
    const s = await seeded([], raw);

    if (name === "a repeat cancel") {
      unwrap(await s.scheduler.cancel({ id: s.booking.id }));
    }

    const { after, hooks, inTx } = recorders();
    const scheduler = createScheduler({ adapter: raw, hooks, schema });
    const refusing = refusingOver(raw, hooks);

    const result = await call({ ...s, scheduler }, refusing);

    expect(result).toMatchObject({ ok: !failing.has(name) });
    expect([...inTx, ...after]).toStrictEqual([]);
  });
});

describe("a lock-by-id retry", () => {
  it("runs the after-commit Hook once, and the result is ok", async () => {
    const inner = memoryAdapter();
    const { booking } = await seeded([], inner);
    const outside = createScheduler({ adapter: inner, schema });
    let moves = 0;

    unwrap(
      await outside.availability.set({ resourceId: "other", rules: [weekdays] })
    );

    // Moves the Booking to `other` once, between the unlocked read and the lock: the lock on `room` then finds it gone.
    const raced = defineAdapter<undefined, "records">((s) => {
      const raw = inner(s);

      return {
        ...raw,
        withResourceLock: async (id, work) => {
          if (moves === 0) {
            moves += 1;
            unwrap(
              await outside.reschedule({
                ...slot,
                id: booking.id,
                resourceId: "other",
              })
            );
          }

          return await raw.withResourceLock(id, work);
        },
      };
    });

    const { after, hooks } = recorders();
    const scheduler = createScheduler({ adapter: raced, hooks, schema });

    const result = await scheduler.cancel({ id: booking.id });

    expect(moves).toBe(1);
    expect(unwrap(result).booking.resourceId).toBe("other");
    expect(after.map(({ action }) => action)).toStrictEqual(["cancel"]);
  });

  it("gives up with AdapterError when an outside writer moves the row before every lock", async () => {
    const inner = memoryAdapter();
    const { booking } = await seeded([], inner);
    const outside = createScheduler({ adapter: inner, schema });
    let moves = 0;

    unwrap(
      await outside.availability.set({ resourceId: "other", rules: [weekdays] })
    );

    // Every lock first moves the Booking to the other Resource, so the locked read never matches the unlocked one.
    const churned = defineAdapter<undefined, "records">((s) => {
      const raw = inner(s);

      return {
        ...raw,
        withResourceLock: async (id, work) => {
          moves += 1;
          unwrap(
            await outside.reschedule({
              ...slot,
              id: booking.id,
              resourceId: moves % 2 === 1 ? "other" : "room",
            })
          );

          return await raw.withResourceLock(id, work);
        },
      };
    });

    const { after, hooks } = recorders();
    const scheduler = createScheduler({ adapter: churned, hooks, schema });

    const result = await scheduler.cancel({ id: booking.id });

    expect(moves).toBe(3);
    expect(result).toMatchObject({
      error: { _tag: "AdapterError" },
      ok: false,
    });
    expect(after).toStrictEqual([]);
  });
});
