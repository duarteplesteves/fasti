import { defineAdapter, isList } from "../adapter/contract.js";
import type {
  Adapter,
  AdapterReads,
  ListBookingsQuery,
  LockedAdapter,
  RecordReads,
  SchemaAdapter,
  StoredRecord,
  StoredValue,
} from "../adapter/contract.js";
import { serialize } from "../adapter/queue.js";
import type { BookingRecord } from "../adapter/records.js";
import type { BookingId } from "../core/types.js";
import type { Json } from "../schema/column.js";
import type { AnySchema } from "../schema/define-schema.js";
import { tablesOf } from "../schema/table.js";

/** A stored row as plain values: every column, Developer Fields included. */
type Row = Readonly<Record<string, StoredValue>>;

/**
 * Whether `v` is a JSON object.
 *
 * @returns `true` when `v` is a JSON object: not a list or a Temporal value.
 */
function isJsonObject(
  v: StoredValue | undefined
): v is Readonly<Record<string, Json>> {
  return (
    v instanceof Object &&
    !isList(v) &&
    !(v instanceof Temporal.Instant) &&
    !(v instanceof Temporal.PlainDate) &&
    !(v instanceof Temporal.PlainTime)
  );
}

/**
 * Deep equality over stored values: Temporal values (no enumerable fields) compare with `equals`,
 * lists in order, JSON objects by key whatever their order, as Postgres's `jsonb` does.
 *
 * @returns `true` when `x` and `y` are equal.
 */
function same(x: StoredValue | undefined, y: StoredValue | undefined): boolean {
  if (x instanceof Temporal.Instant) {
    return y instanceof Temporal.Instant && x.equals(y);
  }

  if (x instanceof Temporal.PlainDate) {
    return y instanceof Temporal.PlainDate && x.equals(y);
  }

  if (x instanceof Temporal.PlainTime) {
    return y instanceof Temporal.PlainTime && x.equals(y);
  }

  if (isList(x)) {
    return (
      isList(y) && x.length === y.length && x.every((v, i) => same(v, y[i]))
    );
  }

  if (isJsonObject(x)) {
    return (
      isJsonObject(y) &&
      [...new Set([...Object.keys(x), ...Object.keys(y)])].every((k) =>
        same(x[k], y[k])
      )
    );
  }

  return x === y;
}

/**
 * Field-by-field {@link same}; an absent field and an `undefined` one are equal.
 *
 * @returns `true` when every field of `a` and `b` is equal.
 */
function sameRecord(a: Row, b: Row): boolean {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) =>
    same(a[k], b[k])
  );
}

/** The committed state, or a unit of work's draft of it. Records are immutable and replaced, so a shallow copy is enough. */
interface Store {
  readonly bookings: Map<BookingId, BookingRecord<AnySchema>>;
  /** Plugin records, by table, then id. */
  readonly records: Map<string, Map<string, StoredRecord>>;
}

/**
 * A copy of `store` a unit of work can change without touching it.
 *
 * @returns The copy.
 */
function draftOf(store: Store): Store {
  return {
    bookings: new Map(store.bookings),
    records: new Map(
      [...store.records].map(([table, rows]) => [table, new Map(rows)])
    ),
  };
}

/** Params of {@link createMemoryAdapter}. */
export interface CreateMemoryAdapterParams {
  /** `false` skips the Resource Lock: only for the negative control, never exported publicly. */
  readonly lock: boolean;
}

/** A record with a time range. */
interface Ranged {
  readonly id: string;
  readonly resourceId: unknown;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : Number(a.id > b.id);
}

function byStart(a: Ranged, b: Ranged): number {
  return Temporal.Instant.compare(a.start, b.start) || byId(a, b);
}

/**
 * The records of one Resource overlapping the half-open range, sorted by `start`, then `id`.
 *
 * @returns The overlapping records.
 */
function overlapping<R extends Ranged>(
  records: Iterable<R>,
  { overlapping: { from, to }, resourceId }: ListBookingsQuery<AnySchema>
): R[] {
  return [...records]
    .filter(
      (r) =>
        r.resourceId === resourceId &&
        Temporal.Instant.compare(r.start, to) < 0 &&
        Temporal.Instant.compare(r.end, from) > 0
    )
    .toSorted(byStart);
}

/**
 * The Plugin records of `table` on `resourceId`, in `store`.
 *
 * @returns The records.
 */
function recordsOn(
  store: Store,
  table: string,
  resourceId: StoredValue
): StoredRecord[] {
  return [...(store.records.get(table)?.values() ?? [])].filter(
    (r) => r["resourceId"] === resourceId
  );
}

/**
 * The reads, over whichever store `current` returns; `timed` names the timed Plugin tables.
 *
 * @returns The Booking and record reads.
 */
