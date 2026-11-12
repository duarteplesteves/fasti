import { describe, expect, expectTypeOf, it } from "vitest";

import { unwrap } from "../test-utils/results.js";
import * as core from "./index.js";
import { findFreeSlots, isSlotValid, withBlockingFlag } from "./index.js";
import type {
  AvailabilityRule,
  AvailabilityViolation,
  Booking,
  BookingId,
  CorePolicy,
  CoreViolations,
  Issue,
  Recurrence,
  Slot,
  WeeklyRecurrence,
} from "./index.js";

function booking<Id extends string>(id: Id): Booking<Id> {
  return {
    end: Temporal.Instant.from("2026-05-12T10:00:00Z"),
    id,
    isBlocking: true,
    resourceId: "doc-1",
    start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
  };
}

describe("public API surface", () => {
  it("composes withBlockingFlag → findFreeSlots → isSlotValid round-trip via the fasti/core entry", () => {
    const tuesday9to17: AvailabilityRule = {
      recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
      resourceId: "doc-1",
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    };

    const rawBookings = [
      {
        end: Temporal.Instant.from("2026-05-12T10:00:00Z"),
        id: "b1",
        resourceId: "doc-1",
        start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
      },
    ];

    const bookings: Booking[] = unwrap(
      withBlockingFlag(rawBookings, {
        default: "blocking",
      })
    );

    const slots: Slot[] = unwrap(
      findFreeSlots({
        bookings,
        duration: 60,
        from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
        interval: 60,
        resourceId: "doc-1",
        rules: [tuesday9to17],
        timezone: "Europe/Lisbon",
        to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
      })
    );

    expect(slots).not.toHaveLength(0);

    for (const slot of slots) {
      const valid = unwrap(
        isSlotValid({
          bookings,
          resourceId: "doc-1",
          rules: [tuesday9to17],
          slot: { end: slot.end.toInstant(), start: slot.start.toInstant() },
        })
      );

      expect(valid).toBeTruthy();
    }
  });
});

/** Copied from the Standard Schema spec (StandardSchemaV1.Issue / PathSegment). */
interface StandardSchemaIssue {
  readonly message: string;
  readonly path?:
    | readonly (PropertyKey | { readonly key: PropertyKey })[]
    | undefined;
}

describe("export surface", () => {
  it("exports exactly the six functions at runtime", () => {
    expect(Object.keys(core).toSorted()).toStrictEqual([
      "checkRule",
      "detectConflicts",
      "expandRules",
      "findFreeSlots",
      "isSlotValid",
      "withBlockingFlag",
    ]);
  });

  it("exports Recurrence as the frequency-discriminated rule recurrence", () => {
    expectTypeOf<AvailabilityRule["recurrence"]>().toEqualTypeOf<Recurrence>();
    expectTypeOf<Recurrence>().toEqualTypeOf<WeeklyRecurrence>();
    expectTypeOf<WeeklyRecurrence["frequency"]>().toEqualTypeOf<"weekly">();
  });

  it("types waived from relax: never without it, AvailabilityViolation with it", () => {
    const params = {
      bookings: [],
      duration: 60,
      from: Temporal.Instant.from("2026-05-12T00:00:00Z"),
      interval: 60,
      resourceId: "doc-1",
      rules: [],
      timezone: "Europe/Lisbon",
      to: Temporal.Instant.from("2026-05-13T00:00:00Z"),
    };

    const strict = unwrap(core.findFreeSlots(params));

    const relaxed = unwrap(
      core.findFreeSlots({ ...params, relax: ["availability"] })
    );

    expectTypeOf(strict).toEqualTypeOf<Slot[]>();
    expectTypeOf<Slot["waived"]>().toEqualTypeOf<readonly never[]>();
    expectTypeOf(relaxed).toEqualTypeOf<Slot<AvailabilityViolation>[]>();
    expectTypeOf<
      AvailabilityViolation["policy"]
    >().toEqualTypeOf<"availability">();
    expectTypeOf<CorePolicy>().toEqualTypeOf<"availability">();
    expectTypeOf<
      CoreViolations["availability"]
    >().toEqualTypeOf<AvailabilityViolation>();

    // @ts-expect-error only Policies the Core knows can be relaxed
    core.findFreeSlots({ ...params, relax: ["notice"] });
  });

  it("keeps Booking id types through the Core; resourceId stays a plain string", () => {
    const candidate = {
      end: Temporal.Instant.from("2026-05-12T10:00:00Z"),
      start: Temporal.Instant.from("2026-05-12T09:00:00Z"),
    };

    // SAFETY: test fixture; the Framework mints real BookingIds.
    const branded = [booking("b1" as BookingId)];

    expectTypeOf(
      unwrap(
        core.detectConflicts({
          bookings: branded,
          candidate,
          resourceId: "doc-1",
        })
      )
    ).toEqualTypeOf<Booking<BookingId>[]>();

    type MyId = string & { readonly __mine: true };

    // SAFETY: test fixture standing in for a developer-minted id.
    const mine = [booking("m1" as MyId)];

    expectTypeOf(
      unwrap(
        core.detectConflicts({
          bookings: mine,
          candidate,
          resourceId: "doc-1",
        })
      )
    ).toEqualTypeOf<Booking<MyId>[]>();

    expectTypeOf(
      unwrap(core.withBlockingFlag(branded, { default: "blocking" }))
    ).toEqualTypeOf<Booking<BookingId>[]>();

    core.detectConflicts({
      bookings: branded,
      candidate,
      // @ts-expect-error a plain string is not a BookingId
      excludeBookingId: "b1",
      resourceId: "doc-1",
    });

    expectTypeOf<Booking["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Booking<BookingId>["resourceId"]>().toEqualTypeOf<string>();
  });

  it("Issue matches the Standard Schema issue structurally", () => {
    expectTypeOf<Issue>().toEqualTypeOf<StandardSchemaIssue>();
  });

  it("accepts readonly `as const` inputs", () => {
    const rules = [
      {
        recurrence: { daysOfWeek: [2], frequency: "weekly", interval: 1 },
        resourceId: "doc-1",
        timeWindow: {
          end: Temporal.PlainTime.from("17:00"),
          start: Temporal.PlainTime.from("09:00"),
        },
        timezone: "Europe/Lisbon",
      },
    ] as const;

    const result = core.expandRules({
      from: Temporal.PlainDate.from("2026-05-12"),
      rules,
      to: Temporal.PlainDate.from("2026-05-12"),
    });

    expect(unwrap(result)).toHaveLength(1);
  });
});
