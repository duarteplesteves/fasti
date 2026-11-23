import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AdapterError,
  InvalidParams,
  Result,
  Scheduler,
} from "../index.js";
import { createScheduler, defineSchema } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import {
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { issuePaths, unwrap } from "../test-utils/results.js";
import type {
  RuleRecord,
  SetAvailabilityValue,
} from "./plugins/availability.js";

const schema = uuidIdSchema;
const [room, otherRoom] = uuidIdResources;

function window(start: string, end: string) {
  return {
    end: Temporal.PlainTime.from(end),
    start: Temporal.PlainTime.from(start),
  };
}

/** Weekday mornings in Lisbon, with no `exceptions` key. */
const mornings = {
  recurrence: { daysOfWeek: [1, 2, 3, 4, 5], frequency: "weekly", interval: 1 },
  timeWindow: window("09:00", "12:00"),
  timezone: "Europe/Lisbon",
} as const;

/** Saturdays, closed on one date. */
const saturdays = {
  exceptions: [Temporal.PlainDate.from("2030-06-08")],
  recurrence: { daysOfWeek: [6], frequency: "weekly", interval: 1 },
  timeWindow: window("10:00", "14:00"),
  timezone: "Europe/Lisbon",
} as const;

function setup() {
  return createScheduler({ policies: [], adapter: memoryAdapter(), schema });
}

describe("availability", () => {
  it("get returns the rules set, as a set, with exceptions present", async () => {
    const scheduler = setup();

    const set = unwrap(
      await scheduler.availability.set({
        resourceId: room,
        rules: [mornings, saturdays],
      })
    );

    const got = unwrap(await scheduler.availability.get({ resourceId: room }));

    const expected = [{ ...mornings, exceptions: [] }, saturdays];

    expect(set.rules).toStrictEqual(expected);
    expect(got).toHaveLength(2);
    expect(got).toStrictEqual(expect.arrayContaining(expected));
  });

  it("replaces the whole rule set; an empty list clears it", async () => {
    const scheduler = setup();

    await scheduler.availability.set({
      resourceId: room,
      rules: [mornings, saturdays],
    });
    await scheduler.availability.set({ resourceId: room, rules: [saturdays] });

    expect(
      unwrap(await scheduler.availability.get({ resourceId: room }))
    ).toStrictEqual([saturdays]);

    await scheduler.availability.set({ resourceId: room, rules: [] });

    expect(
      unwrap(await scheduler.availability.get({ resourceId: room }))
    ).toStrictEqual([]);
  });

  it("get on an unknown Resource is []", async () => {
    const result = await setup().availability.get({ resourceId: otherRoom });

    expect(result).toStrictEqual({ ok: true, value: [] });
  });

  it("invalid rules give InvalidParams under rules[i] and store nothing", async () => {
    const scheduler = setup();

    await scheduler.availability.set({ resourceId: room, rules: [saturdays] });

    const result = await scheduler.availability.set({
      resourceId: room,
      rules: [
        mornings,
        { ...mornings, timeWindow: window("12:00", "09:00") },
        { ...saturdays, timezone: "Mars/Olympus" },
      ],
    });

    expect(issuePaths(result)).toStrictEqual([
      ["rules", 1, "timeWindow", "end"],
      ["rules", 2, "timezone"],
    ]);
    expect(
      unwrap(await scheduler.availability.get({ resourceId: room }))
    ).toStrictEqual([saturdays]);
  });

  it("types: get's value feeds set's rules; exact error unions", () => {
    type Availability = Scheduler<
      typeof schema,
      undefined,
      readonly []
    >["availability"];

    type GetValue =
      Awaited<ReturnType<Availability["get"]>> extends Result<infer A, unknown>
        ? A
        : never;

    expectTypeOf<GetValue>().toEqualTypeOf<readonly RuleRecord[]>();
    expectTypeOf<GetValue>().toExtend<
      Parameters<Availability["set"]>[0]["rules"]
    >();
    expectTypeOf<Awaited<ReturnType<Availability["set"]>>>().toEqualTypeOf<
      Result<SetAvailabilityValue, InvalidParams | AdapterError>
    >();
    expectTypeOf<Awaited<ReturnType<Availability["get"]>>>().toEqualTypeOf<
      Result<readonly RuleRecord[], AdapterError>
    >();
  });
});

describe("without availability()", () => {
  const bare = defineSchema({});

  function bareScheduler() {
    return createScheduler({ adapter: memoryAdapter(), schema: bare });
  }

  /** A `book` relaxing `availability`, which no installed Policy is. */
  async function relaxAvailability() {
    return await bareScheduler().book({
      end: Temporal.Instant.from("2030-06-09T04:00:00Z"),
      // @ts-expect-error -- no `availability` Policy to relax without availability().
      relax: ["availability"],
      resourceId: "room",
      start: Temporal.Instant.from("2030-06-09T03:00:00Z"),
    });
  }

  it("books any free time, even a Sunday at 03:00, and has no scheduler.availability", async () => {
    const scheduler = bareScheduler();

    expect("availability" in scheduler).toBeFalsy();
    expectTypeOf(scheduler).not.toHaveProperty("availability");

    const sunday = Temporal.Instant.from("2030-06-09T03:00:00Z");

    const slot = {
      end: sunday.add({ hours: 1 }),
      resourceId: "room",
      start: sunday,
    };

    expect(unwrap(await scheduler.book(slot))).toMatchObject(slot);
    // The same time again is taken: the overlap Invariant still holds.
    await expect(scheduler.book(slot)).resolves.toMatchObject({
      error: { _tag: "SlotConflict" },
      ok: false,
    });
  });

  it('refuses relax: ["availability"] by type, and at runtime as InvalidParams', async () => {
    expectTypeOf(relaxAvailability).toBeFunction();

    await expect(relaxAvailability()).resolves.toMatchObject({
      error: { _tag: "InvalidParams", issues: [{ path: ["relax", 0] }] },
      ok: false,
    });
  });
});
