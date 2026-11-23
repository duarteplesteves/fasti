import { Effect } from "effect";

import type { BookingChanges, StatusOf } from "../adapter/records.js";
import type { InvalidParams } from "../core/result.js";
import type { BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import { fieldPatch } from "./booking.js";
import type { Booking, ChangeAlso, FieldsPatch } from "./booking.js";
import type {
  AdapterError,
  BookingNotFound,
  PolicyViolation,
  TransitionNotDeclared,
} from "./errors.js";
import { lockedById, retry } from "./lock-by-id.js";
import type { Retry } from "./lock-by-id.js";
import { applicable, checkRelax, enforcePolicies } from "./policy-pass.js";
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

/** What `cancel` returns: the Booking, now `cancelled`. `alreadyCancelled: true` means nothing was written, so no Policy and no `also` ran. */
export type CancelValue<S extends AnySchema> =
  | { readonly booking: Booking<S>; readonly alreadyCancelled: true }
  | { readonly booking: Booking<S>; readonly alreadyCancelled: false };

/** Every way `cancel` can fail, apart from `PolicyViolation`, which the scheduler types from its Policies. */
export type CancelError<S extends AnySchema> =
  | InvalidParams
  | BookingNotFound
  | TransitionNotDeclared<StatusOf<S>>
  | AdapterError;

/** Set a Booking's status to `cancelled` under its Resource's lock, along a declared Transition, keeping every Policy that applies to `cancel` (ADR 014). Idempotent: a repeat writes nothing and runs no Policy. */
export function cancel<S extends AnySchema, Tx, R = never>(
  ctx: ActionContext<S, Tx>,
  params: CancelParams<S> & AlsoParam<AlsoContext<ChangeAlso<S, Tx>>, Tx, R>
): WriteEffect<CancelValue<S>, CancelError<S> | PolicyViolation, R> {
  const { id } = params;

  const policies = applicable(ctx, "cancel");
  // SAFETY: a plain-JS caller may pass anything; checkRelax checks it next.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- WriteAction types `relax` for callers; the implementation takes it as data.
  const { relax } = params as { readonly relax?: readonly string[] };
  const [relaxIssue, ...relaxIssues] = checkRelax(policies, "cancel", relax);

  if (relaxIssue !== undefined) {
    return Effect.fail<InvalidParams>({
      _tag: "InvalidParams",
      issues: [relaxIssue, ...relaxIssues],
    });
  }

  const notFound: BookingNotFound = { _tag: "BookingNotFound", id };

  // SAFETY: every schema's statuses include `cancelled`, and the patch holds declared field names only; TS can't resolve BookingChanges through a generic S.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  const changes = {
    ...fieldPatch<S["booking"]["fields"]>(ctx.schema.booking.fields, params),
    status: "cancelled",
  } as BookingChanges<S>;

  return lockedById(ctx, {
    action: "cancel",
    also: params.also,
    destination: null,
    notFound,
    read: (reads) => reads.getBooking(id),
    work: (locked, booking, now) =>
      Effect.gen(function* cancelUnit(): Effect.fn.Return<
        Outcome<CancelValue<S>, AlsoContext<ChangeAlso<S, Tx>>>,
        | TransitionNotDeclared<StatusOf<S>>
        | PolicyViolation
        | AdapterError
        | Retry
      > {
        if (booking.status === "cancelled") {
          return {
            _tag: "NoOp",
            value: { alreadyCancelled: true, booking },
          };
        }

        // SAFETY: every schema has `cancelled`.
        const cancelled = "cancelled" as StatusOf<S>;

        if (!ctx.codec.canMove(booking.status, cancelled)) {
          return yield* Effect.fail<TransitionNotDeclared<StatusOf<S>>>({
            _tag: "TransitionNotDeclared",
            from: booking.status,
            id,
            to: cancelled,
          });
        }

        const waived = yield* enforcePolicies(
          locked,
          policies,
          { action: "cancel", booking, now },
          relax ?? []
        );

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

        const value = { alreadyCancelled: false, booking: stored } as const;
        // Named, not inline: CancelValue is closed, and the scheduler's WithWaived types the extra key.
        const withWaived = { ...value, waived };

        return {
          _tag: "Done",
          context: { booking: stored, previous: booking },
          // `waived` exactly when `relax` was passed.
          value: relax === undefined ? value : withWaived,
        };
      }),
  });
}
