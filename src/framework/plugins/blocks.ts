import { Effect } from "effect";

import { checkInstantRange } from "../../core/checks.js";
import { checked } from "../../core/result.js";
import type { InvalidParams } from "../../core/result.js";
import type { BlockId } from "../../core/types.js";
import type { Fields } from "../../schema/define-schema.js";
import type {
  Plugin,
  PluginResourceId,
  RecordOf,
  TableDef,
} from "../../schema/table.js";
import { uuidV7 } from "../booking-id.js";
import { fieldPatch, fieldValues, floorMs } from "../booking.js";
import type { FieldValue, FieldsParam, FieldsPatch } from "../booking.js";
import type { AdapterError, SlotConflict, Vetoed } from "../errors.js";
import { retry } from "../lock-by-id.js";
import type { Retry } from "../lock-by-id.js";
import { definePlugin } from "../plugin.js";
import type {
  Lock,
  NativeRead,
  NativeWrite,
  RecordReadsOf,
  Unit,
  Written,
} from "../plugin.js";
import type { Outcome } from "../write-unit.js";

/** The Block table over Developer Fields `F`: timed, and, as in `0.6`, no database default on `id` (I8). */
export interface BlockTable<F extends Fields> extends TableDef<F, true> {
  readonly idDefault: false;
}

/** The `blocks()` Plugin's tables. */
// A Record, not an interface: only a type without declared members fits `Tables`' index signature.
export type BlockTables<F extends Fields> = Readonly<
  Record<"block", BlockTable<F>>
>;

/** A Block as an Action returns it: flat, Developer Fields included. */
export type Block<F extends Fields> = RecordOf<"block", BlockTable<F>>;

