import { assert, describe, expect, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import {
  AdapterError,
  availability,
  createScheduler,
  definePolicy,
  defineSchema,
} from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import {
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { unwrap } from "../test-utils/results.js";
import { replaceRules } from "../testing/plugin-stores.js";
import { mintBookingId } from "./booking-id.js";

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

  await adapter(schema).withResourceLock(room, async (locked) => {
    await replaceRules(locked, { resourceId: room, rules: [weekdays] });
  });

  return adapter;
}

/** Every Booking stored on `room` around the test slot. */
async function stored(adapter: ReturnType<typeof memoryAdapter>) {
  return await adapter(schema).listBookings({
    overlapping: {
      from: start.subtract({ hours: 24 }),
      to: end.add({ hours: 24 }),
    },
    resourceId: room,
  });
}

/** A verb that must never be called. */
// oxlint-disable-next-line require-await -- a verb must return a promise.
async function refuse(): Promise<never> {
  throw new Error("no Adapter call expected");
}

/** Every verb and the lock refuse: proves a call reached no Adapter. */
const noCalls = defineAdapter<undefined, "records">(() => ({
  getRecord: refuse,
  getBooking: refuse,
  getRules: refuse,
  listRecords: refuse,
  listBookings: refuse,
  withResourceLock: refuse,
}));

/** A Policy that always breaks, with a fixed detail. */
const closed = definePolicy(schema, {
  appliesTo: ["book"],
  check: () => ({ reason: "closed" }),
  name: "closed",
});

describe("without policies", () => {
  it("books, reschedules and cancels as with policies: [], the Invariants and availability still applying", async () => {
    const adapter = await seeded();
    const scheduler = createScheduler({ adapter, schema });

    const booking = unwrap(
      await scheduler.book({ end, resourceId: room, start })
    );

    await expect(
      scheduler.book({
        end: end.add({ hours: 120 }),
        resourceId: room,
        start: start.add({ hours: 120 }),
      })
    ).resolves.toStrictEqual({
      error: {
        _tag: "PolicyViolation",
        violations: [{ detail: {}, policy: "availability" }],
      },
      ok: false,
    });
    await expect(
      scheduler.book({ end, resourceId: room, start })
    ).resolves.toMatchObject({ error: { _tag: "SlotConflict" }, ok: false });

    const moved = unwrap(
      await scheduler.reschedule({
        end: end.add({ hours: 1 }),
        id: booking.id,
        start: start.add({ hours: 1 }),
      })
    );

    const cancelled = unwrap(await scheduler.cancel({ id: booking.id }));

    expect(moved.start).toStrictEqual(start.add({ hours: 1 }));
    expect(cancelled.alreadyCancelled).toBeFalsy();
  });
});

describe("Policies on book", () => {
  it("refuses with PolicyViolation carrying the broken Policy's detail, and stores nothing", async () => {
    const adapter = await seeded();
    const scheduler = createScheduler({ adapter, policies: [closed], schema });

    const result = await scheduler.book({ end, resourceId: room, start });

    expect(result).toStrictEqual({
      error: {
        _tag: "PolicyViolation",
        violations: [{ detail: { reason: "closed" }, policy: "closed" }],
      },
      ok: false,
    });
    await expect(stored(adapter)).resolves.toStrictEqual([]);
  });

  it("reports availability and a developer Policy together, availability first", async () => {
    const scheduler = createScheduler({
      adapter: await seeded(),
      policies: [closed],
      schema,
    });

    // Saturday 8 June 2030, outside the weekday rules.
    const result = await scheduler.book({
      end: end.add({ hours: 120 }),
      resourceId: room,
      start: start.add({ hours: 120 }),
    });

    expect(result).toStrictEqual({
      error: {
        _tag: "PolicyViolation",
        violations: [
          { detail: {}, policy: "availability" },
          { detail: { reason: "closed" }, policy: "closed" },
        ],
      },
      ok: false,
    });
  });

  it("reports an overlap that also breaks a Policy as SlotConflict alone", async () => {
    const adapter = await seeded();

    const first = unwrap(
      await createScheduler({ adapter, policies: [], schema }).book({
        end,
        resourceId: room,
        start,
      })
    );

    const result = await createScheduler({
      adapter,
      policies: [closed],
      schema,
    }).book({ end, resourceId: room, start });

    expect(result).toStrictEqual({
      error: {
        _tag: "SlotConflict",
        conflicts: [{ end, id: first.id, kind: "booking", start }],
      },
      ok: false,
    });
  });

  it("runs load once per call, under the lock, with the candidate's range and the now that also sees", async () => {
    const loads: unknown[] = [];
    const seen: Temporal.Instant[] = [];

    const recorded = definePolicy(schema, {
      appliesTo: ["book"],
      check: (candidate, data: string) => {
        seen.push(candidate.now);

        return data === "ok" ? null : { data };
      },
      load: ({ from, now, resourceId, to }) => {
        loads.push({ from, now, resourceId, to });

        return "ok";
      },
      name: "recorded",
    });

    const result = await createScheduler({
      adapter: await seeded(),
      policies: [recorded],
      schema,
    }).book({
      also: ({ now }) => ({ ok: true, value: now }),
      end,
      resourceId: room,
      start,
    });

    const { also } = unwrap(result);

    expect(loads).toStrictEqual([
      { from: start, now: also, resourceId: room, to: end },
    ]);
    expect(seen).toStrictEqual([also]);
  });

  it("returns AdapterError when a read in load fails, and stores nothing", async () => {
    const inner = await seeded();
    const failure = new Error("connection lost");

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
                getBooking: async () => await Promise.reject(failure),
              })
          ),
      };
    });

    const reading = definePolicy(schema, {
      appliesTo: ["book"],
      check: () => null,
      load: async ({ reads }) => await reads.getBooking(mintBookingId()),
      name: "reading",
    });

    const result = await createScheduler({
      adapter,
      policies: [reading],
      schema,
    }).book({ end, resourceId: room, start });

    assert(!result.ok, "expected an error");
    expect(result.error).toBeInstanceOf(AdapterError);
    expect(result.error).toMatchObject({ cause: failure });
    await expect(stored(inner)).resolves.toStrictEqual([]);
  });

  it.each([
    {
      policy: definePolicy(schema, {
        appliesTo: ["book"],
        check: () => null,
        load: async () => await Promise.reject(new Error("load bug")),
        name: "loadThrows",
      }),
      thrown: "load bug",
    },
    {
      policy: definePolicy(schema, {
        appliesTo: ["book"],
        check: () => {
          throw new Error("check bug");
        },
        name: "checkThrows",
      }),
      thrown: "check bug",
    },
  ])(
    "rejects on a throw in $policy.name, as a defect, and stores nothing",
    async ({ policy, thrown }) => {
      const adapter = await seeded();

      const scheduler = createScheduler({
        adapter,
        policies: [policy],
        schema,
      });

      await expect(
        scheduler.book({ end, resourceId: room, start })
      ).rejects.toThrow(thrown);
      await expect(stored(adapter)).resolves.toStrictEqual([]);
    }
  );
});

