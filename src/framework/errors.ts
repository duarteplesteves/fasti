import type { AvailabilityViolation, BookingId } from "../core/types.js";

/** A blocking Booking that a requested slot overlaps; no Developer Fields, so no customer data. */
export interface ConflictingBooking {
  readonly id: BookingId;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

/** The slot overlaps blocking Bookings: the overlap Invariant (ADR 014). */
export interface SlotConflict {
  readonly _tag: "SlotConflict";
  readonly conflicts: readonly ConflictingBooking[];
}

/** The slot breaks one or more Policies (ADR 014). */
export interface PolicyViolation {
  readonly _tag: "PolicyViolation";
  readonly violations: readonly [
    AvailabilityViolation,
    ...AvailabilityViolation[],
  ];
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
