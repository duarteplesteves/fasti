import { DrizzleQueryError, and, asc, eq, gt, lt, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgTable } from "drizzle-orm/pg-core";

import { defineAdapter } from "../../adapter/contract.js";
import type {
  Adapter,
  AdapterReads,
  BlockReads,
  BlockWrites,
  ListBookingsQuery,
  RecordReads,
  RecordWrites,
  SchemaAdapter,
} from "../../adapter/contract.js";
import { LOCK_NAMESPACE, isPgTransient } from "../../adapter/postgres-lock.js";
import { retryTransient } from "../../adapter/retry.js";
import { noOverlapConstraint } from "../../schema/backstop-sql.js";
import type { AnySchema, BlockSchema } from "../../schema/define-schema.js";
import { statusCodec } from "../../schema/status-codec.js";
import { tablesOf } from "../../schema/table.js";
import type { TableDef } from "../../schema/table.js";
import {
  decodeBlock,
  decodeBooking,
  decodeRecord,
  decodeRule,
  encodeBooking,
  encodeRecord,
  encodeRow,
  encodeRule,
} from "../codec.js";
import type { RecordRow, Row } from "../codec.js";
import { col, query, recordTable } from "../query.js";
import type { RecordTable as SharedRecordTable } from "../query.js";
import {
  availabilityRuleTable,
  blockTable,
  bookingTable,
  recordTables,
} from "./tables.js";

// oxlint-disable-next-line typescript/no-explicit-any -- any database, whatever its driver and relations.
type AnyPgDatabase = PgAsyncDatabase<any, any>;

/** The transaction type of `DB`, as its `transaction` callback receives it. */
type TxOf<DB extends AnyPgDatabase> = Parameters<
  Parameters<DB["transaction"]>[0]
>[0];

/** A Booking or Block table of this dialect. */
type RecordTable = SharedRecordTable<PgTable>;

/** The rows of `t` on the Resource overlapping the half-open range, sorted by `start`, then `id`. */
async function overlapping<S extends AnySchema>(
  q: AnyPgDatabase,
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
  return rows as Row[];
}

/** The row of `t` with this id, if any. */
async function byId(
  q: AnyPgDatabase,
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
  return row as Row | undefined;
}

/**
 * Compare-and-set (I4): write `changes` only if every stored column still equals `expected`, nulls included.
 * `true` when the row was updated; `false` when it changed or is gone.
 */
