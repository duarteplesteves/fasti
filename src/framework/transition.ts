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
  Conflict,
  PolicyViolation,
  SlotConflict,
  StatusMismatch,
  Vetoed,
} from "./errors.js";
import type { AlsoFn, Form, Run, WithAlso } from "./forms.js";
import { lockedById, retry } from "./lock-by-id.js";
import type { Retry } from "./lock-by-id.js";
import { checkOverlap, conflictsAt } from "./occupancy.js";
import type { ConflictOf } from "./occupancy.js";
import { applicable, enforcePolicies, parseRelax } from "./policy-pass.js";
import type { UnparsedRelax } from "./policy-pass.js";
import type {
  Edge,
  PolicyErrorOf,
  TransitionCandidate,
  ViolationFor,
  WithWaived,
} from "./policy.js";
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

/** The Violations the Policies in union `P` report on the declared edges `Fr → To`. */
type EdgeViolation<S extends AnySchema, P, Fr, To> = ViolationFor<
  P,
  Extract<Edge<S>, { readonly from: Fr; readonly to: To }>
>;

/** What `relax` may be on an edge whose Policies report `W`: only `undefined` when none apply. */
type RelaxOf<W extends { readonly policy: string }> = [W] extends [never]
  ? undefined
  : readonly W["policy"][] | undefined;

/** `relax` on `transition`. */
interface RelaxParam<X> {
  /** Skip these Policies: they still run, and come back as `waived` when broken. */
  readonly relax?: X;
}

/** `transition`'s params for the edge `Fr → To`. */
type EdgeParams<S extends AnySchema, Fr, To> = {
  readonly id: BookingId;
  readonly from: Fr;
  readonly to: To;
} & FieldsPatch<S["booking"]["fields"]>;

/** `transition` in form `F`, with Policies `P` (a union): generic over the edge, so `relax`, `waived` and `PolicyViolation` narrow to the Policies on it. */
export interface TransitionAction<F extends Form, S extends AnySchema, Tx, P> {
  <
    const Fr extends TransitionEdge<S>["from"],
    const To extends Extract<TransitionEdge<S>, { readonly from: Fr }>["to"],
    A,
    AE,
    R = never,
    const X extends RelaxOf<EdgeViolation<S, P, Fr, To>> = undefined,
  >(
    params: EdgeParams<S, Fr, To> &
      RelaxParam<X> & {
        readonly also: AlsoFn<F, ChangeAlso<S, Tx>, A, AE, R>;
      }
  ): Run<
    F,
    WithAlso<WithWaived<Booking<S>, EdgeViolation<S, P, Fr, To>, X>, A>,
    | TransitionError<S>
    | PolicyErrorOf<EdgeViolation<S, P, Fr, To>, X>
    | Vetoed<AE>,
    R
  >;
  <
    const Fr extends TransitionEdge<S>["from"],
    const To extends Extract<TransitionEdge<S>, { readonly from: Fr }>["to"],
    const X extends RelaxOf<EdgeViolation<S, P, Fr, To>> = undefined,
  >(
    params: EdgeParams<S, Fr, To> & RelaxParam<X>
  ): Run<
    F,
    WithWaived<Booking<S>, EdgeViolation<S, P, Fr, To>, X>,
    TransitionError<S> | PolicyErrorOf<EdgeViolation<S, P, Fr, To>, X>,
    never
  >;
}

/** Every way `transition` can fail, apart from `PolicyViolation`, which the scheduler types from its Policies on the edge. */
export type TransitionError<S extends AnySchema> =
  | InvalidParams
  | BookingNotFound
  | StatusMismatch<StatusOf<S>>
  | SlotConflict<ConflictOf<S>>
  | AdapterError;

/**
 * Move a Booking from `from` to `to` along a declared Transition, compare-and-set on `from` (ADR 009).
 * Into a blocking Status from a non-blocking one, it re-checks overlap; then the Policies on the edge run (never availability).
 */
export function transition<S extends AnySchema, Tx, R = never>(
  ctx: ActionContext<S, Tx>,
  params: TransitionParams<S> &
    UnparsedRelax &
    AlsoParam<AlsoContext<ChangeAlso<S, Tx>>, Tx, R>
): WriteEffect<
  Booking<S>,
  TransitionError<S> | SlotConflict<Conflict> | PolicyViolation,
  R
> {
  const { id } = params;

  // SAFETY: TransitionEdge<S> has `from` and `to` Statuses; a plain-JS caller may pass anything, which canMove refuses next.
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

  const policies = applicable(ctx, { from, to });
  const relaxed = parseRelax(policies, { from, to }, params);

  if (!relaxed.ok) {
    return Effect.fail(relaxed.error);
  }

  const relax = relaxed.value;

  // SAFETY: the patch holds declared field names only, plus a declared Status.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema's field names are only known at runtime.
  const changes = {
    ...fieldPatch<S["booking"]["fields"]>(ctx.schema.booking.fields, params),
    status: to,
  } as BookingChanges<S>;

  return lockedById(ctx, {
    action: "transition",
    also: params.also,
    destination: null,
    notFound: { _tag: "BookingNotFound", id } satisfies BookingNotFound,
    read: (reads) => reads.getBooking(id),
    work: (locked, stored, now) =>
      Effect.gen(function* transitionUnit(): Effect.fn.Return<
        Outcome<Booking<S>, AlsoContext<ChangeAlso<S, Tx>>>,
        | StatusMismatch<StatusOf<S>>
        | SlotConflict<Conflict>
        | PolicyViolation
        | AdapterError
        | Retry
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
          yield* checkOverlap(ctx, locked, range);
        }

        const waived = yield* enforcePolicies(
          locked,
          policies,
          // SAFETY: `from → to` is a declared edge, checked above; TransitionCandidate<S> can't be built inside a generic.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
          {
            action: "transition",
            booking: stored,
            from,
            now,
            to,
          } as TransitionCandidate<S>,
          relax ?? []
        );

        const updated = yield* locked.updateBooking({
          changes,
          expected: stored,
        });

        // On `conflict`, the backstop caught an outside write the lock can't see: report what is there now.
        if (!updated.ok) {
          return yield* updated.reason === "changed"
            ? Effect.fail(retry)
            : Effect.fail<SlotConflict<Conflict>>({
                _tag: "SlotConflict",
                conflicts: yield* conflictsAt(ctx, locked, range),
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
