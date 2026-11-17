import { Cause, Effect, Exit, Result as EffectResult } from "effect";

import type { Adapter, GroupsOf } from "../adapter/contract.js";
import type { Result } from "../core/result.js";
import type { AnySchema } from "../schema/define-schema.js";
import { makeScheduler } from "./scheduler-service.js";
import type { SchedulerActions } from "./scheduler-service.js";

/** Params of {@link createScheduler}. */
export interface CreateSchedulerParams<S extends AnySchema, Tx> {
  /** The schema from `defineSchema`. */
  readonly schema: S;
  /** The Adapter over the developer's database, e.g. `drizzleAdapter(db)`. A schema with `block` needs one that implements Blocks. */
  readonly adapter: Adapter<Tx, GroupsOf<S>>;
}

/** The Actions, plain form: no Effect in sight; expected failures are values, defects reject. */
export type Scheduler<S extends AnySchema, Tx> = SchedulerActions<
  S,
  Tx,
  "plain"
>;

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
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SchedulerActions types the params at the call site.
type AnyAction = (params: unknown) => Effect.Effect<unknown, unknown>;

/** The plain form as {@link toPlain} builds it, before it's typed as a {@link Scheduler}. */
interface PlainTree {
  readonly [name: string]:
    | PlainTree
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- as in AnyAction.
    | ((params: unknown) => Promise<Result<unknown, unknown>>);
}

/** Wrap every Action in `service`, recursing into groups, to run its Effect and map the Exit. */
// oxlint-disable-next-line anti-slop/no-object-parameters -- our own service tree, typed by SchedulerActions at createScheduler.
function toPlain(service: object): PlainTree {
  const entries = Object.entries(service).map(
    ([name, member]: [string, unknown]) => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- our own service tree: a member is an Action or a group.
      if (typeof member !== "function") {
        // SAFETY: a non-function member of a service is a group of Actions.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
        return [name, toPlain(member as object)] as const;
      }

      // SAFETY: a function member of a service is an Action.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
      const action = member as AnyAction;

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- as in AnyAction.
      async function plain(params: unknown) {
        return exitToResult(await Effect.runPromiseExit(action(params)));
      }

      return [name, plain] as const;
    }
  );

  return Object.fromEntries<PlainTree[string]>(entries);
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
): Scheduler<S, Tx> {
  // SAFETY: SchedulerActions<S, Tx, "plain"> is the "effect" form with each Run mapped as this walk does.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the walk can't carry the form parameter.
  return toPlain(makeScheduler(params)) as Scheduler<S, Tx>;
}
