import { assert, describe, expect, expectTypeOf, it } from "vitest";

import { defineAdapter } from "../adapter/index.js";
import type { ResourceIdOf } from "../adapter/records.js";
import { createScheduler, definePolicy } from "../index.js";
import type {
  AdapterError,
  BookingNotFound,
  InvalidParams,
  Violation,
} from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import {
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { refuse } from "../test-utils/refuse.js";
import { unwrap } from "../test-utils/results.js";
import { mintBookingId } from "./booking-id.js";
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

  unwrap(
    await createScheduler({ adapter, policies: [], schema }).availability.set({
      resourceId: room,
      rules: [weekdays],
    })
  );

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

describe("findSlots", () => {
  it("returns free slots zoned in the caller's timezone, with the typed resourceId", async () => {
    const scheduler = createScheduler({
      policies: [],
      adapter: await seeded(),
      schema,
    });

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
    const scheduler = createScheduler({
      policies: [],
      adapter: await seeded(),
      schema,
    });

    const result = await scheduler.findSlots(
      query(Temporal.Instant.from("2030-06-03T15:01:00Z"))
    );

    assert(result.ok, "expected ok");
    expect(result.value.map((s) => s.start.toInstant())).toStrictEqual([from]);
  });

  it("hides a slot when a Booking overlaps only its tail past `to`", async () => {
    const adapter = await seeded();
    const scheduler = createScheduler({ policies: [], adapter, schema });

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
    const scheduler = createScheduler({
      policies: [],
      adapter: await seeded(),
      schema,
    });

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
      const adapter = defineAdapter<undefined, "records">(() => ({
        getRecord: refuse,
        getBooking: refuse,
        listRecords: refuse,
        listBookings: refuse,
        withResourceLock: refuse,
      }));

      const scheduler = createScheduler({ policies: [], adapter, schema });

      const result = await scheduler.findSlots({
        ...query(Temporal.Instant.from("2030-06-03T16:00:00Z")),
        ...change,
      });

      assert(!result.ok, "expected an error");
      assert(result.error._tag === "InvalidParams", "expected InvalidParams");
      expect(result.error.issues.map((i) => i.path)).toStrictEqual([[path]]);
    }
  );

  it("reports a bad relax together with the search's own issues", async () => {
    const adapter = defineAdapter<undefined, "records">(() => ({
      getRecord: refuse,
      getBooking: refuse,
      listRecords: refuse,
      listBookings: refuse,
      withResourceLock: refuse,
    }));

    const scheduler = createScheduler({ policies: [], adapter, schema });

    const result = await scheduler.findSlots({
      ...query(Temporal.Instant.from("2030-06-03T16:00:00Z")),
      duration: 0,
      // @ts-expect-error -- a plain-JS caller gets past relax's type.
      relax: "nope",
    });

    assert(!result.ok, "expected an error");
    assert(result.error._tag === "InvalidParams", "expected InvalidParams");
    expect(result.error.issues.map((i) => i.path)).toStrictEqual([
      ["duration"],
      ["relax"],
    ]);
  });

  it("reports a stored rule the Core finds invalid as AdapterError, not InvalidParams", async () => {
    const inner = await seeded();

    const adapter = defineAdapter<undefined, "records">((s) => {
      const raw = inner(s);

      return {
        ...raw,
        listRecords: async (table, q) => {
          const rows = await raw.listRecords(table, q);

          return rows.map((r) => ({ ...r, timezone: "Nowhere" }));
        },
      };
    });

    const scheduler = createScheduler({ policies: [], adapter, schema });

    const result = await scheduler.findSlots(
      query(Temporal.Instant.from("2030-06-03T16:00:00Z"))
    );

    assert(!result.ok, "expected an error");
    assert(result.error._tag === "AdapterError", "expected AdapterError");
    expect(result.error.cause).toMatchObject({ _tag: "InvalidParams" });
  });

  it("has exactly InvalidParams, BookingNotFound and AdapterError as errors", () => {
    expectTypeOf<FindSlotsError>().toEqualTypeOf<
      InvalidParams | BookingNotFound | AdapterError
    >();
  });
});

describe("findSlots with Policies", () => {
  /** Breaks at a slot starting 12:00 Lisbon. */
  const noLunch = definePolicy(schema, {
    appliesTo: ["book"],
    check: ({ start }) =>
      start.toZonedDateTimeISO("Europe/Lisbon").hour === 12
        ? { lunch: true }
        : null,
    name: "noLunch",
  });

  /** Monday 3 June 2030, hourly starts 08:00–16:00 Lisbon. */
  const day = {
    duration: 60,
    from: Temporal.Instant.from("2030-06-03T07:00:00Z"),
    interval: 60,
    resourceId: room,
    timezone: "Europe/Lisbon",
    to: Temporal.Instant.from("2030-06-03T16:00:00Z"),
  };

  /** Each slot's local start hour and its waived Policy names. */
  function hours(
    slots: readonly Slot<typeof schema, Violation<string, unknown>>[]
  ) {
    return slots.map((s) => [s.start.hour, s.waived.map((w) => w.policy)]);
  }

  it("hides slots that break an unrelaxed Policy, and tags relaxed ones in waived", async () => {
    const scheduler = createScheduler({
      adapter: await seeded(),
      policies: [noLunch],
      schema,
    });

    const strict = unwrap(await scheduler.findSlots(day));

    expect(hours(strict)).toStrictEqual([
      [9, []],
      [10, []],
      [11, []],
      [13, []],
      [14, []],
      [15, []],
      [16, []],
    ]);

    const relaxed = unwrap(
      await scheduler.findSlots({ ...day, relax: ["noLunch"] })
    );

    expect(relaxed.find((s) => s.start.hour === 12)?.waived).toStrictEqual([
      { detail: { lunch: true }, policy: "noLunch" },
    ]);
    expect(relaxed).toHaveLength(8);
  });

  it('exposes Grid slots outside the rules with relax: ["availability"]', async () => {
    const scheduler = createScheduler({
      adapter: await seeded(),
      policies: [noLunch],
      schema,
    });

    const slots = unwrap(
      await scheduler.findSlots({ ...day, relax: ["availability"] })
    );

    expect(hours(slots)).toStrictEqual([
      [8, ["availability"]],
      [9, []],
      [10, []],
      [11, []],
      [13, []],
      [14, []],
      [15, []],
      [16, []],
    ]);
  });

  it("runs load once per call, over [from, to + duration)", async () => {
    const loads: unknown[] = [];

    const counted = definePolicy(schema, {
      appliesTo: ["book"],
      check: () => null,
      load: ({ from: f, resourceId, to }) => {
        loads.push({ from: f, resourceId, to });
      },
      name: "counted",
    });

    const scheduler = createScheduler({
      adapter: await seeded(),
      policies: [counted],
      schema,
    });

    const slots = unwrap(await scheduler.findSlots(day));

    expect(slots.length).toBeGreaterThan(1);
    expect(loads).toStrictEqual([
      {
        from: day.from,
        resourceId: room,
        to: Temporal.Instant.from("2030-06-03T17:00:00Z"),
      },
    ]);
  });

  it("with excludeBookingId, runs the reschedule Policies with that Booking as previous", async () => {
    const seen: unknown[] = [];

    /** Refuses moving a Booking to a later slot. */
    const noLater = definePolicy(schema, {
      appliesTo: ["reschedule"],
      check: (candidate) => {
        seen.push(candidate.previous.id);

        return Temporal.Instant.compare(
          candidate.start,
          candidate.previous.start
        ) > 0
          ? { later: true }
          : null;
      },
      name: "noLater",
    });

    const scheduler = createScheduler({
      adapter: await seeded(),
      policies: [noLunch, noLater],
      schema,
    });

    // 11:00 Lisbon.
    const booking = unwrap(
      await scheduler.book({
        end: Temporal.Instant.from("2030-06-03T11:00:00Z"),
        resourceId: room,
        start: Temporal.Instant.from("2030-06-03T10:00:00Z"),
      })
    );

    const slots = unwrap(
      await scheduler.findSlots({ ...day, excludeBookingId: booking.id })
    );

    // noLunch applies to book only, so 12:00 is not hidden; its own slot is free to it.
    expect(hours(slots)).toStrictEqual([
      [9, []],
      [10, []],
      [11, []],
    ]);
    expect(new Set(seen)).toStrictEqual(new Set([booking.id]));

    const relaxed = unwrap(
      await scheduler.findSlots({
        ...day,
        excludeBookingId: booking.id,
        relax: ["noLater"],
      })
    );

    expect(relaxed.at(-1)?.waived).toStrictEqual([
      { detail: { later: true }, policy: "noLater" },
    ]);
  });

  it("lists slots for a non-blocking excludeBookingId instead of failing StatusMismatch", async () => {
    const scheduler = createScheduler({
      adapter: await seeded(),
      policies: [],
      schema,
    });

    const booking = unwrap(
      await scheduler.book({
        end: Temporal.Instant.from("2030-06-03T09:00:00Z"),
        resourceId: room,
        start: Temporal.Instant.from("2030-06-03T08:00:00Z"),
      })
    );

    unwrap(await scheduler.cancel({ id: booking.id }));

    const slots = unwrap(
      await scheduler.findSlots({ ...day, excludeBookingId: booking.id })
    );

    expect(slots).toHaveLength(8);
  });

  it("refuses an excludeBookingId that names no Booking with BookingNotFound", async () => {
    const scheduler = createScheduler({
      adapter: await seeded(),
      policies: [],
      schema,
    });

    const id = mintBookingId();

    await expect(
      scheduler.findSlots({ ...day, excludeBookingId: id })
    ).resolves.toStrictEqual({
      error: { _tag: "BookingNotFound", id },
      ok: false,
    });
  });

  it("refuses a relax name that doesn't apply with InvalidParams, before any Adapter call", async () => {
    const adapter = defineAdapter<undefined, "records">(() => ({
      getRecord: refuse,
      getBooking: refuse,
      listRecords: refuse,
      listBookings: refuse,
      withResourceLock: refuse,
    }));

    const scheduler = createScheduler({
      adapter,
      policies: [noLunch],
      schema,
    });

    const result = await scheduler.findSlots({
      ...day,
      excludeBookingId: mintBookingId(),
      // @ts-expect-error -- noLunch applies to book, not reschedule.
      relax: ["noLunch"],
    });

    assert(!result.ok, "expected an error");
    assert(result.error._tag === "InvalidParams", "expected InvalidParams");
    expect(result.error.issues.map((i) => i.path)).toStrictEqual([
      ["relax", 0],
    ]);
  });
});
