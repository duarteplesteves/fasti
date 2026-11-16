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
import { createBlock, listBlocks } from "./blocks.js";
import type { BlockActions } from "./blocks.js";
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

/** What every Action runs with. */
export interface ActionContext<S extends AnySchema> {
  readonly schema: S;
  readonly codec: StatusCodec<StatusOf<S>>;
  readonly adapter: EffectAdapter<S>;
}

/** The Actions every scheduler has. */
export interface BaseActions<S extends AnySchema> {
  /** Store a new Booking. */
  readonly book: (
    params: BookParams<S>
  ) => Effect.Effect<Booking<S>, BookError>;
  /** Cancel a Booking, freeing its slot. Idempotent. */
  readonly cancel: (
    params: CancelParams
  ) => Effect.Effect<CancelValue<S>, CancelError>;
  /** Free slots on a Resource in a range, zoned in the caller's timezone. */
  readonly findSlots: (
    params: FindSlotsParams<S>
  ) => Effect.Effect<readonly Slot<S>[], FindSlotsError>;
  /** A Resource's Availability Rules. */
  readonly availability: {
    /** Replace the Resource's whole rule set under its Resource Lock. */
    readonly set: (
      params: SetAvailabilityParams<S>
    ) => Effect.Effect<SetAvailabilityValue, SetAvailabilityError>;
    /** Read the Resource's rules; `[]` when it has none. */
    readonly get: (
      params: GetAvailabilityParams<S>
    ) => Effect.Effect<readonly RuleRecord[], GetAvailabilityError>;
  };
}

/** The Actions, Effect form: each written once, shared by both forms (ADR 010). `blocks` only when the schema declares `block`. */
export type SchedulerService<S extends AnySchema> = BaseActions<S> &
  (HasBlocks<S> extends true ? { readonly blocks: BlockActions<S> } : unknown);

/** Bind the Actions to a schema and an Adapter. */
export function makeScheduler<S extends AnySchema, Tx>({
  adapter,
  schema,
}: CreateSchedulerParams<S, Tx>): SchedulerService<S> {
  const ctx: ActionContext<S> = {
    adapter: liftAdapter(adapter(schema), schema),
    codec: statusCodec(schema),
    schema,
  };

  const blocks: BlockActions<S> = {
    create: (params) => createBlock(ctx, params),
    list: (params) => listBlocks(ctx, params),
  };

  const base: BaseActions<S> = {
    availability: {
      get: (params) => getAvailability(ctx, params),
      set: (params) => setAvailability(ctx, params),
    },
    book: (params) => book(ctx, params),
    cancel: (params) => cancel(ctx, params),
    findSlots: (params) => findSlots(ctx, params),
  };

  return schema.block === null ? base : { ...base, blocks };
}
