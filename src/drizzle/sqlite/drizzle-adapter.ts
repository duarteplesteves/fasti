import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import type { SQLiteAsyncDatabase, SQLiteTable } from "drizzle-orm/sqlite-core";

import { defineAdapter } from "../../adapter/contract.js";
import type {
  Adapter,
  AdapterReads,
  BlockReads,
  BlockWrites,
  ListBookingsQuery,
  LockedAdapter,
  SchemaAdapter,
} from "../../adapter/contract.js";
import { serialize } from "../../adapter/queue.js";
import type { Serialize } from "../../adapter/queue.js";
import type { AnySchema, BlockSchema } from "../../schema/define-schema.js";
import { statusCodec } from "../../schema/status-codec.js";
import {
  decodeBlock,
  decodeBooking,
  decodeRule,
  encodeBooking,
  encodeRow,
  encodeRule,
} from "../codec.js";
import type { Row } from "../codec.js";
import { col, query, recordTable } from "../query.js";
import type { RecordTable as SharedRecordTable } from "../query.js";
import { availabilityRuleTable, blockTable, bookingTable } from "./tables.js";

/** A database on an async driver (libsql); a sync driver's `"sync"` database doesn't type-check. */
// oxlint-disable-next-line typescript/no-explicit-any -- any async database, whatever its run result and relations.
type AnyAsyncSQLiteDatabase = SQLiteAsyncDatabase<"async", any, any>;

/** The transaction type of `DB`, as its `transaction` callback receives it. */
type TxOf<DB extends AnyAsyncSQLiteDatabase> = Parameters<
  Parameters<DB["transaction"]>[0]
>[0];

/** A Booking or Block table of this dialect. */
type RecordTable = SharedRecordTable<SQLiteTable>;

/** One line of units per Drizzle database object, shared by every Adapter and schema on it (I-lock-sqlite). */
const queues = new WeakMap<AnyAsyncSQLiteDatabase, Serialize>();

/** The line of units on `db`, made on first use. */
function queueOf(db: AnyAsyncSQLiteDatabase): Serialize {
  const existing = queues.get(db);

  if (existing !== undefined) {
    return existing;
  }

  const queue = serialize();

  queues.set(db, queue);

  return queue;
}

/** The rows of `t` on the Resource overlapping the half-open range, sorted by `start`, then `id`. */
async function overlapping<S extends AnySchema>(
  q: AnyAsyncSQLiteDatabase,
  t: RecordTable,
  { overlapping: { from, to }, resourceId }: ListBookingsQuery<S>
): Promise<Row[]> {
  const rows = await q
    .select()
    .from(t.table)
    .where(
      and(
        eq(col(t, "resourceId"), resourceId),
        lt(col(t, "start"), new Date(to.epochMilliseconds)),
        gt(col(t, "end"), new Date(from.epochMilliseconds))
      )
    )
    .orderBy(asc(col(t, "start")), asc(col(t, "id")));

  // SAFETY: a record table's columns are the schema's, of the kinds Row holds.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the table is typed generically.
  return rows;
}

/** The row of `t` with this id, if any. */
async function byId(
  q: AnyAsyncSQLiteDatabase,
  t: RecordTable,
  id: string
): Promise<Row | undefined> {
  const [row] = await q
    .select()
    .from(t.table)
    .where(eq(col(t, "id"), id))
    .limit(1);

  // SAFETY: as in overlapping.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the table is typed generically.
  return row;
}

/**
 * Compare-and-set (I4): write `changes` only if every stored column still equals `expected`, nulls included.
 * `true` when the row was updated; `false` when it changed or is gone.
 */
async function compareAndSet(
  q: AnyAsyncSQLiteDatabase,
  t: RecordTable,
  expected: Row,
  changes: Row
): Promise<boolean> {
  const unchanged = Object.entries(expected).map(([key, value]) => {
    const c = col(t, key);

    // SQLite's `is` is null-safe equality, as Postgres's `is not distinct from`.
    return sql`${c} is ${sql.param(value, c)}`;
  });

  const updated = await q
    .update(t.table)
    // `id` never changes; setting it keeps the SET non-empty when `changes` is.
    .set({ ...changes, id: expected["id"] })
    .where(and(...unchanged))
    .returning({ id: col(t, "id") });

  return updated.length === 1;
}

/** Params of {@link createDrizzleAdapter}. */
export interface CreateDrizzleAdapterParams {
  /** `false` skips the Resource Lock: only for the negative control, never exported publicly. */
  readonly lock: boolean;
}

/** The Block table of `schema`, or `null` when it declares no Blocks: then no table is built or needed. */
function blockTableOf(schema: AnySchema): RecordTable | null {
  if (schema.block === null) {
    return null;
  }

  // SAFETY: `block` isn't null, which is all BlockSchema adds.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the generic S can't narrow on the runtime check.
  return recordTable(blockTable(schema as BlockSchema));
}

