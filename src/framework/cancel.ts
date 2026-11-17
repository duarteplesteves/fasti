import { Effect } from "effect";

import type { BookingChanges } from "../adapter/records.js";
import type { BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { Booking } from "./booking.js";
import type { AdapterError, BookingNotFound } from "./errors.js";
import { lockedById, retry } from "./lock-by-id.js";
import type { ActionContext } from "./scheduler-service.js";

/** Params of `cancel`. */
export interface CancelParams {
  /** The Booking to cancel. */
  readonly id: BookingId;
}

/** What `cancel` returns. */
export interface CancelValue<S extends AnySchema> {
  /** The Booking, now `cancelled`. */
  readonly booking: Booking<S>;
  /** `true` when it was already cancelled, so nothing was written. */
  readonly alreadyCancelled: boolean;
}

/** Every way `cancel` can fail. */
export type CancelError = BookingNotFound | AdapterError;

/** Set a Booking's status to `cancelled` under its Resource's lock. Idempotent: a repeat writes nothing. */
export function cancel<S extends AnySchema>(
  ctx: ActionContext<S>,
  params: CancelParams
): Effect.Effect<CancelValue<S>, CancelError> {
  const { id } = params;
  const notFound: BookingNotFound = { _tag: "BookingNotFound", id };
  // SAFETY: every schema's statuses include `cancelled`; TS can't resolve BookingChanges through a generic S.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  const changes = { status: "cancelled" } as BookingChanges<S>;

  return lockedById(ctx, {
    notFound,
    read: (reads) => reads.getBooking(id),
    work: (locked, booking) =>
      Effect.gen(function* cancelUnit() {
        if (booking.status === "cancelled") {
          return { alreadyCancelled: true, booking };
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

        return {
          alreadyCancelled: false,
          booking: { ...booking, ...changes },
        };
      }),
  });
}
