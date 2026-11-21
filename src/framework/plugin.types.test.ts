import type { Effect } from "effect";
import { describe, expectTypeOf, it } from "vitest";

import type { Adapter } from "../adapter/index.js";
import type { Result } from "../core/result.js";
import type {
  PluginResourceId,
  RecordReadsOf,
  RecordStoreOf,
  SchedulerService,
  TableDef,
} from "../effect/index.js";
import { column, createScheduler, defineSchema } from "../index.js";
import type { AdapterError, RecordId, Scheduler, Vetoed } from "../index.js";
import type { Column } from "../schema/column.js";
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
      plugins: [
        {
          ...notes({ max: 1 }),
          tables: { booking: { columns: {}, timed: false } },
        },
      ],
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

/** A timed and an untimed table. A type alias, so it has the implicit index signature `Tables` needs. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- see above.
type SlotTables = {
  readonly slot: TableDef<
    {
      readonly label: {
        readonly required: true;
        readonly type: Column<"text", string>;
      };
    },
    true
  >;
  readonly tag: TableDef<
    {
      readonly on: {
        readonly required: false;
        readonly type: Column<"dates", readonly Temporal.PlainDate[]>;
      };
    },
    false
  >;
};

/** A `list` query with a range. */
interface Ranged {
  readonly resourceId: PluginResourceId;
  readonly overlapping: {
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
  };
}

type Reads = RecordReadsOf<SlotTables>;

type Store = RecordStoreOf<SlotTables>;

/** Never called: only the types are checked. */
function bind(blocksOnly: Adapter<undefined, "blocks">) {
  return [
    // @ts-expect-error -- the notes table needs the `records` verbs.
    createScheduler({ adapter: blocksOnly, schema }),
    createScheduler({ adapter: blocksOnly, schema: defineSchema({}) }),
  ];
}

describe("record handles", () => {
  it("takes `overlapping` on a timed table only", () => {
    expectTypeOf<Ranged>().toExtend<Parameters<Reads["slot"]["list"]>[0]>();
    expectTypeOf<Ranged>().not.toExtend<Parameters<Reads["tag"]["list"]>[0]>();
  });

  it("writes only on a unit, under the lock", () => {
    type Verbs = "insert" | "update" | "delete" | "replace";

    expectTypeOf<Extract<keyof Reads["tag"], Verbs>>().toBeNever();
    expectTypeOf<Extract<keyof Store["tag"], Verbs>>().toEqualTypeOf<Verbs>();
  });

  it("types each verb; `start` and `end` only on a timed table", () => {
    type Slot = NonNullable<Effect.Success<ReturnType<Store["slot"]["get"]>>>;

    type Tag = NonNullable<Effect.Success<ReturnType<Store["tag"]["get"]>>>;

    expectTypeOf<Slot["start"]>().toEqualTypeOf<Temporal.Instant>();
    expectTypeOf<Slot["id"]>().toEqualTypeOf<RecordId<"slot">>();
    expectTypeOf<Tag>().not.toHaveProperty("start");
    expectTypeOf<Tag["on"]>().toEqualTypeOf<
      readonly Temporal.PlainDate[] | null
    >();
    expectTypeOf<
      Effect.Success<ReturnType<Store["tag"]["update"]>>
    >().toEqualTypeOf<
      { readonly ok: true } | { readonly ok: false; readonly reason: "changed" }
    >();
    expectTypeOf<
      Effect.Success<ReturnType<Store["tag"]["delete"]>>
    >().toEqualTypeOf<
      { readonly ok: true } | { readonly ok: false; readonly reason: "missing" }
    >();
    expectTypeOf<{
      readonly label: string;
      readonly resourceId: PluginResourceId;
    }>().not.toExtend<Parameters<Store["slot"]["insert"]>[0]>();
  });

  it("refuses an Adapter without `records` for a schema with Plugin tables", () => {
    expectTypeOf(bind).toBeFunction();
  });
});

describe("name clashes", () => {
  it("refuses each clash at defineSchema", () => {
    expectTypeOf(clashes).toBeFunction();
  });
});
