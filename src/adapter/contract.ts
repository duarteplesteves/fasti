import type { BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type {
  BookingChanges,
  BookingRecord,
  ResourceIdOf,
  RuleRecord,
} from "./records.js";

/** A `listBookings` query: one Resource, one half-open range. */
export interface ListBookingsQuery<S extends AnySchema> {
  /** The Resource whose Bookings to list. */
  readonly resourceId: ResourceIdOf<S>;
  /** Half-open: a Booking matches when `start < to && end > from`. */
  readonly overlapping: {
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
  };
}

/** The reads every Adapter offers, inside and outside a unit of work. */
export interface AdapterReads<S extends AnySchema> {
  /** The Booking with this id, or `null` when there is none. */
  readonly getBooking: (id: BookingId) => Promise<BookingRecord<S> | null>;
  /** Every Booking of the Resource overlapping the range, in every Status; sorted by `start`, then `id`. */
  readonly listBookings: (
    query: ListBookingsQuery<S>
  ) => Promise<BookingRecord<S>[]>;
  /** Every stored rule of the Resource; order unspecified. */
  readonly getRules: (resourceId: ResourceIdOf<S>) => Promise<RuleRecord[]>;
}

/** What `insertBooking` can return. Any other failure (a duplicate id, a lost connection) rejects. */
export type InsertBookingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "conflict" };

/** What `updateBooking` can return. `changed`: the stored row no longer equals `expected`, or is gone. */
export type UpdateBookingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "conflict" | "changed" };

/** Params of {@link LockedAdapter.updateBooking}. The id comes from `expected`. */
export interface UpdateBookingParams<S extends AnySchema> {
  /** The row as last read; the update applies only if the stored row still equals it. */
  readonly expected: BookingRecord<S>;
  /** The fields to change. */
  readonly changes: BookingChanges<S>;
}

/** Params of {@link LockedAdapter.replaceRules}. */
export interface ReplaceRulesParams<S extends AnySchema> {
  /** The Resource whose whole rule set is replaced. */
  readonly resourceId: ResourceIdOf<S>;
  /** The new rule set. */
  readonly rules: readonly RuleRecord[];
}

/**
 * The handle passed into a unit of work. Writes exist only here, so an unlocked write can't type-check.
 * Reads go through the same transaction and see the unit's own writes.
 *
 * @typeParam Tx - The Adapter's own transaction type (`undefined` when there is none).
 */
export interface LockedAdapter<
  S extends AnySchema,
  Tx,
> extends AdapterReads<S> {
  /** The ORM's own transaction, for the developer's writes (ADR 015). */
  readonly tx: Tx;
  /** Store a new Booking. */
  readonly insertBooking: (
    booking: BookingRecord<S>
  ) => Promise<InsertBookingResult>;
  /** Change a Booking, if it still equals `expected` (compare-and-set). */
  readonly updateBooking: (
    params: UpdateBookingParams<S>
  ) => Promise<UpdateBookingResult>;
  /** Replace one Resource's whole rule set. */
  readonly replaceRules: (params: ReplaceRulesParams<S>) => Promise<void>;
}

/** An Adapter bound to one schema. */
export interface SchemaAdapter<
  S extends AnySchema,
  Tx,
> extends AdapterReads<S> {
  /**
   * Run `work` as one transaction that excludes every other locked unit of work on the same Resource.
   * Resolves with the work's value and commits; if the work rejects, nothing persists and the call
   * rejects with the same reason. Locking more broadly is allowed; more narrowly is not.
   */
  readonly withResourceLock: <T>(
    resourceId: ResourceIdOf<S>,
    work: (locked: LockedAdapter<S, Tx>) => Promise<T>
  ) => Promise<T>;
}

/** An Adapter: given the developer's schema, the verbs over their tables. */
export type Adapter<Tx> = <S extends AnySchema>(
  schema: S
) => SchemaAdapter<S, Tx>;

/** Declare an Adapter. Identity at runtime; it infers the schema-dependent types for you. */
export function defineAdapter<Tx>(make: Adapter<Tx>): Adapter<Tx> {
  return make;
}
