import type { BlockId, BookingId } from "../core/types.js";
import type { Json, RecordColumn, TypeOf } from "../schema/column.js";
import type { AnySchema, HasBlocks } from "../schema/define-schema.js";
import type { HasTables } from "../schema/table.js";
import type {
  BlockChanges,
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
export type VerbGroup = "blocks" | "records";

/** The verb groups a schema needs from its Adapter: `"blocks"` when it declares `block`, `"records"` when a Plugin declares tables. */
export type GroupsOf<S extends AnySchema> =
  | (HasBlocks<S> extends true ? "blocks" : never)
  | (HasTables<S> extends true ? "records" : never);

/** A value in a Plugin record's column. */
export type StoredValue = TypeOf<RecordColumn> | null;

/** Whether `v` is a list: a `dates` value or a JSON array. Internal; `Array.isArray` doesn't narrow readonly arrays. */
export function isList(
  v: StoredValue | undefined
): v is readonly Temporal.PlainDate[] | readonly Json[] {
  return Array.isArray(v);
}

/** `value` with every object's keys sorted: stored as text (SQLite), equal values then have equal text, so compare-and-set holds (R3). Internal. */
export function canonical(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (value instanceof Object) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : Number(a > b)))
        .map(([k, v]) => [k, canonical(v)])
    );
  }

  return value;
}

/** A Plugin record as it crosses the Adapter seam: logical column names; `id` and `resourceId` included, and on a timed table `start` and `end`. */
export type StoredRecord = Readonly<Record<string, StoredValue>> & {
  readonly id: string;
};

/** A `listRecords` query: one Resource. */
export interface ListRecordsQuery<S extends AnySchema> {
  /** The Resource whose records to list. */
  readonly resourceId: ResourceIdOf<S>;
  /** Timed tables only (the Framework never passes it on another): a record matches when `start < to && end > from`. */
  readonly overlapping?: {
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
  };
}

/** The Plugin record reads, inside and outside a unit of work; `table` is the table's logical name. */
export interface RecordReads<S extends AnySchema> {
  /** The record with this id, or `null` when there is none. */
  readonly getRecord: (
    table: string,
    id: string
  ) => Promise<StoredRecord | null>;
  /** Every record of the Resource (overlapping the range, when given). A timed table's sorted by `start`, then `id`; another's by `id`. */
  readonly listRecords: (
    table: string,
    query: ListRecordsQuery<S>
  ) => Promise<StoredRecord[]>;
}

/** What `updateRecord` can return. `changed`: the stored record no longer equals `expected`, or is gone. */
export type UpdateRecordResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "changed" };

/** What `deleteRecord` can return. `missing`: there was no record with that id. */
export type DeleteRecordResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "missing" };

/** Params of {@link RecordWrites.updateRecord}. The id comes from `expected`. */
export interface UpdateRecordParams {
  /** The record as last read; the update applies only if the stored one still equals it. JSON compares by value, not key order. */
  readonly expected: StoredRecord;
  /** The columns to change; never `id` or `resourceId`. */
  readonly changes: Readonly<Record<string, StoredValue>>;
}

/** Params of {@link RecordWrites.replaceRecords}. */
export interface ReplaceRecordsParams<S extends AnySchema> {
  /** The Resource whose records of the table are all replaced. */
  readonly resourceId: ResourceIdOf<S>;
  /** The new records, ids minted by fasti; each has this `resourceId`. */
  readonly records: readonly StoredRecord[];
}

/** The Plugin record writes, only inside a unit of work. Any failure not in a result type rejects. */
export interface RecordWrites<S extends AnySchema> {
  /** Store a new record; its id is minted by fasti. */
  readonly insertRecord: (table: string, record: StoredRecord) => Promise<void>;
  /** Change a record, if it still equals `expected` (compare-and-set). */
  readonly updateRecord: (
    table: string,
    params: UpdateRecordParams
  ) => Promise<UpdateRecordResult>;
  /** Remove a record. */
  readonly deleteRecord: (
    table: string,
    id: string
  ) => Promise<DeleteRecordResult>;
  /** Replace every record of the table on one Resource; other Resources' records stay. */
  readonly replaceRecords: (
    table: string,
    params: ReplaceRecordsParams<S>
  ) => Promise<void>;
}

/** A `listBlocks` query: one Resource, one half-open range. */
export type ListBlocksQuery<S extends AnySchema> = ListBookingsQuery<S>;

/** The Block reads, inside and outside a unit of work. */
export interface BlockReads<S extends AnySchema> {
  /** The Block with this id, or `null` when there is none. */
  readonly getBlock: (id: BlockId) => Promise<BlockRecord<S> | null>;
  /** Every Block of the Resource overlapping the half-open range; sorted by `start`, then `id`. */
  readonly listBlocks: (query: ListBlocksQuery<S>) => Promise<BlockRecord<S>[]>;
}

/** What `updateBlock` can return. `changed`: the stored row no longer equals `expected`, or is gone. */
export type UpdateBlockResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "changed" };

/** What `deleteBlock` can return. `missing`: there was no Block with that id. */
export type DeleteBlockResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "missing" };

/** The Block writes, only inside a unit of work. */
export interface BlockWrites<S extends AnySchema> {
  /** Store a new Block. No backstop, so any failure rejects. */
  readonly insertBlock: (block: BlockRecord<S>) => Promise<void>;
  /** Change a Block, if it still equals `expected` (compare-and-set). The id comes from `expected`. */
  readonly updateBlock: (params: {
    /** The row as last read; the update applies only if the stored row still equals it. */
    readonly expected: BlockRecord<S>;
    /** The fields to change. */
    readonly changes: BlockChanges<S>;
  }) => Promise<UpdateBlockResult>;
  /** Remove a Block. */
  readonly deleteBlock: (id: BlockId) => Promise<DeleteBlockResult>;
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
  With<G, "blocks", BlockReads<S> & BlockWrites<S>> &
  With<G, "records", RecordReads<S> & RecordWrites<S>> & {
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
  With<G, "blocks", BlockReads<S>> &
  With<G, "records", RecordReads<S>> & {
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
 * @typeParam G - The optional verb groups it implements; a schema with `block` needs `"blocks"`, one with Plugin tables `"records"`.
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
