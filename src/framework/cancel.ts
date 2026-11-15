import { Effect } from "effect";

import type { BookingChanges } from "../adapter/records.js";
import type { BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { Booking } from "./booking.js";
import type { AdapterError, BookingNotFound } from "./errors.js";
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

/** An outside write moved or changed the row between read and write: start over. Never leaves `cancel`. */
interface Retry {
  readonly _tag: "Retry";
}

const retry: Retry = { _tag: "Retry" };

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

  const once = Effect.gen(function* cancelOnce() {
    // Unlocked, only to learn which Resource to lock.
    const seen = yield* ctx.adapter.getBooking(id);

    if (seen === null) {
      return yield* Effect.fail(notFound);
    }

    return yield* ctx.adapter.withResourceLock(seen.resourceId, (locked) =>
      Effect.gen(function* cancelUnit() {
        const booking = yield* locked.getBooking(id);

        if (booking === null) {
          return yield* Effect.fail(notFound);
        }

        if (booking.resourceId !== seen.resourceId) {
          return yield* Effect.fail(retry);
        }

        if (booking.status === "cancelled") {
          return { alreadyCancelled: true, booking };
        }

        const updated = yield* locked.updateBooking({
          changes,
          expected: booking,
        });

        // Only `changed` can fail it: a cancelled Booking blocks nothing, so no `conflict`.
        if (!updated.ok) {
          return yield* Effect.fail(retry);
        }

        return {
          alreadyCancelled: false,
          booking: { ...booking, ...changes },
        };
      })
    );
  });

  // shortcut: Retry is unbounded; cap it if outside writers ever churn a row.
  return Effect.catchTag(once, "Retry", () => cancel(ctx, params));
}