describe("relax on book", () => {
  it("succeeds with the relaxed Policy's Violation as waived, and stores the Booking", async () => {
    const adapter = await seeded();
    const scheduler = createScheduler({ adapter, policies: [closed], schema });

    const booking = unwrap(
      await scheduler.book({ end, relax: ["closed"], resourceId: room, start })
    );

    expect(booking.waived).toStrictEqual([
      { detail: { reason: "closed" }, policy: "closed" },
    ]);
    await expect(stored(adapter)).resolves.toHaveLength(1);
  });

  it("still refuses with only the unrelaxed Violations", async () => {
    const scheduler = createScheduler({
      adapter: await seeded(),
      policies: [closed],
      schema,
    });

    // Saturday 8 June 2030, outside the weekday rules.
    const result = await scheduler.book({
      end: end.add({ hours: 120 }),
      relax: ["closed"],
      resourceId: room,
      start: start.add({ hours: 120 }),
    });

    expect(result).toStrictEqual({
      error: {
        _tag: "PolicyViolation",
        violations: [{ detail: {}, policy: "availability" }],
      },
      ok: false,
    });
  });

  it("gives waived: [] when nothing relaxed broke, and no waived key without relax", async () => {
    const adapter = await seeded();
    const scheduler = createScheduler({ adapter, policies: [], schema });

    const relaxed = unwrap(
      await scheduler.book({
        end,
        relax: ["availability"],
        resourceId: room,
        start,
      })
    );

    const plain = unwrap(
      await scheduler.book({
        end: end.add({ hours: 1 }),
        resourceId: room,
        start: start.add({ hours: 1 }),
      })
    );

    expect(relaxed.waived).toStrictEqual([]);
    expect(plain).not.toHaveProperty("waived");
  });

  it("books outside hours when availability is relaxed", async () => {
    const scheduler = createScheduler({
      adapter: await seeded(),
      policies: [],
      schema,
    });

    const booking = unwrap(
      await scheduler.book({
        end: end.add({ hours: 120 }),
        relax: ["availability"],
        resourceId: room,
        start: start.add({ hours: 120 }),
      })
    );

    expect(booking.waived).toStrictEqual([
      { detail: {}, policy: "availability" },
    ]);
  });

  it("refuses an unknown name as InvalidParams at its index, before any Adapter call", async () => {
    const scheduler = createScheduler({
      adapter: noCalls,
      policies: [closed],
      schema,
    });

    const result = await scheduler.book({
      end,
      // @ts-expect-error -- relax takes only names that apply to book.
      relax: ["nope", "closed"],
      resourceId: room,
      start,
    });

    expect(result).toStrictEqual({
      error: {
        _tag: "InvalidParams",
        issues: [
          {
            message: "relax: nope is not a Policy that applies to book",
            path: ["relax", 0],
          },
        ],
      },
      ok: false,
    });
  });
});

