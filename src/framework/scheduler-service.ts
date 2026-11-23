import type { StatusOf } from "../adapter/records.js";
import type { AnySchema, TransitionEdge } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";
import { statusCodec } from "../schema/status-codec.js";
import type { PoliciesOf } from "../schema/table.js";
import { book } from "./book.js";
import type { BookAlso, BookError, BookParams } from "./book.js";
import type { Booking, ChangeAlso } from "./booking.js";
import { cancel } from "./cancel.js";
import type { CancelError, CancelParams, CancelValue } from "./cancel.js";
import type { CreateSchedulerParams } from "./create-scheduler.js";
import { liftAdapter } from "./effect-adapter.js";
import type { EffectAdapter } from "./effect-adapter.js";
import { findSlots } from "./find-slots.js";
import type { FindSlotsAction, FindSlotsParams } from "./find-slots.js";
import type { Form, PolicedWriteAction, WriteAction } from "./forms.js";
import type { AnyHookOf } from "./hook.js";
import type { BusySource } from "./occupancy.js";
import {
  pluginActions,
  pluginBusy,
  pluginHooks,
  pluginPolicies,
} from "./plugin.js";
import type { PluginActionsOf } from "./plugin.js";
import { appPolicy } from "./policy-pass.js";
import type { RunnablePolicy } from "./policy-pass.js";
import type { AnyPolicyOf, ViolationFor } from "./policy.js";
import { reschedule } from "./reschedule.js";
import type { RescheduleError, RescheduleParams } from "./reschedule.js";
import { transition } from "./transition.js";
import type { TransitionAction, TransitionParams } from "./transition.js";
import { appHook } from "./write-unit.js";
import type { RunnableHook } from "./write-unit.js";

/** What every Action runs with. */
export interface ActionContext<S extends AnySchema, Tx> {
  readonly schema: S;
  readonly codec: StatusCodec<StatusOf<S>>;
  readonly adapter: EffectAdapter<S, Tx>;
  /** The Plugins' Policies, in install order: run before the developer's. */
  readonly pluginPolicies: readonly RunnablePolicy<S>[];
  /** The developer's Policies; every name unique across these and `pluginPolicies`. */
  readonly policies: readonly RunnablePolicy<S>[];
  /** What a Booking can't overlap, beside other Bookings: the Plugins' busy time. */
  readonly busy: readonly BusySource[];
  /** The Plugins' Hooks in install order, then the developer's: what `writeUnit` runs. */
  readonly hooks: readonly RunnableHook<S, Tx>[];
}

/** The installed Plugins' Policies, as written: a union. */
type PluginPolicy<S extends AnySchema> = PoliciesOf<S["plugins"][number]>;

/**
 * Every Action, in form `F`: each declared once for both forms, so they can't drift (ADR 010).
 * `scheduler.<plugin>` for each installed Plugin; `transition` only when some declared Transition doesn't end in `cancelled`. `Tx` is the Adapter's transaction handle, as `also` gets it; `P` the Policies tuple.
 */
export type SchedulerActions<
  S extends AnySchema,
  Tx,
  P extends readonly AnyPolicyOf<S>[],
  F extends Form,
