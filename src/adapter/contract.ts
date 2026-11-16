import type { BlockId, BookingId } from "../core/types.js";
import type { AnySchema, HasBlocks } from "../schema/define-schema.js";
import type {
  BlockRecord,
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

/** An optional group of verbs an Adapter declares it implements, as `Adapter<Tx, "blocks">`. */
export type VerbGroup = "blocks";

/** The verb groups a schema needs from its Adapter: `"blocks"` when it declares `block`. */
export type GroupsOf<S extends AnySchema> =
  HasBlocks<S> extends true ? "blocks" : never;

/** A `listBlocks` query: one Resource, one half-open range. */
export type ListBlocksQuery<S extends AnySchema> = ListBookingsQuery<S>;

/** The Block reads, inside and outside a unit of work. */
export interface BlockReads<S extends AnySchema> {
  /** The Block with this id, or `null` when there is none. */
  readonly getBlock: (id: BlockId) => Promise<BlockRecord<S> | null>;
  /** Every Block of the Resource overlapping the half-open range; sorted by `start`, then `id`. */
  readonly listBlocks: (query: ListBlocksQuery<S>) => Promise<BlockRecord<S>[]>;
}

/** The Block writes, only inside a unit of work. */
export interface BlockWrites<S extends AnySchema> {
  /** Store a new Block. No backstop, so any failure rejects. */
  readonly insertBlock: (block: BlockRecord<S>) => Promise<void>;
}

/** `T` when the Adapter declares group `K`, nothing otherwise. Tuple-wrapped: `K extends G` makes TypeScript measure G as covariant. */
type With<G extends VerbGroup, K extends VerbGroup, T> = [
  Extract<G, K>,
] extends [never]
  ? unknown
  : T;

/** Type-only key for {@link SchemaAdapter}'s variance marker; no runtime value. */
declare const groups: unique symbol;

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
 * @typeParam G - The optional verb groups the Adapter implements.
 */
export type LockedAdapter<
  S extends AnySchema,
  Tx,
  G extends VerbGroup = never,
> = AdapterReads<S> &
  With<G, "blocks", BlockReads<S> & BlockWrites<S>> & {
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
  };

/** An Adapter bound to one schema. */
export type SchemaAdapter<
  S extends AnySchema,
  Tx,
  G extends VerbGroup = never,
> = AdapterReads<S> &
  With<G, "blocks", BlockReads<S>> & {
    /**
     * Never set. Makes `Adapter<Tx, G>` contravariant in G, which TypeScript can't infer from {@link With}:
     * an Adapter with more groups stands in for one with fewer, never the reverse.
     */
    readonly [groups]?: (group: G) => void;
    /**
     * Run `work` as one transaction that excludes every other locked unit of work on the same Resource.
     * Resolves with the work's value and commits; if the work rejects, nothing persists and the call
     * rejects with the same reason. Locking more broadly is allowed; more narrowly is not.
     */
    readonly withResourceLock: <T>(
      resourceId: ResourceIdOf<S>,
      work: (locked: LockedAdapter<S, Tx, G>) => Promise<T>
    ) => Promise<T>;
  };

/**
 * An Adapter: given the developer's schema, the verbs over their tables.
 *
 * @typeParam G - The optional verb groups it implements; a schema with `block` needs `"blocks"`.
 */
export type Adapter<Tx, G extends VerbGroup = never> = <S extends AnySchema>(
  schema: S
) => SchemaAdapter<S, Tx, G>;

/** Declare an Adapter. Identity at runtime; it infers the schema-dependent types for you. */
export function defineAdapter<Tx, G extends VerbGroup = never>(
  make: Adapter<Tx, G>
): Adapter<Tx, G> {
  return make;
}
