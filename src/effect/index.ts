import { Context, Layer } from "effect";

import type { Adapter } from "../adapter/contract.js";
import type { CreateSchedulerParams } from "../framework/create-scheduler.js";
import type { AnyPolicyOf } from "../framework/policy.js";
import { makeScheduler } from "../framework/scheduler-service.js";
import type { SchedulerService } from "../framework/scheduler-service.js";
import type { AnySchema } from "../schema/define-schema.js";

export type { SchedulerService } from "../framework/scheduler-service.js";

/** An Adapter's transaction handle, to name the `Tx` of {@link Scheduler}: `TxOf<typeof adapter>`. */
export type TxOf<A> = A extends Adapter<infer Tx, infer _G> ? Tx : never;

/** The class {@link Scheduler} returns: a service tag with a static `layer`. */
export type SchedulerClass<
  Self,
  Id extends string,
  S extends AnySchema,
  Tx,
  P extends readonly AnyPolicyOf<S>[],
> = Context.ServiceClass<Self, Id, SchedulerService<S, Tx, P>> & {
  /** Provide the Actions over `schema`, `adapter` and `policies`. */
  readonly layer: (
    params: CreateSchedulerParams<S, Tx, P>
  ) => Layer.Layer<Self>;
};

/**
 * Declare the scheduler as an Effect service. The class you write is the tag; its static
 * `layer` binds the Actions to a schema, an Adapter whose transaction handle is `Tx`
 * (the `tx` an `also` gets; name it with {@link TxOf}), and the Policies tuple `P`.
 *
 * Interrupting the fiber doesn't cancel a unit of work already running in the Adapter: it
 * finishes, then commits or rolls back on its own outcome.
 *
 * @example
 * ```ts
 * const adapter = drizzleAdapter(db);
 * const policies = [maxFourPerDay] as const;
 * class AppScheduler extends Scheduler<AppScheduler, typeof schema, TxOf<typeof adapter>, typeof policies>()("app/Scheduler") {}
 * const live = AppScheduler.layer({ schema, adapter, policies });
 * ```
 */
export function Scheduler<
  Self,
  S extends AnySchema,
  Tx,
  P extends readonly AnyPolicyOf<S>[],
>(): <const Id extends string>(id: Id) => SchedulerClass<Self, Id, S, Tx, P> {
  return (id) => {
    const Tag = Context.Service<Self, SchedulerService<S, Tx, P>>()(id);

    return class extends Tag {
      /** Provide the Actions over `schema` and `adapter`. */
      // Not `this`, so a detached `const { layer } = AppScheduler` still works.
      static layer(params: CreateSchedulerParams<S, Tx, P>): Layer.Layer<Self> {
        return Layer.succeed(Tag, makeScheduler(params));
      }
    };
  };
}
