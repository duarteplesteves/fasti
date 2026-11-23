import { describe, expect, it } from "vitest";

import { createScheduler, defineSchema, notice } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { unwrap } from "../test-utils/results.js";

/** `booked → done`; `done` doesn't block. */
const schema = defineSchema({
  booking: {
    fields: {},
    statuses: { done: { blocking: false } },
    transitions: { booked: ["done"], cancelled: ["booked"] },
  },
});

/** Monday 1 June 2020, 10:00–11:00 Lisbon: in the past. */
const past = {
  end: Temporal.Instant.from("2020-06-01T10:00:00Z"),
  resourceId: "room",
  start: Temporal.Instant.from("2020-06-01T09:00:00Z"),
} as const;

/** Monday 3 June 2030, 10:00–11:00 Lisbon. */
const future = {
  end: Temporal.Instant.from("2030-06-03T10:00:00Z"),
  resourceId: "room",
  start: Temporal.Instant.from("2030-06-03T09:00:00Z"),
} as const;

/** A memory Adapter with a Booking booked (with no Policies) at `slot`. */
async function seeded(slot: typeof past | typeof future) {
  const adapter = memoryAdapter();

  const booking = unwrap(
    await createScheduler({ adapter, policies: [], schema }).book(slot)
  );

  return { adapter, booking };
}

describe(notice, () => {
  it("passes a start of exactly now + minimum, and breaks one millisecond earlier with detail.earliest", () => {
    const { check } = notice(schema, { appliesTo: ["book"], minimum: 120 });
    const now = Temporal.Instant.from("2030-06-03T08:00:00Z");
    const earliest = Temporal.Instant.from("2030-06-03T10:00:00Z");

    function at(start: Temporal.Instant) {
      return check(
        {
          action: "book",
          end: start.add({ hours: 1 }),
          now,
          resourceId: "room",
          start,
        },
        undefined
      );
    }

    expect(at(earliest)).toBeNull();
    expect(at(earliest.subtract({ milliseconds: 1 }))).toStrictEqual({
      earliest,
    });
  });

  it("with minimum 0 refuses a past start on book", async () => {
    const { adapter } = await seeded(future);

    const result = await createScheduler({
      adapter,
      policies: [notice(schema, { appliesTo: ["book"], minimum: 0 })],
      schema,
    }).book(past);

    expect(result).toMatchObject({
      error: {
        _tag: "PolicyViolation",
        violations: [{ policy: "notice" }],
      },
      ok: false,
    });
  });

  it("compares the stored start on cancel and on a Transition edge", async () => {
    const policies = [
      notice(schema, { appliesTo: ["cancel"], minimum: 0 }),
      notice(schema, { appliesTo: [{ to: "done" }], minimum: 0, name: "edge" }),
    ] as const;

    const old = await seeded(past);

    const oldScheduler = createScheduler({
      adapter: old.adapter,
      policies,
      schema,
    });

    await expect(
      oldScheduler.cancel({ id: old.booking.id })
    ).resolves.toMatchObject({
      error: { _tag: "PolicyViolation", violations: [{ policy: "notice" }] },
    });
    await expect(
      oldScheduler.transition({
        from: "booked",
        id: old.booking.id,
        to: "done",
      })
    ).resolves.toMatchObject({
      error: { _tag: "PolicyViolation", violations: [{ policy: "edge" }] },
    });

    const upcoming = await seeded(future);

    const scheduler = createScheduler({
      adapter: upcoming.adapter,
      policies,
      schema,
    });

    unwrap(await scheduler.cancel({ id: upcoming.booking.id }));
  });

  it("lets two renamed notice Policies coexist, each relaxed on its own", async () => {
    const { adapter } = await seeded(future);

    const scheduler = createScheduler({
      adapter,
      policies: [
        notice(schema, {
          appliesTo: ["book"],
          minimum: 0,
          name: "bookingNotice",
        }),
        notice(schema, {
          appliesTo: ["cancel"],
          minimum: 0,
          name: "cancelNotice",
        }),
      ],
      schema,
    });

    await expect(scheduler.book(past)).resolves.toMatchObject({
      error: { violations: [{ policy: "bookingNotice" }] },
    });

    const booked = unwrap(
      await scheduler.book({ ...past, relax: ["bookingNotice"] })
    );

    expect(booked.waived).toMatchObject([{ policy: "bookingNotice" }]);
    await expect(scheduler.cancel({ id: booked.id })).resolves.toMatchObject({
      error: { violations: [{ policy: "cancelNotice" }] },
    });
    expect(
      unwrap(await scheduler.cancel({ id: booked.id, relax: ["cancelNotice"] }))
    ).toMatchObject({ waived: [{ policy: "cancelNotice" }] });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws on minimum %s",
    (minimum) => {
      expect(() => notice(schema, { appliesTo: ["book"], minimum })).toThrow(
        /minimum/u
      );
    }
  );
});
