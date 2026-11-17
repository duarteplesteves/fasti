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
import type {
  AnyPgColumn,
  PgAsyncDatabase,
  PgTable,
} from "drizzle-orm/pg-core";

import { defineAdapter } from "../../adapter/contract.js";
import type {
  Adapter,
  AdapterReads,
  BlockReads,
  BlockWrites,
  ListBookingsQuery,
  SchemaAdapter,
} from "../../adapter/contract.js";
import type { AnySchema, BlockSchema } from "../../schema/define-schema.js";
import { statusCodec } from "../../schema/status-codec.js";
import { noOverlapConstraint } from "./backstop.js";
import {
  decodeBlock,
  decodeBooking,
  decodeRule,
  encodeBooking,
  encodeRow,
  encodeRule,
} from "./codec.js";
import type { Row } from "./codec.js";
import { availabilityRuleTable, blockTable, bookingTable } from "./tables.js";

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

/** The first key of every fasti advisory lock ("fsti" in ASCII), so other advisory locks in the database don't collide. */
const LOCK_NAMESPACE = 0x66_73_74_69;

/** Attempts at a unit of work that fails with a transient error, the first included. */
const MAX_ATTEMPTS = 3;

/** 40001 serialization_failure or 40P01 deadlock_detected, found anywhere on the `cause` chain. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejection reason is whatever was thrown.
function isTransient(error: unknown): boolean {
  for (let e = error; e instanceof Object; e = "cause" in e ? e.cause : null) {
    if ("code" in e && (e.code === "40001" || e.code === "40P01")) {
      return true;
    }
  }

  return false;
}

/** Run `unit`, rerunning the whole of it on a transient error (ADR 008), up to {@link MAX_ATTEMPTS} times. */
async function retryTransient<T>(unit: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- attempts run one after another.
      return await unit();
    } catch (error) {
      if (!isTransient(error) || attempt === MAX_ATTEMPTS) {
        throw error;
      }
    }
  }
}

/** A Booking or Block table, with its columns keyed by logical name. */
interface RecordTable {
  readonly table: PgTable;
  readonly columns: Readonly<Record<string, AnyPgColumn>>;
}

/** A Booking or Block table and its columns, keyed by logical name. */
function recordTable(table: PgTable): RecordTable {
  return { columns: getColumns(table), table };
}

/** A logical column of a record table; every record table has `id`, `resourceId`, `start`, `end`. */
function col({ columns }: RecordTable, key: string): AnyPgColumn {
  const c = columns[key];

  if (c === undefined) {
    throw new Error(`drizzleAdapter: no column "${key}"`);
  }

  return c;
}

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
  expected: Row,
  changes: Row
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

/** The Drizzle Postgres Adapter, with the lock switchable for the negative control. Internal: use {@link drizzleAdapter}. */
export function createDrizzleAdapter<DB extends AnyPgDatabase>(
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
      const noOverlap = noOverlapConstraint(schema);

      function reads(q: AnyPgDatabase): AdapterReads<S> & BlockReads<S> {
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

      const once: SchemaAdapter<S, TxOf<DB>, "blocks"> = {
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
        ...once,
        // The whole unit reruns on a transient error, `work` and the developer's writes in `tx` included.
        withResourceLock: async (lockedId, work) =>
          await retryTransient(
            async () => await once.withResourceLock(lockedId, work)
          ),
      };
    }
  );
}

/**
 * The Drizzle Postgres Adapter, over your tables made with {@link bookingTable},
 * {@link availabilityRuleTable} and, if your schema declares `block`, {@link blockTable}.
 * `tx` is Drizzle's own transaction, for your writes in the same unit of work.
 */
export function drizzleAdapter<DB extends AnyPgDatabase>(
  db: DB
): Adapter<TxOf<DB>, "blocks"> {
  return createDrizzleAdapter(db, { lock: true });
}