function readsOf<S extends AnySchema>(
  current: () => Store,
  timed: ReadonlySet<string>
): AdapterReads<S> & RecordReads<S> {
  return {
    getRecord: async (table, id) =>
      current().records.get(table)?.get(id) ?? null,
    listRecords: async (table, { overlapping: range, resourceId }) => {
      const rows = recordsOn(current(), table, resourceId);

      if (!timed.has(table)) {
        return rows.toSorted(byId);
      }

      // SAFETY: every record of a timed table has Instant `start` and `end` (the Framework writes them).
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- StoredRecord is untyped per table.
      const ranged = rows as (StoredRecord & Ranged)[];

      return range === undefined
        ? ranged.toSorted(byStart)
        : overlapping(ranged, { overlapping: range, resourceId });
    },
    // SAFETY: every stored Booking was inserted through an adapter bound to this same schema.
    getBooking: async (id) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store is shared across bindings, so it holds AnySchema records.
      (current().bookings.get(id) ?? null) as BookingRecord<S> | null,
    // SAFETY: as in getBooking.
    listBookings: async (query) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above.
      overlapping(current().bookings.values(), query) as BookingRecord<S>[],
  };
}

/**
 * The handle over a draft: reads and writes both go to it.
 *
 * @returns The locked handle.
 */
function lockedOn<S extends AnySchema>(
  draft: Store,
  timed: ReadonlySet<string>
): LockedAdapter<S, undefined, "records"> {
  /**
   * The draft's records of `table`, made on first use.
   *
   * @returns The table's records, by id.
   */
  function rowsOf(table: string): Map<string, StoredRecord> {
    const rows = draft.records.get(table) ?? new Map<string, StoredRecord>();

    draft.records.set(table, rows);

    return rows;
  }

  /** Store `record`; a duplicate id rejects, as a primary key would. */
  function insert(table: string, record: StoredRecord): void {
    const rows = rowsOf(table);

    if (rows.has(record.id)) {
      throw new Error(`memoryAdapter: ${table} ${record.id} already exists`);
    }

    rows.set(record.id, record);
  }

  return {
    ...readsOf<S>(() => draft, timed),
    deleteRecord: async (table, id) =>
      rowsOf(table).delete(id)
        ? { ok: true }
        : { ok: false, reason: "missing" },
    insertRecord: async (table, record) => {
      insert(table, record);
    },
    replaceRecords: async (table, { records, resourceId }) => {
      const rows = rowsOf(table);

      for (const { id } of recordsOn(draft, table, resourceId)) {
        rows.delete(id);
      }

      for (const record of records) {
        insert(table, record);
      }
    },
    updateRecord: async (table, { changes, expected }) => {
      const rows = rowsOf(table);
      const stored = rows.get(expected.id);

      if (stored === undefined || !sameRecord(stored, expected)) {
        return { ok: false, reason: "changed" };
      }

      rows.set(expected.id, { ...stored, ...changes });

      return { ok: true };
    },
    insertBooking: async (booking) => {
      if (draft.bookings.has(booking.id)) {
        throw new Error(`memoryAdapter: Booking ${booking.id} already exists`);
      }

      draft.bookings.set(booking.id, booking);

      return { ok: true };
    },
    tx: undefined,
    updateBooking: async ({ changes, expected }) => {
      const stored = draft.bookings.get(expected.id);

      if (stored === undefined || !sameRecord(stored, expected)) {
        return { ok: false, reason: "changed" };
      }

      draft.bookings.set(expected.id, { ...stored, ...changes });

      return { ok: true };
    },
  };
}

/**
 * The in-memory Adapter, with the lock switchable for the negative control. Internal: use {@link memoryAdapter}.
 *
 * @returns The Adapter.
 */
export function createMemoryAdapter({
  lock,
}: CreateMemoryAdapterParams): Adapter<undefined, "records"> {
  // One store per call, however many times it is bound to a schema. Unlocked reads see only committed state.
  let store: Store = {
    bookings: new Map(),
    records: new Map(),
  };

  // One global queue for every locked unit of work: locking more broadly than one Resource is allowed (ADR 008).
  const queue = serialize();

  // shortcut: O(n) copy per unit of work; fine for tests, replace with a write log if anyone benchmarks it.
  async function run<S extends AnySchema, T>(
    timed: ReadonlySet<string>,
    work: (locked: LockedAdapter<S, undefined, "records">) => Promise<T>
  ): Promise<T> {
    const draft = draftOf(store);

    const value = await work(lockedOn<S>(draft, timed));

    // Commit is the swap; a rejection above drops the draft.
    store = draft;

    return value;
  }

  return defineAdapter(
    <S extends AnySchema>(
      schema: S
    ): SchemaAdapter<S, undefined, "records"> => {
      const timed = new Set(
        Object.entries(tablesOf(schema.plugins))
          .filter(([, t]) => t.timed)
          .map(([name]) => name)
      );

      return {
        ...readsOf<S>(() => store, timed),
        withResourceLock: async (_resourceId, work) => {
          if (!lock) {
            return await run(timed, work);
          }

          return await queue(async () => await run(timed, work));
        },
      };
    }
  );
}

/**
 * An Adapter that keeps everything in memory, for tests. `tx` is `undefined`: there is no transaction to join.
 *
 * @returns The Adapter, to pass in `createScheduler`'s `adapter`.
 */
export function memoryAdapter(): Adapter<undefined, "records"> {
  return createMemoryAdapter({ lock: true });
}
