import { Cause, Effect, Exit, Predicate, Result as EffectResult } from "effect";

import type { Adapter, GroupsOf } from "../adapter/contract.js";
import type { Result } from "../core/result.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { PolicyNamesOf } from "../schema/table.js";
import type { ErasedError } from "./errors.js";
import type { AnyHookOf } from "./hook.js";
import type { AnyPolicyOf, UniqueNames } from "./policy.js";
import { bindActions } from "./scheduler-service.js";
import type { SchedulerActions } from "./scheduler-service.js";

/** Params of {@link createScheduler}. */
export interface CreateSchedulerParams<
  S extends AnySchema,
  Tx,
  P extends readonly AnyPolicyOf<S>[],
> {
  /** The schema from `defineSchema`. */
  readonly schema: S;
  /** The Adapter over the developer's database, e.g. `drizzleAdapter(db)`. A schema whose Plugins declare tables needs one that implements `records`. */
  readonly adapter: Adapter<Tx, GroupsOf<S>>;
  /** The Policies from `definePolicy`, names unique, and not an installed Plugin's Policy's; leave out for none. The installed Plugins' run first; without `notice`, past starts are bookable. */
  readonly policies?: P & UniqueNames<P, PolicyNamesOf<S["plugins"][number]>>;
  /** The Hooks from `defineHook`, run in this order on every write they apply to; leave out for none. */
  readonly hooks?: readonly AnyHookOf<S, NoInfer<Tx>>[];
}

/** The Actions, plain form: no Effect in sight; expected failures are values, defects reject. */
export type Scheduler<
  S extends AnySchema,
  Tx,
  P extends readonly AnyPolicyOf<S>[],
> = SchedulerActions<S, Tx, P, "plain">;

/** A typed failure becomes `error`; a defect or interruption is thrown, so the promise rejects. */
export function exitToResult<A, E>(exit: Exit.Exit<A, E>): Result<A, E> {
  if (Exit.isSuccess(exit)) {
    return { ok: true, value: exit.value };
  }

  const { cause } = exit;
  const found = Cause.findError(cause);

  if (
    Cause.hasDies(cause) ||
    Cause.hasInterrupts(cause) ||
    EffectResult.isFailure(found)
  ) {
    throw Cause.squash(cause);
  }

  return { error: found.success, ok: false };
}

/** A plain `also`: sync or async, a {@link Result} either way. SchedulerActions types its context and Result at the call site. */
type PlainAlso = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- see above.
  ctx: unknown
) => Result<unknown, ErasedError> | Promise<Result<unknown, ErasedError>>;

/** `params` with a plain `also` swapped for its Effect form, typed as they came: the Action's own type, not this swap, owns the params'. A throw or rejection inside `also` becomes a defect. */
function effectParams<P>(params: P): P {
  // Plain-JS callers may pass anything as params.
  if (!Predicate.hasProperty(params, "also")) {
    return params;
  }

  // SAFETY: a write Action's `also` is a PlainAlso in the plain form, by WriteAction's type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  const also = params.also as PlainAlso;

  return {
    ...params,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- as in PlainAlso.
    also: (ctx: unknown) =>
      Effect.flatMap(
        Effect.promise(async () => await also(ctx)),
        (result) =>
          result.ok ? Effect.succeed(result.value) : Effect.fail(result.error)
      ),
  };
}

/** `action` in plain form: runs its Effect, with a plain `also` swapped in, and maps the Exit. */
function plain<P, A, E>(
  action: (params: P) => Effect.Effect<A, E>
): (params: P) => Promise<Result<A, E>> {
  return async (params) =>
    exitToResult(await Effect.runPromiseExit(action(effectParams(params))));
}

/**
 * The scheduler over the developer's schema and Adapter, plain form.
 *
 * @example
 * ```ts
 * const scheduler = createScheduler({ schema, adapter: drizzleAdapter(db) });
 * const result = await scheduler.book({ resourceId, start, end });
 * ```
 */
export function createScheduler<
  S extends AnySchema,
  Tx,
  const P extends readonly AnyPolicyOf<S>[] = readonly [],
>(params: CreateSchedulerParams<S, Tx, P>): Scheduler<S, Tx, P> {
  const { base, plugins } = bindActions<S, Tx, P>(params);

  const actions = {
    book: plain(base.book),
    cancel: plain(base.cancel),
    findSlots: plain(base.findSlots),
    reschedule: plain(base.reschedule),
    transition: plain(base.transition),
    ...Object.fromEntries(
      Object.entries(plugins).map(([name, group]) => [
        name,
        Object.fromEntries(
          // A plain `also` runs as an Effect that needs no services.
          Object.entries(group).map(([action, run]) => [
            action,
            plain(run<never>),
          ])
        ),
      ])
    ),
  };

  // SAFETY: SchedulerActions<S, Tx, P, "plain"> is the "effect" form, which makeScheduler returns, with each Run mapped by `plain`.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- an overloaded interface can't be implemented by a single-signature arrow.
  return actions as unknown as Scheduler<S, Tx, P>;
}
