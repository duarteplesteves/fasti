import type { Temporal } from "@js-temporal/polyfill";

/**
 * A bookable resource (person, room, machine, etc.).
 * The engine treats `id` as an opaque, globally unique string.
 */
export interface Resource {
  id: string;
}

/**
 * Abstract rule defining when a resource is available.
 * The engine expands these into concrete time windows on demand.
 */
export interface AvailabilityRule {
  resourceId: string;
  recurrence: {
    /** Currently supports weekly recurrence only. */
    frequency: "weekly";
    /** 1 = every week, 2 = every other week, etc. */
    interval: number;
    /** Days of the week the rule applies to (1 = Monday, 7 = Sunday). */
    daysOfWeek: number[];
  };
  timeWindow: {
    /** Start of the daily availability window. */
    start: Temporal.PlainTime;
    /** End of the daily availability window. */
    end: Temporal.PlainTime;
  };
  /** IANA timezone identifier, e.g. "Europe/Lisbon". */
  timezone: string;
  /** Date from which this rule is effective (inclusive). */
  effectiveFrom?: Temporal.PlainDate;
  /** Date until which this rule is effective (inclusive). */
  effectiveTo?: Temporal.PlainDate;
  /** Specific dates on which this rule should NOT apply (holidays, blocked days). */
  exceptions?: Temporal.PlainDate[];
}

/**
 * An existing booking that occupies a resource.
 * The engine respects `isBlocking` to determine if the booking consumes the slot.
 * When `isBlocking` is omitted, it defaults to `true`.
 */
export interface Booking {
  id: string;
  resourceId: string;
  start: Temporal.Instant;
  end: Temporal.Instant;
  /** User-defined status (metadata only; the engine uses `isBlocking` for logic). */
  status?: string;
  /** Whether this booking blocks the resource. Defaults to `true`. */
  isBlocking?: boolean;
  /** Optional group identifier for pack/course/subscription bookings. */
  groupId?: string;
}

/**
 * A candidate time slot returned by the engine.
 * Includes zoned start/end so the caller knows local wall-clock time.
 */
export interface Slot {
  start: Temporal.ZonedDateTime;
  end: Temporal.ZonedDateTime;
  resourceId: string;
}

/**
 * One concrete application of one `AvailabilityRule` on one calendar date
 * in that rule's timezone. Output of `expandRules()`.
 */
export interface ExpandedWindow {
  resourceId: string;
  start: Temporal.ZonedDateTime;
  end: Temporal.ZonedDateTime;
}

/* ------------------------------------------------------------------ */
// Function parameter types
/* ------------------------------------------------------------------ */

export interface FindFreeSlotsParams {
  rules: AvailabilityRule[];
  bookings: Booking[];
  /** Desired slot duration in minutes. */
  duration: number;
  /** Absolute start of the query range. */
  from: Temporal.Instant;
  /** Absolute end of the query range. */
  to: Temporal.Instant;
  options?: {
    /** If true, includes slots that start before `to` but end after it. */
    includePartialSlots?: boolean;
  };
}

export interface IsSlotValidParams {
  slot: {
    start: Temporal.Instant;
    end: Temporal.Instant;
    resourceId: string;
  };
  rules: AvailabilityRule[];
  bookings: Booking[];
}

export interface DetectConflictsParams {
  candidate: Pick<Booking, "resourceId" | "start" | "end">;
  bookings: Booking[];
}

export interface ExpandRulesParams {
  rules: AvailabilityRule[];
  from: Temporal.PlainDate;
  to: Temporal.PlainDate;
}
