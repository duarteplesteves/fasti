import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import type { SQLiteAsyncDatabase, SQLiteTable } from "drizzle-orm/sqlite-core";

import { defineAdapter } from "../../adapter/contract.js";
import type {
  Adapter,
  AdapterReads,
  ListBookingsQuery,
  LockedAdapter,
  RecordReads,
  RecordWrites,
  SchemaAdapter,
} from "../../adapter/contract.js";
import { serialize } from "../../adapter/queue.js";
import type { Serialize } from "../../adapter/queue.js";
import type { AnySchema } from "../../schema/define-schema.js";
import { statusCodec } from "../../schema/status-codec.js";
import { tablesOf } from "../../schema/table.js";
import type { TableDef } from "../../schema/table.js";
import {
  decodeBooking,
  decodeRecord,
  encodeBooking,
  encodeRecord,
} from "../codec.js";
import type { RecordRow, Row } from "../codec.js";
import { col, query, recordTable } from "../query.js";
import type { RecordTable as SharedRecordTable } from "../query.js";
import { bookingTable, recordTables } from "./tables.js";

/** A database on an async driver (libsql); a sync driver's `"sync"` database doesn't type-check. */
// oxlint-disable-next-line typescript/no-explicit-any -- any async database, whatever its run result and relations.
type AnyAsyncSQLiteDatabase = SQLiteAsyncDatabase<"async", any, any>;

/** The transaction type of `DB`, as its `transaction` callback receives it. */
type TxOf<DB extends AnyAsyncSQLiteDatabase> = Parameters<
  Parameters<DB["transaction"]>[0]
>[0];

/** A Booking or Plugin table of this dialect. */
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

  return row;
}

/**
 * Compare-and-set (I4): write `changes` only if every stored column still equals `expected`, nulls included.
 * `true` when the row was updated; `false` when it changed or is gone.
 */
async function compareAndSet(
  q: AnyAsyncSQLiteDatabase,
  t: RecordTable,
  expected: RecordRow,
  changes: RecordRow
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

/** A Plugin table: its definition and its Drizzle table. */
interface PluginTable {
  readonly def: TableDef;
  readonly t: RecordTable;
}

/** The Plugin tables of `schema`, by logical name; `table` looks one up, and throws on a table no Plugin declares. */
function pluginTablesOf(schema: AnySchema): (table: string) => PluginTable {
  const defs = tablesOf(schema.plugins);
  const tables: Readonly<Record<string, SQLiteTable>> = recordTables(schema);

  return (table) => {
    const def = defs[table];
    const t = tables[table];

    if (def === undefined || t === undefined) {
      throw new Error(`drizzleAdapter: no Plugin table "${table}"`);
    }

    return { def, t: recordTable(t) };
  };
}

/** The record reads over `q`. */
function recordReads<S extends AnySchema>(
  q: AnyAsyncSQLiteDatabase,
  pluginTable: (table: string) => PluginTable
): RecordReads<S> {
  return {
    getRecord: async (table, id) => {
      const { def, t } = pluginTable(table);
      const row = await query("getRecord", async () => await byId(q, t, id));

      return row === undefined ? null : decodeRecord(def, row);
    },
    listRecords: async (table, { overlapping: range, resourceId }) => {
      const { def, t } = pluginTable(table);

      const rows = await query(
        "listRecords",
        async () =>
          await q
            .select()
            .from(t.table)
            .where(
              and(
                eq(col(t, "resourceId"), resourceId),
                ...(range === undefined || !def.timed
                  ? []
                  : [
                      lt(col(t, "start"), new Date(range.to.epochMilliseconds)),
                      gt(col(t, "end"), new Date(range.from.epochMilliseconds)),
                    ])
              )
            )
            .orderBy(
              ...(def.timed ? [asc(col(t, "start"))] : []),
              asc(col(t, "id"))
            )
      );

      return rows.map((row) => decodeRecord(def, row));
    },
  };
}

/** The record writes on `tx`. */
function recordWrites<S extends AnySchema>(
  tx: AnyAsyncSQLiteDatabase,
  pluginTable: (table: string) => PluginTable
): RecordWrites<S> {
  return {
    deleteRecord: async (table, id) => {
      const { t } = pluginTable(table);

      const deleted = await query(
        "deleteRecord",
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
    insertRecord: async (table, record) => {
      const { t } = pluginTable(table);

      await query("insertRecord", async () => {
        await tx.insert(t.table).values(encodeRecord(record));
      });
    },
    replaceRecords: async (table, { records, resourceId }) => {
      const { t } = pluginTable(table);

      await query("replaceRecords", async () => {
        await tx.delete(t.table).where(eq(col(t, "resourceId"), resourceId));

        // Drizzle refuses an insert of no rows.
        if (records.length > 0) {
          await tx.insert(t.table).values(records.map(encodeRecord));
        }
      });
    },
    updateRecord: async (table, { changes, expected }) => {
      const { t } = pluginTable(table);

      const updated = await query(
        "updateRecord",
        async () =>
          await compareAndSet(
            tx,
            t,
            encodeRecord(expected),
            encodeRecord(changes)
          )
      );

      return updated ? { ok: true } : { ok: false, reason: "changed" };
    },
  };
}

/** The Drizzle SQLite Adapter, with the lock switchable for the negative control. Internal: use {@link drizzleAdapter}. */
export function createDrizzleAdapter<DB extends AnyAsyncSQLiteDatabase>(
  db: DB,
  { lock }: CreateDrizzleAdapterParams
): Adapter<TxOf<DB>, "records"> {
  return defineAdapter(
    <S extends AnySchema>(schema: S): SchemaAdapter<S, TxOf<DB>, "records"> => {
      const table = bookingTable(schema);
      const bookings = recordTable(table);
      const codec = statusCodec(schema);
      const pluginTable = pluginTablesOf(schema);

      function reads(
        q: AnyAsyncSQLiteDatabase
      ): AdapterReads<S> & RecordReads<S> {
        return {
          ...recordReads<S>(q, pluginTable),
          getBooking: async (id) => {
            const row = await query(
              "getBooking",
              async () => await byId(q, bookings, id)
            );

            return row === undefined ? null : decodeBooking<S>(codec, row);
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

      /** One unit in its own transaction: `BEGIN IMMEDIATE` takes SQLite's writer slot up front, `deferred` only on first write. */
      async function unit<T>(
        work: (locked: LockedAdapter<S, TxOf<DB>, "records">) => Promise<T>
      ): Promise<T> {
        return await db.transaction(
          async (tx) =>
            await work({
              ...reads(tx),
              ...recordWrites<S>(tx, pluginTable),
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
            }),
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
 * and {@link recordTables} if its Plugins declare tables (`availability()`'s and `blocks()`'s among them).
 * `tx` is Drizzle's own transaction, for your writes in the same unit of work.
 * Use a libsql *file* database on an async driver; leave libsql's `timeout` unset, as it blocks the event loop.
 * Write to the file from one process only: units in one process wait their turn, but another
 * process's writer makes a unit fail with `SQLITE_BUSY`.
 */
export function drizzleAdapter<DB extends AnyAsyncSQLiteDatabase>(
  db: DB
): Adapter<TxOf<DB>, "records"> {
  return createDrizzleAdapter(db, { lock: true });
}
