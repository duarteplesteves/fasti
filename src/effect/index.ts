import { Context, Layer } from "effect";

import type { Adapter } from "../adapter/contract.js";
import type { CreateSchedulerParams } from "../framework/create-scheduler.js";
import type { AnyPolicyOf, UniqueNames } from "../framework/policy.js";
import { makeScheduler } from "../framework/scheduler-service.js";
import type { SchedulerService } from "../framework/scheduler-service.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { PolicyNamesOf } from "../schema/table.js";

export type { SchedulerService } from "../framework/scheduler-service.js";

export { definePlugin } from "../framework/plugin.js";

export type {
  Lock,
  RecordChanges,
  NativeActions,
  NativeRead,
  NativeWrite,
  RecordReadsOf,
  RecordStoreOf,
  TableReads,
  TableWrites,
  Unit,
  Written,
} from "../framework/plugin.js";

export type { Outcome } from "../framework/write-unit.js";

export type {
  Plugin,
  PluginResourceId,
  RecordId,
  RecordOf,
  TableDef,
  Tables,
} from "../schema/table.js";

/** An Adapter's transaction handle, to name the `Tx` of {@link Scheduler}: `TxOf<typeof adapter>`. */
export type TxOf<A> = A extends Adapter<infer Tx, infer _G> ? Tx : never;

/** Params of a {@link SchedulerClass}'s `layer`: `policies` can be left out only when the class declares none, since `P` is fixed by then. */
export type LayerParams<
  S extends AnySchema,
  Tx,
  P extends readonly AnyPolicyOf<S>[],
> = [P] extends [readonly []]
  ? CreateSchedulerParams<S, Tx, P>
  : CreateSchedulerParams<S, Tx, P> & {
      readonly policies: P &
        UniqueNames<P, PolicyNamesOf<S["plugins"][number]>>;
    };

/** The class {@link Scheduler} returns: a service tag with a static `layer`. */
export type SchedulerClass<
  Self,
  Id extends string,
  S extends AnySchema,
  Tx,
  P extends readonly AnyPolicyOf<S>[],
> = Context.ServiceClass<Self, Id, SchedulerService<S, Tx, P>> & {
  /** Provide the Actions over `schema`, `adapter` and `policies`. */
  readonly layer: (params: LayerParams<S, Tx, P>) => Layer.Layer<Self>;
};

/**
 * Declare the scheduler as an Effect service. The class you write is the tag; its static
 * `layer` binds the Actions to a schema, an Adapter whose transaction handle is `Tx`
 * (the `tx` an `also` gets; name it with {@link TxOf}), and the Policies tuple `P`.
 *
 * Interrupting the fiber doesn't cancel a unit of work already running in the Adapter: it
 * finishes, then commits or rolls back on its own outcome.
 *
 * @returns A function taking the service id, which returns the class to extend.
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
  P extends readonly AnyPolicyOf<S>[] = readonly [],
>(): <const Id extends string>(id: Id) => SchedulerClass<Self, Id, S, Tx, P> {
  return (id) => {
    const Tag = Context.Service<Self, SchedulerService<S, Tx, P>>()(id);

    return class extends Tag {
      /**
       * Provide the Actions over `schema` and `adapter`.
       *
       * @returns A Layer providing the scheduler service.
       */
      // Not `this`, so a detached `const { layer } = AppScheduler` still works.
      static layer(params: LayerParams<S, Tx, P>): Layer.Layer<Self> {
        return Layer.succeed(Tag, makeScheduler(params));
      }
    };
  };
}
