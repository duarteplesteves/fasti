// oxlint-disable max-classes-per-file -- one service class per schema under test.
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  References,
  Result as EffectResult,
} from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { Result } from "../core/result.js";
import { Scheduler as EffectScheduler, definePlugin } from "../effect/index.js";
import type { SchedulerService } from "../effect/index.js";
import {
  column,
  createScheduler,
  defineHook,
  definePlugin as definePromisePlugin,
  defineSchema,
} from "../index.js";
import type {
  AdapterError,
  Plugin,
  PluginResourceId,
  Scheduler,
} from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { notes } from "../test-utils/notes-plugin.js";
import { promiseNotes } from "../test-utils/promise-notes-plugin.js";
import { unwrap } from "../test-utils/results.js";

type StaffId = string & { readonly __brand: "StaffId" };

const resource = { idType: column.uuid<StaffId>() };

const schema = defineSchema({ plugins: [notes({ max: 2 })], resource });

const promiseSchema = defineSchema({
  plugins: [promiseNotes({ max: 2 })],
  resource,
});

// SAFETY: test fixtures; any UUID string is a StaffId here.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- brands are applied by assertion.
const ann = "0193b6e2-7c00-7000-8000-000000000001" as StaffId;

type Tx = undefined;

type Err<R> = R extends { readonly ok: false; readonly error: infer E }
  ? E
  : never;

class NotesScheduler extends EffectScheduler<
  NotesScheduler,
  typeof schema,
  Tx
>()("test/NotesScheduler") {}

class PromiseNotesScheduler extends EffectScheduler<
  PromiseNotesScheduler,
  typeof promiseSchema,
  Tx
>()("test/PromiseNotesScheduler") {}

/** `scheduler.notes` in each form, typed by the native Plugin: the Promise-style one must fit these too (I9). */
type PlainNotes = Scheduler<typeof schema, Tx, readonly []>["notes"];

type EffectNotes = SchedulerService<typeof schema, Tx, readonly []>["notes"];

/** What `notes.add`'s `also` gets. */
interface AddContext {
  readonly note: { readonly text: string };
  readonly tx: Tx;
  readonly now: Temporal.Instant;
}

/** The two Actions under test, as Promises of a Result in either form; a defect rejects. */
interface NotesForm {
  readonly add: (params: {
    readonly resourceId: StaffId;
    readonly text: string;
    readonly also?: (ctx: AddContext) => Result<unknown, string>;
  }) => Promise<Result<unknown, unknown>>;
  readonly list: (params: {
    readonly resourceId: StaffId;
  }) => Promise<Result<readonly { readonly text: string }[], unknown>>;
}

/** A typed failure becomes `error`; a defect rejects, as the plain form does. */
function toResult<A, E>(exit: Exit.Exit<A, E>): Result<A, E> {
  if (Exit.isSuccess(exit)) {
    return { ok: true, value: exit.value };
  }

  const found = Cause.findError(exit.cause);

  if (Cause.hasDies(exit.cause) || EffectResult.isFailure(found)) {
    throw Cause.squash(exit.cause);
  }

  return { error: found.success, ok: false };
}

function plainForm(scheduler: PlainNotes): NotesForm {
  return {
    add: async ({ also, ...params }) =>
      also === undefined
        ? await scheduler.add(params)
        : await scheduler.add({ ...params, also }),
    list: async (params) => await scheduler.list(params),
  };
}

async function run<A, E>(effect: Effect.Effect<A, E>) {
  return toResult(await Effect.runPromiseExit(effect));
}

function effectForm(scheduler: EffectNotes): NotesForm {
  return {
    add: async ({ also, ...params }) =>
      await run(
        also === undefined
          ? scheduler.add(params)
          : scheduler.add({
              ...params,
              also: (ctx) => {
                const r = also(ctx);

                return r.ok ? Effect.succeed(r.value) : Effect.fail(r.error);
              },
            })
      ),
    list: async (params) => await run(scheduler.list(params)),
  };
}

