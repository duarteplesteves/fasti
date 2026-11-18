import type { Effect } from "effect";

import type { RuleRecord, StatusOf } from "../adapter/records.js";
import type {
  AnySchema,
  HasBlocks,
  TransitionEdge,
} from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";
import { statusCodec } from "../schema/status-codec.js";
import { getAvailability, setAvailability } from "./availability.js";
import type {
  GetAvailabilityError,
  GetAvailabilityParams,
  SetAvailabilityAlso,
  SetAvailabilityError,
  SetAvailabilityParams,
  SetAvailabilityValue,
} from "./availability.js";
import { createBlock, deleteBlock, listBlocks, updateBlock } from "./blocks.js";
import type {
  BlockActions,
  CreateBlockParams,
  DeleteBlockParams,
  ListBlocksParams,
  UpdateBlockParams,
} from "./blocks.js";
import { book } from "./book.js";
import type { BookAlso, BookError, BookParams } from "./book.js";
import type { Booking, ChangeAlso } from "./booking.js";
import { cancel } from "./cancel.js";
import type { CancelError, CancelParams, CancelValue } from "./cancel.js";
import type { CreateSchedulerParams } from "./create-scheduler.js";
import { liftAdapter } from "./effect-adapter.js";
import type { EffectAdapter } from "./effect-adapter.js";
import { findSlots } from "./find-slots.js";
import type { FindSlotsError, FindSlotsParams, Slot } from "./find-slots.js";
import type { Form, ReadAction, WriteAction } from "./forms.js";
import type { AnyPolicyOf, ViolationFor } from "./policy.js";
import { reschedule } from "./reschedule.js";
import type { RescheduleError, RescheduleParams } from "./reschedule.js";
import { transition } from "./transition.js";
import type { TransitionError, TransitionParams } from "./transition.js";

/** What every Action runs with. */
export interface ActionContext<S extends AnySchema, Tx> {
  readonly schema: S;
  readonly codec: StatusCodec<StatusOf<S>>;
  readonly adapter: EffectAdapter<S, Tx>;
  /** The developer's Policies, names unique. */
  readonly policies: readonly AnyPolicyOf<S>[];
}

/**
 * Every Action, in form `F`: each declared once for both forms, so they can't drift (ADR 010).
 * `blocks` only when the schema declares `block`; `transition` only when some declared Transition doesn't end in `cancelled`. `Tx` is the Adapter's transaction handle, as `also` gets it; `P` the Policies tuple.
 */
export type SchedulerActions<
  S extends AnySchema,
  Tx,
  P extends readonly AnyPolicyOf<S>[],
  F extends Form,
> = {
  /** Store a new Booking. */
  readonly book: WriteAction<
    F,
    BookParams<S>,
    BookAlso<S, Tx>,
    Booking<S>,
    BookError,
    ViolationFor<P[number], "book">
  >;
  /** Move a Booking in time or to another Resource, keeping its id and Status. */
  readonly reschedule: WriteAction<
    F,
    RescheduleParams<S>,
    ChangeAlso<S, Tx>,
    Booking<S>,
    RescheduleError<S>,
    ViolationFor<P[number], "reschedule">
  >;
  /** Cancel a Booking, freeing its slot. Idempotent. */
  readonly cancel: WriteAction<
    F,
    CancelParams<S>,
    ChangeAlso<S, Tx>,
    CancelValue<S>,
    CancelError<S>,
    ViolationFor<P[number], "cancel">
  >;
  /** Free slots on a Resource in a range, zoned in the caller's timezone. */
  readonly findSlots: ReadAction<
    F,
    FindSlotsParams<S>,
    readonly Slot<S>[],
    FindSlotsError
  >;
  /** A Resource's Availability Rules. */
  readonly availability: {
    /** Replace the Resource's whole rule set under its Resource Lock. */
    readonly set: WriteAction<
      F,
      SetAvailabilityParams<S>,
      SetAvailabilityAlso<Tx>,
      SetAvailabilityValue,
      SetAvailabilityError
    >;
    /** Read the Resource's rules; `[]` when it has none. */
    readonly get: ReadAction<
      F,
      GetAvailabilityParams<S>,
      readonly RuleRecord[],
      GetAvailabilityError
    >;
  };
} & (HasBlocks<S> extends true
  ? { readonly blocks: BlockActions<S, Tx, F> }
  : unknown) &
  ([TransitionEdge<S>] extends [never]
    ? unknown
    : {
        /** Move a Booking along a declared Transition, compare-and-set on `from`. */
        readonly transition: WriteAction<
          F,
          TransitionParams<S>,
          ChangeAlso<S, Tx>,
          Booking<S>,
          TransitionError<S>
        >;
      });

/** The Actions, Effect form, over an Adapter whose transaction handle is `Tx`, with Policies `P`. */
export type SchedulerService<
  S extends AnySchema,
  Tx,
  P extends readonly AnyPolicyOf<S>[],
> = SchedulerActions<S, Tx, P, "effect">;

/** Each Action, as written: a single Effect signature, before it's fitted to the overloaded {@link WriteAction}. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- params are typed by SchedulerActions at the call site.
type ActionImpl = (params: never) => Effect.Effect<unknown, unknown>;

/** Bind the Actions to a schema, an Adapter and Policies. Throws on duplicate Policy names. */
export function makeScheduler<
  S extends AnySchema,
  Tx,
  const P extends readonly AnyPolicyOf<S>[],
>({
  adapter,
  policies,
  schema,
}: CreateSchedulerParams<S, Tx, P>): SchedulerActions<S, Tx, P, "effect"> {
  const names = policies.map((p) => p.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);

  // Plain-JS callers can get past UniqueNames.
  if (duplicate !== undefined) {
    throw new Error(`fasti: two Policies are named ${duplicate}`);
  }

  const ctx: ActionContext<S, Tx> = {
    adapter: liftAdapter(adapter(schema), schema),
    codec: statusCodec(schema),
    policies,
    schema,
  };

  const blocks = {
    create: (params: CreateBlockParams<S>) => createBlock(ctx, params),
    delete: (params: DeleteBlockParams) => deleteBlock(ctx, params),
    list: (params: ListBlocksParams<S>) => listBlocks(ctx, params),
    update: (params: UpdateBlockParams<S>) => updateBlock(ctx, params),
  } satisfies Record<string, ActionImpl>;

  const base = {
    availability: {
      get: (params: GetAvailabilityParams<S>) => getAvailability(ctx, params),
      set: (params: SetAvailabilityParams<S>) => setAvailability(ctx, params),
    },
    book: (params: BookParams<S>) => book(ctx, params),
    cancel: (params: CancelParams<S>) => cancel(ctx, params),
    findSlots: (params: FindSlotsParams<S>) => findSlots(ctx, params),
    // Always bound: on a schema with no edge, every call is InvalidParams before any Adapter call.
    transition: (params: TransitionParams<S>) => transition(ctx, params),
    reschedule: (params: RescheduleParams<S>) => reschedule(ctx, params),
  };

  // SAFETY: each Action takes an optional Effect-form `also` and merges its value as WithAlso describes; the plain form's is adapted in toPlain.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an overloaded interface can't be implemented by a single-signature arrow.
  return (
    schema.block === null ? base : { ...base, blocks }
  ) as SchedulerActions<S, Tx, P, "effect">;
}
