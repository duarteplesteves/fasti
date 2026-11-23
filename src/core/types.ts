/** Repeats every `interval` weeks on `daysOfWeek`. */
export interface WeeklyRecurrence {
  frequency: "weekly";
  /** 1 = every week, 2 = every other week, etc. */
  interval: number;
  /** Days of the week the rule applies to (1 = Monday, 7 = Sunday). */
  daysOfWeek: readonly number[];
}

/** How a rule repeats, discriminated by `frequency`. A new frequency is a new member. */
export type Recurrence = WeeklyRecurrence;

/**
 * Abstract rule defining when a resource is available.
 * The engine expands these into concrete time windows on demand.
 */
export interface AvailabilityRule {
  resourceId: string;
  recurrence: Recurrence;
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

/** A Booking id the Framework mints. A plain TypeScript brand on `string`. */
export type BookingId = string & { readonly __brand: "BookingId" };

declare const recordBrand: unique symbol;

/** The id of a record in Plugin table `T`: a UUIDv7 fasti mints, branded so ids of two tables can't mix. */
export type RecordId<T extends string> = string & {
  readonly [recordBrand]: T;
};

/** A Block id: the id of a record in the `blocks()` Plugin's `block` table. */
export type BlockId = RecordId<"block">;

/**
 * An existing booking that occupies a resource.
 * The engine uses `isBlocking` to determine if the booking consumes the slot.
 */
export interface Booking<Id extends string = string> {
  id: Id;
  resourceId: string;
  start: Temporal.Instant;
  end: Temporal.Instant;
  /** Whether this booking blocks the resource. Required (see ADR 004). */
  isBlocking: boolean;
  /** User-defined status (metadata only; the engine uses `isBlocking` for logic). */
  status?: string;
}

/** The slot lies outside the Resource's availability (ADR 014). */
export interface AvailabilityViolation {
  readonly policy: "availability";
  readonly detail: Readonly<Record<string, never>>;
}

/** Each Policy the Core knows, by name, with the violation it reports. */
export interface CoreViolations {
  availability: AvailabilityViolation;
}

/** A Policy name the Core knows, which a caller may relax. */
export type CorePolicy = keyof CoreViolations;

/**
 * A candidate time slot returned by the engine.
 * Includes zoned start/end so the caller knows local wall-clock time.
 * `waived` lists the relaxed Policies this slot breaks; empty for a slot that breaks none.
 */
export interface Slot<W = never> {
  start: Temporal.ZonedDateTime;
  end: Temporal.ZonedDateTime;
  resourceId: string;
  waived: readonly W[];
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

/** A half-open `[start, end)` range of instants. Internal; not exported from the Core. */
export interface InstantRange {
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}