const forms: readonly (readonly [string, string, () => NotesForm])[] = [
  [
    "native",
    "plain",
    () =>
      plainForm(createScheduler({ adapter: memoryAdapter(), schema }).notes),
  ],
  [
    "native",
    "effect",
    () =>
      effectForm(
        Effect.runSync(
          Effect.provide(
            Effect.gen(function* get() {
              return (yield* NotesScheduler).notes;
            }),
            NotesScheduler.layer({ adapter: memoryAdapter(), schema })
          )
        )
      ),
  ],
  [
    "Promise-style",
    "plain",
    () =>
      plainForm(
        createScheduler({ adapter: memoryAdapter(), schema: promiseSchema })
          .notes
      ),
  ],
  [
    "Promise-style",
    "effect",
    () =>
      effectForm(
        Effect.runSync(
          Effect.provide(
            Effect.gen(function* get() {
              return (yield* PromiseNotesScheduler).notes;
            }),
            PromiseNotesScheduler.layer({
              adapter: memoryAdapter(),
              schema: promiseSchema,
            })
          )
        )
      ),
  ],
];

describe.each(forms)("a %s Plugin, %s form", (_style, _form, make) => {
  it("adds a note and lists it back", async () => {
    const scheduler = make();
    const added = unwrap(await scheduler.add({ resourceId: ann, text: "hi" }));

    expect(added).toMatchObject({ resourceId: ann, text: "hi" });
    expect(unwrap(await scheduler.list({ resourceId: ann }))).toStrictEqual([
      added,
    ]);
  });

  it("gives `also` the note, tx and now, and merges its value", async () => {
    const scheduler = make();
    const seen: AddContext[] = [];

    const added = unwrap(
      await scheduler.add({
        also: (ctx) => {
          seen.push(ctx);

          return { ok: true, value: "audited" };
        },
        resourceId: ann,
        text: "hi",
      })
    );

    expect(added).toMatchObject({ also: "audited", text: "hi" });
    expect(seen).toHaveLength(1);

    const [ctx] = seen;

    expect(ctx).toMatchObject({ note: { text: "hi" }, tx: undefined });
    expect(ctx?.now).toBeInstanceOf(Temporal.Instant);
  });

  it("leaves no note when `also` Vetoes", async () => {
    const scheduler = make();

    const result = await scheduler.add({
      also: () => ({ error: "nope", ok: false }),
      resourceId: ann,
      text: "hi",
    });

    expect(result).toStrictEqual({
      error: { _tag: "Vetoed", reason: "nope" },
      ok: false,
    });
    expect(unwrap(await scheduler.list({ resourceId: ann }))).toStrictEqual([]);
  });

  it("returns a typed failure from `work` and saves nothing", async () => {
    const scheduler = make();

    unwrap(await scheduler.add({ resourceId: ann, text: "one" }));
    unwrap(await scheduler.add({ resourceId: ann, text: "two" }));

    await expect(
      scheduler.add({ resourceId: ann, text: "three" })
    ).resolves.toStrictEqual({
      error: { _tag: "NoteLimit", max: 2 },
      ok: false,
    });
    // Listed by id, and two ids minted in one millisecond have no set order.
    expect(
      unwrap(await scheduler.list({ resourceId: ann }))
        .map((n) => n.text)
        .toSorted()
    ).toStrictEqual(["one", "two"]);
  });

  it("rejects on a defect and saves nothing", async () => {
    const scheduler = make();
    const boom = new Error("boom");

    await expect(
      scheduler.add({
        also: () => {
          throw boom;
        },
        resourceId: ann,
        text: "hi",
      })
    ).rejects.toBe(boom);
    expect(unwrap(await scheduler.list({ resourceId: ann }))).toStrictEqual([]);
  });
});

/** A developer service an `also` can require. */
const Audit = Context.Service<{
  readonly record: (text: string) => Effect.Effect<string>;
}>("test/Audit");

/** A log entry as {@link capturing} records it: the `action` annotation, the level and the cause. */
interface LogEntry {
  readonly action: unknown;
  readonly logLevel: string;
  readonly cause: Cause.Cause<unknown>;
}

/** A Logger layer, in place of the default one, that records each entry into `into`. */
function capturing(into: LogEntry[]) {
  return Logger.layer([
    Logger.make(({ cause, fiber, logLevel }) => {
      into.push({
        action: fiber.getRef(References.CurrentLogAnnotations)["action"],
        cause,
        logLevel,
      });
    }),
  ]);
}

