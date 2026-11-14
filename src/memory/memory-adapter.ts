import { defineAdapter } from "../adapter/contract.js";
import type {
  Adapter,
  AdapterReads,
  SchemaAdapter,
} from "../adapter/contract.js";
import type { BookingRecord } from "../adapter/records.js";
import type { BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";

// shortcut: verbs beyond the round-trip reject until #44 builds them.
function notYet(verb: string): () => Promise<never> {
  return async () => {
    throw new Error(`memoryAdapter: ${verb} is not implemented yet`);
  };
}

/** An Adapter that keeps everything in memory, for tests. `tx` is `undefined`: there is no transaction to join. */
export function memoryAdapter(): Adapter<undefined> {
  // One store per memoryAdapter() call, however many times it is bound to a schema.
  const bookings = new Map<BookingId, BookingRecord<AnySchema>>();

  return defineAdapter(
    <S extends AnySchema>(_schema: S): SchemaAdapter<S, undefined> => {
      const reads: AdapterReads<S> = {
        // SAFETY: every stored Booking was inserted through an adapter bound to this same schema.
        getBooking: async (id) =>
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store is shared across bindings, so it holds AnySchema records.
          (bookings.get(id) ?? null) as BookingRecord<S> | null,
        getRules: notYet("getRules"),
        listBookings: notYet("listBookings"),
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
            replaceRules: notYet("replaceRules"),
            tx: undefined,
            updateBooking: notYet("updateBooking"),
          }),
      };
    }
  );
}