/** The Drizzle SQLite Adapter, with the lock switchable for the negative control. Internal: use {@link drizzleAdapter}. */
export function createDrizzleAdapter<DB extends AnyAsyncSQLiteDatabase>(
  db: DB,
  { lock }: CreateDrizzleAdapterParams
): Adapter<TxOf<DB>, "blocks"> {
  return defineAdapter(
    <S extends AnySchema>(schema: S): SchemaAdapter<S, TxOf<DB>, "blocks"> => {
      const table = bookingTable(schema);
      const bookings = recordTable(table);
      const blocks = blockTableOf(schema);
      const rules = availabilityRuleTable(schema);
      const codec = statusCodec(schema);

      function reads(
        q: AnyAsyncSQLiteDatabase
      ): AdapterReads<S> & BlockReads<S> {
        return {
          getBlock: async (id) => {
            if (blocks === null) {
              return null;
            }

            const row = await query(
              "getBlock",
              async () => await byId(q, blocks, id)
            );

            return row === undefined ? null : decodeBlock<S>(row);
          },
          getBooking: async (id) => {
            const row = await query(
              "getBooking",
              async () => await byId(q, bookings, id)
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
          listBlocks: async (range) => {
            if (blocks === null) {
              return [];
            }

            const rows = await query(
              "listBlocks",
              async () => await overlapping(q, blocks, range)
            );

            return rows.map((row) => decodeBlock<S>(row));
          },
          listBookings: async (range) => {
            const rows = await query(
              "listBookings",
              async () => await overlapping(q, bookings, range)
            );

            return rows.map((row) => decodeBooking<S>(codec, row));
          },
        };
      }

      /** The Block table, for a write. */
      function blockWriteTable(verb: string): RecordTable {
        // shortcut: a schema without `block` has no Block table, and the Framework never calls a Block write for it
        // (its liftAdapter dies first), so this only guards direct misuse; keep it if a caller ever can reach it.
        if (blocks === null) {
          throw new Error(`drizzleAdapter: ${verb} on a schema without block`);
        }

        return blocks;
      }

      /** One unit in its own transaction: `BEGIN IMMEDIATE` takes SQLite's writer slot up front, `deferred` only on first write. */
      async function unit<T>(
        work: (locked: LockedAdapter<S, TxOf<DB>, "blocks">) => Promise<T>
      ): Promise<T> {
        return await db.transaction(
          async (tx) => {
            const blockWrites: BlockWrites<S> = {
              deleteBlock: async (id) => {
                const t = blockWriteTable("deleteBlock");

                const deleted = await query(
                  "deleteBlock",
                  async () =>
                    await tx
                      .delete(t.table)
                      .where(eq(col(t, "id"), id))
                      .returning({ id: col(t, "id") })
                );

                return deleted.length === 1
                  ? { ok: true }
                  : { ok: false, reason: "missing" };
              },
              insertBlock: async (block) => {
                const t = blockWriteTable("insertBlock");

                await query("insertBlock", async () => {
                  await tx.insert(t.table).values(encodeRow(block));
                });
              },
              updateBlock: async ({ changes, expected }) => {
                const t = blockWriteTable("updateBlock");

                const updated = await query(
                  "updateBlock",
                  async () =>
                    await compareAndSet(
                      tx,
                      t,
                      encodeRow(expected),
                      encodeRow(changes)
                    )
                );

                return updated
                  ? { ok: true }
                  : { ok: false, reason: "changed" };
              },
            };

            return await work({
              ...reads(tx),
              ...blockWrites,
              // No backstop on SQLite, so never `conflict`.
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
                const updated = await query(
                  "updateBooking",
                  async () =>
                    await compareAndSet(
                      tx,
                      bookings,
                      encodeBooking(codec, expected),
                      encodeBooking(codec, changes)
                    )
                );

                return updated
                  ? { ok: true }
                  : { ok: false, reason: "changed" };
              },
            });
          },
          { behavior: lock ? "immediate" : "deferred" }
        );
      }

      return {
        ...reads(db),
        // The Resource Lock (I2), two layers: units on one `db` in this process wait in line,
        // and `BEGIN IMMEDIATE` makes another process's writer wait. Units on any Resource share the line,
        // as SQLite's single writer slot makes them anyway.
        withResourceLock: async (_resourceId, work) =>
          lock
            ? await queueOf(db)(async () => await unit(work))
            : await unit(work),
      };
    }
  );
}

/**
 * The Drizzle SQLite Adapter, over your tables made with {@link bookingTable},
 * {@link availabilityRuleTable} and, if your schema declares `block`, {@link blockTable}.
 * `tx` is Drizzle's own transaction, for your writes in the same unit of work.
 * Use a libsql *file* database on an async driver; leave libsql's `timeout` unset, as it blocks the event loop.
 */
export function drizzleAdapter<DB extends AnyAsyncSQLiteDatabase>(
  db: DB
): Adapter<TxOf<DB>, "blocks"> {
  return createDrizzleAdapter(db, { lock: true });
}