/** A Policy on `reschedule` and `cancel` that always breaks, recording each candidate it sees. */
function closedFor<const T extends "reschedule" | "cancel">(appliesTo: T) {
  const seen: unknown[] = [];

  const policy = definePolicy(schema, {
    appliesTo: [appliesTo],
    check: (candidate) => {
      seen.push(candidate);

      return { reason: "closed" };
    },
    name: "closed",
  });

  return { policy, seen };
}

/** A seeded Adapter with one Booking in the test slot. */
async function withBooking() {
  const adapter = await seeded();

  const booking = unwrap(
    await createScheduler({ adapter, policies: [], schema }).book({
      end,
      resourceId: room,
      start,
    })
  );

  return { adapter, booking };
}

describe("Policies on reschedule", () => {
  it("gives a Policy the destination Resource and previous, and refuses with its Violation", async () => {
    const { policy, seen } = closedFor("reschedule");
    const { adapter, booking } = await withBooking();
    const scheduler = createScheduler({ adapter, policies: [policy], schema });

    const later = {
      end: end.add({ hours: 1 }),
      start: start.add({ hours: 1 }),
    };

    const result = await scheduler.reschedule({ ...later, id: booking.id });

    expect(result).toStrictEqual({
      error: {
        _tag: "PolicyViolation",
        violations: [{ detail: { reason: "closed" }, policy: "closed" }],
      },
      ok: false,
    });
    expect(seen).toMatchObject([
      {
        action: "reschedule",
        end: later.end,
        previous: booking,
        resourceId: room,
        start: later.start,
      },
    ]);
    await expect(stored(adapter)).resolves.toStrictEqual([booking]);
  });

  it("moves outside hours with availability relaxed, and reports it waived", async () => {
    const { adapter, booking } = await withBooking();
    const scheduler = createScheduler({ adapter, policies: [], schema });

    // Saturday 8 June 2030, outside the weekday rules.
    const moved = unwrap(
      await scheduler.reschedule({
        end: end.add({ hours: 120 }),
        id: booking.id,
        relax: ["availability"],
        start: start.add({ hours: 120 }),
      })
    );

    expect(moved.waived).toStrictEqual([
      { detail: {}, policy: "availability" },
    ]);
    expect(moved.start).toStrictEqual(start.add({ hours: 120 }));
  });

  it("reports an overlap that also breaks a Policy as SlotConflict alone", async () => {
    const { policy, seen } = closedFor("reschedule");
    const { adapter, booking } = await withBooking();

    const later = {
      end: end.add({ hours: 1 }),
      start: start.add({ hours: 1 }),
    };

    const other = unwrap(
      await createScheduler({ adapter, policies: [], schema }).book({
        ...later,
        resourceId: room,
      })
    );

    const result = await createScheduler({
      adapter,
      policies: [policy],
      schema,
    }).reschedule({ ...later, id: booking.id });

    expect(result).toStrictEqual({
      error: {
        _tag: "SlotConflict",
        conflicts: [{ ...later, id: other.id, kind: "booking" }],
      },
      ok: false,
    });
    expect(seen).toStrictEqual([]);
  });

  it("gives StatusMismatch for a non-blocking Booking, even when a Policy would also break", async () => {
    const { policy, seen } = closedFor("reschedule");
    const { adapter, booking } = await withBooking();
    const scheduler = createScheduler({ adapter, policies: [policy], schema });

    unwrap(await scheduler.cancel({ id: booking.id }));

    const result = await scheduler.reschedule({ end, id: booking.id, start });

    expect(result).toStrictEqual({
      error: { _tag: "StatusMismatch", id: booking.id, status: "cancelled" },
      ok: false,
    });
    expect(seen).toStrictEqual([]);
  });

  it("refuses a relax name that doesn't apply to reschedule as InvalidParams, before any Adapter call", async () => {
    const result = await createScheduler({
      adapter: noCalls,
      policies: [closed],
      schema,
    }).reschedule({
      end,
      id: mintBookingId(),
      // @ts-expect-error -- `closed` applies to book only.
      relax: ["closed"],
      start,
    });

    expect(result).toStrictEqual({
      error: {
        _tag: "InvalidParams",
        issues: [
          {
            message: "relax: closed is not a Policy that applies to reschedule",
            path: ["relax", 0],
          },
        ],
      },
      ok: false,
    });
  });
});

