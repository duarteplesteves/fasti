import type { Effect } from "effect";
import { describe, expectTypeOf, it } from "vitest";

import type { Result } from "../core/result.js";
import type { SchedulerService } from "../effect/index.js";
import { column, defineSchema } from "../index.js";
import type { AdapterError, RecordId, Scheduler, Vetoed } from "../index.js";
import { notes } from "../test-utils/notes-plugin.js";
import type { NoteLimit } from "../test-utils/notes-plugin.js";
import { promiseNotes } from "../test-utils/promise-notes-plugin.js";

type StaffId = string & { readonly __brand: "StaffId" };

const schema = defineSchema({
  plugins: [notes({ max: 2 })],
  resource: { idType: column.uuid<StaffId>() },
});

type S = typeof schema;

const promiseSchema = defineSchema({
  plugins: [promiseNotes({ max: 2 })],
  resource: { idType: column.uuid<StaffId>() },
});

/** A note as the app sees it: the schema's branded Resource id, the table's branded record id. */
interface AppNote {
  readonly id: RecordId<"note">;
  readonly resourceId: StaffId;
  readonly text: string;
}

/** Never called: only the types are checked. Each would throw at runtime. */
function clashes() {
  return [
    // @ts-expect-error -- two Plugins named notes.
    defineSchema({ plugins: [notes({ max: 1 }), notes({ max: 2 })] }),
    defineSchema({
      // @ts-expect-error -- `book` is a Booking Action.
      plugins: [{ ...notes({ max: 1 }), name: "book" as const }],
    }),
    defineSchema({
      // @ts-expect-error -- both declare `note`.
      plugins: [
        notes({ max: 1 }),
        { ...notes({ max: 1 }), name: "memos" as const },
      ],
    }),
    defineSchema({
      // @ts-expect-error -- `booking` is fasti's own table.
      plugins: [{ ...notes({ max: 1 }), tables: { booking: { columns: {} } } }],
    }),
  ];
}

/** Never called: `notes.add` without `also`. */
async function addPlain(
  add: Scheduler<S, undefined, readonly []>["notes"]["add"],
  id: StaffId
) {
  // @ts-expect-error -- a plain string isn't the schema's StaffId.
  await add({ resourceId: "0193b6e2-7c00-7000-8000-000000000001", text: "hi" });

  return await add({ resourceId: id, text: "hi" });
}

/** Never called: `notes.add` with a typed `also` context. */
async function audit(
  add: Scheduler<S, undefined, readonly []>["notes"]["add"],
  id: StaffId
) {
  return await add({
    also: (ctx) => {
      expectTypeOf(ctx).toEqualTypeOf<
        { readonly note: AppNote } & {
          readonly tx: undefined;
          readonly now: Temporal.Instant;
        }
      >();

      return { ok: true, value: 1 };
    },
    resourceId: id,
    text: "hi",
  });
}

describe("Plugin Actions on the scheduler", () => {
  it("has scheduler.notes only when the Plugin is installed", () => {
    expectTypeOf<Scheduler<S, undefined, readonly []>>().toHaveProperty(
      "notes"
    );
    const bare = defineSchema({});

    expectTypeOf<
      keyof Scheduler<typeof bare, undefined, readonly []>
    >().not.toEqualTypeOf<"notes">();
    expectTypeOf<
      Extract<keyof Scheduler<typeof bare, undefined, readonly []>, "notes">
    >().toBeNever();
  });

  it("takes and returns the schema's branded Resource id, in both forms", () => {
    type Plain = Scheduler<S, undefined, readonly []>["notes"];

    type Native = SchedulerService<S, undefined, readonly []>["notes"];

    expectTypeOf<Plain["list"]>().parameter(0).toEqualTypeOf<{
      readonly resourceId: StaffId;
    }>();
    expectTypeOf<Plain["list"]>().returns.toEqualTypeOf<
      Promise<Result<readonly AppNote[], AdapterError>>
    >();
    expectTypeOf<Native["list"]>().returns.toEqualTypeOf<
      Effect.Effect<readonly AppNote[], AdapterError>
    >();
  });

  it("types `also`'s context, its typed errors and the merged value", () => {
    type Audited = Awaited<ReturnType<typeof audit>>;

    expectTypeOf<ReturnType<typeof addPlain>>().toEqualTypeOf<
      Promise<Result<AppNote, NoteLimit | AdapterError>>
    >();
    expectTypeOf<Extract<Audited, { readonly ok: true }>["value"]>().toExtend<
      AppNote & { readonly also: number }
    >();
    expectTypeOf<
      Extract<Audited, { readonly ok: false }>["error"]
    >().toEqualTypeOf<NoteLimit | AdapterError | Vetoed<unknown>>();
  });

  it("types a Promise-style Plugin's Actions as the native one's, in both forms (I9)", () => {
    expectTypeOf<
      Scheduler<typeof promiseSchema, undefined, readonly []>["notes"]
    >().toEqualTypeOf<Scheduler<S, undefined, readonly []>["notes"]>();
    expectTypeOf<
      SchedulerService<typeof promiseSchema, undefined, readonly []>["notes"]
    >().toEqualTypeOf<SchedulerService<S, undefined, readonly []>["notes"]>();
  });

  it("brands record ids per table", () => {
    expectTypeOf<RecordId<"note">>().not.toEqualTypeOf<RecordId<"memo">>();
    expectTypeOf<RecordId<"note">>().not.toExtend<RecordId<"memo">>();
    expectTypeOf<string>().not.toExtend<RecordId<"note">>();
  });
});

describe("name clashes", () => {
  it("refuses each clash at defineSchema", () => {
    expectTypeOf(clashes).toBeFunction();
  });
});
