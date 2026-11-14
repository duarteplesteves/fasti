import {
  DrizzleQueryError,
  and,
  asc,
  eq,
  getColumns,
  gt,
  lt,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn, PgAsyncDatabase } from "drizzle-orm/pg-core";

import { defineAdapter } from "../../adapter/contract.js";
import type {
  Adapter,
  AdapterReads,
  SchemaAdapter,
} from "../../adapter/contract.js";
import type { AnySchema } from "../../schema/define-schema.js";
import { statusCodec } from "../../schema/status-codec.js";
import {
  decodeBooking,
  decodeRule,
  encodeBooking,
  encodeRule,
} from "./codec.js";
import { availabilityRuleTable, bookingTable } from "./tables.js";

// oxlint-disable-next-line typescript/no-explicit-any -- any database, whatever its driver and relations.
type AnyPgDatabase = PgAsyncDatabase<any, any>;

/** The transaction type of `DB`, as its `transaction` callback receives it. */
type TxOf<DB extends AnyPgDatabase> = Parameters<
  Parameters<DB["transaction"]>[0]
>[0];

/** Run a verb's queries; a driver failure rejects with the driver's own error as `cause`. */
async function query<T>(verb: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Drizzle wraps the driver's error; the cause is the driver's own (its `code`, `constraint`).
    const cause = error instanceof DrizzleQueryError ? error.cause : error;

    // oxlint-disable-next-line preserve-caught-error -- `cause` is the caught error, unwrapped from Drizzle's.
    throw new Error(`drizzleAdapter: ${verb} failed`, { cause });
  }
}

/**
 * The Drizzle Postgres Adapter, over your tables made with {@link bookingTable} and
 * {@link availabilityRuleTable}. `tx` is Drizzle's own transaction, for your writes in the same unit of work.
 */
export function drizzleAdapter<DB extends AnyPgDatabase>(
  db: DB
): Adapter<TxOf<DB>> {
  return defineAdapter(
    <S extends AnySchema>(schema: S): SchemaAdapter<S, TxOf<DB>> => {
      const table = bookingTable(schema);
      const columns: Readonly<Record<string, AnyPgColumn>> = getColumns(table);
      const rules = availabilityRuleTable(schema);
      const codec = statusCodec(schema);

      function reads(q: AnyPgDatabase): AdapterReads<S> {
        return {
          getBooking: async (id) => {
            const [row] = await query(
              "getBooking",
              async () =>
                await q.select().from(table).where(eq(table.id, id)).limit(1)
            );

            return row === undefined ? null : decodeBooking<S>(codec, row);
          },
          getRules: async (resourceId) => {
            const rows = await query(
              "getRules",
              async () =>
                await q
                  .select()
                  .from(rules)
                  .where(eq(rules.resourceId, resourceId))
            );

            return rows.map(decodeRule);
          },
          listBookings: async ({ overlapping: { from, to }, resourceId }) => {
            const rows = await query(
              "listBookings",
              async () =>
                await q
                  .select()
                  .from(table)
                  .where(
                    and(
                      eq(table.resourceId, resourceId),
                      lt(table.start, new Date(to.epochMilliseconds)),
                      gt(table.end, new Date(from.epochMilliseconds))
                    )
                  )
                  .orderBy(asc(table.start), asc(table.id))
            );

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

                  await query("insertBooking", async () => {
                    await tx.insert(table).values(row);
                  });

                  return { ok: true };
                },
                replaceRules: async ({ resourceId, rules: next }) => {
                  await query("replaceRules", async () => {
                    await tx
                      .delete(rules)
                      .where(eq(rules.resourceId, resourceId));

                    // Drizzle refuses an insert of no rows.
                    if (next.length > 0) {
                      await tx.insert(rules).values(
                        next.map((rule) => ({
                          ...encodeRule(rule),
                          resourceId,
                        }))
                      );
                    }
                  });
                },
                // SAFETY: `tx` is what DB's own transaction callback receives, which TxOf<DB> names.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TS can't resolve TxOf<DB> for a generic DB.
                tx: tx as TxOf<DB>,
                updateBooking: async ({ changes, expected }) => {
                  // Compare-and-set (I4): every stored column must still equal `expected`, nulls included.
                  const unchanged = Object.entries(
                    encodeBooking(codec, expected)
                  ).map(([key, value]) => {
                    const col = columns[key];

                    if (col === undefined) {
                      throw new Error(
                        `drizzleAdapter: Booking has no column "${key}"`
                      );
                    }

                    return sql`${col} is not distinct from ${sql.param(value, col)}`;
                  });

                  const updated = await query(
                    "updateBooking",
                    async () =>
                      await tx
                        .update(table)
                        // `id` never changes; setting it keeps the SET non-empty when `changes` is.
                        .set({
                          ...encodeBooking(codec, changes),
                          id: expected.id,
                        })
                        .where(and(...unchanged))
                        .returning({ id: table.id })
                  );

                  return updated.length === 1
                    ? { ok: true }
                    : { ok: false, reason: "changed" };
                },
              })
          ),
      };
    }
  );
}
