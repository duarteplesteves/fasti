import type { Effect } from "effect";
import { describe, expectTypeOf, it } from "vitest";

import type {
  Adapter,
  BlockChanges,
  BlockReads,
  BlockRecord,
  BlockWrites,
  DeleteBlockResult,
  GroupsOf,
  ListBlocksQuery,
  UpdateBlockResult,
  VerbGroup,
} from "../adapter/index.js";
import type { RuleRecord } from "../adapter/records.js";
import type { InvalidParams, Result } from "../core/result.js";
import type { BookingId } from "../core/types.js";
import type { SchedulerService } from "../effect/index.js";
import type {
  BlockId,
  Block,
  BlockActions,
  BlockColumn,
  BlockNotFound,
  CreateBlockError,
  CreateBlockParams,
  CreateSchedulerParams,
  DeleteBlockError,
  DeleteBlockParams,
  HasBlocks,
  ListBlocksError,
  ListBlocksParams,
  Scheduler,
  UpdateBlockError,
  UpdateBlockParams,
} from "../index.js";
import { createScheduler } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import { column } from "../schema/column.js";
import { defineSchema } from "../schema/define-schema.js";
import type { AnySchema } from "../schema/define-schema.js";
import type {
  integerIdSchema,
  textIdSchema,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import type {
  GetAvailabilityError,
  GetAvailabilityParams,
  SetAvailabilityError,
  SetAvailabilityParams,
  SetAvailabilityValue,
} from "./availability.js";
import type { BookError, BookParams } from "./book.js";
import { mintBlockId } from "./booking-id.js";
import type { Booking } from "./booking.js";
import type { CancelError, CancelParams, CancelValue } from "./cancel.js";
import type { EffectLocked } from "./effect-adapter.js";
import type { AdapterError, PolicyViolation, SlotConflict } from "./errors.js";
import type { FindSlotsError, FindSlotsParams, Slot } from "./find-slots.js";

type StaffId = number & { readonly __brand: "StaffId" };

const brandedSchema = defineSchema({
  resource: { idType: column.integer<StaffId>() },
});

/** Defaults: text ids, no Developer Fields. */
const defaultSchema = defineSchema({});

type NoFields = BookParams<typeof uuidIdSchema>;

type AllOptional = BookParams<typeof integerIdSchema>;

type SomeRequired = BookParams<typeof textIdSchema>;

const instant = Temporal.Instant.from("2030-06-03T09:00:00Z");

const base = { end: instant, resourceId: "staff-a", start: instant } as const;

const required = {
  count: 1,
  label: "",
  paid: true,
  ref: "",
  remindAt: instant,
} as const;

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
      InvalidParams | SlotConflict | PolicyViolation | AdapterError
    >();
    expectTypeOf<
      ReturnType<Scheduler<typeof textIdSchema, undefined>["book"]>
    >().toEqualTypeOf<
      Promise<Result<Booking<typeof textIdSchema>, BookError>>
    >();
    expectTypeOf<
      Booking<typeof uuidIdSchema>["id"]
    >().toEqualTypeOf<BookingId>();
  });
});

const blockSchema = defineSchema({
  block: { fields: { reason: { required: true, type: column.text() } } },
});

const optionalBlockSchema = defineSchema({
  block: { fields: { note: { required: false, type: column.text() } } },
});

const bareBlockSchema = defineSchema({ block: { fields: {} } });

/** A custom 0.1-style Adapter: no verb groups declared. */
declare const plainAdapter: Adapter<{ readonly txBrand: true }>;

/** What createScheduler infers as Tx; type-only. */
declare function txOf<S extends AnySchema, Tx>(
  params: CreateSchedulerParams<S, Tx>
): Tx;

/** Never called: only the types are checked. */
function schedulerCalls() {
  return [
    // @ts-expect-error -- a Blocks schema needs an Adapter that declares "blocks".
    createScheduler({ adapter: plainAdapter, schema: blockSchema }),
    createScheduler({ adapter: plainAdapter, schema: defaultSchema }),
    createScheduler({ adapter: memoryAdapter(), schema: blockSchema }),
    createScheduler({ adapter: memoryAdapter(), schema: defaultSchema }),
  ];
}

/** Never called: only the inferred Tx is checked. */
function txViaMemory() {
  // oxlint-disable-next-line typescript/no-confusing-void-expression -- the `undefined` Tx is what's checked.
  return { tx: txOf({ adapter: memoryAdapter(), schema: blockSchema }) };
}

/** Never called: only the inferred Tx is checked. */
function txViaPlain() {
  return { tx: txOf({ adapter: plainAdapter, schema: defaultSchema }) };
}