describe("the Promise face crossing (R2)", () => {
  it("runs an Effect `also` that reads a caller's service inside a Promise-style `lock`", async () => {
    const audit = Layer.succeed(Audit, {
      record: (text) => Effect.succeed(`audited ${text}`),
    });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* addAudited() {
        return yield* (yield* PromiseNotesScheduler).notes.add({
          also: ({ note }) =>
            Effect.gen(function* record() {
              return yield* (yield* Audit).record(note.text);
            }),
          resourceId: ann,
          text: "hi",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            PromiseNotesScheduler.layer({
              adapter: memoryAdapter(),
              schema: promiseSchema,
            }),
            audit
          )
        )
      )
    );

    expect(exit).toMatchObject({
      _tag: "Success",
      value: { also: "audited hi", text: "hi" },
    });
  });

  it("rolls the unit back when the call is interrupted mid-unit, and aborts the Plugin's signal", async () => {
    const started = Promise.withResolvers<undefined>();
    const aborted = Promise.withResolvers<undefined>();

    const gated = definePromisePlugin({
      actions: {
        add: {
          kind: "write",
          run: async (
            params: {
              readonly resourceId: PluginResourceId;
              readonly text: string;
              readonly wait: boolean;
            },
            { lock, signal }
          ) =>
            await lock(params.resourceId, async ({ records }) => {
              const note = await records.note.insert({
                resourceId: params.resourceId,
                text: params.text,
              });

              if (params.wait) {
                started.resolve(undefined);
                const abort = Promise.withResolvers<undefined>();

                signal.addEventListener("abort", () => {
                  abort.resolve(undefined);
                });
                await abort.promise;
                aborted.resolve(undefined);
              }

              // Done even when aborted: fasti must still roll the unit back.
              return { _tag: "Done", context: { note }, value: note } as const;
            }),
        },
        list: {
          kind: "read",
          run: async (
            params: { readonly resourceId: PluginResourceId },
            { records }
          ) => ({ ok: true, value: await records.note.list(params) }) as const,
        },
      },
      name: "gated",
      tables: {
        note: {
          columns: { text: { required: true, type: column.text() } },
          timed: false,
        },
      },
    });

    const gatedSchema = defineSchema({ plugins: [gated], resource });

    class GatedScheduler extends EffectScheduler<
      GatedScheduler,
      typeof gatedSchema,
      Tx
    >()("test/GatedScheduler") {}

    const listed = await Effect.runPromise(
      Effect.gen(function* interrupted() {
        const s = yield* GatedScheduler;

        const fiber = yield* Effect.forkChild(
          s.gated.add({ resourceId: ann, text: "slow", wait: true })
        );

        yield* Effect.promise(async () => {
          await started.promise;
        });

        const exit = yield* Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber))
        );

        expect(Exit.hasInterrupts(exit)).toBeTruthy();

        yield* Effect.promise(async () => {
          await aborted.promise;
        });

        // Queued behind the slow unit on the Resource Lock, so that unit has finished once this one returns.
        yield* s.gated.add({ resourceId: ann, text: "fast", wait: false });

        return yield* s.gated.list({ resourceId: ann });
      }).pipe(
        Effect.provide(
          GatedScheduler.layer({
            adapter: memoryAdapter(),
            schema: gatedSchema,
          })
        )
      )
    );

    expect(listed.map((n) => n.text)).toStrictEqual(["fast"]);
  });

  it("rejects with what a Promise-style `work` throws, and rolls its writes back", async () => {
    const boom = new Error("boom");

    const throwing = definePromisePlugin({
      actions: {
        add: {
          kind: "write",
          run: async (
            params: { readonly resourceId: PluginResourceId },
            { lock }
          ) =>
            await lock(params.resourceId, async ({ records }) => {
              await records.note.insert({ ...params, text: "hi" });

              throw boom;
            }),
        },
        list: {
          kind: "read",
          run: async (
            params: { readonly resourceId: PluginResourceId },
            { records }
          ) => ({ ok: true, value: await records.note.list(params) }) as const,
        },
      },
      name: "throwing",
      tables: {
        note: {
          columns: { text: { required: true, type: column.text() } },
          timed: false,
        },
      },
    });

    const scheduler = createScheduler({
      adapter: memoryAdapter(),
      schema: defineSchema({ plugins: [throwing], resource }),
    });

    await expect(scheduler.throwing.add({ resourceId: ann })).rejects.toBe(
      boom
    );
    expect(
      unwrap(await scheduler.throwing.list({ resourceId: ann }))
    ).toStrictEqual([]);
  });

  it("logs an after-commit Hook failure to the caller's Logger", async () => {
    const adapter = memoryAdapter();
    const logs: LogEntry[] = [];

    const hooks = [
      defineHook(promiseSchema, adapter, {
        appliesTo: "*",
        run: () => {
          throw new Error("mail server down");
        },
        when: "afterCommit",
      }),
    ];

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* addLogged() {
        return yield* (yield* PromiseNotesScheduler).notes.add({
          resourceId: ann,
          text: "hi",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            PromiseNotesScheduler.layer({
              adapter,
              hooks,
              schema: promiseSchema,
            }),
            capturing(logs)
          )
        )
      )
    );

    expect(exit).toMatchObject({ _tag: "Success", value: { text: "hi" } });
    expect(logs).toMatchObject([{ action: "notes.add", logLevel: "Error" }]);
    expect(Cause.pretty(logs[0]?.cause ?? Cause.empty)).toContain(
      "mail server down"
    );
  });
});

