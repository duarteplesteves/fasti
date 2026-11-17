import { Context, Layer } from "effect";

import type { Adapter } from "../adapter/contract.js";
import type { CreateSchedulerParams } from "../framework/create-scheduler.js";
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
> = Context.ServiceClass<Self, Id, SchedulerService<S, Tx>> & {
  /** Provide the Actions over `schema` and `adapter`. */
  readonly layer: (params: CreateSchedulerParams<S, Tx>) => Layer.Layer<Self>;
};

/**
 * Declare the scheduler as an Effect service. The class you write is the tag; its static
 * `layer` binds the Actions to a schema and an Adapter whose transaction handle is `Tx`
 * (the `tx` an `also` gets; name it with {@link TxOf}).
 *
 * Interrupting the fiber doesn't cancel a unit of work already running in the Adapter: it
 * finishes, then commits or rolls back on its own outcome.
 *
 * @example
 * ```ts
 * const adapter = drizzleAdapter(db);
 * class AppScheduler extends Scheduler<AppScheduler, typeof schema, TxOf<typeof adapter>>()("app/Scheduler") {}
 * const live = AppScheduler.layer({ schema, adapter });
 * ```
 */
export function Scheduler<Self, S extends AnySchema, Tx>(): <
  const Id extends string,
>(
  id: Id
) => SchedulerClass<Self, Id, S, Tx> {
  return (id) => {
    const Tag = Context.Service<Self, SchedulerService<S, Tx>>()(id);

    return class extends Tag {
      /** Provide the Actions over `schema` and `adapter`. */
      // Not `this`, so a detached `const { layer } = AppScheduler` still works.
      static layer(params: CreateSchedulerParams<S, Tx>): Layer.Layer<Self> {
        return Layer.succeed(Tag, makeScheduler(params));
      }
    };
  };
}