describe("Blocks types", () => {
  it("rejects an Adapter without the blocks group at createScheduler for a Blocks schema", () => {
    expectTypeOf(schedulerCalls).toBeFunction();
  });

  it("still infers Tx through Adapter<Tx, GroupsOf<S>>", () => {
    expectTypeOf(txViaMemory).returns.toEqualTypeOf<{ tx: undefined }>();
    expectTypeOf(txViaPlain).returns.toEqualTypeOf<{
      tx: { readonly txBrand: true };
    }>();
  });

  it("has `blocks` only when the schema declares `block`", () => {
    expectTypeOf<
      Scheduler<typeof defaultSchema, undefined>
    >().not.toHaveProperty("blocks");
    expectTypeOf<Scheduler<typeof blockSchema, undefined>>().toHaveProperty(
      "blocks"
    );
    expectTypeOf<
      ReturnType<Scheduler<typeof blockSchema, undefined>["blocks"]["create"]>
    >().toEqualTypeOf<
      Promise<Result<Block<typeof blockSchema>, CreateBlockError>>
    >();
    expectTypeOf<Block<typeof blockSchema>["id"]>().toEqualTypeOf<BlockId>();
  });

  it("makes Block `fields` required, optional or absent as the Developer Fields demand", () => {
    const at = { end: instant, resourceId: "staff-a", start: instant } as const;

    expectTypeOf<
      CreateBlockParams<typeof bareBlockSchema>
    >().not.toHaveProperty("fields");
    expectTypeOf(at).toExtend<CreateBlockParams<typeof optionalBlockSchema>>();
    expectTypeOf({ ...at, fields: { note: null } }).toExtend<
      CreateBlockParams<typeof optionalBlockSchema>
    >();
    expectTypeOf(at).not.toExtend<CreateBlockParams<typeof blockSchema>>();
    expectTypeOf({ ...at, fields: { reason: "x" } }).toExtend<
      CreateBlockParams<typeof blockSchema>
    >();
    expectTypeOf({ ...at, fields: { reason: null } }).not.toExtend<
      CreateBlockParams<typeof blockSchema>
    >();
  });

  it("takes an id, a whole range or none, and fields only when the Block has them, in update", () => {
    const id = mintBlockId();

    expectTypeOf({ id }).toExtend<UpdateBlockParams<typeof blockSchema>>();
    expectTypeOf({ end: instant, id, start: instant }).toExtend<
      UpdateBlockParams<typeof blockSchema>
    >();
    expectTypeOf({ fields: { reason: "x" }, id }).toExtend<
      UpdateBlockParams<typeof blockSchema>
    >();
    expectTypeOf({ id, start: instant }).not.toExtend<
      UpdateBlockParams<typeof blockSchema>
    >();
    expectTypeOf({ end: instant, id }).not.toExtend<
      UpdateBlockParams<typeof blockSchema>
    >();
    expectTypeOf({ fields: { reason: null }, id }).not.toExtend<
      UpdateBlockParams<typeof blockSchema>
    >();
    expectTypeOf<
      UpdateBlockParams<typeof bareBlockSchema>
    >().not.toHaveProperty("fields");
    expectTypeOf<UpdateBlockParams<typeof blockSchema>>().not.toHaveProperty(
      "resourceId"
    );
  });

  it("types `block` as null without it, and as its fields with it", () => {
    expectTypeOf(defaultSchema.block).toEqualTypeOf<null>();
    expectTypeOf(bareBlockSchema.block).toEqualTypeOf<{
      // oxlint-disable-next-line typescript/no-generated-empty-object-type -- no Developer Fields.
      readonly fields: Record<never, never>;
    }>();
  });
});

describe("Block exports", () => {
  it("puts the Block types on the root and the contract types on /adapter", () => {
    type S = typeof blockSchema;

    expectTypeOf<HasBlocks<S>>().toEqualTypeOf<true>();
    expectTypeOf<GroupsOf<S>>().toEqualTypeOf<VerbGroup>();
    expectTypeOf<BlockColumn>().toEqualTypeOf<
      "id" | "resourceId" | "start" | "end"
    >();
    expectTypeOf<Block<S>>().toEqualTypeOf<BlockRecord<S>>();
    expectTypeOf<ListBlocksQuery<S>>().toHaveProperty("overlapping");
    expectTypeOf<BlockReads<S>>().toHaveProperty("listBlocks");
    expectTypeOf<BlockWrites<S>>().toHaveProperty("insertBlock");
    expectTypeOf<
      Parameters<BlockActions<S, "effect">["list"]>[0]
    >().toEqualTypeOf<ListBlocksParams<S>>();
    expectTypeOf<ListBlocksError>().toExtend<CreateBlockError>();
    expectTypeOf<
      Parameters<BlockActions<S, "effect">["update"]>[0]
    >().toEqualTypeOf<UpdateBlockParams<S>>();
    expectTypeOf<
      Parameters<BlockActions<S, "effect">["delete"]>[0]
    >().toEqualTypeOf<DeleteBlockParams>();
    expectTypeOf<BlockNotFound>().toExtend<UpdateBlockError>();
    expectTypeOf<BlockNotFound>().toExtend<DeleteBlockError>();
    expectTypeOf<BlockWrites<S>>().toHaveProperty("updateBlock");
    expectTypeOf<BlockWrites<S>>().toHaveProperty("deleteBlock");
    expectTypeOf<BlockChanges<S>>().not.toHaveProperty("resourceId");
    expectTypeOf<UpdateBlockResult>().toExtend<{ ok: boolean }>();
    expectTypeOf<DeleteBlockResult>().toExtend<{ ok: boolean }>();
  });
});

