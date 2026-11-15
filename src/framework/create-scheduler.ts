import { Cause, Effect, Exit, Result as EffectResult } from "effect";

import type { Adapter } from "../adapter/contract.js";
import type { Result } from "../core/result.js";
import type { AnySchema } from "../schema/define-schema.js";
import { makeScheduler } from "./scheduler-service.js";
import type { SchedulerService } from "./scheduler-service.js";

/** Params of {@link createScheduler}. */
export interface CreateSchedulerParams<S extends AnySchema, Tx> {
  /** The schema from `defineSchema`. */
  readonly schema: S;
  /** The Adapter over the developer's database, e.g. `drizzleAdapter(db)`. */
  readonly adapter: Adapter<Tx>;
}

/** The plain form of an Effect service: each Action resolves to a {@link Result}; nested groups map too. */
export type Plain<T> = {
  readonly [K in keyof T]: T[K] extends (
    params: infer P
  ) => Effect.Effect<infer A, infer E>
    ? (params: P) => Promise<Result<A, E>>
    : Plain<T[K]>;
};

/** The Actions, plain form: no Effect in sight; expected failures are values, defects reject. */
export type Scheduler<S extends AnySchema> = Plain<SchedulerService<S>>;

/** A typed failure becomes `error`; a defect or interruption is thrown, so the promise rejects. */
function exitToResult<A, E>(exit: Exit.Exit<A, E>): Result<A, E> {
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

/** An Action in the walk below; its params pass through untouched, so they stay `unknown` here. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Plain<T> types the params at the call site.
type AnyAction = (params: unknown) => Effect.Effect<unknown, unknown>;

/** Wrap every Action in `service`, recursing into groups, to run its Effect and map the Exit. */
function toPlain<T extends object>(service: T): Plain<T> {
  const entries = Object.entries(service).map(
    ([name, member]: [string, unknown]) => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- our own service tree: a member is an Action or a group.
      if (typeof member !== "function") {
        // SAFETY: a non-function member of a service is a group of Actions.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
        return [name, toPlain(member as object)];
      }

      // SAFETY: a function member of a service is an Action.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
      const action = member as AnyAction;

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- as in AnyAction.
      async function plain(params: unknown) {
        return exitToResult(await Effect.runPromiseExit(action(params)));
      }

      return [name, plain];
    }
  );

  // SAFETY: Plain<T> mirrors exactly this walk.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fromEntries can't keep a mapped type.
  return Object.fromEntries(entries) as Plain<T>;
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
export function createScheduler<S extends AnySchema, Tx>(
  params: CreateSchedulerParams<S, Tx>
): Scheduler<S> {
  return toPlain(makeScheduler(params));
}
