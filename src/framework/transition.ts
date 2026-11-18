import { Effect } from "effect";

import type { BookingChanges, StatusOf } from "../adapter/records.js";
import type { InvalidParams } from "../core/result.js";
import type { BookingId } from "../core/types.js";
import type { AnySchema, TransitionEdge } from "../schema/define-schema.js";
import { fieldPatch } from "./booking.js";
import type { Booking, ChangeAlso, FieldsPatch } from "./booking.js";
import type {
  AdapterError,
  BookingNotFound,
  SlotConflict,
  StatusMismatch,
} from "./errors.js";
import { lockedById, retry } from "./lock-by-id.js";
import type { Retry } from "./lock-by-id.js";
import { checkOverlap, conflictsAt } from "./occupancy.js";
import type { ActionContext } from "./scheduler-service.js";
import type {
  AlsoContext,
  AlsoParam,
  Outcome,
  WriteEffect,
} from "./write-unit.js";

/** Params of `transition`: a declared `from → to` (never into `cancelled`), and a partial `fields` patch. */
export type TransitionParams<S extends AnySchema> = {
  /** The Booking to move. */
  readonly id: BookingId;
} & TransitionEdge<S> &
  FieldsPatch<S["booking"]["fields"]>;

/** Every way `transition` can fail. */
export type TransitionError<S extends AnySchema> =
  | InvalidParams
  | BookingNotFound
  | StatusMismatch<StatusOf<S>>
  | SlotConflict
  | AdapterError;

/**
 * Move a Booking from `from` to `to` along a declared Transition, compare-and-set on `from` (ADR 009).
 * Into a blocking Status from a non-blocking one, it re-checks overlap; it never checks availability.
 */
export function transition<S extends AnySchema, Tx, R = never>(
  ctx: ActionContext<S, Tx>,
  params: TransitionParams<S> & AlsoParam<AlsoContext<ChangeAlso<S, Tx>>, Tx, R>
): WriteEffect<Booking<S>, TransitionError<S>, R> {
  const { id } = params;

  // SAFETY: TransitionEdge<S> has `from` and `to` Statuses; a plain-JS caller may pass anything, which canMove refuses next.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the mapped union can't be read inside a generic.
  const { from, to } = params as {
    readonly from: StatusOf<S>;
    readonly to: StatusOf<S>;
  };

  // Before any Adapter call (Invariant 5). Also refuses every call on a schema with no edge.
  if (to === "cancelled" || !ctx.codec.canMove(from, to)) {
    return Effect.fail<InvalidParams>({
      _tag: "InvalidParams",
      issues: [
        {
          message: `${from} → ${to} isn't a declared Transition (use cancel for cancelled)`,
          path: ["to"],
        },
      ],
    });
  }

  // SAFETY: the patch holds declared field names only, plus a declared Status.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema's field names are only known at runtime.
  const changes = {
    ...fieldPatch<S["booking"]["fields"]>(ctx.schema.booking.fields, params),
    status: to,
  } as BookingChanges<S>;

  return lockedById(ctx, {
    also: params.also,
    destination: null,
    notFound: { _tag: "BookingNotFound", id } satisfies BookingNotFound,
    read: (reads) => reads.getBooking(id),
    work: (locked, stored) =>
      Effect.gen(function* transitionUnit(): Effect.fn.Return<
        Outcome<Booking<S>, AlsoContext<ChangeAlso<S, Tx>>>,
        StatusMismatch<StatusOf<S>> | SlotConflict | AdapterError | Retry
      > {
        if (stored.status !== from) {
          return yield* Effect.fail<StatusMismatch<StatusOf<S>>>({
            _tag: "StatusMismatch",
            id,
            status: stored.status,
          });
        }

        const range = {
          end: stored.end,
          excludeBookingId: id,
          kind: "booking",
          resourceId: stored.resourceId,
          start: stored.start,
        } as const;

        // A blocking Booking already holds its slot; only one coming back from a non-blocking Status must re-check it.
        if (!ctx.codec.isBlocking(from) && ctx.codec.isBlocking(to)) {
          yield* checkOverlap(locked, ctx.codec, range);
        }

        const updated = yield* locked.updateBooking({
          changes,
          expected: stored,
        });

        // On `conflict`, the backstop caught an outside write the lock can't see: report what is there now.
        if (!updated.ok) {
          return yield* updated.reason === "changed"
            ? Effect.fail(retry)
            : Effect.fail<SlotConflict>({
                _tag: "SlotConflict",
                conflicts: yield* conflictsAt(locked, ctx.codec, range),
              });
        }

        const booking = { ...stored, ...changes };

        return {
          _tag: "Done",
          context: { booking, previous: stored },
          value: booking,
        };
      }),
  });
}
