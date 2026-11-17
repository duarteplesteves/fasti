import { Effect } from "effect";

import type { BookingChanges, StatusOf } from "../adapter/records.js";
import type { BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import { fieldPatch } from "./booking.js";
import type { Booking, ChangeAlso, FieldsPatch } from "./booking.js";
import type {
  AdapterError,
  BookingNotFound,
  TransitionNotDeclared,
} from "./errors.js";
import { lockedById, retry } from "./lock-by-id.js";
import type { Retry } from "./lock-by-id.js";
import type { ActionContext } from "./scheduler-service.js";
import type {
  AlsoContext,
  AlsoParam,
  Outcome,
  WriteEffect,
} from "./write-unit.js";

/** Params of `cancel`: the Booking, and a partial `fields` patch written with the cancellation. */
export type CancelParams<S extends AnySchema> = {
  /** The Booking to cancel. */
  readonly id: BookingId;
} & FieldsPatch<S["booking"]["fields"]>;

/** What `cancel` returns: the Booking, now `cancelled`. `alreadyCancelled: true` means nothing was written, so `also` didn't run. */
export type CancelValue<S extends AnySchema> =
  | { readonly booking: Booking<S>; readonly alreadyCancelled: true }
  | { readonly booking: Booking<S>; readonly alreadyCancelled: false };

/** Every way `cancel` can fail. */
export type CancelError<S extends AnySchema> =
  | BookingNotFound
  | TransitionNotDeclared<StatusOf<S>>
  | AdapterError;

/** Set a Booking's status to `cancelled` under its Resource's lock, along a declared Transition. Idempotent: a repeat writes nothing. */
export function cancel<S extends AnySchema, Tx, R = never>(
  ctx: ActionContext<S, Tx>,
  params: CancelParams<S> & AlsoParam<AlsoContext<ChangeAlso<S, Tx>>, Tx, R>
): WriteEffect<CancelValue<S>, CancelError<S>, R> {
  const { id } = params;
  const notFound: BookingNotFound = { _tag: "BookingNotFound", id };

  // SAFETY: every schema's statuses include `cancelled`, and the patch holds declared field names only; TS can't resolve BookingChanges through a generic S.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  const changes = {
    ...fieldPatch<S["booking"]["fields"]>(ctx.schema.booking.fields, params),
    status: "cancelled",
  } as BookingChanges<S>;

  return lockedById(ctx, {
    also: params.also,
    destination: null,
    notFound,
    read: (reads) => reads.getBooking(id),
    work: (locked, booking) =>
      Effect.gen(function* cancelUnit(): Effect.fn.Return<
        Outcome<CancelValue<S>, AlsoContext<ChangeAlso<S, Tx>>>,
        TransitionNotDeclared<StatusOf<S>> | AdapterError | Retry
      > {
        if (booking.status === "cancelled") {
          return {
            _tag: "NoOp",
            value: { alreadyCancelled: true, booking },
          };
        }

        // SAFETY: every schema has `cancelled`.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
        const cancelled = "cancelled" as StatusOf<S>;

        if (!ctx.codec.canMove(booking.status, cancelled)) {
          return yield* Effect.fail<TransitionNotDeclared<StatusOf<S>>>({
            _tag: "TransitionNotDeclared",
            from: booking.status,
            id,
            to: cancelled,
          });
        }

        const updated = yield* locked.updateBooking({
          changes,
          expected: booking,
        });

        if (!updated.ok) {
          // A cancelled Booking blocks nothing, so `conflict` means the Adapter is broken: die, don't loop.
          return yield* updated.reason === "changed"
            ? Effect.fail(retry)
            : Effect.die(new Error("fasti: cancel got `conflict`"));
        }

        const stored = { ...booking, ...changes };

        return {
          _tag: "Done",
          context: { booking: stored, previous: booking },
          value: { alreadyCancelled: false, booking: stored },
        };
      }),
  });
}