/** A Block that a requested slot overlaps; no Developer Fields. */
export interface ConflictingBlock {
  readonly kind: "block";
  readonly id: BlockId;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

/** No Block has this id. */
export interface BlockNotFound {
  readonly _tag: "BlockNotFound";
  readonly id: BlockId;
}

/** Params of `blocks.create`: one Resource, one half-open `[start, end)` range, and the Block's Developer Fields under `fields`. */
export type CreateBlockParams<F extends Fields> = {
  /** The Resource to block. */
  readonly resourceId: PluginResourceId;
  /** Inclusive start; floored to the millisecond. */
  readonly start: Temporal.Instant;
  /** Exclusive end; floored to the millisecond. */
  readonly end: Temporal.Instant;
} & FieldsParam<F>;

/**
 * Params of `blocks.update`: the Block by id, a new range (`start` and `end` together, or neither), and fields to merge.
 * The Resource never changes. `fields` is absent when the Block has no Developer Fields.
 */
export type UpdateBlockParams<F extends Fields> = {
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
  FieldsPatch<F>;

/** Params of `blocks.delete`. */
export interface DeleteBlockParams {
  /** The Block to remove. */
  readonly id: BlockId;
}

/** Params of `blocks.list`: the Blocks of one Resource overlapping `[from, to)`. */
export interface ListBlocksParams {
  /** The Resource whose Blocks to list. */
  readonly resourceId: PluginResourceId;
  /** Inclusive start of the range. */
  readonly from: Temporal.Instant;
  /** Exclusive end of the range. */
  readonly to: Temporal.Instant;
}

/** What `blocks.create`'s `also` gets, beside `tx` and `now`: the new Block. */
export interface CreateBlockAlso<F extends Fields> {
  /** The Block just stored. */
  readonly block: Block<F>;
}

/** What `blocks.update`'s `also` gets: the Block after and before; the same object when nothing changed. */
export interface UpdateBlockAlso<F extends Fields> extends CreateBlockAlso<F> {
  /** The Block as it was. */
  readonly previous: Block<F>;
}

/** What `blocks.delete`'s `also` gets: the Block that was removed. */
export interface DeleteBlockAlso<F extends Fields> {
  /** The Block as it was. */
  readonly previous: Block<F>;
}

/** A Block in the way: only blocking Bookings conflict with a Block (ADR 016). */
export type BlockOverBooking = SlotConflict;

/** Every way `blocks.create` can fail. */
export type CreateBlockError = InvalidParams | BlockOverBooking | AdapterError;

/** Every way `blocks.update` can fail. */
export type UpdateBlockError =
  | InvalidParams
  | BlockOverBooking
  | BlockNotFound
  | AdapterError;

/** Every way `blocks.delete` can fail. */
export type DeleteBlockError = BlockNotFound | AdapterError;

/** Every way `blocks.list` can fail. */
export type ListBlocksError = InvalidParams | AdapterError;

/** The Block Actions, natively. */
export interface BlockActions<F extends Fields> {
  /** Store a new Block, if no blocking Booking overlaps it. Blocks may overlap each other. */
  readonly create: NativeWrite<
    BlockTables<F>,
    CreateBlockParams<F>,
    Block<F>,
    CreateBlockAlso<F>,
    CreateBlockError | Vetoed<unknown>
  >;
  /** Move, resize or re-annotate a Block. A new range mustn't overlap a blocking Booking. */
  readonly update: NativeWrite<
    BlockTables<F>,
    UpdateBlockParams<F>,
    Block<F>,
    UpdateBlockAlso<F>,
    UpdateBlockError | Vetoed<unknown>
  >;
  /** Remove a Block, freeing its time. */
  readonly delete: NativeWrite<
    BlockTables<F>,
    DeleteBlockParams,
    void,
    DeleteBlockAlso<F>,
    DeleteBlockError | Vetoed<unknown>
  >;
  /** The Resource's Blocks overlapping the range, sorted by start, then id. */
  readonly list: NativeRead<
    BlockTables<F>,
    ListBlocksParams,
    readonly Block<F>[],
    ListBlocksError
  >;
}

/** The `blocks({ fields })` Plugin. */
export type BlocksPlugin<F extends Fields> = Plugin<
  "blocks",
  BlockTables<F>,
  BlockActions<F>,
  never,
  ConflictingBlock
>;

/** Inside the Plugin, the Developer Fields are only known at runtime. */
type AnyBlockTables = BlockTables<Fields>;

/** A stored Block, its fields erased. */
type StoredBlock = Block<Fields>;

/**
 * A new Block id: a UUIDv7, as `insert` mints them. For tests and fixtures: a Block's own id comes from `blocks.create`.
 *
 * @returns The new id.
 */
export function mintBlockId(): BlockId {
  // SAFETY: a freshly minted UUIDv7 is exactly what a BlockId is.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- brands are applied by assertion.
  return uuidV7() as BlockId;
}

/**
 * Equal as stored values: Instants by `equals`, the rest by identity.
 *
 * @returns `true` when `a` and `b` are the same stored value.
 */
function sameStoredValue(a: FieldValue | undefined, b: FieldValue): boolean {
  return a instanceof Temporal.Instant && b instanceof Temporal.Instant
    ? a.equals(b)
    : a === b;
}

/**
 * Refuse `[start, end)` if a blocking Booking overlaps it; Blocks may overlap each other (ADR 016).
 *
 * @returns An Effect that succeeds when no blocking Booking overlaps the range; it fails with `BlockOverBooking` or `AdapterError`.
 */
function refuseBookings(
  unit: Unit<AnyBlockTables>,
  range: { readonly start: Temporal.Instant; readonly end: Temporal.Instant }
): Effect.Effect<void, BlockOverBooking | AdapterError> {
  return Effect.flatMap(unit.conflicts(range), (conflicts) =>
    conflicts.length > 0
      ? Effect.fail<BlockOverBooking>({ _tag: "SlotConflict", conflicts })
      : Effect.void
  );
}

/**
 * Run `work` on the Block `id` under its Resource's lock: read unlocked to learn the Resource, then again on the unit.
 * `work` fails with `retry` when compare-and-set reports `changed`, and it all starts over.
 *
 * @returns An Effect of `work`'s value, written; it fails with `BlockNotFound`, `work`'s failure, `Vetoed` or `AdapterError`.
 */
function lockBlock<V, C extends object, E>(
  {
    lock,
    records,
  }: {
    readonly records: RecordReadsOf<AnyBlockTables>;
    readonly lock: Lock<AnyBlockTables>;
  },
  id: BlockId,
  work: (
    unit: Unit<AnyBlockTables>,
    stored: StoredBlock
  ) => Effect.Effect<Outcome<V, C>, E | Retry | AdapterError>
): Effect.Effect<
  Written<V, C>,
  E | BlockNotFound | Vetoed<unknown> | AdapterError
> {
  const notFound: BlockNotFound = { _tag: "BlockNotFound", id };

  const once = Effect.flatMap(records.block.get(id), (seen) =>
    seen === null
      ? Effect.fail(notFound)
      : lock<V, C, E | Retry | BlockNotFound | AdapterError>(
          seen.resourceId,
          (unit) =>
            Effect.gen(function* lockedBlock() {
              const stored = yield* unit.records.block.get(id);

              if (stored === null) {
                return yield* Effect.fail(notFound);
              }

              return yield* work(unit, stored);
            })
        )
  );

  // shortcut: Retry is unbounded, as in lockedById; cap it if outside writers ever churn a row.
  return Effect.catchIf(
    once,
    (error): error is Retry => error === retry,
    () => lockBlock({ lock, records }, id, work)
  );
}

/**
 * The Plugin over Developer Fields known only at runtime.
 *
 * @returns The Blocks Plugin, typed over `Fields`.
 */
function blocksPlugin(fields: Fields) {
  const table: BlockTable<Fields> = {
    columns: fields,
    idDefault: false,
    timed: true,
  };

  return definePlugin({
    actions: {
      create: {
        kind: "write",
        run: (params: CreateBlockParams<Fields>, { lock }) => {
          const { resourceId } = params;
          // Adapters see only ms-floored Instants (Invariant 4).
          const start = floorMs(params.start);
          const end = floorMs(params.end);

          // Before any Adapter call (Invariant 5).
          const range = checked(
            checkInstantRange({ end, start }, []),
            () => null
          );

          if (!range.ok) {
            return Effect.fail(range.error);
          }

          return lock(resourceId, (unit) =>
            Effect.gen(function* createBlockUnit() {
              yield* refuseBookings(unit, { end, start });

              // SAFETY: the base columns, and one value per Developer Field: `fieldValues` fills each, `null` when unset.
              // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- the field names are only known at runtime.
              const record = {
                ...fieldValues(fields, params),
                end,
                resourceId,
                start,
              } as unknown as Omit<StoredBlock, "id">;

              const block = yield* unit.records.block.insert(record);

              return {
                _tag: "Done",
                context: { block },
                value: block,
              } as const;
            })
          );
        },
      },
      delete: {
        kind: "write",
        run: ({ id }: DeleteBlockParams, tools) =>
          lockBlock(tools, id, (unit, stored) =>
            Effect.flatMap(unit.records.block.delete(id), (deleted) =>
              deleted.ok
                ? Effect.succeed({
                    _tag: "Done",
                    context: { previous: stored },
                    value: undefined,
                  } as const)
                : Effect.fail<BlockNotFound>({ _tag: "BlockNotFound", id })
            )
          ),
      },
      list: {
        kind: "read",
        run: (params: ListBlocksParams, { records }) => {
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

          return range.ok
            ? records.block.list({
                overlapping: { from, to },
                resourceId: params.resourceId,
              })
            : Effect.fail(range.error);
        },
      },
      update: {
        kind: "write",
        run: (params: UpdateBlockParams<Fields>, tools) => {
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

          const fieldChanges = fieldPatch(fields, params);

          return lockBlock(tools, params.id, (unit, stored) =>
            Effect.gen(function* updateBlockUnit() {
              // Only a new range can meet a Booking; a fields-only change keeps the time it had (ADR 016).
              if (range !== null) {
                yield* refuseBookings(unit, range);
              }

              // SAFETY: a Block record is a plain object of its columns.
              // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- indexed by runtime field names.
              const current = stored as unknown as Readonly<
                Record<string, FieldValue>
              >;

              const changes = Object.fromEntries(
                Object.entries({ ...range, ...fieldChanges }).filter(
                  ([name, value]) => !sameStoredValue(current[name], value)
                )
              );

              // A no-op still runs `also`, with `block === previous`.
              if (Object.keys(changes).length === 0) {
                return {
                  _tag: "Done",
                  context: { block: stored, previous: stored },
                  value: stored,
                } as const;
              }

              const updated = yield* unit.records.block.update({
                changes,
                expected: stored,
              });

              if (!updated.ok) {
                return yield* Effect.fail(retry);
              }

              const block: StoredBlock = { ...stored, ...changes };

              return {
                _tag: "Done",
                context: { block, previous: stored },
                value: block,
              } as const;
            })
          );
        },
      },
    },
    busy: {
      kind: "block",
      list: ({ overlapping, records, resourceId }) =>
        records.block.list({ overlapping, resourceId }),
    },
    name: "blocks",
    tables: { block: table },
  });
}

/** fasti's own Block columns, and `also`, reserved on a Block's value: no Developer Field can take one. */
type ReservedBlockField = "id" | "resourceId" | "start" | "end" | "also";

/**
 * Blocks on `scheduler.blocks`: time a Resource is unavailable (ADR 016), with Developer Fields `fields` (`{}` for none).
 * Blocks are busy time: no blocking Booking may overlap one, and `findSlots` skips them; Blocks may overlap each other.
 * Its table is `0.6`'s `block`, so installing it needs no migration.
 *
 * @returns The Plugin, to install in `defineSchema`'s `plugins`.
 * @throws When a field is named `also`, or after a column fasti owns.
 */
export function blocks<const F extends Fields>({
  fields,
}: { readonly fields: F } & {
  // Apart from `fields: F`, so `fields: {}` still infers F (an intersection there drops the inference).
  readonly fields: Partial<Readonly<Record<ReservedBlockField, never>>>;
}): BlocksPlugin<F> {
  // Plain-JS callers can get past the type; definePlugin's schema check catches the columns fasti owns.
  if (Object.hasOwn(fields, "also")) {
    throw new Error(
      'blocks: a Block Developer Field can\'t be named "also"; it is reserved.'
    );
  }

  // SAFETY: the Plugin is BlocksPlugin<F> with F erased to Fields: the same values, its types known only at runtime.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- see above.
  return blocksPlugin(fields) as unknown as BlocksPlugin<F>;
}
