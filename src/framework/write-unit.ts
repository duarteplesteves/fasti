import { Cause, Clock, Effect, pipe } from "effect";

import type { ResourceIdOf } from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { ChangeAlso } from "./booking.js";
import type { EffectLocked } from "./effect-adapter.js";
import type { AdapterError, Vetoed } from "./errors.js";
import { hookApplies } from "./hook.js";
import type { Committed, HookEvent } from "./hook.js";
import type { ActionContext } from "./scheduler-service.js";
import type { CalledTarget } from "./target.js";

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

/** Which write Action a unit runs, and the Resource it locks. `action` is a name from `writeActionNames`, or `transition`. */
export interface WriteSite<S extends AnySchema> {
  readonly action: string;
  readonly resourceId: ResourceIdOf<S>;
}

/** The target a call matches: its Action, or for a `transition` the edge it moved along. */
function calledTarget(
  action: WriteSite<AnySchema>["action"],
  // oxlint-disable-next-line anti-slop/no-object-parameters -- an Action's own Done context.
  context: object
): CalledTarget {
  if (action !== "transition") {
    return action;
  }

  // SAFETY: a `transition`'s Done context is a ChangeAlso without `tx`/`now`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  const { booking, previous } = context as AlsoContext<
    ChangeAlso<AnySchema, unknown>
  >;

  return { from: previous.status, to: booking.status };
}

/** Run `work` under the Resource Lock, then `also` and the in-transaction Hooks on the same unit when something changed, then the after-commit Hooks: the one place `also` and Hooks run (ADR 015, ADR 017). */
export function writeUnit<S extends AnySchema, Tx, V, C extends object, E, R>(
  ctx: ActionContext<S, Tx>,
  site: WriteSite<S>,
  work: (
    locked: EffectLocked<S, Tx>,
    now: Temporal.Instant
  ) => Effect.Effect<Outcome<V, C>, E>,
  also: EffectAlso<C, Tx, R> | undefined
): WriteEffect<V, E, R> {
  const unit = ctx.adapter.withResourceLock(site.resourceId, (locked) =>
    Effect.gen(function* writeUnitRun() {
      // Read once, first: the work, `also` and the Hooks see the same `now`.
      const now = Temporal.Instant.fromEpochMilliseconds(
        yield* Clock.currentTimeMillis
      );

      const outcome = yield* work(locked, now);

      if (outcome._tag === "NoOp") {
        return { afterCommit: Effect.void, value: outcome.value };
      }

      const value =
        also === undefined
          ? outcome.value
          : yield* also({ ...outcome.context, now, tx: locked.tx }).pipe(
              // A failure fails the unit, so the Adapter rolls fasti's write back.
              Effect.mapError((reason): Vetoed<unknown> => ({
                _tag: "Vetoed",
                reason,
              })),
              Effect.map((alsoValue) =>
                outcome.value === undefined
                  ? { also: alsoValue }
                  : { ...outcome.value, also: alsoValue }
              )
            );

      const called = calledTarget(site.action, outcome.context);
      const applying = ctx.hooks.filter((hook) => hookApplies(hook, called));

      // Each Action's Done context is its `also` context without `tx`/`now`: with these, its HookEvent minus `tx`.
      // oxlint-disable-next-line anti-slop/no-known-value-widening -- C can't be tied to the Action's name; the Hook calls below assert the event's type.
      const event: object = { ...outcome.context, action: site.action, now };

      // A throw is a defect: it rolls the unit back, and the Action rejects with it.
      yield* pipe(
        applying,
        Effect.forEach((hook) =>
          hook.when === "inTransaction"
            ? Effect.promise(async () => {
                // SAFETY: `event` with `tx` is the Action's HookEvent (see above); the generic C can't be tied to the Action's name.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
                await hook.run({ ...event, tx: locked.tx } as HookEvent<S, Tx>);
              })
            : Effect.void
        )
      );

      // Built here, run once the unit has committed: a failure is logged, and the next Hook still runs.
      const afterCommit = pipe(
        applying,
        Effect.forEach((hook) =>
          hook.when === "afterCommit"
            ? Effect.promise(async () => {
                // SAFETY: `event` is the Action's HookEvent without `tx` (see above).
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
                await hook.run(event as Committed<HookEvent<S, Tx>>);
              }).pipe(
                Effect.catchCause((cause) =>
                  // An interrupt isn't the Hook failing: let it stop the rest.
                  Cause.hasInterrupts(cause)
                    ? Effect.failCause(cause)
                    : Effect.logError(
                        "fasti: an after-commit Hook failed",
                        cause
                      )
                )
              )
            : Effect.void
        ),
        Effect.annotateLogs({ action: site.action })
      );

      return { afterCommit, value };
    })
  );

  return unit.pipe(
    Effect.flatMap(({ afterCommit, value }) => Effect.as(afterCommit, value))
  );
}
