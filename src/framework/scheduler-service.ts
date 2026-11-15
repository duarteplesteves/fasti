import type { Effect } from "effect";

import type { StatusOf } from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";
import { statusCodec } from "../schema/status-codec.js";
import { book } from "./book.js";
import type { BookError, BookParams } from "./book.js";
import type { Booking } from "./booking.js";
import type { CreateSchedulerParams } from "./create-scheduler.js";
import { liftAdapter } from "./effect-adapter.js";
import type { EffectAdapter } from "./effect-adapter.js";

/** What every Action runs with. */
export interface ActionContext<S extends AnySchema> {
  readonly schema: S;
  readonly codec: StatusCodec<StatusOf<S>>;
  readonly adapter: EffectAdapter<S>;
}

/** The Actions, Effect form: each written once, shared by both forms (ADR 010). */
export interface SchedulerService<S extends AnySchema> {
  /** Store a new Booking. */
  readonly book: (
    params: BookParams<S>
  ) => Effect.Effect<Booking<S>, BookError>;
}

/** Bind the Actions to a schema and an Adapter. */
export function makeScheduler<S extends AnySchema, Tx>({
  adapter,
  schema,
}: CreateSchedulerParams<S, Tx>): SchedulerService<S> {
  const ctx: ActionContext<S> = {
    adapter: liftAdapter(adapter(schema)),
    codec: statusCodec(schema),
    schema,
  };

  return { book: (params) => book(ctx, params) };
}
