import { assert, describe, expect, it } from "vitest";

import { defineAdapter } from "../adapter/contract.js";
import type { Result } from "../core/result.js";
import { createScheduler } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import {
  textIdResources,
  textIdSchema,
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { refuse } from "../test-utils/refuse.js";
import { unwrap } from "../test-utils/results.js";
import { mintBookingId } from "./booking-id.js";

const schema = uuidIdSchema;
const [room] = uuidIdResources;

/** Weekdays 09:00–17:00 in Lisbon. */
const weekdays = {
  exceptions: [],
  recurrence: { daysOfWeek: [1, 2, 3, 4, 5], frequency: "weekly", interval: 1 },
  timeWindow: {
    end: Temporal.PlainTime.from("17:00"),
    start: Temporal.PlainTime.from("09:00"),
  },
  timezone: "Europe/Lisbon",
} as const;

/** UUIDv7 (RFC 9562): version nibble 7, variant bits 10. */
const uuidV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** The error of a failed result; fails the test if it is ok. */
function errorOf<E>(result: Result<unknown, E>): E {
  assert(!result.ok, "expected an error");

  return result.error;
}

/** The one issue `end <= start` gives. */
const endIssue = { _tag: "InvalidParams", issues: [{ path: ["end"] }] };

/** `hours` from 09:00 Monday 3 June 2030 Lisbon, as Instants. */
function at(hours: number): Temporal.Instant {
  return Temporal.Instant.from("2030-06-03T08:00:00Z").add({ hours });
}

describe("book", () => {
  it("books a free slot inside availability, with a fresh UUIDv7 id", async () => {
    const adapter = memoryAdapter();
    const scheduler = createScheduler({ policies: [], adapter, schema });

    unwrap(
      await scheduler.availability.set({ resourceId: room, rules: [weekdays] })
    );
    // Monday 3 June 2030, 10:00–11:00 Lisbon (UTC+1).
    const start = Temporal.Instant.from("2030-06-03T09:00:00Z");
    const end = Temporal.Instant.from("2030-06-03T10:00:00Z");

    const result = await scheduler.book({ end, resourceId: room, start });

    assert(result.ok, "expected ok");

    const { id, ...rest } = result.value;

    expect(id).toMatch(uuidV7);
    expect(rest).toStrictEqual({
      end,
      resourceId: room,
      start,
      status: "booked",
    });
    await expect(adapter(schema).getBooking(id)).resolves.toStrictEqual(
      result.value
    );
  });

  it("refuses end <= start as InvalidParams at end, before any Adapter call", async () => {
    const adapter = defineAdapter<undefined, "records">(() => ({
      getRecord: refuse,
      getBooking: refuse,
      listRecords: refuse,
      listBookings: refuse,
      withResourceLock: refuse,
    }));

    const scheduler = createScheduler({ policies: [], adapter, schema });
    const start = Temporal.Instant.from("2030-06-03T09:00:00Z");

    const same = await scheduler.book({ end: start, resourceId: room, start });

    const before = await scheduler.book({
      end: start.subtract({ minutes: 1 }),
      resourceId: room,
      start,
    });

    expect(errorOf(same)).toMatchObject(endIssue);
    expect(errorOf(before)).toMatchObject(endIssue);
  });

  it("stores Instants floored to the millisecond, and refuses a range that flooring empties", async () => {
    const adapter = memoryAdapter();

    unwrap(
      await createScheduler({ adapter, policies: [], schema }).availability.set(
        { resourceId: room, rules: [weekdays] }
      )
    );

    const scheduler = createScheduler({ policies: [], adapter, schema });

    const result = await scheduler.book({
      end: Temporal.Instant.from("2030-06-03T10:00:00.000999999Z"),
      resourceId: room,
      start: Temporal.Instant.from("2030-06-03T09:00:00.000000001Z"),
    });

    assert(result.ok, "expected ok");
    expect(result.value.start).toStrictEqual(
      Temporal.Instant.from("2030-06-03T09:00:00Z")
    );
    expect(result.value.end).toStrictEqual(
      Temporal.Instant.from("2030-06-03T10:00:00Z")
    );
    await expect(
      adapter(schema).getBooking(result.value.id)
    ).resolves.toStrictEqual(result.value);

    const emptied = await scheduler.book({
      end: Temporal.Instant.from("2030-06-03T11:00:00.000999Z"),
      resourceId: room,
      start: Temporal.Instant.from("2030-06-03T11:00:00.000001Z"),
    });

    expect(errorOf(emptied)).toMatchObject(endIssue);
  });

  describe("with Developer Fields", () => {
    const [staff] = textIdResources;

    /** Every required field of {@link textIdSchema}, set. */
    const required = {
      count: 3,
      label: "Haircut",
      paid: false,
      ref: "0193b6e2-7c00-7000-8000-00000000000a",
      remindAt: Temporal.Instant.from("2030-06-02T09:00:00Z"),
    };

    /** Every optional field of {@link textIdSchema}, set. */
    const optional = {
      countOpt: 0,
      labelOpt: "",
      paidOpt: true,
      refOpt: "0193b6e2-7c00-7000-8000-00000000000b",
      remindAtOpt: Temporal.Instant.from("2030-06-03T08:00:00Z"),
    };

    /** Unset optional fields, as they read back. */
    const unset = {
      countOpt: null,
      labelOpt: null,
      paidOpt: null,
      refOpt: null,
      remindAtOpt: null,
    };

    async function setUp(rules: readonly (typeof weekdays)[] = [weekdays]) {
      const adapter = memoryAdapter();

      unwrap(
        await createScheduler({
          adapter,
          policies: [],
          schema: textIdSchema,
        }).availability.set({ resourceId: staff, rules })
      );

      return {
        adapter,
        scheduler: createScheduler({
          policies: [],
          adapter,
          schema: textIdSchema,
        }),
      };
    }

    it("round-trips required fields and reads unset optional ones as null", async () => {
      const { adapter, scheduler } = await setUp();

      const bare = await scheduler.book({
        end: at(2),
        fields: required,
        resourceId: staff,
        start: at(1),
      });

      const full = await scheduler.book({
        end: at(3),
        fields: { ...required, ...optional },
        resourceId: staff,
        start: at(2),
      });

      const nulls = await scheduler.book({
        end: at(4),
        fields: { ...required, ...unset },
        resourceId: staff,
        start: at(3),
      });

      assert(bare.ok && full.ok && nulls.ok, "expected ok");
      expect(bare.value).toStrictEqual({
        end: at(2),
        id: bare.value.id,
        resourceId: staff,
        start: at(1),
        status: "booked",
        ...required,
        ...unset,
      });
      expect(full.value).toStrictEqual({
        end: at(3),
        id: full.value.id,
        resourceId: staff,
        start: at(2),
        status: "booked",
        ...required,
        ...optional,
      });
      expect(nulls.value).toStrictEqual({
        ...bare.value,
        end: at(4),
        id: nulls.value.id,
        start: at(3),
      });

      const stored = await Promise.all(
        [bare, full, nulls].map(
          async ({ value }) => await adapter(textIdSchema).getBooking(value.id)
        )
      );

      expect(stored).toStrictEqual([bare.value, full.value, nulls.value]);
    });

    it("refuses an overlap with SlotConflict listing only id, start and end", async () => {
      const { scheduler } = await setUp();

      const first = await scheduler.book({
        end: at(2),
        fields: { ...required, ...optional },
        resourceId: staff,
        start: at(1),
      });

      assert(first.ok, "expected ok");

      const overlap = await scheduler.book({
        end: at(3),
        fields: required,
        resourceId: staff,
        start: at(1).add({ minutes: 30 }),
      });

      expect(errorOf(overlap)).toStrictEqual({
        _tag: "SlotConflict",
        conflicts: [
          { end: at(2), id: first.value.id, kind: "booking", start: at(1) },
        ],
      });
    });

    it("floors instant Developer Fields to the millisecond", async () => {
      const { scheduler } = await setUp();

      const result = await scheduler.book({
        end: at(2),
        fields: {
          ...required,
          remindAt: Temporal.Instant.from("2030-06-02T09:00:00.000999999Z"),
          remindAtOpt: Temporal.Instant.from("2030-06-02T10:00:00.000000001Z"),
        },
        resourceId: staff,
        start: at(1),
      });

      assert(result.ok, "expected ok");
      // toStrictEqual, not toMatchObject: the latter sees every Instant as equal.
      const { remindAt, remindAtOpt } = result.value;

      expect({ remindAt, remindAtOpt }).toStrictEqual({
        remindAt: Temporal.Instant.from("2030-06-02T09:00:00Z"),
        remindAtOpt: Temporal.Instant.from("2030-06-02T10:00:00Z"),
      });
    });

    it("books back-to-back slots", async () => {
      const { scheduler } = await setUp();

      const slots = [
        [at(1), at(2)],
        [at(2), at(3)],
        [at(0), at(1)],
      ] as const;

      const results = await Promise.all(
        slots.map(
          async ([start, end]) =>
            await scheduler.book({
              end,
              fields: required,
              resourceId: staff,
              start,
            })
        )
      );

      expect(results).toMatchObject([{ ok: true }, { ok: true }, { ok: true }]);
    });

    it("doesn't count a cancelled Booking as a conflict", async () => {
      const { adapter, scheduler } = await setUp();

      await adapter(textIdSchema).withResourceLock(staff, async (locked) => {
        await locked.insertBooking({
          end: at(2),
          id: mintBookingId(),
          resourceId: staff,
          start: at(1),
          status: "cancelled",
          ...required,
          ...unset,
        });
      });

      const result = await scheduler.book({
        end: at(2),
        fields: required,
        resourceId: staff,
        start: at(1),
      });

      expect(result).toMatchObject({ ok: true });
    });

    it("refuses a slot outside availability with PolicyViolation", async () => {
      const { scheduler } = await setUp();

      // 17:00–18:00 Lisbon: past the window's end.
      const late = await scheduler.book({
        end: at(9),
        fields: required,
        resourceId: staff,
        start: at(8),
      });

      expect(errorOf(late)).toStrictEqual({
        _tag: "PolicyViolation",
        violations: [{ detail: {}, policy: "availability" }],
      });
    });

    it("books nothing on a Resource with no rules", async () => {
      const { scheduler } = await setUp([]);

      const result = await scheduler.book({
        end: at(2),
        fields: required,
        resourceId: staff,
        start: at(1),
      });

      expect(errorOf(result)).toMatchObject({ _tag: "PolicyViolation" });
    });

    it("reports an overlap outside availability as SlotConflict alone", async () => {
      const { adapter, scheduler } = await setUp();

      const blocker = {
        end: at(10),
        id: mintBookingId(),
        resourceId: staff,
        start: at(8),
        status: "booked",
        ...required,
        ...unset,
      } as const;

      await adapter(textIdSchema).withResourceLock(staff, async (locked) => {
        await locked.insertBooking(blocker);
      });

      const result = await scheduler.book({
        end: at(9),
        fields: required,
        resourceId: staff,
        start: at(8),
      });

      expect(errorOf(result)).toStrictEqual({
        _tag: "SlotConflict",
        conflicts: [
          { end: at(10), id: blocker.id, kind: "booking", start: at(8) },
        ],
      });
    });
  });
});
