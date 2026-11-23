import { Cause, Clock, Effect, pipe } from "effect";

import type { ResourceIdOf } from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { ChangeAlso } from "./booking.js";
import type { EffectLocked } from "./effect-adapter.js";
import type { AdapterError, Vetoed } from "./errors.js";
import { hookApplies } from "./hook.js";
import type { AnyHookOf, Committed, HookEvent } from "./hook.js";
import type { ActionContext } from "./scheduler-service.js";
import type { CalledTarget } from "./target.js";

/** What a write unit did. Done: run `also` with `context`. NoOp: skip `also` (a repeat cancel; a no-op update still returns Done, by ADR 015). */
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

/**
 * Which write Action a unit runs, and the Resource it locks. `action` is a name from `writeActionNames`, or `transition`.
 * A string: `WriteActionName<S>` can't be checked inside an Action generic over `S`. Names are checked where they're chosen: Hook targets by type, `defineHook` against `writeActionNames`.
 */
export interface WriteSite<S extends AnySchema> {
  readonly action: string;
  readonly resourceId: ResourceIdOf<S>;
}

/** A Hook as `writeUnit` runs it, app or Plugin: `event` is the Action's Done context with `action` and `now`. */
export type RunnableHook<S extends AnySchema, Tx> =
  | {
      readonly when: "inTransaction";
      readonly applies: (called: CalledTarget) => boolean;
      readonly run: (
        // oxlint-disable-next-line anti-slop/no-object-parameters -- the Action's event, typed where the Hook is written.
        event: object,
        locked: EffectLocked<S, Tx>
      ) => Effect.Effect<void>;
    }
  | {
      readonly when: "afterCommit";
      readonly applies: (called: CalledTarget) => boolean;
      // oxlint-disable-next-line anti-slop/no-object-parameters -- as above.
      readonly run: (event: object) => Effect.Effect<void>;
    };

/** An app Hook as `writeUnit` runs it: a throw or rejection is a defect. */
export function appHook<S extends AnySchema, Tx>(
  hook: AnyHookOf<S, Tx>
): RunnableHook<S, Tx> {
  function applies(called: CalledTarget): boolean {
    return hookApplies(hook, called);
  }

  if (hook.when === "inTransaction") {
    return {
      applies,
      run: (event, locked) =>
        Effect.promise(async () => {
          // SAFETY: `event` with `tx` is the Action's HookEvent; the generic C in writeUnit can't be tied to the Action's name.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
          await hook.run({ ...event, tx: locked.tx } as HookEvent<S, Tx>);
        }),
      when: hook.when,
    };
  }

  return {
    applies,
    run: (event) =>
      Effect.promise(async () => {
        // SAFETY: `event` is the Action's HookEvent without `tx` (see above).
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
        await hook.run(event as Committed<HookEvent<S, Tx>>);
      }),
    when: hook.when,
  };
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
      // The Plugins' Hooks come first in ctx.hooks.
      const applying = ctx.hooks.filter((hook) => hook.applies(called));

      // Each Action's Done context is its `also` context without `tx`/`now`: with these, its HookEvent minus `tx`.
      const event = { ...outcome.context, action: site.action, now };

      // A throw is a defect: it rolls the unit back, and the Action rejects with it.
      yield* pipe(
        applying,
        Effect.forEach((hook) =>
          hook.when === "inTransaction" ? hook.run(event, locked) : Effect.void
        )
      );

      // Built here, run once the unit has committed: a failure is logged, and the next Hook still runs.
      const afterCommit = pipe(
        applying,
        Effect.forEach((hook) =>
          hook.when === "afterCommit"
            ? hook.run(event).pipe(
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
