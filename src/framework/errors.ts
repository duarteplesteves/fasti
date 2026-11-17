import type {
  AvailabilityViolation,
  BlockId,
  BookingId,
} from "../core/types.js";

/** A blocking Booking that a requested slot overlaps; no Developer Fields, so no customer data. */
export interface ConflictingBooking {
  readonly kind: "booking";
  readonly id: BookingId;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

/** A Block that a requested slot overlaps; no Developer Fields. */
export interface ConflictingBlock {
  readonly kind: "block";
  readonly id: BlockId;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

/** Something a requested slot overlaps; narrow on `kind`. */
export type Conflict = ConflictingBooking | ConflictingBlock;

/** The slot overlaps what occupies the Resource: the overlap Invariant (ADR 014). Sorted by start, then id. */
export interface SlotConflict {
  readonly _tag: "SlotConflict";
  readonly conflicts: readonly Conflict[];
}

/** The slot breaks one or more Policies (ADR 014). */
export interface PolicyViolation {
  readonly _tag: "PolicyViolation";
  readonly violations: readonly [
    AvailabilityViolation,
    ...AvailabilityViolation[],
  ];
}

/** No Booking has this id. */
export interface BookingNotFound {
  readonly _tag: "BookingNotFound";
  readonly id: BookingId;
}

/** The stored Status isn't one the call needs, e.g. reschedule of a non-blocking Booking. */
export interface StatusMismatch<St extends string = string> {
  readonly _tag: "StatusMismatch";
  readonly id: BookingId;
  readonly status: St;
}

/** No Block has this id. */
export interface BlockNotFound {
  readonly _tag: "BlockNotFound";
  readonly id: BlockId;
}

/** The Adapter or its database failed. `cause` is the original rejection. A plain `Error`, so no Effect import is needed. */
export class AdapterError extends Error {
  readonly _tag = "AdapterError" as const;
  override readonly name = "AdapterError";
  override readonly cause: unknown;

  /** Wrap the Adapter's rejection. */
  constructor(cause: unknown) {
    super("The Adapter failed.", { cause });
    this.cause = cause;
  }
}

/** The developer's `also` refused; everything rolled back. */
export interface Vetoed<E> {
  readonly _tag: "Vetoed";
  readonly reason: E;
}

/** The stored Status isn't what the call needed (`from` on `transition`). `status` is the stored one. */
export interface StatusMismatch<St extends string = string> {
  readonly _tag: "StatusMismatch";
  readonly id: BookingId;
  readonly status: St;
}

/** No declared Transition from the stored Status to `to` (reached through `cancel`). */
export interface TransitionNotDeclared<St extends string = string> {
  readonly _tag: "TransitionNotDeclared";
  readonly id: BookingId;
  readonly from: St;
  readonly to: St;
}
