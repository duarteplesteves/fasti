import * as Effect from "effect/Effect";

import type {
  BookingChanges,
  ResourceIdOf,
  StatusOf,
} from "../adapter/records.js";
import { checkInstantRange } from "../core/checks.js";
import { checked } from "../core/result.js";
import type { InvalidParams } from "../core/result.js";
import type { BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import { fieldPatch, floorMs } from "./booking.js";
import type { Booking, ChangeAlso, FieldsPatch } from "./booking.js";
import type {
  AdapterError,
  BookingNotFound,
  Conflict,
  PolicyViolation,
  SlotConflict,
  StatusMismatch,
} from "./errors.js";
import { lockedById, retry } from "./lock-by-id.js";
import type { Retry } from "./lock-by-id.js";
import { checkOverlap, conflictsAt } from "./occupancy.js";
import type { ConflictOf } from "./occupancy.js";
import { applicable, enforcePolicies, parseRelax } from "./policy-pass.js";
import type { UnparsedRelax } from "./policy-pass.js";
import type { ActionContext } from "./scheduler-service.js";
import type {
  AlsoContext,
  AlsoParam,
  Outcome,
  WriteEffect,
} from "./write-unit.js";

/** Params of `reschedule`: the Booking's new `[start, end)`, optionally on another Resource, and a `fields` patch. */
export type RescheduleParams<S extends AnySchema> = {
  /** The Booking to move. */
  readonly id: BookingId;
  /** Inclusive start; floored to the millisecond. */
  readonly start: Temporal.Instant;
  /** Exclusive end; floored to the millisecond. */
  readonly end: Temporal.Instant;
  /** The Resource to move to; the stored one when left out. Only this one is locked. */
  readonly resourceId?: ResourceIdOf<S>;
} & FieldsPatch<S["booking"]["fields"]>;

/** Every way `reschedule` can fail, apart from `PolicyViolation`, which the scheduler types from its Policies. */
export type RescheduleError<S extends AnySchema> =
  | InvalidParams
  | BookingNotFound
  | StatusMismatch<StatusOf<S>>
  | SlotConflict<ConflictOf<S>>
  | AdapterError;

/**
 * Move a blocking Booking in time or to another Resource, keeping its id and Status (ADR 009): the Invariants first (overlap ignoring itself), then every Policy that applies to `reschedule` (ADR 014).
 *
 * @returns An Effect of the moved Booking, with `also`'s value merged in when one ran; it fails with `InvalidParams`, `BookingNotFound`, `StatusMismatch`, `SlotConflict`, `PolicyViolation`, `Vetoed` or `AdapterError`.
 */
export function reschedule<S extends AnySchema, Tx, R = never>(
  ctx: ActionContext<S, Tx>,
  params: RescheduleParams<S> &
    UnparsedRelax &
    AlsoParam<AlsoContext<ChangeAlso<S, Tx>>, Tx, R>
): WriteEffect<
  Booking<S>,
  RescheduleError<S> | SlotConflict<Conflict> | PolicyViolation,
  R
> {
  const { id } = params;
  // Adapters see only ms-floored Instants (Invariant 4).
  const start = floorMs(params.start);
  const end = floorMs(params.end);

  // Before any Adapter call (Invariant 5).
  const checkedRange = checked(
    checkInstantRange({ end, start }, []),
    () => null
  );

  if (!checkedRange.ok) {
    return Effect.fail(checkedRange.error);
  }

  const patch = fieldPatch<S["booking"]["fields"]>(
    ctx.schema.booking.fields,
    params
  );

  const policies = applicable(ctx, "reschedule");
  const relaxed = parseRelax(policies, "reschedule", params);

  if (!relaxed.ok) {
    return Effect.fail(relaxed.error);
  }

  const relax = relaxed.value;

  const notFound: BookingNotFound = { _tag: "BookingNotFound", id };

  return lockedById(ctx, {
    action: "reschedule",
    also: params.also,
    destination: params.resourceId ?? null,
    notFound,
    read: (reads) => reads.getBooking(id),
    work: (locked, stored, now) =>
      Effect.gen(function* rescheduleUnit(): Effect.fn.Return<
        Outcome<Booking<S>, AlsoContext<ChangeAlso<S, Tx>>>,
        | StatusMismatch<StatusOf<S>>
        | SlotConflict<Conflict>
        | PolicyViolation
        | AdapterError
        | Retry
      > {
        if (!ctx.codec.isBlocking(stored.status)) {
          return yield* Effect.fail<StatusMismatch<StatusOf<S>>>({
            _tag: "StatusMismatch",
            id,
            status: stored.status,
          });
        }

        const placement = {
          end,
          excludeBookingId: id,
          resourceId: params.resourceId ?? stored.resourceId,
          start,
        };

        yield* checkOverlap(ctx, locked, placement);

        const waived = yield* enforcePolicies(
          locked,
          policies,
          {
            action: "reschedule",
            end,
            now,
            previous: stored,
            resourceId: placement.resourceId,
            start,
          },
          relax ?? []
        );

        // SAFETY: base columns of the right types, and a patch of declared fields only.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema's field names are only known at runtime.
        const changes = {
          ...patch,
          end,
          resourceId: placement.resourceId,
          start,
        } as BookingChanges<S>;

        const updated = yield* locked.updateBooking({
          changes,
          expected: stored,
        });

        if (!updated.ok) {
          // `conflict`: the backstop caught an outside write the lock can't see; report what is there now.
          return yield* updated.reason === "changed"
            ? Effect.fail(retry)
            : Effect.fail<SlotConflict<Conflict>>({
                _tag: "SlotConflict",
                conflicts: yield* conflictsAt(ctx, locked, {
                  ...placement,
                  kind: "booking",
                }),
              });
        }

        const booking = { ...stored, ...changes };

        return {
          _tag: "Done",
          context: { booking, previous: stored },
          // `waived` exactly when `relax` was passed.
          value: relax === undefined ? booking : { ...booking, waived },
        };
      }),
  });
}