describe("Policies on cancel", () => {
  it("gives a Policy the stored Booking and its range in load, and refuses", async () => {
    const loads: unknown[] = [];
    const seen: unknown[] = [];

    const recorded = definePolicy(schema, {
      appliesTo: ["cancel"],
      check: (candidate) => {
        seen.push(candidate);

        return { reason: "closed" };
      },
      load: ({ from, resourceId, to }) => {
        loads.push({ from, resourceId, to });
      },
      name: "recorded",
    });

    const { adapter, booking } = await withBooking();

    const scheduler = createScheduler({
      adapter,
      policies: [recorded],
      schema,
    });

    const result = await scheduler.cancel({ id: booking.id });

    expect(result).toStrictEqual({
      error: {
        _tag: "PolicyViolation",
        violations: [{ detail: { reason: "closed" }, policy: "recorded" }],
      },
      ok: false,
    });
    expect(loads).toStrictEqual([{ from: start, resourceId: room, to: end }]);
    expect(seen).toMatchObject([{ action: "cancel", booking }]);
    await expect(stored(adapter)).resolves.toStrictEqual([booking]);
  });

  it("cancels with the Policy relaxed, and reports it waived", async () => {
    const { policy } = closedFor("cancel");
    const { adapter, booking } = await withBooking();
    const scheduler = createScheduler({ adapter, policies: [policy], schema });

    const value = unwrap(
      await scheduler.cancel({ id: booking.id, relax: ["closed"] })
    );

    expect(value).toStrictEqual({
      alreadyCancelled: false,
      booking: { ...booking, status: "cancelled" },
      waived: [{ detail: { reason: "closed" }, policy: "closed" }],
    });
  });

  it("runs no Policy and no also on a repeat cancel", async () => {
    const { policy, seen } = closedFor("cancel");
    const { adapter, booking } = await withBooking();
    const scheduler = createScheduler({ adapter, policies: [policy], schema });
    let alsoRuns = 0;

    unwrap(await scheduler.cancel({ id: booking.id, relax: ["closed"] }));
    seen.length = 0;

    const repeat = unwrap(
      await scheduler.cancel({
        also: () => {
          alsoRuns += 1;

          return { ok: true, value: null };
        },
        id: booking.id,
        relax: ["closed"],
      })
    );

    expect(repeat).toStrictEqual({
      alreadyCancelled: true,
      booking: { ...booking, status: "cancelled" },
    });
    expect(seen).toStrictEqual([]);
    expect(alsoRuns).toBe(0);
  });

  it("gives TransitionNotDeclared before any Policy", async () => {
    const started = defineSchema({
      plugins: [availability()],
      booking: {
        initial: ["inProgress"],
        statuses: { inProgress: { blocking: true } },
        transitions: { booked: ["inProgress"] },
      },
    });

    let checks = 0;

    const counted = definePolicy(started, {
      appliesTo: ["cancel"],
      check: () => {
        checks += 1;

        return { reason: "closed" };
      },
      name: "counted",
    });

    const scheduler = createScheduler({
      adapter: memoryAdapter(),
      policies: [counted],
      schema: started,
    });

    const booking = unwrap(
      await scheduler.book({
        end,
        relax: ["availability"],
        resourceId: "room",
        start,
      })
    );

    const result = await scheduler.cancel({ id: booking.id });

    expect(result).toStrictEqual({
      error: {
        _tag: "TransitionNotDeclared",
        from: "inProgress",
        id: booking.id,
        to: "cancelled",
      },
      ok: false,
    });
    expect(checks).toBe(0);
  });

  it("refuses a relax name that doesn't apply to cancel as InvalidParams, before any Adapter call", async () => {
    const result = await createScheduler({
      adapter: noCalls,
      policies: [closed],
      schema,
    }).cancel({
      id: mintBookingId(),
      // @ts-expect-error -- no Policy applies to cancel, so it takes no relax.
      relax: ["availability"],
    });

    expect(result).toStrictEqual({
      error: {
        _tag: "InvalidParams",
        issues: [
          {
            message:
              "relax: availability is not a Policy that applies to cancel",
            path: ["relax", 0],
          },
        ],
      },
      ok: false,
    });
  });
});

describe("Policy definition", () => {
  it("throws on an empty appliesTo, and on an app Policy named like availability()'s", () => {
    expect(() =>
      definePolicy(schema, {
        // @ts-expect-error -- appliesTo is non-empty by type.
        appliesTo: [],
        check: () => null,
        name: "nowhere",
      })
    ).toThrow("at least one Action");

    // `availability` is availability()'s Policy now: the clash is found when the scheduler is built.
    const clash = definePolicy(schema, {
      appliesTo: ["book"],
      check: () => null,
      name: "availability",
    });

    expect(() =>
      createScheduler({
        adapter: memoryAdapter(),
        // @ts-expect-error -- availability() already has a Policy named availability.
        policies: [clash],
        schema,
      })
    ).toThrow("two Policies are named availability");
  });

  it("throws on two Policies with one name", () => {
    expect(() =>
      createScheduler({
        adapter: memoryAdapter(),
        // @ts-expect-error -- names must be unique.
        policies: [closed, closed],
        schema,
      })
    ).toThrow("two Policies are named closed");
  });
});
