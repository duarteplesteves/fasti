import { assert, describe, expect, expectTypeOf, it } from "vitest";

import { defineAdapter } from "../adapter/index.js";
import type { ResourceIdOf } from "../adapter/records.js";
import { createScheduler } from "../index.js";
import type { AdapterError, InvalidParams } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import {
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { unwrap } from "../test-utils/results.js";
import type { FindSlotsError, Slot } from "./find-slots.js";

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

/** A memory Adapter with `weekdays` stored for `room`. */
async function seeded() {
  const adapter = memoryAdapter();

  await adapter(schema).withResourceLock(room, async (locked) => {
    await locked.replaceRules({ resourceId: room, rules: [weekdays] });
  });

  return adapter;
}

/** Monday 3 June 2030, 16:00 Lisbon. */
const from = Temporal.Instant.from("2030-06-03T15:00:00Z");

/** A search on `room` from `from`; `to` is the only thing tests vary. */
function query(to: Temporal.Instant) {
  return {
    duration: 60,
    from,
    interval: 30,
    resourceId: room,
    timezone: "America/New_York",
    to,
  };
}

/** Every verb of an Adapter that must never be called. */
async function refuse(): Promise<never> {
  return await Promise.reject(new Error("no Adapter call expected"));
}

describe("findSlots", () => {
  it("returns free slots zoned in the caller's timezone, with the typed resourceId", async () => {
    const scheduler = createScheduler({ adapter: await seeded(), schema });

    // 16:00 and 16:30 Lisbon start in range; only 16:00 fits before 17:00.
    const result = await scheduler.findSlots(
      query(Temporal.Instant.from("2030-06-03T16:00:00Z"))
    );

    assert(result.ok, "expected ok");
    expect(result.value).toStrictEqual([
      {
        end: Temporal.ZonedDateTime.from(
          "2030-06-03T12:00:00-04:00[America/New_York]"
        ),
        resourceId: room,
        start: Temporal.ZonedDateTime.from(
          "2030-06-03T11:00:00-04:00[America/New_York]"
        ),
        waived: [],
      },
    ]);
    expectTypeOf(result.value).toEqualTypeOf<readonly Slot<typeof schema>[]>();
    expectTypeOf<Slot<typeof schema>["resourceId"]>().toEqualTypeOf<
      ResourceIdOf<typeof schema>
    >();
  });

  it("finds a slot whose end passes `to`", async () => {
    const scheduler = createScheduler({ adapter: await seeded(), schema });

    const result = await scheduler.findSlots(
      query(Temporal.Instant.from("2030-06-03T15:01:00Z"))
    );

    assert(result.ok, "expected ok");
    expect(result.value.map((s) => s.start.toInstant())).toStrictEqual([from]);
  });

  it("hides a slot when a Booking overlaps only its tail past `to`", async () => {
    const adapter = await seeded();
    const scheduler = createScheduler({ adapter, schema });

    const booked = await scheduler.book({
      end: Temporal.Instant.from("2030-06-03T16:00:00Z"),
      resourceId: room,
      start: Temporal.Instant.from("2030-06-03T15:30:00Z"),
    });

    assert(booked.ok, "expected the seed booking to succeed");

    const result = await scheduler.findSlots(
      query(Temporal.Instant.from("2030-06-03T15:01:00Z"))
    );

    assert(result.ok, "expected ok");
    expect(result.value).toStrictEqual([]);
  });

  it("drops a booked slot, and brings it back after cancel", async () => {
    const scheduler = createScheduler({ adapter: await seeded(), schema });
    const to = Temporal.Instant.from("2030-06-03T16:00:00Z");

    const booked = await scheduler.book({
      end: to,
      resourceId: room,
      start: from,
    });

    assert(booked.ok, "expected the seed booking to succeed");

    const result = await scheduler.findSlots(query(to));

    assert(result.ok, "expected ok");
    expect(result.value).toStrictEqual([]);

    unwrap(await scheduler.cancel({ id: booked.value.id }));

    const after = await scheduler.findSlots(query(to));

    assert(after.ok, "expected ok");
    expect(after.value.map((s) => s.start.toInstant())).toStrictEqual([from]);
  });

  it.each([
    ["duration", { duration: 0 }],
    ["interval", { interval: Number.NaN }],
    ["timezone", { timezone: "Mars/Olympus" }],
    ["to", { to: from }],
  ] as const)(
    "refuses an invalid %s with InvalidParams, before any Adapter call",
    async (path, change) => {
      const adapter = defineAdapter(() => ({
        getBooking: refuse,
        getRules: refuse,
        listBookings: refuse,
        withResourceLock: refuse,
      }));

      const scheduler = createScheduler({ adapter, schema });

      const result = await scheduler.findSlots({
        ...query(Temporal.Instant.from("2030-06-03T16:00:00Z")),
        ...change,
      });

      assert(!result.ok, "expected an error");
      assert(result.error._tag === "InvalidParams", "expected InvalidParams");
      expect(result.error.issues.map((i) => i.path)).toStrictEqual([[path]]);
    }
  );

  it("reports a stored rule the Core finds invalid as AdapterError, not InvalidParams", async () => {
    const inner = await seeded();

    const adapter = defineAdapter((s) => {
      const raw = inner(s);

      return {
        ...raw,
        getRules: async (id) => {
          const rules = await raw.getRules(id);

          return rules.map((r) => ({ ...r, timezone: "Nowhere" }));
        },
      };
    });

    const scheduler = createScheduler({ adapter, schema });

    const result = await scheduler.findSlots(
      query(Temporal.Instant.from("2030-06-03T16:00:00Z"))
    );

    assert(!result.ok, "expected an error");
    assert(result.error._tag === "AdapterError", "expected AdapterError");
    expect(result.error.cause).toMatchObject({ _tag: "InvalidParams" });
  });

  it("has exactly InvalidParams and AdapterError as errors", () => {
    expectTypeOf<FindSlotsError>().toEqualTypeOf<
      InvalidParams | AdapterError
    >();
  });
});
