import type { PostgresClient } from "@prisma/orm-postgres/runtime";

import { defineAdapter } from "../adapter/contract.js";
import type {
  Adapter,
  AdapterReads,
  BlockReads,
  BlockWrites,
  ListBookingsQuery,
  RecordReads,
  RecordWrites,
  SchemaAdapter,
} from "../adapter/contract.js";
import { LOCK_NAMESPACE, isPgTransient } from "../adapter/postgres-lock.js";
import { retryTransient } from "../adapter/retry.js";
import { noOverlapConstraint } from "../schema/backstop-sql.js";
import type { AnySchema } from "../schema/define-schema.js";
import { statusCodec } from "../schema/status-codec.js";
import { physicalColumns, physicalTable, tablesOf } from "../schema/table.js";
import type { TableDef } from "../schema/table.js";
import {
  decodeBlock,
  decodeBooking,
  decodeRule,
  decodeStored,
  encodeBooking,
  encodeRecord,
  encodeRule,
  encodeStored,
  physical,
} from "./codec.js";
import type { ColumnNames, PrismaRow, PrismaValue } from "./codec.js";

// oxlint-disable-next-line typescript/no-explicit-any -- any client, whatever its contract and collections.
type AnyPostgresClient = PostgresClient<any, any>;

/** The transaction type of `DB`, as its `transaction` callback receives it. */
type PrismaTxOf<DB extends AnyPostgresClient> = Parameters<
  Parameters<DB["transaction"]>[0]
>[0];

/** A client or a transaction: both run plans, and build them over the same contract. */
type Queryable = Pick<AnyPostgresClient, "execute" | "query" | "raw" | "sql">;

/** A plan, as `query` and `execute` take it. */
type Plan = Parameters<Queryable["query"]>[0];

/** A column or a condition of the SQL builder; opaque here. */
interface Expression {
  readonly buildAst: () => object;
}

/** The column proxy of a `where` callback, keyed by physical column name. */
type Fields = Readonly<Partial<Record<string, Expression>>>;

/** The operators of a `where` callback that fasti uses. */
interface Fns {
  readonly and: (...conditions: Expression[]) => Expression;
  readonly eq: (column: Expression, value: PrismaValue) => Expression;
  readonly gt: (column: Expression, value: PrismaValue) => Expression;
  readonly lt: (column: Expression, value: PrismaValue) => Expression;
}

/** Builds a `WHERE` from the column proxy and the operators. */
type Where = (f: Fields, fns: Fns) => Expression;

/** A buildable statement. */
interface Buildable {
  readonly build: () => Plan;
}

/** A statement that can return columns. */
interface Returning extends Buildable {
  readonly returning: (...columns: string[]) => Buildable;
}

/**
 * The part of a `tx.sql` table builder fasti uses. Untyped: a table looked up by a name only known
 * at runtime has no contract type (strategy (a), #140). Columns are addressed by physical name.
 */
interface AnyTable {
  readonly insert: (rows: readonly PrismaRow[]) => Buildable;
  readonly select: (...columns: string[]) => {
    readonly where: (where: Where) => Buildable & {
      readonly orderBy: (
        column: string,
        options: { readonly direction: "asc" }
      ) => Buildable & {
        readonly orderBy: (
          column: string,
          options: { readonly direction: "asc" }
        ) => Buildable;
      };
    };
  };
  readonly update: (set: PrismaRow) => {
    readonly where: (where: Where) => Returning;
  };
  readonly delete: () => { readonly where: (where: Where) => Returning };
}

/** The table builder of physical table `name` on `q`. */
function tableOf(q: Queryable, name: string): AnyTable {
  // SAFETY: prismaModels puts every fasti table in the contract; tx.sql.public is keyed by physical table name.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- the typed builder can't be indexed by a runtime string.
  const tables = q.sql["public"] as unknown as Readonly<
    Partial<Record<string, AnyTable>>
  >;

  const table = tables[name];

  if (table === undefined) {
    throw new Error(
      `prismaAdapter: no table "${name}" in the contract; spread prismaModels(schema, helpers) into it`
    );
  }

  return table;
}

/** The column `name` of a `where` callback's column proxy. */
function ref(f: Fields, name: string): Expression {
  const column = f[name];

  if (column === undefined) {
    throw new Error(`prismaAdapter: no column "${name}" on the table builder`);
  }

  return column;
}

/** Run a verb's queries; a driver failure rejects with Prisma's error as `cause`. */
async function query<T>(verb: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`prismaAdapter: ${verb} failed`, { cause: error });
  }
}

