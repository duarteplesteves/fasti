import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type { Adapter } from "../adapter/contract.js";
import type { TxOf } from "../effect/index.js";
import { column, createScheduler, defineHook, defineSchema } from "../index.js";
import type { Booking } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { uuidIdResources } from "../test-utils/conformance-schemas.js";
import { unwrap } from "../test-utils/results.js";
import type { AnyHookOf } from "./hook.js";

const schema = defineSchema({
  booking: {},
  resource: { idType: column.uuid() },
});

const [room] = uuidIdResources;

// Monday 3 June 2030, 10:00–11:00 Lisbon (UTC+1).
const slot = {
  end: Temporal.Instant.from("2030-06-03T10:00:00Z"),
  resourceId: room,
  start: Temporal.Instant.from("2030-06-03T09:00:00Z"),
} as const;

const weekdays = {
  exceptions: [],
  recurrence: { daysOfWeek: [1, 2, 3, 4, 5], frequency: "weekly", interval: 1 },
  timeWindow: {
    end: Temporal.PlainTime.from("17:00"),
    start: Temporal.PlainTime.from("09:00"),
  },
  timezone: "Europe/Lisbon",
} as const;

/** Types `defineHook`'s `tx` only; each test's scheduler gets a fresh one. */
const adapter = memoryAdapter();

/** A scheduler over `raw` with `hooks`, and rules on `room`. */
async function setup(
  hooks: readonly AnyHookOf<typeof schema, undefined>[],
  raw = memoryAdapter()
) {
  const scheduler = createScheduler({ adapter: raw, hooks, schema });

  unwrap(
    await scheduler.availability.set({ resourceId: room, rules: [weekdays] })
  );

  return { reads: raw(schema), scheduler };
}

/** A book event as a Hook saw it. */
interface SeenBook {
  readonly action: "book";
  readonly booking: Booking<typeof schema>;
  readonly now: Temporal.Instant;
}

describe("in-transaction Hooks on book", () => {
  it("get { action, booking, tx, now }, the Booking as saved", async () => {
    const seen: (SeenBook & { readonly tx: undefined })[] = [];

    const hook = defineHook(schema, adapter, {
      appliesTo: ["book"],
      run: (event) => {
        seen.push(event);
      },
      when: "inTransaction",
    });

    const { scheduler } = await setup([hook]);

    const booking = unwrap(await scheduler.book(slot));

    const [event] = seen;

    expect(seen).toHaveLength(1);
    expect(event?.now).toBeInstanceOf(Temporal.Instant);
    expect(event).toStrictEqual({
      action: "book",
      booking,
      now: event?.now,
      tx: undefined,
    });
  });
});

describe("after-commit Hooks on book", () => {
  it("run after the commit, without `tx`, and have finished when book resolves", async () => {
    const raw = memoryAdapter();
    const reads = raw(schema);
    const seen: { readonly event: SeenBook; readonly stored: unknown }[] = [];

    const hook = defineHook(schema, adapter, {
      appliesTo: ["book"],
      run: async (event) => {
        // A tick first: book must await the Hook, not just start it.
        await Promise.resolve();
        seen.push({ event, stored: await reads.getBooking(event.booking.id) });
      },
      when: "afterCommit",
    });

    const { scheduler } = await setup([hook], raw);

    const booking = unwrap(await scheduler.book(slot));

    const [first] = seen;

    expect(seen).toHaveLength(1);
    expect(first?.event).toStrictEqual({
      action: "book",
      booking,
      now: first?.event.now,
    });
    expect(first?.event).not.toHaveProperty("tx");
    expect(first?.stored).toMatchObject({ id: booking.id });
  });
});

