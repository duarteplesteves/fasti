import { describe, expect, expectTypeOf, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import {
  column,
  createScheduler,
  definePolicy,
  defineSchema,
} from "../index.js";
import type {
  Booking,
  PolicyViolation,
  TransitionError,
  Violation,
} from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { uuidIdSchema } from "../test-utils/conformance-schemas.js";
import { unwrap } from "../test-utils/results.js";
import { mintBookingId } from "./booking-id.js";
import type { TransitionCandidate } from "./policy.js";

/** Two edges into `missed`; `inProgress` blocks. */
const schema = defineSchema({
  booking: {
    fields: { note: { required: false, type: column.text() } },
    statuses: {
      done: { blocking: false },
      inProgress: { blocking: true },
      missed: { blocking: false },
    },
    transitions: {
      booked: ["inProgress", "missed"],
      cancelled: ["booked"],
      inProgress: ["missed", "done"],
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

/** Monday 3 June 2030, 10:00–11:00 Lisbon. */
const slot = {
  end: Temporal.Instant.from("2030-06-03T10:00:00Z"),
  resourceId: "room",
  start: Temporal.Instant.from("2030-06-03T09:00:00Z"),
} as const;

/** A verb that must never be called. */
// oxlint-disable-next-line require-await -- a verb must return a promise.
async function refuse(): Promise<never> {
  throw new Error("no Adapter call expected");
}

/** Breaks on every edge into `missed`. */
const intoMissed = definePolicy(schema, {
  appliesTo: [{ to: "missed" }],
  check: (candidate) => {
    expectTypeOf(candidate).toEqualTypeOf<
      | TransitionCandidate<typeof schema, { from: "booked"; to: "missed" }>
      | TransitionCandidate<typeof schema, { from: "inProgress"; to: "missed" }>
    >();

    return { from: candidate.from };
  },
  name: "intoMissed",
});

/** Breaks on `booked → missed` only. */
const noShowOnly = definePolicy(schema, {
  appliesTo: [{ from: "booked", to: "missed" }],
  check: () => ({ reason: "too early" as const }),
  name: "noShowOnly",
});

/** A memory Adapter with `weekdays` on `room` and one booked Booking in `slot`. */
async function seeded() {
  const adapter = memoryAdapter();

  await adapter(schema).withResourceLock("room", async (locked) => {
    await locked.replaceRules({ resourceId: "room", rules: [weekdays] });
  });

  const booking = unwrap(
    await createScheduler({ adapter, policies: [], schema }).book(slot)
  );

  return { adapter, booking, reads: adapter(schema) };
}

describe("Policies on Transition edges", () => {
  it("runs a { to } Policy on every declared edge into `to`, and only those", async () => {
    const first = await seeded();

    const scheduler = createScheduler({
      adapter: first.adapter,
      policies: [intoMissed],
      schema,
    });

    await expect(
      scheduler.transition({
        from: "booked",
        id: first.booking.id,
        to: "missed",
      })
    ).resolves.toStrictEqual({
      error: {
        _tag: "PolicyViolation",
        violations: [{ detail: { from: "booked" }, policy: "intoMissed" }],
      },
      ok: false,
    });
    await expect(
      first.reads.getBooking(first.booking.id)
    ).resolves.toStrictEqual(first.booking);

    unwrap(
      await scheduler.transition({
        from: "booked",
        id: first.booking.id,
        to: "inProgress",
      })
    );

    await expect(
      scheduler.transition({
        from: "inProgress",
        id: first.booking.id,
        to: "missed",
      })
    ).resolves.toMatchObject({
      error: {
        _tag: "PolicyViolation",
        violations: [{ detail: { from: "inProgress" }, policy: "intoMissed" }],
      },
      ok: false,
    });
  });

  it("runs a { from, to } Policy on that edge only", async () => {
    const { booking, adapter } = await seeded();

    const scheduler = createScheduler({
      adapter,
      policies: [noShowOnly],
      schema,
    });

    await expect(
      scheduler.transition({ from: "booked", id: booking.id, to: "missed" })
    ).resolves.toMatchObject({
      error: { _tag: "PolicyViolation" },
      ok: false,
    });

    unwrap(
      await scheduler.transition({
        from: "booked",
        id: booking.id,
        to: "inProgress",
      })
    );

    expect(
      unwrap(
        await scheduler.transition({
          from: "inProgress",
          id: booking.id,
          to: "missed",
        })
      ).status
    ).toBe("missed");
  });

  it("gives StatusMismatch on a stale `from`, not PolicyViolation", async () => {
    const { booking, adapter } = await seeded();

    const scheduler = createScheduler({
      adapter,
      policies: [intoMissed],
      schema,
    });

    unwrap(
      await scheduler.transition({
        from: "booked",
        id: booking.id,
        to: "inProgress",
      })
    );

    await expect(
      scheduler.transition({ from: "booked", id: booking.id, to: "missed" })
    ).resolves.toStrictEqual({
      error: { _tag: "StatusMismatch", id: booking.id, status: "inProgress" },
      ok: false,
    });
  });

  it("gives SlotConflict moving into a blocking Status over an overlap, before any Policy", async () => {
    const intoBooked = definePolicy(schema, {
      appliesTo: [{ to: "booked" }],
      check: () => ({}),
      name: "intoBooked",
    });

    const { booking, adapter } = await seeded();

    const scheduler = createScheduler({
      adapter,
      policies: [intoBooked],
      schema,
    });

    unwrap(await scheduler.cancel({ id: booking.id }));
    const newer = unwrap(await scheduler.book(slot));

    await expect(
      scheduler.transition({ from: "cancelled", id: booking.id, to: "booked" })
    ).resolves.toStrictEqual({
      error: {
        _tag: "SlotConflict",
        conflicts: [
          { end: slot.end, id: newer.id, kind: "booking", start: slot.start },
        ],
      },
      ok: false,
    });
  });

  it("hands check the stored Booking and the edge, and load the stored range and the now that also sees", async () => {
    const seen: unknown[] = [];

    const recorded = definePolicy(schema, {
      appliesTo: [{ from: "booked", to: "missed" }],
      check: (candidate, data: string) => {
        seen.push(candidate);

        return data === "ok" ? null : {};
      },
      load: ({ from, now, resourceId, to }) => {
        seen.push({ from, now, resourceId, to });

        return "ok";
      },
      name: "recorded",
    });

    const { booking, adapter } = await seeded();

    const scheduler = createScheduler({
      adapter,
      policies: [recorded],
      schema,
    });

    const { also } = unwrap(
      await scheduler.transition({
        also: ({ now }) => ({ ok: true, value: now }),
        from: "booked",
        id: booking.id,
        to: "missed",
      })
    );

    expect(seen).toStrictEqual([
      { from: slot.start, now: also, resourceId: "room", to: slot.end },
      {
        action: "transition",
        booking,
        from: "booked",
        now: also,
        to: "missed",
      },
    ]);
  });

  it("succeeds with waived when the broken Policy is relaxed", async () => {
    const { booking, reads, adapter } = await seeded();

    const scheduler = createScheduler({
      adapter,
      policies: [intoMissed],
      schema,
    });

    const moved = unwrap(
      await scheduler.transition({
        from: "booked",
        id: booking.id,
        relax: ["intoMissed"],
        to: "missed",
      })
    );

    expect(moved).toStrictEqual({
      ...booking,
      status: "missed",
      waived: [{ detail: { from: "booked" }, policy: "intoMissed" }],
    });
    await expect(reads.getBooking(booking.id)).resolves.toStrictEqual({
      ...booking,
      status: "missed",
    });
  });

  it("refuses a relax name that doesn't apply to the edge as InvalidParams at its index, before any Adapter call", async () => {
    const scheduler = createScheduler({
      adapter: defineAdapter<undefined, "blocks">(() => ({
        getBlock: refuse,
        getBooking: refuse,
        getRules: refuse,
        listBlocks: refuse,
        listBookings: refuse,
        withResourceLock: refuse,
      })),
      policies: [intoMissed, noShowOnly],
      schema,
    });

    await expect(
      scheduler.transition({
        from: "inProgress",
        id: mintBookingId(),
        // @ts-expect-error -- noShowOnly doesn't apply to inProgress → missed, and availability applies to no edge.
        relax: ["intoMissed", "noShowOnly", "availability"],
        to: "missed",
      })
    ).resolves.toStrictEqual({
      error: {
        _tag: "InvalidParams",
        issues: [
          {
            message:
              "relax: noShowOnly is not a Policy that applies to inProgress → missed",
            path: ["relax", 1],
          },
          {
            message:
              "relax: availability is not a Policy that applies to inProgress → missed",
            path: ["relax", 2],
          },
        ],
      },
      ok: false,
    });
  });
});

describe("Policy definition on edges", () => {
  it("throws on an undeclared edge, an edge into cancelled, and { to } with no declared edge into it", () => {
    const definitions = [
      () =>
        definePolicy(schema, {
          // @ts-expect-error -- booked → done isn't declared.
          appliesTo: [{ from: "booked", to: "done" }],
          check: () => null,
          name: "undeclared",
        }),
      () =>
        definePolicy(schema, {
          // @ts-expect-error -- edges into cancelled belong to cancel.
          appliesTo: [{ to: "cancelled" }],
          check: () => null,
          name: "intoCancelled",
        }),
      () =>
        definePolicy(uuidIdSchema, {
          // @ts-expect-error -- uuidIdSchema declares no edge into booked.
          appliesTo: [{ to: "booked" }],
          check: () => null,
          name: "noEdge",
        }),
    ];

    for (const define of definitions) {
      expect(define).toThrow("isn't a declared Transition");
    }
  });
});

/** Never called: only the types are checked. */
function calls() {
  const scheduler = createScheduler({
    adapter: memoryAdapter(),
    policies: [intoMissed, noShowOnly],
    schema,
  });

  const id = mintBookingId();

  return {
    intoProgress: scheduler.transition({
      from: "booked",
      id,
      to: "inProgress",
    }),
    noShow: scheduler.transition({ from: "booked", id, to: "missed" }),
    relaxed: scheduler.transition({
      from: "booked",
      id,
      relax: ["noShowOnly"],
      to: "missed",
    }),
    unpoliced: scheduler.transition({
      from: "booked",
      id,
      // @ts-expect-error -- no Policy applies to booked → inProgress, so it takes no relax.
      relax: [],
      to: "inProgress",
    }),
  };
}

type IntoMissed = Violation<"intoMissed", { from: "booked" | "inProgress" }>;

type NoShowOnly = Violation<"noShowOnly", { reason: "too early" }>;

type Calls = ReturnType<typeof calls>;

type Settled<K extends keyof Calls> = Awaited<Calls[K]>;

describe("Policy types on edges", () => {
  it("types PolicyViolation per edge, and adds waived narrowed to the relaxed Policies", () => {
    expectTypeOf<
      Extract<Settled<"noShow">, { ok: false }>["error"]
    >().toEqualTypeOf<
      TransitionError<typeof schema> | PolicyViolation<IntoMissed | NoShowOnly>
    >();
    expectTypeOf<
      Extract<Settled<"intoProgress">, { ok: false }>["error"]
    >().toEqualTypeOf<TransitionError<typeof schema>>();
    expectTypeOf<
      Extract<Settled<"relaxed">, { ok: true }>["value"]
    >().toEqualTypeOf<
      Booking<typeof schema> & { readonly waived: readonly NoShowOnly[] }
    >();
    expectTypeOf<
      Extract<Settled<"relaxed">, { ok: false }>["error"]
    >().toEqualTypeOf<
      TransitionError<typeof schema> | PolicyViolation<IntoMissed>
    >();
  });
});