/** The rows of a row-returning plan. */
async function rowsOf(q: Queryable, plan: Plan): Promise<readonly PrismaRow[]> {
  // SAFETY: the plan reads fasti's columns, decoded by the contract's codecs into PrismaValues.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the table is looked up untyped.
  return (await q.query(plan)) as readonly PrismaRow[];
}

/** A fasti table: its physical name and its columns, logical → physical. */
interface PhysicalTable {
  readonly name: string;
  readonly names: ColumnNames;
}

/** The rows of `t` on the Resource overlapping the half-open range, sorted by `start`, then `id`. */
async function overlapping<S extends AnySchema>(
  q: Queryable,
  { name, names }: PhysicalTable,
  { overlapping: { from, to }, resourceId }: ListBookingsQuery<S>
): Promise<readonly PrismaRow[]> {
  const plan = tableOf(q, name)
    .select(...Object.values(names))
    .where((f, fns) =>
      fns.and(
        fns.eq(ref(f, physical(names, "resourceId")), resourceId),
        fns.lt(ref(f, physical(names, "start")), to),
        fns.gt(ref(f, physical(names, "end")), from)
      )
    )
    .orderBy(physical(names, "start"), { direction: "asc" })
    .orderBy(physical(names, "id"), { direction: "asc" })
    .build();

  return await rowsOf(q, plan);
}

/** The row of `t` with this id, if any. */
async function byId(
  q: Queryable,
  { name, names }: PhysicalTable,
  id: string
): Promise<PrismaRow | undefined> {
  const plan = tableOf(q, name)
    .select(...Object.values(names))
    .where((f, fns) => fns.eq(ref(f, physical(names, "id")), id))
    .build();

  const [row] = await rowsOf(q, plan);

  return row;
}

/**
 * Compare-and-set (I4): write `changes` only if every stored column still equals `expected`; `eq` with
 * `null` renders `IS NULL`. `true` when the row was updated; `false` when it changed or is gone.
 */
async function compareAndSet(
  q: Queryable,
  { name, names }: PhysicalTable,
  expected: PrismaRow,
  changes: PrismaRow
): Promise<boolean> {
  const id = physical(names, "id");

  const plan = tableOf(q, name)
    // `id` never changes; setting it keeps the SET non-empty when `changes` is.
    .update({ ...changes, [id]: expected[id] ?? null })
    .where((f, fns) =>
      fns.and(
        ...Object.entries(expected).map(([column, value]) =>
          fns.eq(ref(f, column), value)
        )
      )
    )
    .returning(id)
    .build();

  const updated = await rowsOf(q, plan);

  return updated.length === 1;
}

/** A Plugin table: its definition and its physical table. */
interface PluginTable {
  readonly def: TableDef;
  readonly t: PhysicalTable;
}

/** The Plugin tables of `schema`, by logical name; `table` looks one up, and throws on a table no Plugin declares. */
function pluginTablesOf(schema: AnySchema): (table: string) => PluginTable {
  const defs = tablesOf(schema.plugins);

  return (table) => {
    const def = defs[table];

    if (def === undefined) {
      throw new Error(`prismaAdapter: no Plugin table "${table}"`);
    }

    const names = physicalColumns(schema, table);

    const columns = [
      "id",
      "resourceId",
      ...(def.timed ? ["start", "end"] : []),
      ...Object.keys(def.columns),
    ];

    return {
      def,
      t: {
        name: physicalTable(schema, table),
        names: Object.fromEntries(columns.map((c) => [c, names(c)])),
      },
    };
  };
}

/** The record reads over `q`. */
function recordReads<S extends AnySchema>(
  q: Queryable,
  pluginTable: (table: string) => PluginTable
): RecordReads<S> {
  return {
    getRecord: async (table, id) => {
      const { def, t } = pluginTable(table);
      const row = await query("getRecord", async () => await byId(q, t, id));

      return row === undefined ? null : decodeStored(def, t.names, row);
    },
    listRecords: async (table, { overlapping: range, resourceId }) => {
      const { def, t } = pluginTable(table);

      const rows = await query("listRecords", async () => {
        if (def.timed && range !== undefined) {
          return await overlapping(q, t, { overlapping: range, resourceId });
        }

        const select = tableOf(q, t.name)
          .select(...Object.values(t.names))
          .where((f, fns) =>
            fns.eq(ref(f, physical(t.names, "resourceId")), resourceId)
          );

        const id = physical(t.names, "id");

        const plan = def.timed
          ? select
              .orderBy(physical(t.names, "start"), { direction: "asc" })
              .orderBy(id, { direction: "asc" })
              .build()
          : select.orderBy(id, { direction: "asc" }).build();

        return await rowsOf(q, plan);
      });

      return rows.map((row) => decodeStored(def, t.names, row));
    },
  };
}

