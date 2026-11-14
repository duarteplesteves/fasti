import { defineAdapter } from "../adapter/contract.js";
import type {
  Adapter,
  AdapterReads,
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

/** An Adapter that keeps everything in memory, for tests. `tx` is `undefined`: there is no transaction to join. */
export function memoryAdapter(): Adapter<undefined> {
  // One store per memoryAdapter() call, however many times it is bound to a schema.
  const bookings = new Map<BookingId, BookingRecord<AnySchema>>();
  const rules = new Map<unknown, readonly RuleRecord[]>();

  return defineAdapter(
    <S extends AnySchema>(_schema: S): SchemaAdapter<S, undefined> => {
      const reads: AdapterReads<S> = {
        // SAFETY: every stored Booking was inserted through an adapter bound to this same schema.
        getBooking: async (id) =>
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store is shared across bindings, so it holds AnySchema records.
          (bookings.get(id) ?? null) as BookingRecord<S> | null,
        getRules: async (resourceId) => [...(rules.get(resourceId) ?? [])],
        listBookings: async ({ overlapping: { from, to }, resourceId }) =>
          // SAFETY: as in getBooking, every stored Booking was inserted through an adapter bound to this same schema.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store is shared across bindings, so it holds AnySchema records.
          [...bookings.values()]
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

      return {
        ...reads,
        // shortcut: no lock and no rollback yet; the queue and copy-on-write arrive with #45.
        withResourceLock: async (_resourceId, work) =>
          await work({
            ...reads,
            insertBooking: async (booking) => {
              if (bookings.has(booking.id)) {
                throw new Error(
                  `memoryAdapter: Booking ${booking.id} already exists`
                );
              }

              bookings.set(booking.id, booking);

              return { ok: true };
            },
            replaceRules: async ({ resourceId, rules: next }) => {
              rules.set(resourceId, [...next]);
            },
            tx: undefined,
            updateBooking: async ({ changes, expected }) => {
              const stored = bookings.get(expected.id);

              if (stored === undefined || !sameBooking(stored, expected)) {
                return { ok: false, reason: "changed" };
              }

              bookings.set(expected.id, { ...stored, ...changes });

              return { ok: true };
            },
          }),
      };
    }
  );
}
