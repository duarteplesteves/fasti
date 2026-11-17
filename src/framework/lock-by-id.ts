import { Effect } from "effect";

import type { ResourceIdOf } from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { EffectLocked, EffectReads } from "./effect-adapter.js";
import type { AdapterError } from "./errors.js";
import type { ActionContext } from "./scheduler-service.js";

/** An outside write moved or changed the row between read and write: start over. Never leaves `lockedById`. */
export interface Retry {
  readonly _tag: "Retry";
}

export const retry: Retry = { _tag: "Retry" };

/** Params of `lockedById`. */
export interface LockedByIdParams<
  S extends AnySchema,
  Rec extends { readonly resourceId: ResourceIdOf<S> },
  NF,
  V,
  E,
> {
  /** Read the row by id, unlocked first, then again under the lock. */
  readonly read: (
    reads: EffectReads<S>
  ) => Effect.Effect<Rec | null, AdapterError>;
  /** The failure when the row is missing. */
  readonly notFound: NF;
  /** The locked work on the stored row; fail with `retry` when compare-and-set reports `changed`. */
  readonly work: (
    locked: EffectLocked<S>,
    stored: Rec
  ) => Effect.Effect<V, E | Retry>;
}

/** Run `work` on a row addressed by id, under its Resource's lock; the one place an Action retries (I-3). */
export function lockedById<
  S extends AnySchema,
  Rec extends { readonly resourceId: ResourceIdOf<S> },
  NF,
  V,
  E,
>(
  ctx: ActionContext<S>,
  p: LockedByIdParams<S, Rec, NF, V, E>
): Effect.Effect<V, E | NF | AdapterError> {
  const once = Effect.gen(function* lockedByIdOnce() {
    // Unlocked, only to learn which Resource to lock.
    const seen = yield* p.read(ctx.adapter);

    if (seen === null) {
      return yield* Effect.fail(p.notFound);
    }

    return yield* ctx.adapter.withResourceLock(seen.resourceId, (locked) =>
      Effect.gen(function* lockedByIdUnit() {
        const stored = yield* p.read(locked);

        if (stored === null) {
          return yield* Effect.fail(p.notFound);
        }

        if (stored.resourceId !== seen.resourceId) {
          return yield* Effect.fail(retry);
        }

        return yield* p.work(locked, stored);
      })
    );
  });

  // shortcut: Retry is unbounded; cap it if outside writers ever churn a row.
  return Effect.catchIf(
    once,
    (e): e is Retry => e === retry,
    () => lockedById(ctx, p)
  );
}
