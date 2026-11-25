import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as EffectResult from "effect/Result";

import type {
  AdapterReads,
  DeleteRecordResult,
  GroupsOf,
  InsertBookingResult,
  ListBookingsQuery,
  ListRecordsQuery,
  LockedAdapter,
  RecordReads,
  ReplaceRecordsParams,
  SchemaAdapter,
  StoredRecord,
  UpdateBookingParams,
  UpdateBookingResult,
  UpdateRecordParams,
  UpdateRecordResult,
  VerbGroup,
} from "../adapter/contract.js";
import type { BookingRecord, ResourceIdOf } from "../adapter/records.js";
import type { BookingId } from "../core/types.js";
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
  /** Only called for a table some Plugin declares, so only on an Adapter with `records`. */
  readonly getRecord: (
    table: string,
    id: string
  ) => Effect.Effect<StoredRecord | null, AdapterError>;
  /** Only called for a table some Plugin declares, so only on an Adapter with `records`. */
  readonly listRecords: (
    table: string,
    query: ListRecordsQuery<S>
  ) => Effect.Effect<StoredRecord[], AdapterError>;
}

/** The handle inside a unit of work, as Effects. */
export interface EffectLocked<S extends AnySchema, Tx> extends EffectReads<S> {
  /** The Adapter's transaction handle for this unit. */
  readonly tx: Tx;
  readonly insertBooking: (
    booking: BookingRecord<S>
  ) => Effect.Effect<InsertBookingResult, AdapterError>;
  /** Store a new Plugin record; only called for a table some Plugin declares, so only on an Adapter with `records`. */
  readonly insertRecord: (
    table: string,
    record: StoredRecord
  ) => Effect.Effect<void, AdapterError>;
  /** As `insertRecord`. */
  readonly updateRecord: (
    table: string,
    params: UpdateRecordParams
  ) => Effect.Effect<UpdateRecordResult, AdapterError>;
  /** As `insertRecord`. */
  readonly deleteRecord: (
    table: string,
    id: string
  ) => Effect.Effect<DeleteRecordResult, AdapterError>;
  /** As `insertRecord`. */
  readonly replaceRecords: (
    table: string,
    params: ReplaceRecordsParams<S>
  ) => Effect.Effect<void, AdapterError>;
  readonly updateBooking: (
    params: UpdateBookingParams<S>
  ) => Effect.Effect<UpdateBookingResult, AdapterError>;
}

/** An Adapter as Effects: the only place a Promise Adapter becomes Effect. */
export interface EffectAdapter<S extends AnySchema, Tx> extends EffectReads<S> {
  /** Run `work` under the Resource Lock, with the caller's services (so its `Clock` too); the unit commits iff `work` succeeds (Invariant 3). */
  readonly withResourceLock: <A, E, R>(
    resourceId: ResourceIdOf<S>,
    work: (locked: EffectLocked<S, Tx>) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | AdapterError, R>;
}

/**
 * Run an Adapter verb; any rejection is the Adapter failing.
 *
 * @returns An Effect of the verb's value; it fails with `AdapterError` wrapping the rejection.
 */
function attempt<A>(run: () => Promise<A>): Effect.Effect<A, AdapterError> {
  return Effect.tryPromise({
    catch: (cause) => new AdapterError(cause),
    try: run,
  });
}

function liftReads<S extends AnySchema>(
  raw: AdapterReads<S> & RecordReads<S>
): EffectReads<S> {
  return {
    getRecord: (table, id) =>
      attempt(async () => await raw.getRecord(table, id)),
    listRecords: (table, query) =>
      attempt(async () => await raw.listRecords(table, query)),
    getBooking: (id) => attempt(async () => await raw.getBooking(id)),
    listBookings: (query) => attempt(async () => await raw.listBookings(query)),
  };
}

function liftLocked<S extends AnySchema, Tx>(
  raw: LockedAdapter<S, Tx, VerbGroup>
): EffectLocked<S, Tx> {
  return {
    ...liftReads(raw),
    tx: raw.tx,
    insertBooking: (booking) =>
      attempt(async () => await raw.insertBooking(booking)),
    insertRecord: (table, record) =>
      attempt(async () => {
        await raw.insertRecord(table, record);
      }),
    updateRecord: (table, params) =>
      attempt(async () => await raw.updateRecord(table, params)),
    deleteRecord: (table, id) =>
      attempt(async () => await raw.deleteRecord(table, id)),
    replaceRecords: (table, params) =>
      attempt(async () => {
        await raw.replaceRecords(table, params);
      }),
    updateBooking: (params) =>
      attempt(async () => await raw.updateBooking(params)),
  };
}

/**
 * The rollback reason for a failed unit, so the Adapter can classify it (e.g. as transient): an AdapterError's original rejection, a defect as thrown, otherwise `rollback`.
 *
 * @returns The value to reject the Adapter's transaction with.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- a rejection reason is whatever was thrown; the Adapter classifies it.
function rejectionFor(cause: Cause.Cause<unknown>, rollback: Error): unknown {
  const found = Cause.findError(cause);

  if (EffectResult.isFailure(found)) {
    return Cause.squash(cause);
  }

  return found.success instanceof AdapterError ? found.success.cause : rollback;
}

/**
 * Wrap a Promise Adapter bound to a schema as an {@link EffectAdapter}: the Booking verbs, and `records` for the Plugin tables.
 *
 * @returns The Effect form of `bound`.
 */
export function liftAdapter<S extends AnySchema, Tx>(
  bound: SchemaAdapter<S, Tx, GroupsOf<S>>
): EffectAdapter<S, Tx> {
  // SAFETY: GroupsOf<S> has "records" exactly when a Plugin declares tables, and the record verbs are only called with those tables.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the conditional type can't follow the runtime check.
  const raw = bound as SchemaAdapter<S, Tx, VerbGroup>;

  return {
    ...liftReads(raw),
    withResourceLock: <A, E, R>(
      resourceId: ResourceIdOf<S>,
      work: (locked: EffectLocked<S, Tx>) => Effect.Effect<A, E, R>
    ) =>
      Effect.flatMap(Effect.context<R>(), (services) =>
        Effect.flatten(
          attempt(async (): Promise<Exit.Exit<A, E>> => {
            let failure: Exit.Exit<A, E> | undefined;
            let thrown: unknown;
            const rollback = new Error("fasti: the unit of work failed");

            try {
              return await raw.withResourceLock(resourceId, async (locked) => {
                const exit = await Effect.runPromiseExitWith(services)(
                  work(liftLocked(locked))
                );

                if (Exit.isFailure(exit)) {
                  failure = exit;
                  thrown = rejectionFor(exit.cause, rollback);
                  // Rejecting rolls the unit back; the contract rejects with this same reason.
                  throw thrown;
                }

                return exit;
              });
            } catch (error) {
              // The work's own failure (typed or defect) passes through; anything else is the Adapter's.
              if (failure !== undefined && error === thrown) {
                return failure;
              }

              throw error;
            }
          })
        )
      ),
  };
}
