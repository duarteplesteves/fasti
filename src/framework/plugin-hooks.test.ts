import { describe, expect, it } from "vitest";

import { column, createScheduler, defineHook, defineSchema } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { notes } from "../test-utils/notes-plugin.js";
import { promiseNotes } from "../test-utils/promise-notes-plugin.js";
import { unwrap } from "../test-utils/results.js";

type StaffId = string & { readonly __brand: "StaffId" };

const resource = { idType: column.uuid<StaffId>() };

// SAFETY: test fixtures; any UUID string is a StaffId here.
const ann = "0193b6e2-7c00-7000-8000-000000000001" as StaffId;

function nativeSchema(trace: string[] | null) {
  return defineSchema({ plugins: [notes({ max: 1, trace })], resource });
}

type S = ReturnType<typeof nativeSchema>;

/** The `notes` Plugin in each style (I9): the Promise-style one must fit the native one's schema type. */
const styles: readonly (readonly [string, (trace: string[] | null) => S])[] = [
  ["native", nativeSchema],
  [
    "Promise-style",
    (trace) =>
      defineSchema({ plugins: [promiseNotes({ max: 1, trace })], resource }),
  ],
];

describe.each(styles)("Hooks on a %s Plugin", (_style, makeSchema) => {
  /** A scheduler whose app Hooks, on `"*"`, push what they saw to `seen`; the Plugin's own Hooks push to `trace`. */
  function setup(trace: string[] | null) {
    const schema = makeSchema(trace);
    const adapter = memoryAdapter();
    const seen: string[] = [];

    const scheduler = createScheduler({
      adapter,
      hooks: [
        defineHook(schema, adapter, {
          appliesTo: "*",
          run: ({ action }) => {
            seen.push(`inTransaction ${action}`);
          },
          when: "inTransaction",
        }),
        defineHook(schema, adapter, {
          appliesTo: "*",
          run: ({ action }) => {
            seen.push(`afterCommit ${action}`);
          },
          when: "afterCommit",
        }),
      ],
      schema,
    });

    return { scheduler, seen, trace };
  }

  type Setup = ReturnType<typeof setup> & { readonly trace: string[] };

  it('runs a `"notes.add"` Hook with the note, tx and now, and a `"*"` one', async () => {
    const schema = makeSchema(null);
    const adapter = memoryAdapter();
    const events: { readonly now: Temporal.Instant }[] = [];

    const scheduler = createScheduler({
      adapter,
      hooks: [
        defineHook(schema, adapter, {
          appliesTo: ["notes.add"],
          run: (event) => {
            events.push(event);
          },
          when: "inTransaction",
        }),
        defineHook(schema, adapter, {
          appliesTo: ["notes.add"],
          run: (event) => {
            events.push(event);
          },
          when: "afterCommit",
        }),
      ],
      schema,
    });

    const note = unwrap(
      await scheduler.notes.add({ resourceId: ann, text: "hi" })
    );

    expect(events.map((e) => e.now instanceof Temporal.Instant)).toStrictEqual([
      true,
      true,
    ]);
    expect(events.map(({ now: _now, ...rest }) => rest)).toStrictEqual([
      { action: "notes.add", note, tx: undefined },
      { action: "notes.add", note },
    ]);

    const star = setup(null);

    unwrap(await star.scheduler.notes.add({ resourceId: ann, text: "hi" }));

    expect(star.seen).toStrictEqual([
      "inTransaction notes.add",
      "afterCommit notes.add",
    ]);
  });

  it.each([
    [
      "notes.list",
      async ({ scheduler }: Setup) => {
        unwrap(await scheduler.notes.list({ resourceId: ann }));
      },
    ],
    [
      "a NoOp",
      async ({ scheduler }: Setup) => {
        unwrap(await scheduler.notes.noop({ resourceId: ann }));
      },
    ],
    [
      "a typed failure",
      async ({ scheduler, seen, trace }: Setup) => {
        // Fills the one slot, so there is something to refuse over.
        unwrap(await scheduler.notes.add({ resourceId: ann, text: "one" }));
        seen.length = 0;
        trace.length = 0;

        const result = await scheduler.notes.add({
          resourceId: ann,
          text: "two",
        });

        expect(result).toStrictEqual({
          error: { _tag: "NoteLimit", max: 1 },
          ok: false,
        });
      },
    ],
    [
      "a Veto",
      async ({ scheduler }: Setup) => {
        const result = await scheduler.notes.add({
          also: () => ({ error: "nope", ok: false }),
          resourceId: ann,
          text: "two",
        });

        expect(result).toStrictEqual({
          error: { _tag: "Vetoed", reason: "nope" },
          ok: false,
        });
      },
    ],
  ])("runs no Hook on %s", async (_name, call) => {
    const trace: string[] = [];
    const ctx = { ...setup(trace), trace };

    await call(ctx);

    expect(ctx.seen).toStrictEqual([]);
    expect(trace).toStrictEqual([]);
  });

  it("runs also, then the Plugin's in-transaction Hooks before the app's, then after commit the Plugin's before the app's", async () => {
    const log: string[] = [];
    const schema = makeSchema(log);
    const adapter = memoryAdapter();

    const scheduler = createScheduler({
      adapter,
      hooks: [
        defineHook(schema, adapter, {
          appliesTo: ["notes.add"],
          run: () => {
            log.push("app inTransaction notes.add");
          },
          when: "inTransaction",
        }),
        defineHook(schema, adapter, {
          appliesTo: ["notes.add"],
          run: () => {
            log.push("app afterCommit notes.add");
          },
          when: "afterCommit",
        }),
      ],
      schema,
    });

    unwrap(
      await scheduler.notes.add({
        also: () => {
          log.push("also");

          return { ok: true, value: null };
        },
        resourceId: ann,
        text: "hi",
      })
    );

    expect(log).toStrictEqual([
      "also",
      "plugin inTransaction notes.add",
      "app inTransaction notes.add",
      "plugin afterCommit notes.add",
      "app afterCommit notes.add",
    ]);
  });

  it("keeps a Plugin in-transaction Hook's record write with the unit, and rolls it back with it", async () => {
    const kept = setup([]);

    unwrap(await kept.scheduler.notes.add({ resourceId: ann, text: "hi" }));

    expect(
      unwrap(await kept.scheduler.notes.list({ resourceId: ann }))
        .map((n) => n.text)
        .toSorted()
    ).toStrictEqual(["hi", "hi (echo)"]);

    const schema = makeSchema([]);
    const adapter = memoryAdapter();
    const reason = new Error("app Hook failed");

    const scheduler = createScheduler({
      adapter,
      hooks: [
        defineHook(schema, adapter, {
          appliesTo: ["notes.add"],
          run: () => {
            throw reason;
          },
          when: "inTransaction",
        }),
      ],
      schema,
    });

    await expect(
      scheduler.notes.add({ resourceId: ann, text: "hi" })
    ).rejects.toBe(reason);
    expect(
      unwrap(await scheduler.notes.list({ resourceId: ann }))
    ).toStrictEqual([]);
  });
});
