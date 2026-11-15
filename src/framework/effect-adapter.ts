import { Effect, Exit } from "effect";

import type {
  AdapterReads,
  InsertBookingResult,
  ListBookingsQuery,
  LockedAdapter,
  SchemaAdapter,
} from "../adapter/contract.js";
import type {
  BookingRecord,
  ResourceIdOf,
  RuleRecord,
} from "../adapter/records.js";
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
  readonly getRules: (
    resourceId: ResourceIdOf<S>
  ) => Effect.Effect<RuleRecord[], AdapterError>;
}

/** The handle inside a unit of work, as Effects. No `tx` until `also` (checkpoint 6). */
export interface EffectLocked<S extends AnySchema> extends EffectReads<S> {
  readonly insertBooking: (
    booking: BookingRecord<S>
  ) => Effect.Effect<InsertBookingResult, AdapterError>;
}

/** An Adapter as Effects: the only place a Promise Adapter becomes Effect. */
export interface EffectAdapter<S extends AnySchema> extends EffectReads<S> {
  /** Run `work` under the Resource Lock; the unit commits iff `work` succeeds (Invariant 3). */
  readonly withResourceLock: <A, E>(
    resourceId: ResourceIdOf<S>,
    work: (locked: EffectLocked<S>) => Effect.Effect<A, E>
  ) => Effect.Effect<A, E | AdapterError>;
}

/** Run an Adapter verb; any rejection is the Adapter failing. */
function attempt<A>(run: () => Promise<A>): Effect.Effect<A, AdapterError> {
  return Effect.tryPromise({
    catch: (cause) => new AdapterError(cause),
    try: run,
  });
}

function liftReads<S extends AnySchema>(raw: AdapterReads<S>): EffectReads<S> {
  return {
    getBooking: (id) => attempt(async () => await raw.getBooking(id)),
    getRules: (resourceId) =>
      attempt(async () => await raw.getRules(resourceId)),
    listBookings: (query) => attempt(async () => await raw.listBookings(query)),
  };
}

function liftLocked<S extends AnySchema, Tx>(
  raw: LockedAdapter<S, Tx>
): EffectLocked<S> {
  return {
    ...liftReads(raw),
    insertBooking: (booking) =>
      attempt(async () => await raw.insertBooking(booking)),
  };
}

/** Wrap a Promise Adapter bound to a schema as an {@link EffectAdapter}. */
export function liftAdapter<S extends AnySchema, Tx>(
  raw: SchemaAdapter<S, Tx>
): EffectAdapter<S> {
  return {
    ...liftReads(raw),
    withResourceLock: <A, E>(
      resourceId: ResourceIdOf<S>,
      work: (locked: EffectLocked<S>) => Effect.Effect<A, E>
    ) =>
      Effect.flatten(
        attempt(async (): Promise<Exit.Exit<A, E>> => {
          let failure: Exit.Exit<A, E> | undefined;
          const rollback = new Error("fasti: the unit of work failed");

          try {
            return await raw.withResourceLock(resourceId, async (locked) => {
              const exit = await Effect.runPromiseExit(
                work(liftLocked(locked))
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