/** An Action's plain overload, as a single signature: what the old `Plain<T>` produced. */
type Single<A extends (params: never) => object> = (
  params: Parameters<A>[0]
) => ReturnType<A>;

interface Tx {
  readonly txBrand: true;
}

/** Never called: only the types are checked. */
async function noAlsoYet(scheduler: Scheduler<typeof defaultSchema, Tx>) {
  return await scheduler.book({
    // @ts-expect-error -- no Action takes `also` until it lands.
    also: () => ({ ok: true, value: 1 }),
    end: instant,
    resourceId: "staff-a",
    start: instant,
  });
}

/** Never called: only the inferred Scheduler types are checked. */
function schedulersByAdapter() {
  return {
    memory: createScheduler({ adapter: memoryAdapter(), schema: blockSchema }),
    plain: createScheduler({ adapter: plainAdapter, schema: defaultSchema }),
  };
}

describe("forms", () => {
  it("keeps the old plain surface for every Action, without Blocks", () => {
    type S = typeof defaultSchema;

    type Plain = Scheduler<S, Tx>;

    expectTypeOf<Single<Plain["book"]>>().toEqualTypeOf<
      (params: BookParams<S>) => Promise<Result<Booking<S>, BookError>>
    >();
    expectTypeOf<Single<Plain["cancel"]>>().toEqualTypeOf<
      (params: CancelParams) => Promise<Result<CancelValue<S>, CancelError>>
    >();
    expectTypeOf<Single<Plain["findSlots"]>>().toEqualTypeOf<
      (
        params: FindSlotsParams<S>
      ) => Promise<Result<readonly Slot<S>[], FindSlotsError>>
    >();
    expectTypeOf<Single<Plain["availability"]["set"]>>().toEqualTypeOf<
      (
        params: SetAvailabilityParams<S>
      ) => Promise<Result<SetAvailabilityValue, SetAvailabilityError>>
    >();
    expectTypeOf<Single<Plain["availability"]["get"]>>().toEqualTypeOf<
      (
        params: GetAvailabilityParams<S>
      ) => Promise<Result<readonly RuleRecord[], GetAvailabilityError>>
    >();
    expectTypeOf<keyof Plain>().toEqualTypeOf<
      "book" | "cancel" | "findSlots" | "availability"
    >();
    expectTypeOf(noAlsoYet).toBeFunction();
  });

  it("keeps the old plain surface for every Block Action, with Blocks", () => {
    type S = typeof blockSchema;

    type Blocks = Scheduler<S, Tx>["blocks"];

    expectTypeOf<Single<Blocks["create"]>>().toEqualTypeOf<
      (
        params: CreateBlockParams<S>
      ) => Promise<Result<Block<S>, CreateBlockError>>
    >();
    expectTypeOf<Single<Blocks["update"]>>().toEqualTypeOf<
      (
        params: UpdateBlockParams<S>
      ) => Promise<Result<Block<S>, UpdateBlockError>>
    >();
    expectTypeOf<Single<Blocks["delete"]>>().toEqualTypeOf<
      (params: DeleteBlockParams) => Promise<Result<void, DeleteBlockError>>
    >();
    expectTypeOf<Single<Blocks["list"]>>().toEqualTypeOf<
      (
        params: ListBlocksParams<S>
      ) => Promise<Result<readonly Block<S>[], ListBlocksError>>
    >();
    expectTypeOf<keyof Scheduler<S, Tx>>().toEqualTypeOf<
      "book" | "cancel" | "findSlots" | "availability" | "blocks"
    >();
  });

  it("keeps the Effect form's surface", () => {
    type S = typeof blockSchema;

    type Service = SchedulerService<S>;

    expectTypeOf<Single<Service["book"]>>().toEqualTypeOf<
      (params: BookParams<S>) => Effect.Effect<Booking<S>, BookError>
    >();
    expectTypeOf<Single<Service["findSlots"]>>().toEqualTypeOf<
      (
        params: FindSlotsParams<S>
      ) => Effect.Effect<readonly Slot<S>[], FindSlotsError>
    >();
    expectTypeOf<Single<Service["blocks"]["delete"]>>().toEqualTypeOf<
      (params: DeleteBlockParams) => Effect.Effect<void, DeleteBlockError>
    >();
  });

  it("infers Tx from the Adapter in createScheduler", () => {
    expectTypeOf(schedulersByAdapter).returns.toEqualTypeOf<{
      memory: Scheduler<typeof blockSchema, undefined>;
      plain: Scheduler<typeof defaultSchema, Tx>;
    }>();
  });

  it("exposes the Adapter's tx on the locked handle", () => {
    expectTypeOf<
      EffectLocked<typeof defaultSchema, Tx>["tx"]
    >().toEqualTypeOf<Tx>();
  });
});
