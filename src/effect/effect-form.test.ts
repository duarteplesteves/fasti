// oxlint-disable max-classes-per-file -- one service class per schema under test.
import { Cause, Context, Effect, Exit, Layer } from "effect";
import { TestClock } from "effect/testing";
import { assert, describe, expect, expectTypeOf, it } from "vitest";

import type { Adapter } from "../adapter/contract.js";
import type { Result } from "../core/result.js";
import { mintBookingId } from "../framework/booking-id.js";
import {
  column,
  createScheduler,
  definePolicy,
  defineSchema,
} from "../index.js";
import type {
  BlockNotFound,
  SlotConflict,
  StatusMismatch,
  TransitionError,
  Violation,
} from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import {
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { Scheduler } from "./index.js";
import type { SchedulerService, TxOf } from "./index.js";

const schema = uuidIdSchema;
const [room] = uuidIdResources;

type Tx = TxOf<ReturnType<typeof memoryAdapter>>;

class AppScheduler extends Scheduler<
  AppScheduler,
  typeof schema,
  Tx,
  readonly []
>()("test/AppScheduler") {}

type Service = SchedulerService<typeof schema, Tx, readonly []>;

/** A developer service an `also` can require. */
interface AuditLog {
  readonly record: (note: string) => Effect.Effect<string>;
}

const Audit = Context.Service<AuditLog>("test/Audit");

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
      AppScheduler.layer({ policies: [], adapter, schema })
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
  const plain = createScheduler({ policies: [], adapter, schema });

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

  it("blocks.update and blocks.delete run through the layer, with BlockNotFound in the error channel", async () => {
    const { adapter } = await seeded();

    const created = await viaEffect(adapter, (s) =>
      s.blocks.create({ end: at(4), resourceId: room, start: at(3) })
    );

    assert(Exit.isSuccess(created), "expected the Block to be created");

    const { id } = created.value;

    await expect(
      viaEffect(adapter, (s) =>
        s.blocks.update({ end: at(6), id, start: at(5) })
      )
    ).resolves.toStrictEqual(
      Exit.succeed({ ...created.value, end: at(6), start: at(5) })
    );
    await expect(
      viaEffect(adapter, (s) => s.blocks.delete({ id }))
    ).resolves.toStrictEqual(Exit.void);

    const gone = await viaEffect(adapter, (s) =>
      s.blocks.delete({ id }).pipe(
        Effect.catchTag("BlockNotFound", (error) => {
          expectTypeOf(error).toEqualTypeOf<BlockNotFound>();

          return Effect.succeed(error.id);
        })
      )
    );

    expect(gone).toStrictEqual(Exit.succeed(id));
  });

  it("reschedule runs through the layer, with StatusMismatch in the error channel", async () => {
    const { adapter, booking } = await seeded();

    await expect(
      viaEffect(adapter, (s) =>
        s.reschedule({ end: at(4), id: booking.id, start: at(3) })
      )
    ).resolves.toStrictEqual(
      Exit.succeed({ ...booking, end: at(4), start: at(3) })
    );

    await viaEffect(adapter, (s) => s.cancel({ id: booking.id }));

    const refused = await viaEffect(adapter, (s) =>
      s.reschedule({ end: at(6), id: booking.id, start: at(5) }).pipe(
        Effect.catchTag("StatusMismatch", (error) => {
          expectTypeOf(error).toEqualTypeOf<
            StatusMismatch<"booked" | "cancelled">
          >();

          return Effect.succeed(error.status);
        })
      )
    );

    expect(refused).toStrictEqual(Exit.succeed("cancelled"));
  });

  it("dies on a defect from a contract-violating Adapter", async () => {
    const inner = memoryAdapter();

    await createScheduler({
      policies: [],
      adapter: inner,
      schema,
    }).availability.set({
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

  it("TxOf is the Adapter's Tx, and `tx` in an `also` has it", () => {
    interface DbTx {
      readonly query: (sql: string) => Promise<readonly string[]>;
    }

    expectTypeOf<Tx>().toEqualTypeOf<undefined>();
    expectTypeOf<TxOf<Adapter<DbTx, "blocks">>>().toEqualTypeOf<DbTx>();

    function bookWithTx(s: SchedulerService<typeof schema, DbTx, readonly []>) {
      return s.book({
        also: ({ tx }) => {
          expectTypeOf(tx).toEqualTypeOf<DbTx>();

          return Effect.void;
        },
        end: at(2),
        resourceId: room,
        start: at(1),
      });
    }

    expectTypeOf(bookWithTx).toBeFunction();
  });

  it("an `also` that needs a service needs its Layer, and runs with it", async () => {
    const { adapter } = await seeded();

    const program = Effect.gen(function* bookAudited() {
      const s = yield* AppScheduler;

      return yield* s.book({
        also: ({ booking }) =>
          Effect.gen(function* audited() {
            const audit = yield* Audit;

            return yield* audit.record(`booked ${booking.id}`);
          }),
        end: at(4),
        resourceId: room,
        start: at(3),
      });
    });

    expectTypeOf<Effect.Services<typeof program>>().toEqualTypeOf<
      AppScheduler | AuditLog
    >();

    const withoutAudit = program.pipe(
      Effect.provide(AppScheduler.layer({ policies: [], adapter, schema }))
    );

    // @ts-expect-error -- Audit isn't provided.
    expectTypeOf(Effect.runPromiseExit).toBeCallableWith(withoutAudit);

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            AppScheduler.layer({ policies: [], adapter, schema }),
            Layer.succeed(Audit, {
              record: (note) => Effect.succeed(`audited: ${note}`),
            })
          )
        )
      )
    );

    assert(Exit.isSuccess(exit), "expected the audited booking to succeed");
    expect(exit.value.also).toBe(`audited: booked ${exit.value.id}`);
  });

  it("`now` in an `also` is the Clock's, so TestClock controls it", async () => {
    const { adapter } = await seeded();
    const frozen = Temporal.Instant.from("2031-01-01T00:00:00Z");

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* bookAtTestTime() {
        yield* TestClock.setTime(frozen.epochMilliseconds);
        const s = yield* AppScheduler;

        return yield* s.book({
          also: ({ now }) => Effect.succeed(now),
          end: at(4),
          resourceId: room,
          start: at(3),
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            AppScheduler.layer({ policies: [], adapter, schema }),
            TestClock.layer()
          )
        )
      )
    );

    assert(Exit.isSuccess(exit), "expected the booking to succeed");
    expect(exit.value.also).toStrictEqual(frozen);
  });
});

