import { Clock, Effect } from "effect";

import type { ResourceIdOf } from "../adapter/records.js";
import type { AnySchema, BlockSchema } from "../schema/define-schema.js";
import type { EffectLocked } from "./effect-adapter.js";
import type { AdapterError, Vetoed } from "./errors.js";
import type { ActionContext } from "./scheduler-service.js";
import type { WriteActionName } from "./target.js";

/** What a write unit did. Done: run `also` with `context`. NoOp: skip `also` (a repeat cancel; a no-op `blocks.update` still returns Done, by ADR 015). */
export type Outcome<V, C> =
  | { readonly _tag: "Done"; readonly value: V; readonly context: C }
  | { readonly _tag: "NoOp"; readonly value: V };

/** An `also` context without the `tx` and `now` that `writeUnit` adds. */
export type AlsoContext<T> = Omit<T, "tx" | "now">;

/** The `also` an Action receives, in Effect form: the plain form's is adapted in `toPlain`. */
export type EffectAlso<C, Tx, R> = (
  ctx: C & { readonly tx: Tx; readonly now: Temporal.Instant }
) => Effect.Effect<unknown, unknown, R>;

/** The `also` key on an Action implementation's params; the overloads in `WriteAction` type it for callers. */
export interface AlsoParam<C, Tx, R> {
  readonly also?: EffectAlso<C, Tx, R>;
}

/** What a write Action's implementation returns: its value, with `also` merged in (or wrapping a void one) when one ran. `WithAlso` types it for callers. */
export type WriteEffect<V, E, R> = Effect.Effect<
  V | { readonly also: unknown },
  E | Vetoed<unknown> | AdapterError,
  R
>;

/** Which write Action a unit runs, and the Resource it locks. Every name, whatever the schema: only a schema with `block` reaches `blocks.*`. */
export interface WriteSite<S extends AnySchema> {
  readonly action: WriteActionName<BlockSchema> | "transition";
  readonly resourceId: ResourceIdOf<S>;
}

/** Run `work` under the Resource Lock, then `also` on the same unit when something changed: the one place `also` runs (ADR 015). */
export function writeUnit<S extends AnySchema, Tx, V, C, E, R>(
  ctx: ActionContext<S, Tx>,
  site: WriteSite<S>,
  work: (
    locked: EffectLocked<S, Tx>,
    now: Temporal.Instant
  ) => Effect.Effect<Outcome<V, C>, E>,
  also: EffectAlso<C, Tx, R> | undefined
): WriteEffect<V, E, R> {
  return ctx.adapter.withResourceLock(site.resourceId, (locked) =>
    Effect.gen(function* writeUnitRun() {
      // Read once, first: the work and `also` see the same `now`.
      const now = Temporal.Instant.fromEpochMilliseconds(
        yield* Clock.currentTimeMillis
      );

      const outcome = yield* work(locked, now);

      if (outcome._tag === "NoOp" || also === undefined) {
        return outcome.value;
      }

      // A failure fails the unit, so the Adapter rolls fasti's write back.
      const value = yield* Effect.mapError(
        also({ ...outcome.context, now, tx: locked.tx }),
        (reason): Vetoed<unknown> => ({ _tag: "Vetoed", reason })
      );

      return outcome.value === undefined
        ? { also: value }
        : { ...outcome.value, also: value };
    })
  );
}
