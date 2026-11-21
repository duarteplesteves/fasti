import { defineAdapter } from "../adapter/contract.js";
import type {
  Adapter,
  AdapterReads,
  BlockReads,
  ListBookingsQuery,
  LockedAdapter,
  RecordReads,
  SchemaAdapter,
  StoredRecord,
} from "../adapter/contract.js";
import { serialize } from "../adapter/queue.js";
import type {
  BlockRecord,
  BookingRecord,
  RuleRecord,
} from "../adapter/records.js";
import type { BlockId, BookingId } from "../core/types.js";
import type { AnyColumn, TypeOf } from "../schema/column.js";
import type { AnySchema } from "../schema/define-schema.js";

/** A stored row as plain values: every column, Developer Fields included. */
type Row = Readonly<Record<string, TypeOf<AnyColumn> | null>>;

/** Field-by-field equality; Temporal values have no enumerable fields, so they compare with `equals`. */
function sameRecord(a: Row, b: Row): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);

  return [...keys].every((k) => {
    const x: unknown = a[k];
    const y: unknown = b[k];

    return x instanceof Temporal.Instant && y instanceof Temporal.Instant
      ? x.equals(y)
      : x === y;
  });
}

/** The committed state, or a unit of work's draft of it. Records are immutable and replaced, so a shallow copy is enough. */
interface Store {
  readonly bookings: Map<BookingId, BookingRecord<AnySchema>>;
  readonly blocks: Map<BlockId, BlockRecord<AnySchema>>;
  readonly rules: Map<unknown, readonly RuleRecord[]>;
  /** Plugin records, by table, then id. */
  readonly records: Map<string, Map<string, StoredRecord>>;
}

/** A copy of `store` a unit of work can change without touching it. */
function draftOf(store: Store): Store {
  return {
    blocks: new Map(store.blocks),
    bookings: new Map(store.bookings),
    records: new Map(
      [...store.records].map(([table, rows]) => [table, new Map(rows)])
    ),
    rules: new Map(store.rules),
  };
}

/** Params of {@link createMemoryAdapter}. */
export interface CreateMemoryAdapterParams {
  /** `false` skips the Resource Lock: only for the negative control, never exported publicly. */
  readonly lock: boolean;
}

/** The records of one Resource overlapping the half-open range, sorted by `start`, then `id`. */
function overlapping<
  R extends {
    readonly id: string;
    readonly resourceId: unknown;
    readonly start: Temporal.Instant;
    readonly end: Temporal.Instant;
  },
>(
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
    .toSorted(
      (a, b) =>
        Temporal.Instant.compare(a.start, b.start) ||
        (a.id < b.id ? -1 : Number(a.id > b.id))
    );
}

/** The reads, over whichever store `current` returns. */
function readsOf<S extends AnySchema>(
  current: () => Store
): AdapterReads<S> & BlockReads<S> & RecordReads<S> {
  return {
    getRecord: async (table, id) =>
      current().records.get(table)?.get(id) ?? null,
    listRecords: async (table, { resourceId }) =>
      [...(current().records.get(table)?.values() ?? [])]
        .filter((r) => r["resourceId"] === resourceId)
        .toSorted((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id))),
    // SAFETY: every stored record was inserted through an adapter bound to this same schema.
    getBlock: async (id) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store is shared across bindings, so it holds AnySchema records.
      (current().blocks.get(id) ?? null) as BlockRecord<S> | null,
    // SAFETY: every stored Booking was inserted through an adapter bound to this same schema.
    getBooking: async (id) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store is shared across bindings, so it holds AnySchema records.
      (current().bookings.get(id) ?? null) as BookingRecord<S> | null,
    getRules: async (resourceId) => [
      ...(current().rules.get(resourceId) ?? []),
    ],
    // SAFETY: as in getBlock.
    listBlocks: async (query) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above.
      overlapping(current().blocks.values(), query) as BlockRecord<S>[],
    // SAFETY: as in getBlock.
    listBookings: async (query) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above.
      overlapping(current().bookings.values(), query) as BookingRecord<S>[],
  };
}

/** The handle over a draft: reads and writes both go to it. */
function lockedOn<S extends AnySchema>(
  draft: Store
): LockedAdapter<S, undefined, "blocks" | "records"> {
  return {
    ...readsOf<S>(() => draft),
    insertRecord: async (table, record) => {
      const rows = draft.records.get(table) ?? new Map<string, StoredRecord>();

      if (rows.has(record.id)) {
        throw new Error(`memoryAdapter: ${table} ${record.id} already exists`);
      }

      draft.records.set(table, rows.set(record.id, record));
    },
    insertBlock: async (block) => {
      if (draft.blocks.has(block.id)) {
        throw new Error(`memoryAdapter: Block ${block.id} already exists`);
      }

      draft.blocks.set(block.id, block);
    },
    deleteBlock: async (id) =>
      draft.blocks.delete(id) ? { ok: true } : { ok: false, reason: "missing" },
    insertBooking: async (booking) => {
      if (draft.bookings.has(booking.id)) {
        throw new Error(`memoryAdapter: Booking ${booking.id} already exists`);
      }

      draft.bookings.set(booking.id, booking);

      return { ok: true };
    },
    replaceRules: async ({ resourceId, rules }) => {
      draft.rules.set(resourceId, [...rules]);
    },
    tx: undefined,
    updateBlock: async ({ changes, expected }) => {
      const stored = draft.blocks.get(expected.id);

      if (stored === undefined || !sameRecord(stored, expected)) {
        return { ok: false, reason: "changed" };
      }

      draft.blocks.set(expected.id, { ...stored, ...changes });

      return { ok: true };
    },
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

/** The in-memory Adapter, with the lock switchable for the negative control. Internal: use {@link memoryAdapter}. */
export function createMemoryAdapter({
  lock,
}: CreateMemoryAdapterParams): Adapter<undefined, "blocks" | "records"> {
  // One store per call, however many times it is bound to a schema. Unlocked reads see only committed state.
  let store: Store = {
    blocks: new Map(),
    bookings: new Map(),
    records: new Map(),
    rules: new Map(),
  };

  // One global queue for every locked unit of work: locking more broadly than one Resource is allowed (ADR 008).
  const queue = serialize();

  // shortcut: O(n) copy per unit of work; fine for tests, replace with a write log if anyone benchmarks it.
  async function run<S extends AnySchema, T>(
    work: (
      locked: LockedAdapter<S, undefined, "blocks" | "records">
    ) => Promise<T>
  ): Promise<T> {
    const draft = draftOf(store);

    const value = await work(lockedOn<S>(draft));

    // Commit is the swap; a rejection above drops the draft.
    store = draft;

    return value;
  }

  return defineAdapter(
    <S extends AnySchema>(
      _schema: S
    ): SchemaAdapter<S, undefined, "blocks" | "records"> => ({
      ...readsOf<S>(() => store),
      withResourceLock: async (_resourceId, work) => {
        if (!lock) {
          return await run(work);
        }

        return await queue(async () => await run(work));
      },
    })
  );
}

/** An Adapter that keeps everything in memory, for tests. `tx` is `undefined`: there is no transaction to join. */
export function memoryAdapter(): Adapter<undefined, "blocks" | "records"> {
  return createMemoryAdapter({ lock: true });
}