/** UUID ids, Blocks, and `booked → inProgress`, so the Effect form has `transition`. */
const lifecycleSchema = defineSchema({
  block: { fields: {} },
  booking: {
    statuses: { inProgress: { blocking: true } },
    transitions: { booked: ["inProgress"] },
  },
  resource: { idType: column.uuid() },
});

class LifecycleScheduler extends Scheduler<
  LifecycleScheduler,
  typeof lifecycleSchema,
  Tx,
  readonly []
>()("test/LifecycleScheduler") {}

describe("Effect form transition", () => {
  it("runs through the layer, with StatusMismatch in the error channel", async () => {
    const adapter = memoryAdapter();

    const plain = createScheduler({
      policies: [],
      adapter,
      schema: lifecycleSchema,
    });

    await plain.availability.set({ resourceId: room, rules: [weekdays] });

    const booked = await plain.book({
      end: at(2),
      resourceId: room,
      start: at(1),
    });

    assert(booked.ok, "expected the seed booking to succeed");
    const { id } = booked.value;

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* moveTwice() {
          const scheduler = yield* LifecycleScheduler;

          const moved = yield* scheduler.transition({
            from: "booked",
            id,
            to: "inProgress",
          });

          const stale = yield* Effect.flip(
            scheduler.transition({ from: "booked", id, to: "inProgress" })
          );

          return { moved, stale };
        }),
        LifecycleScheduler.layer({
          policies: [],
          adapter,
          schema: lifecycleSchema,
        })
      )
    );

    assert(Exit.isSuccess(exit), "expected both calls to run");
    expect(exit.value.moved.status).toBe("inProgress");
    expect(exit.value.stale).toStrictEqual({
      _tag: "StatusMismatch",
      id,
      status: "inProgress",
    });
    expectTypeOf(exit.value.stale).toEqualTypeOf<
      TransitionError<typeof lifecycleSchema>
    >();
  });
});

