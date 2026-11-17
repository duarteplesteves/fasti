import type { Effect } from "effect";

import type { RuleRecord, StatusOf } from "../adapter/records.js";
import type { AnySchema, HasBlocks } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";
import { statusCodec } from "../schema/status-codec.js";
import { getAvailability, setAvailability } from "./availability.js";
import type {
  GetAvailabilityError,
  GetAvailabilityParams,
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
import type { BookError, BookParams } from "./book.js";
import type { Booking } from "./booking.js";
import { cancel } from "./cancel.js";
import type { CancelError, CancelParams, CancelValue } from "./cancel.js";
import type { CreateSchedulerParams } from "./create-scheduler.js";
import { liftAdapter } from "./effect-adapter.js";
import type { EffectAdapter } from "./effect-adapter.js";
import { findSlots } from "./find-slots.js";
import type { FindSlotsError, FindSlotsParams, Slot } from "./find-slots.js";
import type { Form, ReadAction, WriteAction } from "./forms.js";

/** What every Action runs with. */
export interface ActionContext<S extends AnySchema, Tx> {
  readonly schema: S;
  readonly codec: StatusCodec<StatusOf<S>>;
  readonly adapter: EffectAdapter<S, Tx>;
}

/**
 * Every Action, in form `F`: each declared once for both forms, so they can't drift (ADR 010).
 * `blocks` only when the schema declares `block`. `_Tx` is the Adapter's transaction handle; unused until `also` contexts carry it.
 */
export type SchedulerActions<S extends AnySchema, _Tx, F extends Form> = {
  /** Store a new Booking. */
  readonly book: WriteAction<F, BookParams<S>, never, Booking<S>, BookError>;
  /** Cancel a Booking, freeing its slot. Idempotent. */
  readonly cancel: WriteAction<
    F,
    CancelParams,
    never,
    CancelValue<S>,
    CancelError
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
      never,
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
  ? { readonly blocks: BlockActions<S, F> }
  : unknown);

/** The Actions, Effect form. The Effect form doesn't name `Tx` yet, so it's `unknown` here. */
export type SchedulerService<S extends AnySchema> = SchedulerActions<
  S,
  unknown,
  "effect"
>;

/** Each Action, as written: a single Effect signature, before it's fitted to the overloaded {@link WriteAction}. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- params are typed by SchedulerActions at the call site.
type Bound = (params: never) => Effect.Effect<unknown, unknown>;

/** Bind the Actions to a schema and an Adapter. */
export function makeScheduler<S extends AnySchema, Tx>({
  adapter,
  schema,
}: CreateSchedulerParams<S, Tx>): SchedulerActions<S, Tx, "effect"> {
  const ctx: ActionContext<S, Tx> = {
    adapter: liftAdapter(adapter(schema), schema),
    codec: statusCodec(schema),
    schema,
  };

  const blocks = {
    create: (params: CreateBlockParams<S>) => createBlock(ctx, params),
    delete: (params: DeleteBlockParams) => deleteBlock(ctx, params),
    list: (params: ListBlocksParams<S>) => listBlocks(ctx, params),
    update: (params: UpdateBlockParams<S>) => updateBlock(ctx, params),
  } satisfies Record<string, Bound>;

  const base = {
    availability: {
      get: (params: GetAvailabilityParams<S>) => getAvailability(ctx, params),
      set: (params: SetAvailabilityParams<S>) => setAvailability(ctx, params),
    },
    book: (params: BookParams<S>) => book(ctx, params),
    cancel: (params: CancelParams) => cancel(ctx, params),
    findSlots: (params: FindSlotsParams<S>) => findSlots(ctx, params),
  };

  // SAFETY: each Action implements its WriteAction's plain overload; the `also` overload is unreachable until `also` lands (its param is never).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an overloaded interface can't be implemented by a single-signature arrow.
  return (
    schema.block === null ? base : { ...base, blocks }
  ) as SchedulerActions<S, Tx, "effect">;
}