describe("a Plugin that throws", () => {
  const boom = new Error("boom");

  const broken = definePlugin({
    actions: {
      crash: {
        kind: "write",
        run: (_params: { readonly why?: string }): Effect.Effect<never> => {
          throw boom;
        },
      },
    },
    name: "broken",
  });

  const brokenSchema = defineSchema({ plugins: [broken] });

  class BrokenScheduler extends EffectScheduler<
    BrokenScheduler,
    typeof brokenSchema,
    Tx
  >()("test/BrokenScheduler") {}

  it("rejects in the plain form", async () => {
    const scheduler = createScheduler({
      adapter: memoryAdapter(),
      schema: brokenSchema,
    });

    await expect(scheduler.broken.crash({})).rejects.toBe(boom);
  });

  it("is a defect of the Effect, not a throw at call time, in the Effect form", async () => {
    const service = Effect.runSync(
      Effect.provide(
        BrokenScheduler,
        BrokenScheduler.layer({
          adapter: memoryAdapter(),
          schema: brokenSchema,
        })
      )
    );

    const crash = service.broken.crash({});
    const exit = await Effect.runPromiseExit(crash);

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(boom);
  });
});

describe("record handles on a timed table", () => {
  const start = Temporal.Instant.from("2030-06-03T09:00:00Z");
  const end = start.add({ hours: 1 });

  const shifts = definePlugin({
    actions: {
      churn: {
        kind: "write",
        run: (params: { readonly resourceId: PluginResourceId }, { lock }) =>
          lock(params.resourceId, ({ records }) =>
            Effect.gen(function* churn() {
              const { resourceId } = params;

              const first = yield* records.shift.insert({
                end,
                label: "first",
                resourceId,
                start,
              });

              const moved = yield* records.shift.update({
                changes: { label: "moved" },
                expected: first,
              });

              const stale = yield* records.shift.update({
                changes: { label: "stale" },
                expected: first,
              });

              yield* records.shift.replace({
                records: [{ end, label: "replaced", start }],
                resourceId,
              });

              const gone = yield* records.shift.delete(first.id);

              return {
                _tag: "Done",
                context: {},
                value: { gone, moved, stale },
              } as const;
            })
          ),
      },
      during: {
        kind: "read",
        run: (
          params: {
            readonly resourceId: PluginResourceId;
            readonly from: Temporal.Instant;
            readonly to: Temporal.Instant;
          },
          { records }
        ) =>
          records.shift.list({
            overlapping: { from: params.from, to: params.to },
            resourceId: params.resourceId,
          }),
      },
    },
    name: "shifts",
    tables: {
      shift: {
        columns: { label: { required: true, type: column.text() } },
        timed: true,
      },
    },
  });

  it("updates by compare-and-set, replaces, deletes and lists by range", async () => {
    const scheduler = createScheduler({
      adapter: memoryAdapter(),
      schema: defineSchema({
        plugins: [shifts],
        resource: { idType: column.uuid<StaffId>() },
      }),
    });

    expect(
      unwrap(await scheduler.shifts.churn({ resourceId: ann }))
    ).toStrictEqual({
      gone: { ok: false, reason: "missing" },
      moved: { ok: true },
      stale: { ok: false, reason: "changed" },
    });
    expect(
      unwrap(
        await scheduler.shifts.during({ from: start, resourceId: ann, to: end })
      ).map(({ id: _id, ...shift }) => shift)
    ).toStrictEqual([{ end, label: "replaced", resourceId: ann, start }]);
    expect(
      unwrap(
        await scheduler.shifts.during({
          from: end,
          resourceId: ann,
          to: end.add({ hours: 1 }),
        })
      )
    ).toStrictEqual([]);
  });
});

