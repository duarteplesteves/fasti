import { Effect, Exit } from "effect";

import type {
  AdapterReads,
  BlockReads,
  BlockWrites,
  DeleteBlockResult,
  GroupsOf,
  InsertBookingResult,
  ListBlocksQuery,
  ListBookingsQuery,
  LockedAdapter,
  ReplaceRulesParams,
  SchemaAdapter,
  UpdateBlockResult,
  UpdateBookingParams,
  UpdateBookingResult,
  VerbGroup,
} from "../adapter/contract.js";
import type {
  BlockRecord,
  BookingRecord,
  ResourceIdOf,
  RuleRecord,
} from "../adapter/records.js";
import type { BlockId, BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import { AdapterError } from "./errors.js";

/** The Adapter's reads, as Effects that fail with {@link AdapterError}. */
export interface EffectReads<S extends AnySchema> {
  readonly getBooking: (
    id: BookingId
  ) => Effect.Effect<BookingRecord<S> | null, AdapterError>;
  readonly listBookings: (
    query: ListBookingsQuery<S>
  ) => Effect.Effect<BookingRecord<S>[], AdapterError>;
  readonly getRules: (
    resourceId: ResourceIdOf<S>
  ) => Effect.Effect<RuleRecord[], AdapterError>;
  /** Dies on a schema without `block`: no Action calls it there. */
  readonly getBlock: (
    id: BlockId
  ) => Effect.Effect<BlockRecord<S> | null, AdapterError>;
  /** `[]` on a schema without `block`, with no database read. */
  readonly listBlocks: (
    query: ListBlocksQuery<S>
  ) => Effect.Effect<BlockRecord<S>[], AdapterError>;
}

/** The handle inside a unit of work, as Effects. */
export interface EffectLocked<S extends AnySchema, Tx> extends EffectReads<S> {
  /** The Adapter's transaction handle for this unit. */
  readonly tx: Tx;
  readonly insertBooking: (
    booking: BookingRecord<S>
  ) => Effect.Effect<InsertBookingResult, AdapterError>;
  /** Dies on a schema without `block`: no Action calls it there. */
  readonly insertBlock: (
    block: BlockRecord<S>
  ) => Effect.Effect<void, AdapterError>;
  /** Dies on a schema without `block`, as `insertBlock`. */
  readonly updateBlock: (
    params: Parameters<BlockWrites<S>["updateBlock"]>[0]
  ) => Effect.Effect<UpdateBlockResult, AdapterError>;
  /** Dies on a schema without `block`, as `insertBlock`. */
  readonly deleteBlock: (
    id: BlockId
  ) => Effect.Effect<DeleteBlockResult, AdapterError>;
  readonly replaceRules: (
    params: ReplaceRulesParams<S>
  ) => Effect.Effect<void, AdapterError>;
  readonly updateBooking: (
    params: UpdateBookingParams<S>
  ) => Effect.Effect<UpdateBookingResult, AdapterError>;
}

/** An Adapter as Effects: the only place a Promise Adapter becomes Effect. */
export interface EffectAdapter<S extends AnySchema, Tx> extends EffectReads<S> {
  /** Run `work` under the Resource Lock; the unit commits iff `work` succeeds (Invariant 3). */
  readonly withResourceLock: <A, E>(
    resourceId: ResourceIdOf<S>,
    work: (locked: EffectLocked<S, Tx>) => Effect.Effect<A, E>
  ) => Effect.Effect<A, E | AdapterError>;
}

/** Run an Adapter verb; any rejection is the Adapter failing. */
function attempt<A>(run: () => Promise<A>): Effect.Effect<A, AdapterError> {
  return Effect.tryPromise({
    catch: (cause) => new AdapterError(cause),
    try: run,
  });
}

/** A Block verb: run it with `block`, die without (the Framework never calls it there). */
function blockVerb<A>(
  hasBlocks: boolean,
  name: string,
  run: () => Promise<A>
): Effect.Effect<A, AdapterError> {
  return hasBlocks
    ? attempt(run)
    : Effect.die(new Error(`fasti: ${name} on a schema without block`));
}

function liftReads<S extends AnySchema>(
  raw: AdapterReads<S> & BlockReads<S>,
  hasBlocks: boolean
): EffectReads<S> {
  return {
    getBlock: (id) =>
      blockVerb(hasBlocks, "getBlock", async () => await raw.getBlock(id)),
    getBooking: (id) => attempt(async () => await raw.getBooking(id)),
    getRules: (resourceId) =>
      attempt(async () => await raw.getRules(resourceId)),
    listBlocks: (query) =>
      hasBlocks
        ? attempt(async () => await raw.listBlocks(query))
        : Effect.succeed([]),
    listBookings: (query) => attempt(async () => await raw.listBookings(query)),
  };
}

function liftLocked<S extends AnySchema, Tx>(
  raw: LockedAdapter<S, Tx, VerbGroup>,
  hasBlocks: boolean
): EffectLocked<S, Tx> {
  return {
    ...liftReads(raw, hasBlocks),
    tx: raw.tx,
    deleteBlock: (id) =>
      blockVerb(
        hasBlocks,
        "deleteBlock",
        async () => await raw.deleteBlock(id)
      ),
    insertBlock: (block) =>
      blockVerb(hasBlocks, "insertBlock", async () => {
        await raw.insertBlock(block);
      }),
    insertBooking: (booking) =>
      attempt(async () => await raw.insertBooking(booking)),
    replaceRules: (params) =>
      attempt(async () => {
        await raw.replaceRules(params);
      }),
    updateBlock: (params) =>
      blockVerb(
        hasBlocks,
        "updateBlock",
        async () => await raw.updateBlock(params)
      ),
    updateBooking: (params) =>
      attempt(async () => await raw.updateBooking(params)),
  };
}

/** Wrap a Promise Adapter bound to `schema` as an {@link EffectAdapter}. Without `block`, the Block verbs never reach it. */
export function liftAdapter<S extends AnySchema, Tx>(
  bound: SchemaAdapter<S, Tx, GroupsOf<S>>,
  schema: S
): EffectAdapter<S, Tx> {
  const hasBlocks = schema.block !== null;
  // SAFETY: GroupsOf<S> is "blocks" exactly when `schema.block` isn't null, and the Block verbs are only called then.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the conditional type can't follow the runtime check.
  const raw = bound as SchemaAdapter<S, Tx, VerbGroup>;

  return {
    ...liftReads(raw, hasBlocks),
    withResourceLock: <A, E>(
      resourceId: ResourceIdOf<S>,
      work: (locked: EffectLocked<S, Tx>) => Effect.Effect<A, E>
    ) =>
      Effect.flatten(
        attempt(async (): Promise<Exit.Exit<A, E>> => {
          let failure: Exit.Exit<A, E> | undefined;
          const rollback = new Error("fasti: the unit of work failed");

          try {
            return await raw.withResourceLock(resourceId, async (locked) => {
              const exit = await Effect.runPromiseExit(
                work(liftLocked(locked, hasBlocks))
              );

              if (Exit.isFailure(exit)) {
                failure = exit;
                // Rejecting rolls the unit back; the contract rejects with this same reason.
                throw rollback;
              }

              return exit;
            });
          } catch (error) {
            // The work's own failure (typed or defect) passes through; anything else is the Adapter's.
            if (error === rollback && failure !== undefined) {
              return failure;
            }

            throw error;
          }
        })
      ),
  };
}
