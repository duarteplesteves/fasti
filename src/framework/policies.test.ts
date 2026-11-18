import { assert, describe, expect, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import { AdapterError, createScheduler, definePolicy } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import {
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { unwrap } from "../test-utils/results.js";
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
    await locked.replaceRules({ resourceId: room, rules: [weekdays] });
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
const noCalls = defineAdapter<undefined, "blocks">(() => ({
  getBlock: refuse,
  getBooking: refuse,
  getRules: refuse,
  listBlocks: refuse,
  listBookings: refuse,
  withResourceLock: refuse,
}));

/** A Policy that always breaks, with a fixed detail. */
const closed = definePolicy(schema, {
  appliesTo: ["book"],
  check: () => ({ reason: "closed" }),
  name: "closed",
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

describe("Policy definition", () => {
  it("throws on an empty appliesTo and on the name availability", () => {
    expect(() =>
      definePolicy(schema, {
        // @ts-expect-error -- appliesTo is non-empty by type.
        appliesTo: [],
        check: () => null,
        name: "nowhere",
      })
    ).toThrow("at least one Action");
    expect(() =>
      definePolicy(schema, {
        appliesTo: ["book"],
        check: () => null,
        // @ts-expect-error -- availability is fasti's own.
        name: "availability",
      })
    ).toThrow("availability");
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
