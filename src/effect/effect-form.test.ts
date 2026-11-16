import { Cause, Effect, Exit } from "effect";
import { assert, describe, expect, expectTypeOf, it } from "vitest";

import type { Adapter } from "../adapter/contract.js";
import type { Result } from "../core/result.js";
import { mintBookingId } from "../framework/booking-id.js";
import { createScheduler } from "../index.js";
import type { SlotConflict } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import {
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { Scheduler } from "./index.js";
import type { SchedulerService } from "./index.js";

const schema = uuidIdSchema;
const [room] = uuidIdResources;

class AppScheduler extends Scheduler<AppScheduler, typeof schema>()(
  "test/AppScheduler"
) {}

type Service = SchedulerService<typeof schema>;

const weekdays = {
  exceptions: [],
  recurrence: { daysOfWeek: [1, 2, 3, 4, 5], frequency: "weekly", interval: 1 },
  timeWindow: {
    end: Temporal.PlainTime.from("17:00"),
    start: Temporal.PlainTime.from("09:00"),
  },
  timezone: "Europe/Lisbon",
} as const;

/** `hours` from 09:00 Monday 3 June 2030 Lisbon, as Instants. */
function at(hours: number): Temporal.Instant {
  return Temporal.Instant.from("2030-06-03T08:00:00Z").add({ hours });
}

/** Run `use` against the Effect form over `adapter`, to its Exit. */
async function viaEffect<A, E>(
  adapter: Adapter<undefined, "blocks">,
  use: (service: Service) => Effect.Effect<A, E>
): Promise<Exit.Exit<A, E>> {
  return await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* withService() {
        return yield* use(yield* AppScheduler);
      }),
      AppScheduler.layer({ adapter, schema })
    )
  );
}

/** The Exit a failed plain Result stands for, so both forms compare directly. */
function failureOf<E>(result: Result<unknown, E>): Exit.Exit<never, E> {
  assert(!result.ok, "expected the plain form to fail");

  return Exit.fail(result.error);
}

/** A scheduler over a fresh Adapter with weekday availability and a 10:00–11:00 Booking. */
async function seeded() {
  const adapter = memoryAdapter();
  const plain = createScheduler({ adapter, schema });

  await plain.availability.set({ resourceId: room, rules: [weekdays] });

  const booked = await plain.book({
    end: at(2),
    resourceId: room,
    start: at(1),
  });

  assert(booked.ok, "expected the seed booking to succeed");

  return { adapter, booking: booked.value, plain };
}

/** Wrap `inner` so a locked `listBookings` breaks the contract by resolving to a non-array. */
function listingNonArray(
  inner: Adapter<undefined, "blocks">
): Adapter<undefined, "blocks"> {
  return (s) => {
    const bound = inner(s);

    return {
      ...bound,
      withResourceLock: async (resourceId, work) =>
        await bound.withResourceLock(
          resourceId,
          async (locked) =>
            await work({
              ...locked,
              listBookings: async () =>
                // @ts-expect-error -- deliberately violates the contract.
                await Promise.resolve("not an array"),
            })
        ),
    };
  };
}

describe("Effect form", () => {
  it("yield* AppScheduler gives a typed SchedulerService from AppScheduler.layer", async () => {
    const exit = await viaEffect(memoryAdapter(), Effect.succeed);

    assert(Exit.isSuccess(exit), "expected the layer to provide the service");
    expectTypeOf(exit.value).toEqualTypeOf<Service>();
  });

  it("fails with the same values as the plain form", async () => {
    const { adapter, plain } = await seeded();
    const overlap = { end: at(3), resourceId: room, start: at(1) };
    const outside = { end: at(10), resourceId: room, start: at(9) };
    const unknown = { id: mintBookingId() };

    const conflict = failureOf(await plain.book(overlap));
    const violation = failureOf(await plain.book(outside));
    const notFound = failureOf(await plain.cancel(unknown));

    await expect(
      viaEffect(adapter, (s) => s.book(overlap))
    ).resolves.toStrictEqual(conflict);
    await expect(
      viaEffect(adapter, (s) => s.book(outside))
    ).resolves.toStrictEqual(violation);
    await expect(
      viaEffect(adapter, (s) => s.cancel(unknown))
    ).resolves.toStrictEqual(notFound);
  });

  it("Effect.catchTag narrows to SlotConflict", async () => {
    const { adapter, booking } = await seeded();

    const exit = await viaEffect(adapter, (s) =>
      s.book({ end: at(3), resourceId: room, start: at(1) }).pipe(
        Effect.catchTag("SlotConflict", (error) => {
          expectTypeOf(error).toEqualTypeOf<SlotConflict>();

          return Effect.succeed(error.conflicts);
        })
      )
    );

    expect(exit).toStrictEqual(
      Exit.succeed([
        { end: at(2), id: booking.id, kind: "booking", start: at(1) },
      ])
    );
  });

  it("blocks.create and blocks.list run through the layer, with SlotConflict in the error channel", async () => {
    const { adapter, booking } = await seeded();

    const created = await viaEffect(adapter, (s) =>
      s.blocks.create({ end: at(4), resourceId: room, start: at(3) })
    );

    assert(Exit.isSuccess(created), "expected the Block to be created");

    await expect(
      viaEffect(adapter, (s) =>
        s.blocks.list({ from: at(0), resourceId: room, to: at(8) })
      )
    ).resolves.toStrictEqual(Exit.succeed([created.value]));

    const refused = await viaEffect(adapter, (s) =>
      s.blocks.create({ end: at(2), resourceId: room, start: at(1) }).pipe(
        Effect.catchTag("SlotConflict", (error) => {
          expectTypeOf(error).toEqualTypeOf<SlotConflict>();

          return Effect.succeed(error.conflicts);
        })
      )
    );

    expect(refused).toStrictEqual(
      Exit.succeed([
        { end: at(2), id: booking.id, kind: "booking", start: at(1) },
      ])
    );
  });

  it("dies on a defect from a contract-violating Adapter", async () => {
    const inner = memoryAdapter();

    await createScheduler({ adapter: inner, schema }).availability.set({
      resourceId: room,
      rules: [weekdays],
    });

    const exit = await viaEffect(listingNonArray(inner), (s) =>
      s.book({ end: at(2), resourceId: room, start: at(1) })
    );

    assert(Exit.isFailure(exit), "expected a failure");
    expect(Cause.hasDies(exit.cause)).toBeTruthy();
    await expect(
      inner(schema).listBookings({
        overlapping: { from: at(0), to: at(24) },
        resourceId: room,
      })
    ).resolves.toStrictEqual([]);
  });
});
