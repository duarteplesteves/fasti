import { defineAdapter } from "../adapter/contract.js";
import type {
  Adapter,
  AdapterReads,
  LockedAdapter,
  SchemaAdapter,
} from "../adapter/contract.js";
import type { BookingRecord, RuleRecord } from "../adapter/records.js";
import type { BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";

/** Field-by-field equality; Temporal values have no enumerable fields, so they compare with `equals`. */
function sameBooking(
  a: BookingRecord<AnySchema>,
  b: BookingRecord<AnySchema>
): boolean {
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
  readonly rules: Map<unknown, readonly RuleRecord[]>;
}

/** Params of {@link createMemoryAdapter}. */
export interface CreateMemoryAdapterParams {
  /** `false` skips the Resource Lock: only for the negative control, never exported publicly. */
  readonly lock: boolean;
}

/** The reads, over whichever store `current` returns. */
function readsOf<S extends AnySchema>(current: () => Store): AdapterReads<S> {
  return {
    // SAFETY: every stored Booking was inserted through an adapter bound to this same schema.
    getBooking: async (id) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store is shared across bindings, so it holds AnySchema records.
      (current().bookings.get(id) ?? null) as BookingRecord<S> | null,
    getRules: async (resourceId) => [
      ...(current().rules.get(resourceId) ?? []),
    ],
    listBookings: async ({ overlapping: { from, to }, resourceId }) =>
      // SAFETY: as in getBooking, every stored Booking was inserted through an adapter bound to this same schema.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store is shared across bindings, so it holds AnySchema records.
      [...current().bookings.values()]
        .filter(
          (b) =>
            b.resourceId === resourceId &&
            Temporal.Instant.compare(b.start, to) < 0 &&
            Temporal.Instant.compare(b.end, from) > 0
        )
        .toSorted(
          (a, b) =>
            Temporal.Instant.compare(a.start, b.start) ||
            (a.id < b.id ? -1 : Number(a.id > b.id))
        ) as BookingRecord<S>[],
  };
}

/** The handle over a draft: reads and writes both go to it. */
function lockedOn<S extends AnySchema>(
  draft: Store
): LockedAdapter<S, undefined> {
  return {
    ...readsOf<S>(() => draft),
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
    updateBooking: async ({ changes, expected }) => {
      const stored = draft.bookings.get(expected.id);

      if (stored === undefined || !sameBooking(stored, expected)) {
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
}: CreateMemoryAdapterParams): Adapter<undefined> {
  // One store per call, however many times it is bound to a schema. Unlocked reads see only committed state.
  let store: Store = { bookings: new Map(), rules: new Map() };
  // One global queue for every locked unit of work: locking more broadly than one Resource is allowed (ADR 008).
  let queue: Promise<unknown> = Promise.resolve();

  // shortcut: O(n) copy per unit of work; fine for tests, replace with a write log if anyone benchmarks it.
  async function run<S extends AnySchema, T>(
    work: (locked: LockedAdapter<S, undefined>) => Promise<T>
  ): Promise<T> {
    const draft: Store = {
      bookings: new Map(store.bookings),
      rules: new Map(store.rules),
    };

    const value = await work(lockedOn<S>(draft));

    // Commit is the swap; a rejection above drops the draft.
    store = draft;

    return value;
  }

  return defineAdapter(
    <S extends AnySchema>(_schema: S): SchemaAdapter<S, undefined> => ({
      ...readsOf<S>(() => store),
      withResourceLock: async (_resourceId, work) => {
        if (!lock) {
          return await run(work);
        }

        const result = queue.then(async () => await run(work));

        // The next unit waits for this one to settle, whether it resolves or rejects.
        queue = result.catch(() => null);

        return await result;
      },
    })
  );
}

/** An Adapter that keeps everything in memory, for tests. `tx` is `undefined`: there is no transaction to join. */
export function memoryAdapter(): Adapter<undefined> {
  return createMemoryAdapter({ lock: true });
}
