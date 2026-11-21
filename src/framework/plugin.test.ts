import { Cause, Effect, Exit, Result as EffectResult } from "effect";
import { describe, expect, it } from "vitest";

import type { Result } from "../core/result.js";
import { Scheduler as EffectScheduler } from "../effect/index.js";
import { column, createScheduler, defineSchema } from "../index.js";
import type { Plugin } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { notes } from "../test-utils/notes-plugin.js";
import { unwrap } from "../test-utils/results.js";

type StaffId = string & { readonly __brand: "StaffId" };

const schema = defineSchema({
  plugins: [notes({ max: 2 })],
  resource: { idType: column.uuid<StaffId>() },
});

// SAFETY: test fixtures; any UUID string is a StaffId here.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- brands are applied by assertion.
const ann = "0193b6e2-7c00-7000-8000-000000000001" as StaffId;

type Tx = undefined;

class NotesScheduler extends EffectScheduler<
  NotesScheduler,
  typeof schema,
  Tx
>()("test/NotesScheduler") {}

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
    readonly also?: (ctx: AddContext) => Result<unknown, unknown>;
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

const forms: readonly (readonly [string, () => NotesForm])[] = [
  [
    "plain",
    () => {
      const scheduler = createScheduler({ adapter: memoryAdapter(), schema });

      return {
        add: async ({ also, ...params }) =>
          also === undefined
            ? await scheduler.notes.add(params)
            : await scheduler.notes.add({ ...params, also }),
        list: async (params) => await scheduler.notes.list(params),
      };
    },
  ],
  [
    "effect",
    () => {
      const layer = NotesScheduler.layer({ adapter: memoryAdapter(), schema });

      async function run<A, E>(
        use: (s: NotesScheduler["Service"]) => Effect.Effect<A, E>
      ) {
        return toResult(
          await Effect.runPromiseExit(
            Effect.provide(
              Effect.gen(function* withService() {
                return yield* use(yield* NotesScheduler);
              }),
              layer
            )
          )
        );
      }

      return {
        add: async ({ also, ...params }) =>
          await run((s) =>
            also === undefined
              ? s.notes.add(params)
              : s.notes.add({
                  ...params,
                  also: (ctx) => {
                    const r = also(ctx);

                    return r.ok
                      ? Effect.succeed(r.value)
                      : Effect.fail(r.error);
                  },
                })
          ),
        list: async (params) => await run((s) => s.notes.list(params)),
      };
    },
  ],
];

describe.each(forms)("a native Plugin, %s form", (_form, make) => {
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
      [{ ...notes({ max: 1 }), tables: { booking: { columns: {} } } }],
      /"booking" is fasti's own table/u,
    ],
  ] satisfies readonly (readonly [string, readonly Plugin[], RegExp])[])(
    "throws on %s",
    (_case, plugins: readonly Plugin[], message) => {
      // A plain list, not a tuple, so only the runtime check sees the clash; plugin.types.test.ts checks the type error.
      expect(() => defineSchema({ plugins })).toThrow(message);
    }
  );
});
