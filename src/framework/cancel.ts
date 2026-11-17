import { Effect } from "effect";

import type { BookingChanges } from "../adapter/records.js";
import type { BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { Booking, ChangeAlso } from "./booking.js";
import type { AdapterError, BookingNotFound } from "./errors.js";
import { lockedById, retry } from "./lock-by-id.js";
import type { Retry } from "./lock-by-id.js";
import type { ActionContext } from "./scheduler-service.js";
import type {
  AlsoContext,
  AlsoParam,
  Outcome,
  WriteEffect,
} from "./write-unit.js";

/** Params of `cancel`. */
export interface CancelParams {
  /** The Booking to cancel. */
  readonly id: BookingId;
}

/** What `cancel` returns: the Booking, now `cancelled`. `alreadyCancelled: true` means nothing was written, so `also` didn't run. */
export type CancelValue<S extends AnySchema> =
  | { readonly booking: Booking<S>; readonly alreadyCancelled: true }
  | { readonly booking: Booking<S>; readonly alreadyCancelled: false };

/** Every way `cancel` can fail. */
export type CancelError = BookingNotFound | AdapterError;

/** Set a Booking's status to `cancelled` under its Resource's lock. Idempotent: a repeat writes nothing. */
export function cancel<S extends AnySchema, Tx, R = never>(
  ctx: ActionContext<S, Tx>,
  params: CancelParams & AlsoParam<AlsoContext<ChangeAlso<S, Tx>>, Tx, R>
): WriteEffect<CancelValue<S>, CancelError, R> {
  const { id } = params;
  const notFound: BookingNotFound = { _tag: "BookingNotFound", id };
  // SAFETY: every schema's statuses include `cancelled`; TS can't resolve BookingChanges through a generic S.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  const changes = { status: "cancelled" } as BookingChanges<S>;

  return lockedById(ctx, {
    also: params.also,
    notFound,
    read: (reads) => reads.getBooking(id),
    work: (locked, booking) =>
      Effect.gen(function* cancelUnit(): Effect.fn.Return<
        Outcome<CancelValue<S>, AlsoContext<ChangeAlso<S, Tx>>>,
        AdapterError | Retry
      > {
        if (booking.status === "cancelled") {
          return {
            _tag: "NoOp",
            value: { alreadyCancelled: true, booking },
          };
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

        const cancelled = { ...booking, ...changes };

        return {
          _tag: "Done",
          context: { booking: cancelled, previous: booking },
          value: { alreadyCancelled: false, booking: cancelled },
        };
      }),
  });
}
