import { Context, Layer } from "effect";

import type { CreateSchedulerParams } from "../framework/create-scheduler.js";
import { makeScheduler } from "../framework/scheduler-service.js";
import type { SchedulerService } from "../framework/scheduler-service.js";
import type { AnySchema } from "../schema/define-schema.js";

export type { SchedulerService } from "../framework/scheduler-service.js";

/** The class {@link Scheduler} returns: a service tag with a static `layer`. */
export type SchedulerClass<
  Self,
  Id extends string,
  S extends AnySchema,
> = Context.ServiceClass<Self, Id, SchedulerService<S>> & {
  /** Provide the Actions over `schema` and `adapter`. */
  readonly layer: <Tx>(
    params: CreateSchedulerParams<S, Tx>
  ) => Layer.Layer<Self>;
};

/**
 * Declare the scheduler as an Effect service. The class you write is the tag; its static
 * `layer` binds the Actions to a schema and an Adapter.
 *
 * Interrupting the fiber doesn't cancel a unit of work already running in the Adapter: it
 * finishes, then commits or rolls back on its own outcome.
 *
 * @example
 * ```ts
 * class AppScheduler extends Scheduler<AppScheduler, typeof schema>()("app/Scheduler") {}
 * const live = AppScheduler.layer({ schema, adapter: drizzleAdapter(db) });
 * ```
 */
export function Scheduler<Self, S extends AnySchema>(): <
  const Id extends string,
>(
  id: Id
) => SchedulerClass<Self, Id, S> {
  return (id) =>
    class extends Context.Service<Self, SchedulerService<S>>()(id) {
      /** Provide the Actions over `schema` and `adapter`. */
      static layer<Tx>(
        params: CreateSchedulerParams<S, Tx>
      ): Layer.Layer<Self> {
        return Layer.succeed(this, makeScheduler(params));
      }
    };
}