const closed = definePolicy(schema, {
  appliesTo: ["book"],
  check: () => ({ reason: "closed" }),
  name: "closed",
});

const policies = [closed] as const;

class PolicyScheduler extends Scheduler<
  PolicyScheduler,
  typeof schema,
  Tx,
  typeof policies
>()("test/PolicyScheduler") {}

describe("Effect form Policies", () => {
  it("returns PolicyViolation through the layer, as the plain form does", async () => {
    const { adapter } = await seeded();
    const params = { end: at(4), resourceId: room, start: at(3) };

    const viaLayer = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* bookThroughLayer() {
          return yield* (yield* PolicyScheduler).book(params);
        }),
        PolicyScheduler.layer({ adapter, policies, schema })
      )
    );

    const plain = await createScheduler({ adapter, policies, schema }).book(
      params
    );

    expect(viaLayer).toStrictEqual(
      Exit.fail({
        _tag: "PolicyViolation",
        violations: [{ detail: { reason: "closed" }, policy: "closed" }],
      })
    );
    expect(viaLayer).toStrictEqual(failureOf(plain));
  });

  it("takes relax and returns waived through the layer, as the plain form does", async () => {
    const { adapter } = await seeded();

    const params = {
      end: at(4),
      relax: ["closed"],
      resourceId: room,
      start: at(3),
    } as const;

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* bookRelaxed() {
          return yield* (yield* PolicyScheduler).book(params);
        }),
        PolicyScheduler.layer({ adapter, policies, schema })
      )
    );

    assert(Exit.isSuccess(exit), "expected the booking to succeed");
    expectTypeOf(exit.value.waived).toEqualTypeOf<
      readonly Violation<"closed", { reason: string }>[]
    >();
    expect(exit.value.waived).toStrictEqual([
      { detail: { reason: "closed" }, policy: "closed" },
    ]);
  });

  it("gives the Policies and `also` the same TestClock `now`", async () => {
    const { adapter } = await seeded();
    const frozen = Temporal.Instant.from("2031-01-01T00:00:00Z");
    const seen: Temporal.Instant[] = [];

    const watching = definePolicy(schema, {
      appliesTo: ["book"],
      check: () => null,
      load: ({ now }) => {
        seen.push(now);
      },
      name: "watching",
    });

    class WatchingScheduler extends Scheduler<
      WatchingScheduler,
      typeof schema,
      Tx,
      readonly [typeof watching]
    >()("test/WatchingScheduler") {}

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* bookAtTestTime() {
        yield* TestClock.setTime(frozen.epochMilliseconds);

        return yield* (yield* WatchingScheduler).book({
          also: ({ now }) => Effect.succeed(now),
          end: at(4),
          resourceId: room,
          start: at(3),
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            WatchingScheduler.layer({
              adapter,
              policies: [watching],
              schema,
            }),
            TestClock.layer()
          )
        )
      )
    );

    assert(Exit.isSuccess(exit), "expected the booking to succeed");
    expect(seen).toStrictEqual([frozen]);
    expect(exit.value.also).toStrictEqual(frozen);
  });

  it("requires policies on layer", () => {
    // @ts-expect-error -- policies is required.
    expectTypeOf(PolicyScheduler.layer).toBeCallableWith({
      adapter: memoryAdapter(),
      schema,
    });
  });
});
