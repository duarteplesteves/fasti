import { Effect } from "effect";

import type {
  BlockFieldsOf,
  BlockRecord,
  ResourceIdOf,
} from "../adapter/records.js";
import { checkInstantRange } from "../core/checks.js";
import { checked } from "../core/result.js";
import type { InvalidParams } from "../core/result.js";
import type { AnySchema } from "../schema/define-schema.js";
import { mintBlockId } from "./booking-id.js";
import { fieldValues, floorMs } from "./booking.js";
import type { FieldsParam } from "./booking.js";
import type { AdapterError, SlotConflict } from "./errors.js";
import { conflictsAt } from "./occupancy.js";
import type { ActionContext } from "./scheduler-service.js";

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

/** Params of `blocks.list`: the Blocks of one Resource overlapping `[from, to)`. */
export interface ListBlocksParams<S extends AnySchema> {
  /** The Resource whose Blocks to list. */
  readonly resourceId: ResourceIdOf<S>;
  /** Inclusive start of the range. */
  readonly from: Temporal.Instant;
  /** Exclusive end of the range. */
  readonly to: Temporal.Instant;
}

/** Every way `blocks.create` can fail. */
export type CreateBlockError = InvalidParams | SlotConflict | AdapterError;

/** Every way `blocks.list` can fail. */
export type ListBlocksError = InvalidParams | AdapterError;

/** The Block Actions, Effect form: on a scheduler only when the schema declares `block`. */
export interface BlockActions<S extends AnySchema> {
  /** Store a new Block, if no blocking Booking overlaps it. Blocks may overlap each other. */
  readonly create: (
    params: CreateBlockParams<S>
  ) => Effect.Effect<Block<S>, CreateBlockError>;
  /** The Resource's Blocks overlapping the range, sorted by start, then id. */
  readonly list: (
    params: ListBlocksParams<S>
  ) => Effect.Effect<readonly Block<S>[], ListBlocksError>;
}

/** Store a new Block under the Resource Lock; a blocking Booking in the way is a SlotConflict (ADR 016). */
export function createBlock<S extends AnySchema>(
  { adapter, codec, schema }: ActionContext<S>,
  params: CreateBlockParams<S>
): Effect.Effect<Block<S>, CreateBlockError> {
  const { resourceId } = params;
  // Adapters see only ms-floored Instants (Invariant 4).
  const start = floorMs(params.start);
  const end = floorMs(params.end);
  // Before any Adapter call (Invariant 5).
  const range = checked(checkInstantRange({ end, start }, []), () => null);

  if (!range.ok) {
    return Effect.fail(range.error);
  }

  return adapter.withResourceLock(resourceId, (locked) =>
    Effect.gen(function* createBlockUnit() {
      // Only blocking Bookings conflict with a Block: Blocks may overlap each other (ADR 016).
      const conflicts = yield* conflictsAt(locked, codec, {
        end,
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

      return record;
    })
  );
}

/** The Resource's Blocks overlapping `[from, to)`, read without the lock. */
export function listBlocks<S extends AnySchema>(
  { adapter }: ActionContext<S>,
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
