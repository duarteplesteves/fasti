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
    daysOfWeek: readonly number[];
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
  exceptions?: readonly Temporal.PlainDate[];
}

/**
 * An existing booking that occupies a resource.
 * The engine uses `isBlocking` to determine if the booking consumes the slot.
 */
export interface Booking {
  id: string;
  resourceId: string;
  start: Temporal.Instant;
  end: Temporal.Instant;
  /** Whether this booking blocks the resource. Required (see ADR 004). */
  isBlocking: boolean;
  /** User-defined status (metadata only; the engine uses `isBlocking` for logic). */
  status?: string;
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