/** The record writes on `tx`. */
function recordWrites<S extends AnySchema>(
  tx: Queryable,
  pluginTable: (table: string) => PluginTable
): RecordWrites<S> {
  return {
    deleteRecord: async (table, id) => {
      const { t } = pluginTable(table);

      const deleted = await query("deleteRecord", async () => {
        const plan = tableOf(tx, t.name)
          .delete()
          .where((f, fns) => fns.eq(ref(f, physical(t.names, "id")), id))
          .returning(physical(t.names, "id"))
          .build();

        return await rowsOf(tx, plan);
      });

      return deleted.length === 1
        ? { ok: true }
        : { ok: false, reason: "missing" };
    },
    insertRecord: async (table, record) => {
      const { t } = pluginTable(table);

      await query("insertRecord", async () => {
        await tx.execute(
          tableOf(tx, t.name)
            .insert([encodeStored(t.names, record)])
            .build()
        );
      });
    },
    replaceRecords: async (table, { records, resourceId }) => {
      const { t } = pluginTable(table);

      await query("replaceRecords", async () => {
        const builder = tableOf(tx, t.name);

        await tx.execute(
          builder
            .delete()
            .where((f, fns) =>
              fns.eq(ref(f, physical(t.names, "resourceId")), resourceId)
            )
            .build()
        );

        if (records.length > 0) {
          await tx.execute(
            builder.insert(records.map((r) => encodeStored(t.names, r))).build()
          );
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
            encodeStored(t.names, expected),
            encodeStored(t.names, changes)
          )
      );

      return updated ? { ok: true } : { ok: false, reason: "changed" };
    },
  };
}

/** Params of {@link createPrismaAdapter}. */
export interface CreatePrismaAdapterParams {
  /** `false` skips the Resource Lock: only for the negative control, never exported publicly. */
  readonly lock: boolean;
}

/** The Prisma Adapter, with the lock switchable for the negative control. Internal: use {@link prismaAdapter}. */
export function createPrismaAdapter<DB extends AnyPostgresClient>(
  db: DB,
  { lock }: CreatePrismaAdapterParams
): Adapter<PrismaTxOf<DB>, "blocks" | "records"> {
  return defineAdapter(
    <S extends AnySchema>(
      schema: S
    ): SchemaAdapter<S, PrismaTxOf<DB>, "blocks" | "records"> => {
      const { columns, tables } = schema.names;
      const codec = statusCodec(schema);
      const noOverlap = noOverlapConstraint(schema);
      const pluginTable = pluginTablesOf(schema);

      const bookings: PhysicalTable = {
        name: tables.booking,
        names: columns.booking,
      };

      const blocks: PhysicalTable | null =
        schema.block === null
          ? null
          : { name: tables.block, names: columns.block };

      const rules: PhysicalTable = {
        name: tables.availabilityRule,
        names: columns.availabilityRule,
      };

      /** The Block table, for a write. */
      function blockWriteTable(verb: string): PhysicalTable {
        // shortcut: a schema without `block` has no Block table, and the Framework never calls a Block write for it
        // (its liftAdapter dies first), so this only guards direct misuse; keep it if a caller ever can reach it.
        if (blocks === null) {
          throw new Error(`prismaAdapter: ${verb} on a schema without block`);
        }

        return blocks;
      }

      function reads(
        q: Queryable
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

            return row === undefined ? null : decodeBlock<S>(blocks.names, row);
          },
          getBooking: async (id) => {
            const row = await query(
              "getBooking",
              async () => await byId(q, bookings, id)
            );

            return row === undefined
              ? null
              : decodeBooking<S>(codec, bookings.names, row);
          },
          getRules: async (resourceId) => {
            const rows = await query("getRules", async () => {
              const plan = tableOf(q, rules.name)
                .select(...Object.values(rules.names))
                .where((f, fns) =>
                  fns.eq(
                    ref(f, physical(rules.names, "resourceId")),
                    resourceId
                  )
                )
                .build();

              return await rowsOf(q, plan);
            });

            return rows.map((row) => decodeRule(rules.names, row));
          },
          listBlocks: async (range) => {
            if (blocks === null) {
              return [];
            }

            const rows = await query(
              "listBlocks",
              async () => await overlapping(q, blocks, range)
            );

            return rows.map((row) => decodeBlock<S>(blocks.names, row));
          },
          listBookings: async (range) => {
            const rows = await query(
              "listBookings",
              async () => await overlapping(q, bookings, range)
            );

            return rows.map((row) =>
              decodeBooking<S>(codec, bookings.names, row)
            );
          },
        };
      }

      const singleAttempt: SchemaAdapter<
        S,
        PrismaTxOf<DB>,
        "blocks" | "records"
      > = {
        ...reads(db),
        withResourceLock: async (lockedId, work) =>
          await db.transaction(async (tx: Queryable) => {
            if (lock) {
              // The Resource Lock (I2, I-lock-pg): the unit's first statement, held until COMMIT or ROLLBACK.
              await query("withResourceLock", async () => {
                await tx.execute(
                  tx.raw
                    .sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE}::int4, hashtext(${String(lockedId)}::text))`
                    .affectedCount()
                    .build()
                );
              });
            }

            /** Run a write in a savepoint, so a backstop overlap undoes only the write and `tx` stays usable. */
            async function backstopped<T>(
              verb: string,
              write: () => Promise<T>
            ): Promise<T | "conflict"> {
              return await query(verb, async () => {
                // Prisma's `tx` has no nested transaction, so the savepoint is raw.
                await tx.execute(
                  tx.raw.sql`savepoint fasti_backstop`.affectedCount().build()
                );

                try {
                  const result = await write();

                  await tx.execute(
                    tx.raw.sql`release savepoint fasti_backstop`
                      .affectedCount()
                      .build()
                  );

                  return result;
                } catch (error) {
                  // The backstop (I8) refusing an overlap: exclusion_violation on fasti's constraint, which Prisma's SqlQueryError names.
                  if (
                    error instanceof Object &&
                    "sqlState" in error &&
                    error.sqlState === "23P01" &&
                    "constraint" in error &&
                    error.constraint === noOverlap
                  ) {
                    await tx.execute(
                      tx.raw.sql`rollback to savepoint fasti_backstop`
                        .affectedCount()
                        .build()
                    );

                    return "conflict";
                  }

                  throw error;
                }
              });
            }

            const blockWrites: BlockWrites<S> = {
              deleteBlock: async (id) => {
                const { name, names } = blockWriteTable("deleteBlock");

                const deleted = await query("deleteBlock", async () => {
                  const plan = tableOf(tx, name)
                    .delete()
                    .where((f, fns) =>
                      fns.eq(ref(f, physical(names, "id")), id)
                    )
                    .returning(physical(names, "id"))
                    .build();

                  return await rowsOf(tx, plan);
                });

                return deleted.length === 1
                  ? { ok: true }
                  : { ok: false, reason: "missing" };
              },
              insertBlock: async (block) => {
                const { name, names } = blockWriteTable("insertBlock");

                await query("insertBlock", async () => {
                  await tx.execute(
                    tableOf(tx, name)
                      .insert([encodeRecord(names, block)])
                      .build()
                  );
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
                      encodeRecord(t.names, expected),
                      encodeRecord(t.names, changes)
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
                const inserted = await backstopped(
                  "insertBooking",
                  async () => {
                    await tx.execute(
                      tableOf(tx, bookings.name)
                        .insert([encodeBooking(codec, bookings.names, booking)])
                        .build()
                    );
                  }
                );

                return inserted === "conflict"
                  ? { ok: false, reason: "conflict" }
                  : { ok: true };
              },
              replaceRules: async ({ resourceId, rules: next }) => {
                await query("replaceRules", async () => {
                  const t = tableOf(tx, rules.name);
                  const resource = physical(rules.names, "resourceId");

                  await tx.execute(
                    t
                      .delete()
                      .where((f, fns) => fns.eq(ref(f, resource), resourceId))
                      .build()
                  );

                  if (next.length > 0) {
                    await tx.execute(
                      t
                        .insert(
                          next.map((rule) => ({
                            ...encodeRule(rules.names, rule),
                            [resource]: resourceId,
                          }))
                        )
                        .build()
                    );
                  }
                });
              },
              // SAFETY: `tx` is what DB's own transaction callback receives, which PrismaTxOf<DB> names.
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TS can't resolve PrismaTxOf<DB> for a generic DB.
              tx: tx as PrismaTxOf<DB>,
              updateBooking: async ({ changes, expected }) => {
                const updated = await backstopped(
                  "updateBooking",
                  async () =>
                    await compareAndSet(
                      tx,
                      bookings,
                      encodeBooking(codec, bookings.names, expected),
                      encodeBooking(codec, bookings.names, changes)
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
 * The Prisma Adapter, over the tables {@link prismaModels} put in your contract, Plugin tables included. `tx` is Prisma's
 * own transaction, for your writes in the same unit of work.
 *
 * @experimental While Prisma 8 is a release candidate.
 */
export function prismaAdapter<DB extends AnyPostgresClient>(
  db: DB
): Adapter<PrismaTxOf<DB>, "blocks" | "records"> {
  return createPrismaAdapter(db, { lock: true });
}
