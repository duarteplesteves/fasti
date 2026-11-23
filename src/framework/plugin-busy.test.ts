import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { definePlugin } from "../effect/index.js";
import {
  availability,
  column,
  createScheduler,
  definePolicy,
  defineSchema,
} from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { holidays } from "../test-utils/holidays-plugin.js";
import { promiseHolidays } from "../test-utils/promise-holidays-plugin.js";
import { unwrap } from "../test-utils/results.js";

type StaffId = string & { readonly __brand: "StaffId" };

// SAFETY: test fixtures; any UUID string is a StaffId here.
const ann = "0193b6e2-7c00-7000-8000-000000000001" as StaffId;

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

/** Monday 3 June 2030 at `hour`:`minute` UTC. */
function at(hour: number, minute = 0) {
  return Temporal.Instant.from(
    `2030-06-03T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`
  );
}

/** The holiday the tests add first: 12:00–14:00 UTC. */
const lunch = { end: at(14), name: "Lunch", resourceId: ann, start: at(12) };

/** A Policy on `book` that always breaks. */
function closedPolicy<S extends Parameters<typeof definePolicy>[0]>(schema: S) {
  return definePolicy(schema, {
    appliesTo: ["book"],
    check: () => ({ reason: "closed" }),
    name: "closed",
  });
}

const styles = [
  ["native", holidays],
  ["Promise-style", promiseHolidays],
] as const;

