import type { Effect } from "effect";
import { describe, expectTypeOf, it } from "vitest";

import type {
  Adapter,
  DeleteRecordResult,
  GroupsOf,
  UpdateRecordResult,
} from "../adapter/index.js";
import type { InvalidParams, Result } from "../core/result.js";
import type { AvailabilityViolation, BookingId } from "../core/types.js";
import { Scheduler as EffectScheduler } from "../effect/index.js";
import type { SchedulerService } from "../effect/index.js";
import type {
  BlockId,
  Block,
  BlockActions,
  BlockNotFound,
  BookCandidate,
  CancelCandidate,
  CreateBlockError,
  CreateBlockParams,
  CreateSchedulerParams,
  DeleteBlockError,
  DeleteBlockParams,
  ListBlocksError,
  ListBlocksParams,
  RescheduleCandidate,
  Scheduler,
  UpdateBlockError,
  UpdateBlockParams,
  Violation,
} from "../index.js";
import {
  availability,
  blocks,
  createScheduler,
  definePolicy,
} from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { column } from "../schema/column.js";
import { defineSchema } from "../schema/define-schema.js";
import type { AnySchema } from "../schema/define-schema.js";
import type {
  integerIdSchema,
  textIdSchema,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import type { BookError, BookParams } from "./book.js";
import { mintBookingId } from "./booking-id.js";
import type { Booking } from "./booking.js";
import type { CancelError, CancelParams, CancelValue } from "./cancel.js";
import type { EffectLocked } from "./effect-adapter.js";
import type {
  AdapterError,
  PolicyViolation,
  SlotConflict,
  Vetoed,
} from "./errors.js";
import type { FindSlotsError, Slot } from "./find-slots.js";
import type { Fill } from "./plugin.js";
import type {
  RuleRecord,
  GetAvailabilityError,
  GetAvailabilityParams,
  SetAvailabilityError,
  SetAvailabilityParams,
  SetAvailabilityValue,
} from "./plugins/availability.js";
import { mintBlockId } from "./plugins/blocks.js";
import type { RescheduleError } from "./reschedule.js";

type StaffId = number & { readonly __brand: "StaffId" };

const brandedSchema = defineSchema({
  resource: { idType: column.integer<StaffId>() },
});

/** Defaults: text ids, no Developer Fields; availability() installed. */
const defaultSchema = defineSchema({ plugins: [availability()] });

/** A Plugin Action's types as an app over text ids sees them. */
type App<X> = Fill<string, X>;

type NoFields = BookParams<typeof uuidIdSchema>;

type AllOptional = BookParams<typeof integerIdSchema>;

type SomeRequired = BookParams<typeof textIdSchema>;

const instant = Temporal.Instant.from("2030-06-03T09:00:00Z");

const base = { end: instant, resourceId: "staff-a", start: instant } as const;

/** A `findSlots` search on `staff-a`, without `excludeBookingId` or `relax`. */
const search = {
  duration: 60,
  from: instant,
  interval: 30,
  resourceId: "staff-a",
  timezone: "UTC",
  to: instant,
} as const;

const required = {
  count: 1,
  label: "",
  paid: true,
  ref: "",
  remindAt: instant,
} as const;

/** Never called: `ReturnType` of `book` itself would instantiate `relax` at its constraint, so the types read a call. */
async function bookTextId(
  scheduler: Scheduler<typeof textIdSchema, undefined, readonly []>
) {
  return await scheduler.book({ ...base, fields: required });
}

describe("book types", () => {
  it("has no `fields` when the schema declares no Developer Fields", () => {
    expectTypeOf<NoFields>().not.toHaveProperty("fields");
    expectTypeOf<BookParams<typeof defaultSchema>>().not.toHaveProperty(
      "fields"
    );
  });

  it("makes `fields` optional when every Developer Field is optional", () => {
    expectTypeOf({ ...base, resourceId: 1 }).toExtend<AllOptional>();
    expectTypeOf({
      ...base,
      fields: {},
      resourceId: 1,
    }).toExtend<AllOptional>();
    expectTypeOf({
      ...base,
      fields: { note: null },
      resourceId: 1,
    }).toExtend<AllOptional>();
    expectTypeOf({
      ...base,
      fields: { note: 1 },
      resourceId: 1,
    }).not.toExtend<AllOptional>();
  });

  it("requires `fields`, and each required field, when one is required", () => {
    expectTypeOf(base).not.toExtend<SomeRequired>();
    expectTypeOf({ ...base, fields: required }).toExtend<SomeRequired>();
    expectTypeOf({
      ...base,
      fields: { ...required, countOpt: null, labelOpt: "x" },
    }).toExtend<SomeRequired>();
    expectTypeOf({
      ...base,
      fields: { ...required, label: null },
    }).not.toExtend<SomeRequired>();

    const { count: _count, ...missingCount } = required;

    expectTypeOf({
      ...base,
      fields: missingCount,
    }).not.toExtend<SomeRequired>();
  });

  it("types `resourceId` by the schema's idType, brand included", () => {
    expectTypeOf<SomeRequired["resourceId"]>().toEqualTypeOf<string>();
    expectTypeOf<NoFields["resourceId"]>().toEqualTypeOf<string>();
    expectTypeOf<AllOptional["resourceId"]>().toEqualTypeOf<number>();
    expectTypeOf<
      BookParams<typeof brandedSchema>["resourceId"]
    >().toEqualTypeOf<StaffId>();
    expectTypeOf({ ...base, resourceId: 1 }).not.toExtend<
      BookParams<typeof brandedSchema>
    >();
  });

  it("fails with exactly BookError and returns a BookingId", () => {
    expectTypeOf<BookError>().toEqualTypeOf<
      InvalidParams | SlotConflict | AdapterError
    >();

    expectTypeOf<ReturnType<typeof bookTextId>>().toEqualTypeOf<
      Promise<
        Result<
          Booking<typeof textIdSchema>,
          | BookError<typeof textIdSchema>
          | PolicyViolation<AvailabilityViolation>
        >
      >
    >();
    expectTypeOf<
      Booking<typeof uuidIdSchema>["id"]
    >().toEqualTypeOf<BookingId>();
  });
});

const reasonFields = {
  reason: { required: true, type: column.text() },
} as const;

const noteFields = { note: { required: false, type: column.text() } } as const;

type Reason = typeof reasonFields;

type Note = typeof noteFields;

// oxlint-disable-next-line typescript/no-generated-empty-object-type -- no Developer Fields.
type Bare = Record<never, never>;

const blockSchema = defineSchema({
  plugins: [availability(), blocks({ fields: reasonFields })],
});

const bareBlockSchema = defineSchema({
  plugins: [availability(), blocks({ fields: {} })],
});

/** No Plugins: no tables, so any Adapter fits. */
const pluginFreeSchema = defineSchema({});

/** A custom 0.1-style Adapter: no verb groups declared. */
declare const plainAdapter: Adapter<{ readonly txBrand: true }>;

/** What createScheduler infers as Tx; type-only. */
declare function txOf<S extends AnySchema, Tx>(
  params: CreateSchedulerParams<S, Tx, readonly []>
): Tx;

/** Never called: only the types are checked. */
function schedulerCalls() {
  return [
    createScheduler({
      // @ts-expect-error -- a Blocks schema needs an Adapter that declares "records".
      adapter: plainAdapter,
      policies: [],
      schema: blockSchema,
    }),
    createScheduler({
      policies: [],
      adapter: plainAdapter,
      schema: pluginFreeSchema,
    }),
    createScheduler({
      policies: [],
      adapter: memoryAdapter(),
      schema: blockSchema,
    }),
    createScheduler({
      policies: [],
      adapter: memoryAdapter(),
      schema: defaultSchema,
    }),
  ];
}

/** Never called: only the inferred Tx is checked. */
function txViaMemory() {
  return {
    // oxlint-disable-next-line typescript/no-confusing-void-expression -- the `undefined` Tx is what's checked.
    tx: txOf({ adapter: memoryAdapter(), policies: [], schema: blockSchema }),
  };
}

/** Never called: only the inferred Tx is checked. */
function txViaPlain() {
  return {
    tx: txOf({ adapter: plainAdapter, policies: [], schema: pluginFreeSchema }),
  };
}

describe("Blocks types", () => {
  it("rejects an Adapter without the records group at createScheduler for a Blocks schema", () => {
    expectTypeOf(schedulerCalls).toBeFunction();
  });

  it("still infers Tx through Adapter<Tx, GroupsOf<S>>", () => {
    expectTypeOf(txViaMemory).returns.toEqualTypeOf<{ tx: undefined }>();
    expectTypeOf(txViaPlain).returns.toEqualTypeOf<{
      tx: { readonly txBrand: true };
    }>();
  });

  it("has `blocks` only when the schema installs blocks()", () => {
    expectTypeOf<
      Scheduler<typeof defaultSchema, undefined, readonly []>
    >().not.toHaveProperty("blocks");
    expectTypeOf<
      Scheduler<typeof blockSchema, undefined, readonly []>
    >().toHaveProperty("blocks");
    expectTypeOf<
      ReturnType<
        Scheduler<
          typeof blockSchema,
          undefined,
          readonly []
        >["blocks"]["create"]
      >
    >().toEqualTypeOf<Promise<Result<App<Block<Reason>>, CreateBlockError>>>();
    expectTypeOf<Block<Reason>["id"]>().toEqualTypeOf<BlockId>();
  });

  it("makes Block `fields` required, optional or absent as the Developer Fields demand", () => {
    const at = { end: instant, resourceId: "staff-a", start: instant } as const;

    expectTypeOf<App<CreateBlockParams<Bare>>>().not.toHaveProperty("fields");
    expectTypeOf(at).toExtend<App<CreateBlockParams<Note>>>();
    expectTypeOf({ ...at, fields: { note: null } }).toExtend<
      App<CreateBlockParams<Note>>
    >();
    expectTypeOf(at).not.toExtend<App<CreateBlockParams<Reason>>>();
    expectTypeOf({ ...at, fields: { reason: "x" } }).toExtend<
      App<CreateBlockParams<Reason>>
    >();
    expectTypeOf({ ...at, fields: { reason: null } }).not.toExtend<
      App<CreateBlockParams<Reason>>
    >();
  });

  it("takes an id, a whole range or none, and fields only when the Block has them, in update", () => {
    const id = mintBlockId();

    expectTypeOf({ id }).toExtend<UpdateBlockParams<Reason>>();
    expectTypeOf({ end: instant, id, start: instant }).toExtend<
      UpdateBlockParams<Reason>
    >();
    expectTypeOf({ fields: { reason: "x" }, id }).toExtend<
      UpdateBlockParams<Reason>
    >();
    expectTypeOf({ id, start: instant }).not.toExtend<
      UpdateBlockParams<Reason>
    >();
    expectTypeOf({ end: instant, id }).not.toExtend<
      UpdateBlockParams<Reason>
    >();
    expectTypeOf({ fields: { reason: null }, id }).not.toExtend<
      UpdateBlockParams<Reason>
    >();
    expectTypeOf<UpdateBlockParams<Bare>>().not.toHaveProperty("fields");
    expectTypeOf<UpdateBlockParams<Reason>>().not.toHaveProperty("resourceId");
  });

  it("types blocks()' table by its fields; the schema has no `block` of its own", () => {
    expectTypeOf(bareBlockSchema).not.toHaveProperty("block");
    expectTypeOf(
      blocks({ fields: {} }).tables.block.columns
    ).toEqualTypeOf<Bare>();
    expectTypeOf(
      blocks({ fields: reasonFields }).tables.block.columns
    ).toEqualTypeOf<Reason>();
  });
});

describe("Block exports", () => {
  it("puts the Block types on the root, and Blocks on `records`", () => {
    type S = typeof blockSchema;

    expectTypeOf<GroupsOf<S>>().toEqualTypeOf<"records">();
    expectTypeOf<Block<Reason>>().toHaveProperty("reason");
    expectTypeOf<Block<Reason>>().toHaveProperty("start");
    expectTypeOf<
      Parameters<BlockActions<Reason>["list"]["run"]>[0]
    >().toEqualTypeOf<ListBlocksParams>();
    expectTypeOf<ListBlocksError>().toExtend<CreateBlockError>();
    expectTypeOf<
      Parameters<BlockActions<Reason>["update"]["run"]>[0]
    >().toEqualTypeOf<UpdateBlockParams<Reason>>();
    expectTypeOf<
      Parameters<BlockActions<Reason>["delete"]["run"]>[0]
    >().toEqualTypeOf<DeleteBlockParams>();
    expectTypeOf<BlockNotFound>().toExtend<UpdateBlockError>();
    expectTypeOf<BlockNotFound>().toExtend<DeleteBlockError>();
    expectTypeOf<UpdateRecordResult>().toExtend<{ ok: boolean }>();
    expectTypeOf<DeleteRecordResult>().toExtend<{ ok: boolean }>();
  });
});

/** An Action's plain overload, as a single signature: what the old `Plain<T>` produced. */
type Single<A extends (params: never) => object> = (
  params: Parameters<A>[0]
) => ReturnType<A>;

interface Tx {
  readonly txBrand: true;
}

/** Never called: only the inferred Scheduler types are checked. */
function schedulersByAdapter() {
  return {
    memory: createScheduler({
      policies: [],
      adapter: memoryAdapter(),
      schema: blockSchema,
    }),
    plain: createScheduler({
      policies: [],
      adapter: plainAdapter,
      schema: pluginFreeSchema,
    }),
  };
}

describe("forms", () => {
  it("keeps the old plain surface for every Action, without Blocks", () => {
    type S = typeof defaultSchema;

    type Plain = Scheduler<S, Tx, readonly []>;

    /** Never called: a call without `relax`, as before Policies. */
    async function bookCall(plain: Plain) {
      return await plain.book(base);
    }

    expectTypeOf<ReturnType<typeof bookCall>>().toEqualTypeOf<
      Promise<
        Result<Booking<S>, BookError | PolicyViolation<AvailabilityViolation>>
      >
    >();
    expectTypeOf<Single<Plain["cancel"]>>().toEqualTypeOf<
      (
        params: CancelParams<S>
      ) => Promise<Result<CancelValue<S>, CancelError<S>>>
    >();

    /** Never called: a reschedule without `relax`, as before Policies. */
    async function rescheduleCall(plain: Plain) {
      return await plain.reschedule({ ...base, id: mintBookingId() });
    }

    expectTypeOf<ReturnType<typeof rescheduleCall>>().toEqualTypeOf<
      Promise<
        Result<
          Booking<S>,
          RescheduleError<S> | PolicyViolation<AvailabilityViolation>
        >
      >
    >();

    /** Never called: a search without `relax`, as before Policies. */
    async function findSlotsCall(plain: Plain) {
      return await plain.findSlots(search);
    }

    expectTypeOf<ReturnType<typeof findSlotsCall>>().toEqualTypeOf<
      Promise<Result<readonly Slot<S>[], FindSlotsError>>
    >();
    expectTypeOf<Single<Plain["availability"]["set"]>>().toEqualTypeOf<
      (
        params: App<SetAvailabilityParams>
      ) => Promise<Result<SetAvailabilityValue, SetAvailabilityError>>
    >();
    expectTypeOf<Single<Plain["availability"]["get"]>>().toEqualTypeOf<
      (
        params: App<GetAvailabilityParams>
      ) => Promise<Result<readonly RuleRecord[], GetAvailabilityError>>
    >();
    expectTypeOf<keyof Plain>().toEqualTypeOf<
      "book" | "reschedule" | "cancel" | "findSlots" | "availability"
    >();
  });

  it("keeps the old plain surface for every Block Action, with Blocks", () => {
    type S = typeof blockSchema;

    type Blocks = Scheduler<S, Tx, readonly []>["blocks"];

    expectTypeOf<Single<Blocks["create"]>>().toEqualTypeOf<
      (
        params: App<CreateBlockParams<Reason>>
      ) => Promise<Result<App<Block<Reason>>, CreateBlockError>>
    >();
    expectTypeOf<Single<Blocks["update"]>>().toEqualTypeOf<
      (
        params: App<UpdateBlockParams<Reason>>
      ) => Promise<Result<App<Block<Reason>>, UpdateBlockError>>
    >();
    expectTypeOf<Single<Blocks["delete"]>>().toEqualTypeOf<
      (params: DeleteBlockParams) => Promise<Result<void, DeleteBlockError>>
    >();
    expectTypeOf<Single<Blocks["list"]>>().toEqualTypeOf<
      (
        params: App<ListBlocksParams>
      ) => Promise<Result<readonly App<Block<Reason>>[], ListBlocksError>>
    >();
    expectTypeOf<keyof Scheduler<S, Tx, readonly []>>().toEqualTypeOf<
      "book" | "reschedule" | "cancel" | "findSlots" | "availability" | "blocks"
    >();
  });

  it("keeps the Effect form's surface", () => {
    type S = typeof blockSchema;

    type Service = SchedulerService<S, Tx, readonly []>;

    /** Never called: a call without `relax`. */
    function bookCall(service: Service) {
      return service.book(base);
    }

    expectTypeOf<ReturnType<typeof bookCall>>().toEqualTypeOf<
      Effect.Effect<
        Booking<S>,
        BookError<S> | PolicyViolation<AvailabilityViolation>
      >
    >();

    /** Never called: a search without `relax`. */
    function findSlotsCall(service: Service) {
      return service.findSlots(search);
    }

    expectTypeOf<ReturnType<typeof findSlotsCall>>().toEqualTypeOf<
      Effect.Effect<readonly Slot<S>[], FindSlotsError>
    >();
    expectTypeOf<Single<Service["cancel"]>>().toEqualTypeOf<
      (params: CancelParams<S>) => Effect.Effect<CancelValue<S>, CancelError<S>>
    >();
    expectTypeOf<Single<Service["availability"]["set"]>>().toEqualTypeOf<
      (
        params: App<SetAvailabilityParams>
      ) => Effect.Effect<SetAvailabilityValue, SetAvailabilityError>
    >();
    expectTypeOf<Single<Service["availability"]["get"]>>().toEqualTypeOf<
      (
        params: App<GetAvailabilityParams>
      ) => Effect.Effect<readonly RuleRecord[], GetAvailabilityError>
    >();
    expectTypeOf<Single<Service["blocks"]["create"]>>().toEqualTypeOf<
      (
        params: App<CreateBlockParams<Reason>>
      ) => Effect.Effect<App<Block<Reason>>, CreateBlockError>
    >();
    expectTypeOf<Single<Service["blocks"]["update"]>>().toEqualTypeOf<
      (
        params: App<UpdateBlockParams<Reason>>
      ) => Effect.Effect<App<Block<Reason>>, UpdateBlockError>
    >();
    expectTypeOf<Single<Service["blocks"]["delete"]>>().toEqualTypeOf<
      (params: DeleteBlockParams) => Effect.Effect<void, DeleteBlockError>
    >();
    expectTypeOf<Single<Service["blocks"]["list"]>>().toEqualTypeOf<
      (
        params: App<ListBlocksParams>
      ) => Effect.Effect<readonly App<Block<Reason>>[], ListBlocksError>
    >();
  });

  it("infers Tx from the Adapter in createScheduler", () => {
    expectTypeOf(schedulersByAdapter).returns.toEqualTypeOf<{
      memory: Scheduler<typeof blockSchema, undefined, readonly []>;
      plain: Scheduler<typeof pluginFreeSchema, Tx, readonly []>;
    }>();
  });

  it("exposes the Adapter's tx on the locked handle", () => {
    expectTypeOf<
      EffectLocked<typeof defaultSchema, Tx>["tx"]
    >().toEqualTypeOf<Tx>();
  });
});

describe("Policy types", () => {
  /** A Policy over `defaultSchema` whose `detail` is inferred from `check`. */
  const closed = definePolicy(defaultSchema, {
    appliesTo: ["book"],
    check: (candidate) => {
      expectTypeOf(candidate).toEqualTypeOf<
        BookCandidate<typeof defaultSchema>
      >();

      return { reason: "closed" as const };
    },
    name: "closed",
  });

  /** Never called: only the types are checked. */
  function withClosed() {
    return createScheduler({
      adapter: memoryAdapter(),
      policies: [closed],
      schema: defaultSchema,
    });
  }

  /** Never called: `book` without `relax`. */
  async function bookUnrelaxed() {
    return await withClosed().book(base);
  }

  /** Never called: `book` relaxing `relax`. */
  async function bookRelaxed<
    const X extends readonly ("availability" | "closed")[],
  >(relax: X) {
    return await withClosed().book({ ...base, relax });
  }

  it("infers each Policy's detail into book's PolicyViolation, next to availability", () => {
    type BookResult = Awaited<ReturnType<typeof bookUnrelaxed>>;

    expectTypeOf<
      Extract<
        Extract<BookResult, { readonly ok: false }>["error"],
        { readonly _tag: "PolicyViolation" }
      >
    >().toEqualTypeOf<
      PolicyViolation<
        AvailabilityViolation | Violation<"closed", { reason: "closed" }>
      >
    >();
  });

  type Closed = Violation<"closed", { reason: "closed" }>;

  type Ok<R> =
    Awaited<R> extends infer A
      ? A extends { readonly ok: true; readonly value: infer V }
        ? V
        : never
      : never;

  type Err<R> =
    Awaited<R> extends infer A
      ? A extends { readonly ok: false; readonly error: infer E }
        ? E
        : never
      : never;

  it("adds waived only with relax, typed by the relaxed Policies", () => {
    expectTypeOf<Ok<ReturnType<typeof bookUnrelaxed>>>().toEqualTypeOf<
      Booking<typeof defaultSchema>
    >();
    expectTypeOf<
      Ok<ReturnType<typeof bookRelaxed<readonly ["closed"]>>>["waived"]
    >().toEqualTypeOf<readonly Closed[]>();
    expectTypeOf<
      Ok<ReturnType<typeof bookRelaxed<readonly []>>>["waived"]
    >().toEqualTypeOf<readonly never[]>();
  });

  it("drops relaxed Policies from PolicyViolation, and PolicyViolation when all are relaxed", () => {
    expectTypeOf<
      Err<ReturnType<typeof bookRelaxed<readonly ["closed"]>>>
    >().toEqualTypeOf<BookError | PolicyViolation<AvailabilityViolation>>();
    expectTypeOf<
      Err<ReturnType<typeof bookRelaxed<readonly ["availability", "closed"]>>>
    >().toEqualTypeOf<BookError>();
  });

  /** Never called: `relax` whose entries or presence aren't known statically. */
  function looseRelax(
    names: readonly ("availability" | "closed")[],
    maybe: readonly ["closed"] | undefined
  ) {
    const scheduler = withClosed();

    return {
      maybe: scheduler.book({ ...base, relax: maybe }),
      names: scheduler.book({ ...base, relax: names }),
    };
  }

  it("keeps PolicyViolation for a widened relax, and waived optional for a maybe-undefined one", () => {
    type Loose = ReturnType<typeof looseRelax>;

    expectTypeOf<Err<Loose["names"]>>().toEqualTypeOf<
      BookError | PolicyViolation<AvailabilityViolation | Closed>
    >();
    expectTypeOf<Err<Loose["maybe"]>>().toEqualTypeOf<
      BookError | PolicyViolation<AvailabilityViolation | Closed>
    >();
    expectTypeOf<Ok<Loose["maybe"]>>().toEqualTypeOf<
      Booking<typeof defaultSchema> & { readonly waived?: readonly Closed[] }
    >();
  });

  /** Never called: `relax` next to `also`, and where it isn't taken. */
  function relaxCalls() {
    const scheduler = withClosed();

    return {
      also: scheduler.book({
        ...base,
        also: (): Result<number, "no"> => ({ ok: true, value: 1 }),
        relax: ["availability"],
      }),
      // @ts-expect-error -- relax takes only names that apply to book.
      unknown: scheduler.book({ ...base, relax: ["nope"] }),
      unpoliced: scheduler.availability.set({
        // @ts-expect-error -- no Policy applies to availability.set, so it takes no relax.
        relax: [],
        resourceId: "staff-a",
        rules: [],
      }),
    };
  }

  it("types relax with also, and leaves it off Actions no Policy applies to", () => {
    type Also = ReturnType<typeof relaxCalls>["also"];

    expectTypeOf<Ok<Also>>().toEqualTypeOf<
      Booking<typeof defaultSchema> & {
        readonly waived: readonly AvailabilityViolation[];
      } & { readonly also: number }
    >();
    expectTypeOf<Err<Also>>().toEqualTypeOf<
      BookError | PolicyViolation<Closed> | Vetoed<"no">
    >();
  });

  type S = typeof defaultSchema;

  /** A Policy on both `reschedule` and `cancel`: its candidate is either. */
  const late = definePolicy(defaultSchema, {
    appliesTo: ["reschedule", "cancel"],
    check: (candidate) => {
      expectTypeOf(candidate).toEqualTypeOf<
        RescheduleCandidate<S> | CancelCandidate<S>
      >();

      if (candidate.action === "reschedule") {
        expectTypeOf(candidate.previous).toEqualTypeOf<Booking<S>>();
      }

      return { late: true as const };
    },
    name: "late",
  });

  type Late = Violation<"late", { late: true }>;

  /** Never called: `reschedule` and `cancel` with and without `relax`. */
  function changeCalls() {
    const scheduler = createScheduler({
      adapter: memoryAdapter(),
      policies: [closed, late],
      schema: defaultSchema,
    });

    const id = mintBookingId();

    return {
      cancel: scheduler.cancel({ id }),
      cancelRelaxed: scheduler.cancel({ id, relax: ["late"] }),
      // @ts-expect-error -- availability doesn't apply to cancel.
      cancelWrong: scheduler.cancel({ id, relax: ["availability"] }),
      reschedule: scheduler.reschedule({ ...base, id }),
      rescheduleRelaxed: scheduler.reschedule({
        ...base,
        id,
        relax: ["availability"],
      }),
      // @ts-expect-error -- `closed` applies to book only.
      rescheduleWrong: scheduler.reschedule({ ...base, id, relax: ["closed"] }),
    };
  }

  type Calls = ReturnType<typeof changeCalls>;

  it("narrows relax and PolicyViolation per Action", () => {
    expectTypeOf<Err<Calls["reschedule"]>>().toEqualTypeOf<
      RescheduleError<S> | PolicyViolation<AvailabilityViolation | Late>
    >();
    expectTypeOf<Err<Calls["rescheduleRelaxed"]>>().toEqualTypeOf<
      RescheduleError<S> | PolicyViolation<Late>
    >();
    expectTypeOf<Ok<Calls["rescheduleRelaxed"]>>().toEqualTypeOf<
      Booking<S> & { readonly waived: readonly AvailabilityViolation[] }
    >();
    expectTypeOf<Err<Calls["cancel"]>>().toEqualTypeOf<
      CancelError<S> | PolicyViolation<Late>
    >();
    expectTypeOf<Err<Calls["cancelRelaxed"]>>().toEqualTypeOf<CancelError<S>>();
  });

  /** Never called: `findSlots` with and without `excludeBookingId` and `relax`. */
  function searchCalls() {
    const scheduler = createScheduler({
      adapter: memoryAdapter(),
      policies: [closed, late],
      schema: defaultSchema,
    });

    const excludeBookingId = mintBookingId();

    return {
      book: scheduler.findSlots(search),
      bookRelaxed: scheduler.findSlots({ ...search, relax: ["closed"] }),
      // @ts-expect-error -- `late` applies to reschedule, not book.
      bookWrong: scheduler.findSlots({ ...search, relax: ["late"] }),
      move: scheduler.findSlots({ ...search, excludeBookingId }),
      moveRelaxed: scheduler.findSlots({
        ...search,
        excludeBookingId,
        relax: ["availability", "late"],
      }),
      moveWrong: scheduler.findSlots({
        ...search,
        excludeBookingId,
        // @ts-expect-error -- `closed` applies to book, not reschedule.
        relax: ["closed"],
      }),
    };
  }

  type Searches = ReturnType<typeof searchCalls>;

  it("narrows findSlots' relax by excludeBookingId, and types waived as Slot<S, W>", () => {
    expectTypeOf<Ok<Searches["book"]>>().toEqualTypeOf<readonly Slot<S>[]>();
    expectTypeOf<Ok<Searches["move"]>>().toEqualTypeOf<readonly Slot<S>[]>();
    expectTypeOf<Ok<Searches["bookRelaxed"]>>().toEqualTypeOf<
      readonly Slot<S, Closed>[]
    >();
    expectTypeOf<Ok<Searches["moveRelaxed"]>>().toEqualTypeOf<
      readonly Slot<S, AvailabilityViolation | Late>[]
    >();
    expectTypeOf<Slot<S, Late>["waived"]>().toEqualTypeOf<readonly Late[]>();
    expectTypeOf<Slot<S>["waived"]>().toEqualTypeOf<readonly never[]>();
    expectTypeOf<
      Err<Searches["moveRelaxed"]>
    >().toEqualTypeOf<FindSlotsError>();
  });

  it("adds waived to cancel's alreadyCancelled: false branch only", () => {
    expectTypeOf<Ok<Calls["cancelRelaxed"]>>().toEqualTypeOf<
      | { readonly booking: Booking<S>; readonly alreadyCancelled: true }
      | ({ readonly booking: Booking<S>; readonly alreadyCancelled: false } & {
          readonly waived: readonly Late[];
        })
    >();
    expectTypeOf<Ok<Calls["cancel"]>>().toEqualTypeOf<CancelValue<S>>();
  });

  /** Never called: only the types are checked. */
  function refusedCalls() {
    return [
      createScheduler({
        adapter: memoryAdapter(),
        // @ts-expect-error -- `closed` is over defaultSchema, with text ids.
        policies: [closed],
        schema: brandedSchema,
      }),
    ];
  }

  it("refuses a Policy from another schema", () => {
    expectTypeOf(refusedCalls).toBeFunction();
  });

  it("lets policies be omitted, as readonly []", () => {
    expectTypeOf(
      createScheduler({ adapter: memoryAdapter(), schema: defaultSchema })
    ).toEqualTypeOf<Scheduler<typeof defaultSchema, undefined, readonly []>>();
  });

  it("defaults the Effect-form Scheduler's fourth type parameter to readonly []", () => {
    expectTypeOf(
      EffectScheduler<unknown, typeof defaultSchema, undefined>()("test/Bare")
        .layer
    )
      .parameter(0)
      .toEqualTypeOf<
        CreateSchedulerParams<typeof defaultSchema, undefined, readonly []>
      >();
  });

  it("requires policies on layer when the Effect-form Scheduler declares some", () => {
    const WithClosed = EffectScheduler<
      unknown,
      typeof defaultSchema,
      undefined,
      readonly [typeof closed]
    >()("test/WithClosed");

    expectTypeOf(WithClosed.layer).toBeCallableWith({
      adapter: memoryAdapter(),
      policies: [closed],
      schema: defaultSchema,
    });
    // @ts-expect-error -- the class declares `closed`, so `layer` must be given it.
    expectTypeOf(WithClosed.layer).toBeCallableWith({
      adapter: memoryAdapter(),
      schema: defaultSchema,
    });
  });
});
