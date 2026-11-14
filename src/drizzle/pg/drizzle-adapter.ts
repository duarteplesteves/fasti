import { and, asc, eq, gt, lt } from "drizzle-orm";
import type { PgAsyncDatabase } from "drizzle-orm/pg-core";

import { defineAdapter } from "../../adapter/contract.js";
import type {
  Adapter,
  AdapterReads,
  SchemaAdapter,
} from "../../adapter/contract.js";
import type { AnySchema } from "../../schema/define-schema.js";
import { statusCodec } from "../../schema/status-codec.js";
import { decodeBooking, encodeBooking } from "./codec.js";
import { bookingTable } from "./tables.js";

// oxlint-disable-next-line typescript/no-explicit-any -- any database, whatever its driver and relations.
type AnyPgDatabase = PgAsyncDatabase<any, any>;

/** The transaction type of `DB`, as its `transaction` callback receives it. */
type TxOf<DB extends AnyPgDatabase> = Parameters<
  Parameters<DB["transaction"]>[0]
>[0];

function notYet(verb: string): () => Promise<never> {
  // shortcut: rules and updates arrive with #47; until then these verbs reject.
  // oxlint-disable-next-line require-await -- rejects without awaiting, like the verbs it stands in for.
  return async () => {
    throw new Error(`drizzleAdapter: ${verb} is not implemented yet`);
  };
}

/**
 * The Drizzle Postgres Adapter, over your tables made with {@link bookingTable}.
 * `tx` is Drizzle's own transaction, for your writes in the same unit of work.
 */
export function drizzleAdapter<DB extends AnyPgDatabase>(
  db: DB
): Adapter<TxOf<DB>> {
  return defineAdapter(
    <S extends AnySchema>(schema: S): SchemaAdapter<S, TxOf<DB>> => {
      const table = bookingTable(schema);
      const codec = statusCodec(schema);

      function reads(q: AnyPgDatabase): AdapterReads<S> {
        return {
          getBooking: async (id) => {
            const [row] = await q
              .select()
              .from(table)
              .where(eq(table.id, id))
              .limit(1);

            return row === undefined ? null : decodeBooking<S>(codec, row);
          },
          getRules: notYet("getRules"),
          listBookings: async ({ overlapping: { from, to }, resourceId }) => {
            const rows = await q
              .select()
              .from(table)
              .where(
                and(
                  eq(table.resourceId, resourceId),
                  lt(table.start, new Date(to.epochMilliseconds)),
                  gt(table.end, new Date(from.epochMilliseconds))
                )
              )
              .orderBy(asc(table.start), asc(table.id));

            return rows.map((row) => decodeBooking<S>(codec, row));
          },
        };
      }

      return {
        ...reads(db),
        // shortcut: a plain transaction; the advisory lock arrives with #48.
        withResourceLock: async (_resourceId, work) =>
          await db.transaction(
            async (tx) =>
              await work({
                ...reads(tx),
                insertBooking: async (booking) => {
                  // SAFETY: encodeBooking writes one value per column of bookingTable(schema).
                  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the row is built from the schema at runtime.
                  const row = encodeBooking(
                    codec,
                    booking
                  ) as typeof table.$inferInsert;

                  await tx.insert(table).values(row);

                  return { ok: true };
                },
                replaceRules: notYet("replaceRules"),
                // SAFETY: `tx` is what DB's own transaction callback receives, which TxOf<DB> names.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TS can't resolve TxOf<DB> for a generic DB.
                tx: tx as TxOf<DB>,
                updateBooking: notYet("updateBooking"),
              })
          ),
      };
    }
  );
}