describe("installing Plugins", () => {
  it("has no Plugin Actions without Plugins", () => {
    const scheduler = createScheduler({
      adapter: memoryAdapter(),
      schema: defineSchema({}),
    });

    expect(Object.keys(scheduler)).not.toContain("notes");
  });

  it.each([
    [
      "two Plugins with one name",
      [notes({ max: 1 }), notes({ max: 2 })],
      /two Plugins are named "notes"/u,
    ],
    [
      "a Plugin named like a scheduler key",
      [{ ...notes({ max: 1 }), name: "book" }],
      /"book" is a scheduler key/u,
    ],
    [
      "two tables with one name",
      [notes({ max: 1 }), { ...notes({ max: 1 }), name: "memos" }],
      /two tables are named "note"/u,
    ],
    [
      "a table named booking",
      [
        {
          ...notes({ max: 1 }),
          tables: { booking: { columns: {}, timed: false } },
        },
      ],
      /"booking" is fasti's own table/u,
    ],
    ...(["start", "end"] as const).map(
      (name) =>
        [
          `a column named ${name}`,
          [
            {
              ...notes({ max: 1 }),
              tables: {
                slot: {
                  columns: { [name]: { required: true, type: column.text() } },
                  timed: true,
                },
              },
            },
          ],
          new RegExp(`"${name}" is a column fasti owns`, "u"),
        ] as const
    ),
  ] satisfies readonly (readonly [string, readonly Plugin[], RegExp])[])(
    "throws on %s",
    (_case, plugins: readonly Plugin[], message) => {
      // A plain list, not a tuple, so only the runtime check sees the clash; plugin.types.test.ts checks the type error.
      expect(() => defineSchema({ plugins })).toThrow(message);
    }
  );
});

describe("a Promise-style Plugin that never fails", () => {
  const quiet = definePromisePlugin({
    actions: {
      list: {
        kind: "read",
        run: async (
          params: { readonly resourceId: PluginResourceId },
          { records }
        ) => ({ ok: true, value: await records.memo.list(params) }) as const,
      },
      touch: {
        kind: "write",
        run: async (
          params: { readonly resourceId: PluginResourceId },
          { lock }
        ) =>
          await lock(params.resourceId, async () => {
            await Promise.resolve();

            return { _tag: "NoOp", value: 1 } as const;
          }),
      },
    },
    name: "quiet",
    tables: {
      memo: {
        columns: { text: { required: true, type: column.text() } },
        timed: false,
      },
    },
  });

  const quietSchema = defineSchema({ plugins: [quiet], resource });

  type Plain = Scheduler<typeof quietSchema, Tx, readonly []>["quiet"];

  type Fx = SchedulerService<typeof quietSchema, Tx, readonly []>["quiet"];

  it("types both Actions' error as AdapterError in the plain form", () => {
    expectTypeOf<
      Err<Awaited<ReturnType<Plain["list"]>>>
    >().toEqualTypeOf<AdapterError>();
    expectTypeOf<
      Err<Awaited<ReturnType<Plain["touch"]>>>
    >().toEqualTypeOf<AdapterError>();
  });

  it("types both Actions' error as AdapterError in the Effect form", () => {
    expectTypeOf<
      Effect.Error<ReturnType<Fx["list"]>>
    >().toEqualTypeOf<AdapterError>();
    expectTypeOf<
      Effect.Error<ReturnType<Fx["touch"]>>
    >().toEqualTypeOf<AdapterError>();
  });
});