async function compareAndSet(
  q: AnyPgDatabase,
  t: RecordTable,
  expected: RecordRow,
  changes: RecordRow
): Promise<boolean> {
  const unchanged = Object.entries(expected).map(([key, value]) => {
    const c = col(t, key);

    return sql`${c} is not distinct from ${sql.param(value, c)}`;
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

/** A Plugin table: its definition and its Drizzle table. */
interface PluginTable {
  readonly def: TableDef;
  readonly t: RecordTable;
}

/** The Plugin tables of `schema`, by logical name; `table` looks one up, and throws on a table no Plugin declares. */
function pluginTablesOf(schema: AnySchema): (table: string) => PluginTable {
  const defs = tablesOf(schema.plugins);
  const tables: Readonly<Record<string, PgTable>> = recordTables(schema);

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
  q: AnyPgDatabase,
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

      // SAFETY: a record table's columns are the schema's, of the kinds RecordRow holds.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the table is typed generically.
      return (rows as RecordRow[]).map((row) => decodeRecord(def, row));
    },
  };
}

/** The record writes on `tx`. */
function recordWrites<S extends AnySchema>(
  tx: AnyPgDatabase,
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

/** The Drizzle Postgres Adapter, with the lock switchable for the negative control. Internal: use {@link drizzleAdapter}. */
export function createDrizzleAdapter<DB extends AnyPgDatabase>(
  db: DB,
  { lock }: CreateDrizzleAdapterParams
): Adapter<TxOf<DB>, "blocks" | "records"> {
  return defineAdapter(
    <S extends AnySchema>(
      schema: S
    ): SchemaAdapter<S, TxOf<DB>, "blocks" | "records"> => {
      const table = bookingTable(schema);
      const bookings = recordTable(table);
      const blocks = blockTableOf(schema);
      const rules = availabilityRuleTable(schema);
      const codec = statusCodec(schema);
      const noOverlap = noOverlapConstraint(schema);
      const pluginTable = pluginTablesOf(schema);

      function reads(
        q: AnyPgDatabase
      ): AdapterReads<S> & BlockReads<S> & RecordReads<S> {
        return {
          ...recordReads<S>(q, pluginTable),
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

      const singleAttempt: SchemaAdapter<S, TxOf<DB>, "blocks" | "records"> = {
        ...reads(db),
        withResourceLock: async (lockedId, work) =>
          await db.transaction(async (tx) => {
            if (lock) {
              // The Resource Lock (I2): held until COMMIT or ROLLBACK, so the transaction ending releases it.
              await query("withResourceLock", async () => {
                await tx.execute(
                  sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE}::int4, hashtext(${String(lockedId)}::text))`
                );
              });
            }

            /** Run a write in a savepoint, so a backstop overlap undoes only the write and `tx` stays usable. */
            async function backstopped<T>(
              verb: string,
              write: (sp: typeof tx) => Promise<T>
            ): Promise<T | "conflict"> {
              return await query(verb, async () => {
                try {
                  return await tx.transaction(async (sp) => await write(sp));
                } catch (error) {
                  // The backstop (I8) refusing an overlap: Postgres's exclusion_violation on fasti's constraint.
                  if (
                    error instanceof DrizzleQueryError &&
                    error.cause !== undefined &&
                    "code" in error.cause &&
                    error.cause.code === "23P01" &&
                    "constraint" in error.cause &&
                    error.cause.constraint === noOverlap
                  ) {
                    return "conflict";
                  }

                  throw error;
                }
              });
            }

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
              ...recordWrites<S>(tx, pluginTable),
              insertBooking: async (booking) => {
                // SAFETY: encodeBooking writes one value per column of bookingTable(schema).
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the row is built from the schema at runtime.
                const row = encodeBooking(
                  codec,
                  booking
                ) as typeof table.$inferInsert;

                const inserted = await backstopped(
                  "insertBooking",
                  async (sp) => {
                    await sp.insert(table).values(row);
                  }
                );

                return inserted === "conflict"
                  ? { ok: false, reason: "conflict" }
                  : { ok: true };
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
                const updated = await backstopped(
                  "updateBooking",
                  async (sp) =>
                    await compareAndSet(
                      sp,
                      bookings,
                      encodeBooking(codec, expected),
                      encodeBooking(codec, changes)
                    )
                );

                if (updated === "conflict") {
                  return { ok: false, reason: "conflict" };
                }

                return updated
                  ? { ok: true }
                  : { ok: false, reason: "changed" };
              },
            });
          }),
      };

      return {
        ...singleAttempt,
        // The whole unit reruns on a transient error, `work` and the developer's writes in `tx` included.
        withResourceLock: async (lockedId, work) =>
          await retryTransient(
            async () => await singleAttempt.withResourceLock(lockedId, work),
            isPgTransient
          ),
      };
    }
  );
}

/**
 * The Drizzle Postgres Adapter, over your tables made with {@link bookingTable},
 * {@link availabilityRuleTable}, {@link blockTable} if your schema declares `block`, and {@link recordTables} if its Plugins declare tables.
 * `tx` is Drizzle's own transaction, for your writes in the same unit of work.
 */
export function drizzleAdapter<DB extends AnyPgDatabase>(
  db: DB
): Adapter<TxOf<DB>, "blocks" | "records"> {
  return createDrizzleAdapter(db, { lock: true });
}