> = {
  /** Store a new Booking. */
  readonly book: PolicedWriteAction<
    F,
    BookParams<S>,
    BookAlso<S, Tx>,
    Booking<S>,
    BookError<S>,
    ViolationFor<P[number] | PluginPolicy<S>, "book">
  >;
  /** Move a Booking in time or to another Resource, keeping its id and Status. */
  readonly reschedule: PolicedWriteAction<
    F,
    RescheduleParams<S>,
    ChangeAlso<S, Tx>,
    Booking<S>,
    RescheduleError<S>,
    ViolationFor<P[number] | PluginPolicy<S>, "reschedule">
  >;
  /** Cancel a Booking, freeing its slot. Idempotent. */
  readonly cancel: WriteAction<
    F,
    CancelParams<S>,
    ChangeAlso<S, Tx>,
    CancelValue<S>,
    CancelError<S>,
    ViolationFor<P[number] | PluginPolicy<S>, "cancel">
  >;
  /** Free slots on a Resource in a range, zoned in the caller's timezone. */
  readonly findSlots: FindSlotsAction<
    F,
    S,
    ViolationFor<P[number] | PluginPolicy<S>, "book">,
    ViolationFor<P[number] | PluginPolicy<S>, "reschedule">
  >;
} & PluginActionsOf<S, Tx, F> &
  ([TransitionEdge<S>] extends [never]
    ? unknown
    : {
        /** Move a Booking along a declared Transition, compare-and-set on `from`. */
        readonly transition: TransitionAction<F, S, Tx, P[number]>;
      });

/** The Actions, Effect form, over an Adapter whose transaction handle is `Tx`, with Policies `P`. */
export type SchedulerService<
  S extends AnySchema,
  Tx,
  P extends readonly AnyPolicyOf<S>[],
> = SchedulerActions<S, Tx, P, "effect">;

/**
 * The Actions bound to a schema, an Adapter and Policies, Effect form, before either form types them: the built-ins in `base`, each installed Plugin's in `plugins` by name.
 * Throws on duplicate Policy names, across the Plugins' and the app's.
 */
export function bindActions<
  S extends AnySchema,
  Tx,
  P extends readonly AnyPolicyOf<S>[],
>(registered: CreateSchedulerParams<S, Tx, P>) {
  const { adapter, schema } = registered;
  // Widened from the caller's P: only the types need the tuple.
  const policies: readonly AnyPolicyOf<S>[] = registered.policies ?? [];
  const hooks: readonly AnyHookOf<S, Tx>[] = registered.hooks ?? [];

  const first = pluginPolicies<S>(schema.plugins);

  const names = [...first, ...policies].map((p) => p.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);

  // Plain-JS callers can get past UniqueNames and InstallablePlugins.
  if (duplicate !== undefined) {
    throw new Error(`fasti: two Policies are named ${duplicate}`);
  }

  const lifted = liftAdapter(adapter(schema));

  const ctx: ActionContext<S, Tx> = {
    adapter: lifted,
    codec: statusCodec(schema),
    busy: pluginBusy(schema.plugins),
    hooks: [
      ...pluginHooks<S, Tx>(schema.plugins, lifted),
      ...hooks.map(appHook),
    ],
    pluginPolicies: first,
    policies: policies.map(appPolicy),
    schema,
  };

  const base = {
    book: (params: BookParams<S>) => book(ctx, params),
    cancel: (params: CancelParams<S>) => cancel(ctx, params),
    findSlots: (params: FindSlotsParams<S>) => findSlots(ctx, params),
    // Always bound: on a schema with no edge, every call is InvalidParams before any Adapter call.
    transition: (params: TransitionParams<S>) => transition(ctx, params),
    reschedule: (params: RescheduleParams<S>) => reschedule(ctx, params),
  };

  return { base, plugins: pluginActions(ctx) };
}

/** Bind the Actions to a schema, an Adapter and Policies, Effect form. Throws on duplicate Policy names, across the Plugins' and the app's. */
export function makeScheduler<
  S extends AnySchema,
  Tx,
  const P extends readonly AnyPolicyOf<S>[],
>(
  registered: CreateSchedulerParams<S, Tx, P>
): SchedulerActions<S, Tx, P, "effect"> {
  const { base, plugins } = bindActions<S, Tx, P>(registered);

  // Plugin names never take a scheduler key (defineSchema checks), so nothing here is overwritten.
  // SAFETY: each Action takes an optional Effect-form `also` and merges its value as WithAlso describes.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- an overloaded interface can't be implemented by a single-signature arrow.
  return { ...base, ...plugins } as unknown as SchedulerActions<
    S,
    Tx,
    P,
    "effect"
  >;
}