describe.each(styles)("a %s holiday Plugin", (_style, make) => {
  function setup() {
    const schema = defineSchema({
      booking: { transitions: { cancelled: ["booked"] } },
      plugins: [availability(), make({ eveHours: 1 })],
      resource: { idType: column.uuid<StaffId>() },
    });

    const adapter = memoryAdapter();

    return {
      adapter,
      scheduler: createScheduler({ adapter, schema }),
      schema,
    };
  }

  async function seeded() {
    const s = setup();

    unwrap(
      await s.scheduler.availability.set({ resourceId: ann, rules: [weekdays] })
    );

    return { ...s, lunch: unwrap(await s.scheduler.holidays.add(lunch)) };
  }

  describe("busy time (Invariant 1, not relaxable)", () => {
    it("refuses `book` over a holiday with the holiday's kind", async () => {
      const { lunch: holiday, scheduler } = await seeded();

      await expect(
        scheduler.book({
          end: at(13),
          relax: ["availability", "holidayEve"],
          resourceId: ann,
          start: at(12, 30),
        })
      ).resolves.toStrictEqual({
        error: {
          _tag: "SlotConflict",
          conflicts: [
            { end: at(14), id: holiday.id, kind: "holiday", start: at(12) },
          ],
        },
        ok: false,
      });
    });

    it("refuses `reschedule` onto a holiday", async () => {
      const { lunch: holiday, scheduler } = await seeded();

      const booking = unwrap(
        await scheduler.book({ end: at(10), resourceId: ann, start: at(9) })
      );

      await expect(
        scheduler.reschedule({ end: at(14), id: booking.id, start: at(13) })
      ).resolves.toMatchObject({
        error: {
          _tag: "SlotConflict",
          conflicts: [{ id: holiday.id, kind: "holiday" }],
        },
        ok: false,
      });
    });

    it("refuses a Transition into a blocking Status over a holiday, but lets the holiday be added over the cancelled Booking", async () => {
      const { scheduler } = await seeded();

      const booking = unwrap(
        await scheduler.book({ end: at(16), resourceId: ann, start: at(15) })
      );

      unwrap(await scheduler.cancel({ id: booking.id }));

      const late = unwrap(
        await scheduler.holidays.add({
          end: at(16),
          name: "Late",
          resourceId: ann,
          start: at(15),
        })
      );

      await expect(
        scheduler.transition({
          from: "cancelled",
          id: booking.id,
          to: "booked",
        })
      ).resolves.toMatchObject({
        error: {
          _tag: "SlotConflict",
          conflicts: [{ id: late.id, kind: "holiday" }],
        },
        ok: false,
      });
    });

    it("leaves holidays out of `findSlots`", async () => {
      const { scheduler } = await seeded();

      const slots = unwrap(
        await scheduler.findSlots({
          duration: 60,
          from: at(8),
          interval: 60,
          relax: ["holidayEve"],
          resourceId: ann,
          timezone: "Europe/Lisbon",
          to: at(16),
        })
      );

      expect(slots.map((s) => s.start.toInstant().toString())).toStrictEqual(
        [8, 9, 10, 11, 14, 15].map((h) => at(h).toString())
      );
    });

    it("stores two overlapping holidays", async () => {
      const { lunch: holiday, scheduler } = await seeded();

      const longer = unwrap(
        await scheduler.holidays.add({
          end: at(15),
          name: "Long lunch",
          resourceId: ann,
          start: at(13),
        })
      );

      expect(
        unwrap(await scheduler.holidays.list({ resourceId: ann }))
          .map((h) => h.id)
          .toSorted()
      ).toStrictEqual([holiday.id, longer.id].toSorted());
    });

    it("`conflicts()` inside `lock` returns only the blocking Bookings", async () => {
      const { scheduler } = setup();

      unwrap(
        await scheduler.availability.set({
          resourceId: ann,
          rules: [weekdays],
        })
      );

      const kept = unwrap(
        await scheduler.book({ end: at(10), resourceId: ann, start: at(9) })
      );

      const dropped = unwrap(
        await scheduler.book({ end: at(11), resourceId: ann, start: at(10) })
      );

      unwrap(await scheduler.cancel({ id: dropped.id }));

      await expect(
        scheduler.holidays.add({
          end: at(12),
          name: "Morning",
          resourceId: ann,
          start: at(8),
        })
      ).resolves.toStrictEqual({
        error: {
          _tag: "SlotConflict",
          conflicts: [
            { end: at(10), id: kept.id, kind: "booking", start: at(9) },
          ],
        },
        ok: false,
      });
      await expect(
        scheduler.holidays.list({ resourceId: ann })
      ).resolves.toStrictEqual({ ok: true, value: [] });
    });
  });

  describe("Plugin Policies (relaxable)", () => {
    /** 11:00–11:30 UTC: ends half an hour before `lunch`, inside `holidayEve`'s hour. */
    const eve = { end: at(11, 30), resourceId: ann, start: at(11) };

    it("refuses with PolicyViolation", async () => {
      const { lunch: holiday, scheduler } = await seeded();

      await expect(scheduler.book(eve)).resolves.toStrictEqual({
        error: {
          _tag: "PolicyViolation",
          violations: [
            { detail: { holiday: holiday.id }, policy: "holidayEve" },
          ],
        },
        ok: false,
      });
    });

    it("can be relaxed by name, and comes back in `waived`", async () => {
      const { lunch: holiday, scheduler } = await seeded();

      const booking = unwrap(
        await scheduler.book({ ...eve, relax: ["holidayEve"] })
      );

      expect(booking.waived).toStrictEqual([
        { detail: { holiday: holiday.id }, policy: "holidayEve" },
      ]);
    });

    it("runs before the app's Policies", async () => {
      const s = await seeded();

      const scheduler = createScheduler({
        adapter: s.adapter,
        policies: [closedPolicy(s.schema)],
        schema: s.schema,
      });

      await expect(scheduler.book(eve)).resolves.toMatchObject({
        error: {
          _tag: "PolicyViolation",
          violations: [{ policy: "holidayEve" }, { policy: "closed" }],
        },
        ok: false,
      });
    });
  });
});

