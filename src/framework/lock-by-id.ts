import { Effect } from "effect";

import type { ResourceIdOf } from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { EffectLocked, EffectReads } from "./effect-adapter.js";
import type { AdapterError } from "./errors.js";
import type { ActionContext } from "./scheduler-service.js";
import { writeUnit } from "./write-unit.js";
import type { EffectAlso, Outcome, WriteEffect } from "./write-unit.js";

/** An outside write moved or changed the row between read and write: start over. Never leaves `lockedById`. */
export interface Retry {
  readonly _tag: "Retry";
}

/** The one `Retry` value: fail with it from `lockedById`'s `work`. */
export const retry: Retry = { _tag: "Retry" };

/** Params of `lockedById`. */
export interface LockedByIdParams<
  S extends AnySchema,
  Tx,
  Rec extends { readonly resourceId: ResourceIdOf<S> },
  NF,
  V,
  C,
  E,
  R,
> {
  /** Read the row by id, unlocked first, then again under the lock. */
  readonly read: (
    reads: EffectReads<S>
  ) => Effect.Effect<Rec | null, AdapterError>;
  /** The failure when the row is missing. */
  readonly notFound: NF;
  /** The Resource to lock instead of the stored one (reschedule's destination); `null` for the stored one. */
  readonly destination: ResourceIdOf<S> | null;
  /** The locked work on the stored row; fail with `retry` when compare-and-set reports `changed`. */
  readonly work: (
    locked: EffectLocked<S, Tx>,
    stored: Rec,
    now: Temporal.Instant
  ) => Effect.Effect<Outcome<V, C>, E | Retry>;
  /** The developer's `also`, run by `writeUnit` after `work`. */
  readonly also: EffectAlso<C, Tx, R> | undefined;
}

/** Run `work` on a row addressed by id, under its Resource's lock: the one place an Action retries. */
export function lockedById<
  S extends AnySchema,
  Tx,
  Rec extends { readonly resourceId: ResourceIdOf<S> },
  NF,
  V,
  C,
  E,
  R,
>(
  ctx: ActionContext<S, Tx>,
  params: LockedByIdParams<S, Tx, Rec, NF, V, C, E, R>
): WriteEffect<V, E | NF, R> {
  const once: WriteEffect<V, E | NF | Retry, R> = Effect.gen(
    function* lockedByIdOnce() {
      // Unlocked, only to learn which Resource to lock.
      const seen = yield* params.read(ctx.adapter);

      if (seen === null) {
        return yield* Effect.fail(params.notFound);
      }

      return yield* writeUnit(
        ctx,
        params.destination ?? seen.resourceId,
        (locked, now) =>
          Effect.gen(function* lockedByIdUnit() {
            const stored = yield* params.read(locked);

            if (stored === null) {
              return yield* Effect.fail(params.notFound);
            }

            if (stored.resourceId !== seen.resourceId) {
              return yield* Effect.fail(retry);
            }

            return yield* params.work(locked, stored, now);
          }),
        params.also
      );
    }
  );

  // shortcut: Retry is unbounded; cap it if outside writers ever churn a row.
  return Effect.catchIf(
    once,
    (error): error is Retry => error === retry,
    () => lockedById(ctx, params)
  );
}