describe("Hook order", () => {
  it("is also, in-transaction Hooks in order, then after-commit Hooks in order", async () => {
    const log: string[] = [];

    function push(name: string) {
      return () => {
        log.push(name);
      };
    }

    const hooks = [
      defineHook(schema, adapter, {
        appliesTo: ["book"],
        run: push("after1"),
        when: "afterCommit",
      }),
      defineHook(schema, adapter, {
        appliesTo: ["book"],
        run: push("in1"),
        when: "inTransaction",
      }),
      defineHook(schema, adapter, {
        appliesTo: ["book"],
        run: push("after2"),
        when: "afterCommit",
      }),
      defineHook(schema, adapter, {
        appliesTo: ["book"],
        run: push("in2"),
        when: "inTransaction",
      }),
    ];

    const { scheduler } = await setup(hooks);

    const result = await scheduler.book({
      ...slot,
      also: () => {
        log.push("also");

        return { ok: true, value: "audited" };
      },
    });

    expect(unwrap(result).also).toBe("audited");
    expect(log).toStrictEqual(["also", "in1", "in2", "after1", "after2"]);
  });

  it("runs Hooks with no `also`, and the value has no `also` key", async () => {
    const log: string[] = [];

    const hooks = [
      defineHook(schema, adapter, {
        appliesTo: ["book"],
        run: () => {
          log.push("inTransaction");
        },
        when: "inTransaction",
      }),
      defineHook(schema, adapter, {
        appliesTo: ["book"],
        run: () => {
          log.push("afterCommit");
        },
        when: "afterCommit",
      }),
    ];

    const { scheduler } = await setup(hooks);

    const booking = unwrap(await scheduler.book(slot));

    expect(log).toStrictEqual(["inTransaction", "afterCommit"]);
    expect(booking).not.toHaveProperty("also");
  });
});

describe("Hook failures", () => {
  const thrown = new Error("no");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      "sync",
      () => {
        throw thrown;
      },
    ],
    [
      "async",
      async () => {
        await Promise.resolve();
        throw thrown;
      },
    ],
  ] as const)(
    "an in-transaction Hook's %s throw rejects book with it and stores no Booking",
    async (_, run) => {
      const after = vi.fn<() => void>();

      const { reads, scheduler } = await setup([
        defineHook(schema, adapter, {
          appliesTo: ["book"],
          run,
          when: "inTransaction",
        }),
        defineHook(schema, adapter, {
          appliesTo: ["book"],
          run: after,
          when: "afterCommit",
        }),
      ]);

      await expect(scheduler.book(slot)).rejects.toBe(thrown);

      expect(after).not.toHaveBeenCalled();
      await expect(
        reads.listBookings({
          overlapping: { from: slot.start, to: slot.end },
          resourceId: room,
        })
      ).resolves.toStrictEqual([]);
    }
  );

  it("an after-commit Hook's throw is logged, the next still runs, and the result is unchanged", async () => {
    // Effect's default logger writes to console.log.
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const second = vi.fn<() => void>();

    const { scheduler } = await setup([
      defineHook(schema, adapter, {
        appliesTo: ["book"],
        run: () => {
          throw new Error("mail server down");
        },
        when: "afterCommit",
      }),
      defineHook(schema, adapter, {
        appliesTo: ["book"],
        run: second,
        when: "afterCommit",
      }),
    ]);

    const booking = unwrap(await scheduler.book(slot));

    expect(booking.status).toBe("booked");
    expect(booking).not.toHaveProperty("also");
    expect(second).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls)).toContain("mail server down");
  });
});

describe("Hook types", () => {
  it("types `tx` as the Adapter's, and leaves it out after the commit", () => {
    interface DbTx {
      readonly db: "tx";
    }

    /** Type-checked only: never called. */
    function hooksOver(dbAdapter: Adapter<DbTx>) {
      return [
        defineHook(schema, dbAdapter, {
          appliesTo: ["book"],
          run: (event) => {
            expectTypeOf(event.tx).toEqualTypeOf<TxOf<typeof dbAdapter>>();
            expectTypeOf(event.action).toEqualTypeOf<"book">();
          },
          when: "inTransaction",
        }),
        defineHook(schema, dbAdapter, {
          appliesTo: ["book"],
          run: (event) => {
            expectTypeOf(event).not.toHaveProperty("tx");
            expectTypeOf(event.action).toEqualTypeOf<"book">();
          },
          when: "afterCommit",
        }),
      ];
    }

    expectTypeOf(hooksOver).returns.items.toHaveProperty("run");
  });
});
