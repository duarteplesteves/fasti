import { Effect } from "effect";

import type { ResourceIdOf } from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { EffectLocked, EffectReads } from "./effect-adapter.js";
import { AdapterError } from "./errors.js";
import type { ActionContext } from "./scheduler-service.js";
import { writeUnit } from "./write-unit.js";
import type {
  EffectAlso,
  Outcome,
  WriteEffect,
  WriteSite,
} from "./write-unit.js";

/** An outside write moved or changed the row between read and write: start over. Never leaves `lockedById`. */
export interface Retry {
  readonly _tag: "Retry";
}

/** The one `Retry` value: fail with it from `lockedById`'s `work`. */
export const retry: Retry = { _tag: "Retry" };

/**
 * Whether a failure is `retry`.
 *
 * @returns `true` for `retry`.
 */
function isRetry(failure: unknown): failure is Retry {
  return failure === retry;
}

/** Attempts at a row that an outside writer keeps moving or changing, the first included. */
const MAX_ATTEMPTS = 3;

/**
 * Rerun `once` while it fails with `retry`, up to {@link MAX_ATTEMPTS} times, so a churned row can't keep an Action looping.
 *
 * @returns An Effect of `once`'s value; once the attempts run out it fails with `AdapterError`, as an exhausted transient retry does (ADR 008).
 */
export function retryChanged<A, E, R>(
  once: Effect.Effect<A, E | Retry, R>
): Effect.Effect<A, Exclude<E, Retry> | AdapterError, R> {
  // Explicit, as `E` is generic here: inference can't pick the refinement overload.
  return Effect.catchIf<A, E | Retry, R, Retry, never, AdapterError, never>(
    Effect.retry(once, { times: MAX_ATTEMPTS - 1, while: isRetry }),
    isRetry,
    () =>
      Effect.fail(
        new AdapterError(
          new Error(
            `The row changed under its Resource Lock on each of ${MAX_ATTEMPTS} attempts.`
          )
        )
      )
  );
}

/** Params of `lockedById`. */
export interface LockedByIdParams<
  S extends AnySchema,
  Tx,
  Rec extends { readonly resourceId: ResourceIdOf<S> },
  NF,
  V,
  C extends object,
  E,
  R,
> {
  /** The Action this is, passed on to `writeUnit`. */
  readonly action: WriteSite<S>["action"];
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

/**
 * Run `work` on a row addressed by id, under its Resource's lock: the one place an Action retries.
 *
 * @returns An Effect of `work`'s value, with `also`'s value merged in when one ran; it fails with `notFound` when the row is missing, or with `work`'s failure, `Vetoed` or `AdapterError`.
 */
export function lockedById<
  S extends AnySchema,
  Tx,
  Rec extends { readonly resourceId: ResourceIdOf<S> },
  NF,
  V,
  C extends object,
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
        {
          action: params.action,
          resourceId: params.destination ?? seen.resourceId,
        },
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

  return retryChanged(once);
}
