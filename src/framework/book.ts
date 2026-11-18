import { Effect } from "effect";

import type { BookingRecord, ResourceIdOf } from "../adapter/records.js";
import { checkInstantRange } from "../core/checks.js";
import { checked } from "../core/result.js";
import type { InvalidParams } from "../core/result.js";
import type { AnySchema, InitialOf } from "../schema/define-schema.js";
import { mintBookingId } from "./booking-id.js";
import { fieldValues, floorMs } from "./booking.js";
import type { Booking, FieldsParam } from "./booking.js";
import type { AdapterError, PolicyViolation, SlotConflict } from "./errors.js";
import { checkOverlap, conflictsAt } from "./occupancy.js";
import { checkAvailability } from "./placement.js";
import type { ActionContext } from "./scheduler-service.js";
import { writeUnit } from "./write-unit.js";
import type { AlsoParam, WriteEffect } from "./write-unit.js";

type IsUnion<T, U = T> = T extends unknown
  ? [U] extends [T]
    ? false
    : true
  : never;

/** `status` is required when the schema has several initial Statuses, and absent otherwise. */
export type StatusParam<S extends AnySchema> =
  true extends IsUnion<InitialOf<S>>
    ? {
        /** The Status to create the Booking in: one of the schema's `initial`. */
        readonly status: InitialOf<S>;
      }
    : unknown;

/** Params of `book`: one Resource, one half-open `[start, end)` range, the schema's Developer Fields under `fields`, and `status` when `initial` has several. */
export type BookParams<S extends AnySchema> = {
  /** The Resource to book, typed by the schema's `idType`. */
  readonly resourceId: ResourceIdOf<S>;
  /** Inclusive start; floored to the millisecond. */
  readonly start: Temporal.Instant;
  /** Exclusive end; floored to the millisecond. */
  readonly end: Temporal.Instant;
} & FieldsParam<S["booking"]["fields"]> &
  StatusParam<S>;

/** What `book`'s `also` gets: the new Booking, on fasti's unit of work. */
export interface BookAlso<S extends AnySchema, Tx> {
  /** The Adapter's transaction handle: write through it to share the unit. */
  readonly tx: Tx;
  /** The Booking just stored. */
  readonly booking: Booking<S>;
  /** The Clock's time, read on the unit. */
  readonly now: Temporal.Instant;
}

/** Every way `book` can fail. */
export type BookError =
  | InvalidParams
  | SlotConflict
  | PolicyViolation
  | AdapterError;

/** Store a new Booking in its initial Status, if the slot is free (when that Status blocks) and inside availability (ADR 014: overlap first). */
export function book<S extends AnySchema, Tx, R = never>(
  ctx: ActionContext<S, Tx>,
  params: BookParams<S> & AlsoParam<{ readonly booking: Booking<S> }, Tx, R>
): WriteEffect<Booking<S>, BookError, R> {
  const { resourceId } = params;
  // Adapters see only ms-floored Instants (Invariant 4).
  const start = floorMs(params.start);
  const end = floorMs(params.end);

  const range = {
    end,
    excludeBookingId: null,
    kind: "booking",
    resourceId,
    start,
  } as const;

  // Before any Adapter call (Invariant 5).
  const checkedRange = checked(checkInstantRange(range, []), () => range);

  if (!checkedRange.ok) {
    return Effect.fail(checkedRange.error);
  }

  const { initial } = ctx.schema;
  // SAFETY: StatusParam<S> is `unknown` or `{ status }`; a plain-JS caller may pass anything, checked next.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the conditional type can't narrow inside a generic.
  const requested = (params as { readonly status?: unknown }).status;

  const wanted =
    requested === undefined && initial.length === 1 ? initial[0] : requested;

  const status = initial.find((s) => s === wanted);

  if (status === undefined) {
    return Effect.fail<InvalidParams>({
      _tag: "InvalidParams",
      issues: [
        {
          message: `status must be one of ${initial.join(", ")}`,
          path: ["status"],
        },
      ],
    });
  }

  return writeUnit(
    ctx,
    resourceId,
    (locked) =>
      Effect.gen(function* bookUnit() {
        // A non-blocking Booking can't conflict.
        if (ctx.codec.isBlocking(status)) {
          yield* checkOverlap(locked, ctx.codec, range);
        }

        yield* checkAvailability(locked, range);

        // SAFETY: the base columns are set, and every schema field is set: required ones by BookParams' type, optional ones to their value or `null`.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema's field names are only known at runtime.
        const record = {
          ...fieldValues<S["booking"]["fields"]>(
            ctx.schema.booking.fields,
            params
          ),
          end,
          id: mintBookingId(),
          resourceId,
          start,
          status,
        } as BookingRecord<S>;

        const inserted = yield* locked.insertBooking(record);

        if (!inserted.ok) {
          // The backstop caught an outside write the lock can't see: report what is there now.
          return yield* Effect.fail<SlotConflict>({
            _tag: "SlotConflict",
            conflicts: yield* conflictsAt(locked, ctx.codec, range),
          });
        }

        return {
          _tag: "Done",
          context: { booking: record },
          value: record,
        } as const;
      }),
    params.also
  );
}