describe("Policy names", () => {
  const resource = { idType: column.uuid<StaffId>() };

  it("throws in createScheduler when a Plugin Policy and an app Policy share a name", () => {
    const schema = defineSchema({
      plugins: [holidays({ eveHours: 1 })],
      resource,
    });

    const clash = definePolicy(schema, {
      appliesTo: ["book"],
      check: () => null,
      name: "holidayEve",
    });

    expect(() =>
      createScheduler({
        adapter: memoryAdapter(),
        // @ts-expect-error -- `holidayEve` is the holidays Plugin's.
        policies: [clash],
        schema,
      })
    ).toThrow("fasti: two Policies are named holidayEve");
  });

  it("throws in createScheduler when two Plugins' Policies share a name", () => {
    const other = definePlugin({
      actions: {},
      name: "other",
      policies: [
        {
          appliesTo: ["book"],
          check: () => null,
          load: () => Effect.succeed(null),
          name: "holidayEve",
        },
      ],
    });

    const schema = defineSchema({
      // @ts-expect-error -- both Plugins have a `holidayEve` Policy.
      plugins: [holidays({ eveHours: 1 }), other],
      resource,
    });

    expect(() => createScheduler({ adapter: memoryAdapter(), schema })).toThrow(
      "fasti: two Policies are named holidayEve"
    );
  });

  it("throws in defineSchema on a Plugin Policy that applies to nothing", () => {
    const idle = definePlugin({
      actions: {},
      name: "idle",
      policies: [
        {
          // SAFETY: a plain-JS caller's empty list, past the non-empty tuple type.
          // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the point of the test.
          appliesTo: [] as unknown as readonly ["book"],
          check: () => null,
          load: null,
          name: "idle",
        },
      ],
    });

    expect(() => defineSchema({ plugins: [idle], resource })).toThrow(
      `defineSchema: Plugin "idle"'s Policy "idle" must apply to at least one Action.`
    );
  });
});

/** A computed busy source: one range, `[start, end)`, with whatever id the test sets. */
function echoSetup(start: Temporal.Instant, end: Temporal.Instant) {
  const range = { end, id: "", start };

  const echo = definePlugin({
    actions: {},
    busy: { kind: "echo", list: () => Effect.succeed([range]) },
    name: "echo",
  });

  const schema = defineSchema({
    plugins: [echo],
    resource: { idType: column.uuid<StaffId>() },
  });

  return {
    range,
    scheduler: createScheduler({ adapter: memoryAdapter(), schema }),
  };
}

describe("a busy range that shares an id with a Booking", () => {
  it("still refuses `reschedule` onto it when it has the moved Booking's id", async () => {
    const { range, scheduler } = echoSetup(at(13), at(14));

    const booking = unwrap(
      await scheduler.book({ end: at(10), resourceId: ann, start: at(9) })
    );

    range.id = booking.id;

    await expect(
      scheduler.reschedule({ end: at(14), id: booking.id, start: at(13) })
    ).resolves.toStrictEqual({
      error: {
        _tag: "SlotConflict",
        conflicts: [
          { end: at(14), id: booking.id, kind: "echo", start: at(13) },
        ],
      },
      ok: false,
    });
  });

  it("still hides its slots from `findSlots({ excludeBookingId })`", async () => {
    const { range, scheduler } = echoSetup(at(13), at(14));

    const booking = unwrap(
      await scheduler.book({ end: at(10), resourceId: ann, start: at(9) })
    );

    range.id = booking.id;

    const slots = unwrap(
      await scheduler.findSlots({
        duration: 60,
        excludeBookingId: booking.id,
        from: at(8),
        interval: 60,
        resourceId: ann,
        timezone: "UTC",
        to: at(16),
      })
    );

    expect(slots.map((s) => s.start.toInstant().toString())).toStrictEqual(
      [8, 9, 10, 11, 12, 14, 15].map((h) => at(h).toString())
    );
  });

  it("reports each overlap with its own kind", async () => {
    const { range, scheduler } = echoSetup(at(15), at(16));

    const booking = unwrap(
      await scheduler.book({ end: at(14), resourceId: ann, start: at(13) })
    );

    range.id = booking.id;

    await expect(
      scheduler.book({ end: at(16), resourceId: ann, start: at(13) })
    ).resolves.toStrictEqual({
      error: {
        _tag: "SlotConflict",
        conflicts: [
          { end: at(14), id: booking.id, kind: "booking", start: at(13) },
          { end: at(16), id: booking.id, kind: "echo", start: at(15) },
        ],
      },
      ok: false,
    });
  });
});
