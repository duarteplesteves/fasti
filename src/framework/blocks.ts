import { Effect } from "effect";

import type {
  BlockChanges,
  BlockFieldsOf,
  BlockRecord,
  ResourceIdOf,
} from "../adapter/records.js";
import { checkInstantRange } from "../core/checks.js";
import { checked } from "../core/result.js";
import type { InvalidParams } from "../core/result.js";
import type { BlockId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import { mintBlockId } from "./booking-id.js";
import { fieldPatch, fieldValues, floorMs } from "./booking.js";
import type { FieldValue, FieldsParam, FieldsPatch } from "./booking.js";
import type { AdapterError, BlockNotFound, SlotConflict } from "./errors.js";
import type { Form, ReadAction, WriteAction } from "./forms.js";
import { lockedById, retry } from "./lock-by-id.js";
import type { Retry } from "./lock-by-id.js";
import { conflictsAt } from "./occupancy.js";
import type { ActionContext } from "./scheduler-service.js";
import { writeUnit } from "./write-unit.js";
import type {
  AlsoContext,
  AlsoParam,
  Outcome,
  WriteEffect,
} from "./write-unit.js";

/** A Block as an Action returns it: flat, Developer Fields included. */
export type Block<S extends AnySchema> = BlockRecord<S>;

/** Params of `blocks.create`: one Resource, one half-open `[start, end)` range, and the Block's Developer Fields under `fields`. */
export type CreateBlockParams<S extends AnySchema> = {
  /** The Resource to block, typed by the schema's `idType`. */
  readonly resourceId: ResourceIdOf<S>;
  /** Inclusive start; floored to the millisecond. */
  readonly start: Temporal.Instant;
  /** Exclusive end; floored to the millisecond. */
  readonly end: Temporal.Instant;
} & FieldsParam<BlockFieldsOf<S>>;

/**
 * Params of `blocks.update`: the Block by id, a new range (`start` and `end` together, or neither), and fields to merge.
 * The Resource never changes. `fields` is absent when the Block has no Developer Fields.
 */
export type UpdateBlockParams<S extends AnySchema> = {
  /** The Block to change. */
  readonly id: BlockId;
} & (
  | {
      /** New inclusive start; floored to the millisecond. */
      readonly start: Temporal.Instant;
      /** New exclusive end; floored to the millisecond. */
      readonly end: Temporal.Instant;
    }
  | { readonly start?: never; readonly end?: never }
) &
  FieldsPatch<BlockFieldsOf<S>>;

/** Params of `blocks.delete`. */
export interface DeleteBlockParams {
  /** The Block to remove. */
  readonly id: BlockId;
}

/** Params of `blocks.list`: the Blocks of one Resource overlapping `[from, to)`. */
export interface ListBlocksParams<S extends AnySchema> {
  /** The Resource whose Blocks to list. */
  readonly resourceId: ResourceIdOf<S>;
  /** Inclusive start of the range. */
  readonly from: Temporal.Instant;
  /** Exclusive end of the range. */
  readonly to: Temporal.Instant;
}

/** What `blocks.create`'s `also` gets: the new Block, on fasti's unit of work. */
export interface CreateBlockAlso<S extends AnySchema, Tx> {
  /** The Adapter's transaction handle: write through it to share the unit. */
  readonly tx: Tx;
  /** The Block just stored. */
  readonly block: Block<S>;
  /** The Clock's time, read on the unit. */
  readonly now: Temporal.Instant;
}

/** What `blocks.update`'s `also` gets: the Block after and before; the same object when nothing changed. */
export interface UpdateBlockAlso<
  S extends AnySchema,
  Tx,
> extends CreateBlockAlso<S, Tx> {
  /** The Block as it was. */
  readonly previous: Block<S>;
}

/** What `blocks.delete`'s `also` gets: the Block that was removed. */
export interface DeleteBlockAlso<S extends AnySchema, Tx> {
  /** The Adapter's transaction handle: write through it to share the unit. */
  readonly tx: Tx;
  /** The Block as it was. */
  readonly previous: Block<S>;
  /** The Clock's time, read on the unit. */
  readonly now: Temporal.Instant;
}

/** Every way `blocks.create` can fail. */
export type CreateBlockError = InvalidParams | SlotConflict | AdapterError;

/** Every way `blocks.update` can fail. */
export type UpdateBlockError =
  | InvalidParams
  | SlotConflict
  | BlockNotFound
  | AdapterError;

/** Every way `blocks.delete` can fail. */
export type DeleteBlockError = BlockNotFound | AdapterError;

/** Every way `blocks.list` can fail. */
export type ListBlocksError = InvalidParams | AdapterError;

/** The Block Actions in form `F`: on a scheduler only when the schema declares `block`. `Tx` as in `SchedulerActions`. */
export interface BlockActions<S extends AnySchema, Tx, F extends Form> {
  /** Store a new Block, if no blocking Booking overlaps it. Blocks may overlap each other. */
  readonly create: WriteAction<
    F,
    CreateBlockParams<S>,
    CreateBlockAlso<S, Tx>,
    Block<S>,
    CreateBlockError
  >;
  /** Move, resize or re-annotate a Block. A new range mustn't overlap a blocking Booking. */
  readonly update: WriteAction<
    F,
    UpdateBlockParams<S>,
    UpdateBlockAlso<S, Tx>,
    Block<S>,
    UpdateBlockError
  >;
  /** Remove a Block, freeing its time. */
  readonly delete: WriteAction<
    F,
    DeleteBlockParams,
    DeleteBlockAlso<S, Tx>,
    void,
    DeleteBlockError
  >;
  /** The Resource's Blocks overlapping the range, sorted by start, then id. */
  readonly list: ReadAction<
    F,
    ListBlocksParams<S>,
    readonly Block<S>[],
    ListBlocksError
  >;
}

/** Store a new Block under the Resource Lock; a blocking Booking in the way is a SlotConflict (ADR 016). */
export function createBlock<S extends AnySchema, Tx, R = never>(
  ctx: ActionContext<S, Tx>,
  params: CreateBlockParams<S> &
    AlsoParam<AlsoContext<CreateBlockAlso<S, Tx>>, Tx, R>
): WriteEffect<Block<S>, CreateBlockError, R> {
  const { codec, schema } = ctx;
  const { resourceId } = params;
  // Adapters see only ms-floored Instants (Invariant 4).
  const start = floorMs(params.start);
  const end = floorMs(params.end);
  // Before any Adapter call (Invariant 5).
  const range = checked(checkInstantRange({ end, start }, []), () => null);

  if (!range.ok) {
    return Effect.fail(range.error);
  }

  return writeUnit(
    ctx,
    resourceId,
    (locked) =>
      Effect.gen(function* createBlockUnit(): Effect.fn.Return<
        Outcome<Block<S>, AlsoContext<CreateBlockAlso<S, Tx>>>,
        SlotConflict | AdapterError
      > {
        // Only blocking Bookings conflict with a Block: Blocks may overlap each other (ADR 016).
        const conflicts = yield* conflictsAt(locked, codec, {
          end,
          excludeBookingId: null,
          kind: "block",
          resourceId,
          start,
        });

        if (conflicts.length > 0) {
          return yield* Effect.fail<SlotConflict>({
            _tag: "SlotConflict",
            conflicts,
          });
        }

        // SAFETY: the base columns are set, and every Block field is set: required ones by CreateBlockParams' type, optional ones to their value or `null`.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema's field names are only known at runtime.
        const record = {
          ...fieldValues<BlockFieldsOf<S>>(
            // SAFETY: BlockFieldsOf<S> is the fields of `schema.block`, which isn't null when this Action exists.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above.
            (schema.block?.fields ?? {}) as BlockFieldsOf<S>,
            params
          ),
          end,
          id: mintBlockId(),
          resourceId,
          start,
        } as BlockRecord<S>;

        yield* locked.insertBlock(record);

        return { _tag: "Done", context: { block: record }, value: record };
      }),
    params.also
  );
}

/** Equal as stored values: Instants by `equals`, the rest by identity. */
function sameStoredValue(a: FieldValue | undefined, b: FieldValue): boolean {
  return a instanceof Temporal.Instant && b instanceof Temporal.Instant
    ? a.equals(b)
    : a === b;
}

/** Change a Block under its Resource's lock (compare-and-set); a no-op change writes nothing. */
export function updateBlock<S extends AnySchema, Tx, R = never>(
  ctx: ActionContext<S, Tx>,
  params: UpdateBlockParams<S> &
    AlsoParam<AlsoContext<UpdateBlockAlso<S, Tx>>, Tx, R>
): WriteEffect<Block<S>, UpdateBlockError, R> {
  const { id } = params;
  const notFound: BlockNotFound = { _tag: "BlockNotFound", id };

  // Adapters see only ms-floored Instants (Invariant 4).
  const range =
    params.start === undefined || params.end === undefined
      ? null
      : { end: floorMs(params.end), start: floorMs(params.start) };

  // Before any Adapter call (Invariant 5).
  if (range !== null) {
    const valid = checked(checkInstantRange(range, []), () => null);

    if (!valid.ok) {
      return Effect.fail(valid.error);
    }
  }

  const fieldChanges = fieldPatch(
    // SAFETY: BlockFieldsOf<S> is the fields of `schema.block`, which isn't null when this Action exists.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above.
    (ctx.schema.block?.fields ?? {}) as BlockFieldsOf<S>,
    params
  );

  return lockedById(ctx, {
    also: params.also,
    destination: null,
    notFound,
    read: (reads) => reads.getBlock(id),
    work: (locked, stored) =>
      Effect.gen(function* updateBlockUnit(): Effect.fn.Return<
        Outcome<Block<S>, AlsoContext<UpdateBlockAlso<S, Tx>>>,
        SlotConflict | AdapterError | Retry
      > {
        // Only a new range can meet a Booking; a fields-only change keeps the time it had (ADR 016).
        if (range !== null) {
          const conflicts = yield* conflictsAt(locked, ctx.codec, {
            ...range,
            excludeBookingId: null,
            kind: "block",
            resourceId: stored.resourceId,
          });

          if (conflicts.length > 0) {
            return yield* Effect.fail<SlotConflict>({
              _tag: "SlotConflict",
              conflicts,
            });
          }
        }

        // SAFETY: a Block record is a plain object of its columns.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- indexed by runtime field names.
        const current = stored as Readonly<Record<string, FieldValue>>;

        // SAFETY: only `start`/`end` and declared Developer Fields, with values of their declared types.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the field names are only known at runtime.
        const changes = Object.fromEntries(
          Object.entries({ ...range, ...fieldChanges }).filter(
            ([name, value]) => !sameStoredValue(current[name], value)
          )
        ) as BlockChanges<S>;

        // A no-op still runs `also`, with `block === previous`.
        if (Object.keys(changes).length === 0) {
          return {
            _tag: "Done",
            context: { block: stored, previous: stored },
            value: stored,
          };
        }

        const updated = yield* locked.updateBlock({
          changes,
          expected: stored,
        });

        if (!updated.ok) {
          return yield* Effect.fail(retry);
        }

        const block = { ...stored, ...changes };

        return {
          _tag: "Done",
          context: { block, previous: stored },
          value: block,
        };
      }),
  });
}

/** Remove a Block under its Resource's lock. */
export function deleteBlock<S extends AnySchema, Tx, R = never>(
  ctx: ActionContext<S, Tx>,
  params: DeleteBlockParams &
    AlsoParam<AlsoContext<DeleteBlockAlso<S, Tx>>, Tx, R>
): WriteEffect<void, DeleteBlockError, R> {
  const { id } = params;
  const notFound: BlockNotFound = { _tag: "BlockNotFound", id };

  return lockedById(ctx, {
    also: params.also,
    destination: null,
    notFound,
    read: (reads) => reads.getBlock(id),
    work: (locked, stored) =>
      Effect.flatMap(locked.deleteBlock(id), (deleted) =>
        deleted.ok
          ? Effect.succeed({
              _tag: "Done",
              context: { previous: stored },
              value: undefined,
            } as const)
          : Effect.fail(notFound)
      ),
  });
}

/** The Resource's Blocks overlapping `[from, to)`, read without the lock. */
export function listBlocks<S extends AnySchema, Tx>(
  { adapter }: ActionContext<S, Tx>,
  params: ListBlocksParams<S>
): Effect.Effect<readonly Block<S>[], ListBlocksError> {
  const from = floorMs(params.from);
  const to = floorMs(params.to);

  const range = checked(
    Temporal.Instant.compare(from, to) < 0
      ? []
      : [
          {
            message: `to (${to.toString()}) must be after from (${from.toString()}).`,
            path: ["to"],
          },
        ],
    () => null
  );

  if (!range.ok) {
    return Effect.fail(range.error);
  }

  return adapter.listBlocks({
    overlapping: { from, to },
    resourceId: params.resourceId,
  });
}
