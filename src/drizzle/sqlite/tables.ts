import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { ResourceIdOf } from "../../adapter/records.js";
import { sqlLiteral } from "../../schema/backstop-sql.js";
import type { RecordColumn } from "../../schema/column.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { Accepts } from "../../schema/references.js";
import { statusCodec } from "../../schema/status-codec.js";
import {
  installedTable,
  physicalColumns,
  physicalTable,
  tablesOf,
} from "../../schema/table.js";
import type { Columns, TableDef, TableNamesOf } from "../../schema/table.js";

/**
 * Options of {@link bookingTable}.
 *
 * @typeParam C - The referenced column.
 */
export interface TableOptions<S extends AnySchema, C extends AnySQLiteColumn> {
  /**
   * Your Resource column, e.g. `() => staff.id`, for a foreign key with `ON DELETE RESTRICT`.
   * Its type must hold the schema's Resource id type. Without it there is no foreign key.
   */
  readonly references?: () => C & Accepts<C["_"]["data"], ResourceIdOf<S>>;
}

/**
 * A SQLite column of a schema column kind. Instants are integer milliseconds (I7); dates and times are ISO text,
 * JSON and dates lists JSON text, written with sorted keys by the codec, so equal values compare equal (R3).
 *
 * @returns The column builder.
 */
function sqliteColumn(type: RecordColumn, name: string) {
  switch (type.kind) {
    case "text":
    case "uuid":
    case "date":
    case "time": {
      return text(name);
    }

    case "json":
    case "dates": {
      return text(name, { mode: "json" });
    }

    case "integer": {
      return integer(name);
    }

    case "boolean": {
      return integer(name, { mode: "boolean" });
    }

    case "instant": {
      return integer(name, { mode: "timestamp_ms" });
    }

    default: {
      throw new Error(`Unknown column kind: ${JSON.stringify(type)}`);
    }
  }
}

/**
 * The `NOT NULL` Resource id column, with its foreign key when `references` is given.
 *
 * @returns The column builder.
 */
function resourceIdColumn<S extends AnySchema, C extends AnySQLiteColumn>(
  schema: S,
  name: string,
  options: TableOptions<S, C>
) {
  const col = sqliteColumn(schema.resource.idType, name).notNull();

  if (options.references !== undefined) {
    col.references(options.references, { onDelete: "restrict" });
  }

  return col;
}

/**
 * One column per Developer Field or Plugin table column, keyed by logical name; `NOT NULL` when required.
 *
 * @returns The column builders, by logical name.
 */
function fieldColumns(
  fields: Columns,
  names: Readonly<Partial<Record<string, string>>>
) {
  return Object.fromEntries(
    Object.entries(fields).map(([field, def]) => {
      const col = sqliteColumn(def.type, names[field] ?? field);

      return [field, def.required ? col.notNull() : col];
    })
  );
}

/**
 * The Booking table of `schema`, with your physical names, for your drizzle-kit schema file.
 * Columns are keyed by logical name. Status is `text` with a `CHECK` over its stored values,
 * so declaring a Status changes the table: generate a migration.
 *
 * @returns The Drizzle table.
 */
export function bookingTable<
  S extends AnySchema,
  C extends AnySQLiteColumn = AnySQLiteColumn,
>(schema: S, options: TableOptions<S, C> = {}) {
  const names = schema.names.columns.booking;

  const columns = {
    id: text(names.id).primaryKey(),
    resourceId: resourceIdColumn(schema, names.resourceId, options),
    start: sqliteColumn({ kind: "instant" }, names.start).notNull(),
    end: sqliteColumn({ kind: "instant" }, names.end).notNull(),
    status: text(names.status).notNull(),
    ...fieldColumns(schema.booking.fields, names),
  };

  const stored = statusCodec(schema).allStored.map(sqlLiteral).join(", ");
  const table = schema.names.tables.booking;

  return sqliteTable(table, columns, (self) => [
    // DDL takes no bind parameters, so the stored values go in as escaped literals.
    check(`${table}_status_check`, sql`${self.status} in (${sql.raw(stored)})`),
  ]);
}

/**
 * One Plugin table, with your physical names: `id` (fasti mints it; the default stays unless `idDefault: false`, as on 0.6's tables, R4), `resourceId`, a timed table's range, then its columns.
 *
 * @returns The Drizzle table.
 */
function pluginTable<S extends AnySchema, C extends AnySQLiteColumn>(
  schema: S,
  name: string,
  { columns, idDefault = true, timed }: TableDef,
  options: TableOptions<S, C>
) {
  const names = physicalColumns(schema, name);
  const id = text(names("id")).primaryKey();

  return sqliteTable(physicalTable(schema, name), {
    id: idDefault ? id.$defaultFn(() => randomUUID()) : id,
    resourceId: resourceIdColumn(schema, names("resourceId"), options),
    ...(timed && {
      start: sqliteColumn({ kind: "instant" }, names("start")).notNull(),
      end: sqliteColumn({ kind: "instant" }, names("end")).notNull(),
    }),
    ...fieldColumns(
      columns,
      Object.fromEntries(Object.keys(columns).map((c) => [c, names(c)]))
    ),
  });
}

/**
 * The tables of every Plugin `schema` installs, by logical name, for your drizzle-kit schema file.
 * Table and column names are your physical ones; columns are keyed by logical name. `references` gives each its Resource foreign key.
 *
 * @returns The Drizzle tables, by logical name.
 */
export function recordTables<
  S extends AnySchema,
  C extends AnySQLiteColumn = AnySQLiteColumn,
>(
  schema: S,
  options: TableOptions<S, C> = {}
): Readonly<
  Record<TableNamesOf<S["plugins"]>, ReturnType<typeof pluginTable<S, C>>>
> {
  // SAFETY: one entry per table the Plugins declare, which is all of TableNamesOf.
  return Object.fromEntries(
    Object.entries(tablesOf(schema.plugins)).map(([name, def]) => [
      name,
      pluginTable(schema, name, def, options),
    ])
  );
}

/**
 * `blocks()`'s Block table: `recordTables(schema).block`.
 *
 * @returns The Drizzle table.
 * @deprecated Use `recordTables(schema).block`; this alias goes in a later minor.
 * @throws When `schema` doesn't install `blocks()`.
 */
export function blockTable<
  S extends AnySchema,
  C extends AnySQLiteColumn = AnySQLiteColumn,
>(schema: S, options: TableOptions<S, C> = {}) {
  return installedTable<ReturnType<typeof pluginTable<S, C>>>(
    recordTables(schema, options),
    "block",
    "blockTable"
  );
}

/**
 * `availability()`'s AvailabilityRule table: `recordTables(schema).availabilityRule`.
 *
 * @returns The Drizzle table.
 * @deprecated Use `recordTables(schema).availabilityRule`; this alias goes in a later minor.
 * @throws When `schema` doesn't install `availability()`.
 */
export function availabilityRuleTable<
  S extends AnySchema,
  C extends AnySQLiteColumn = AnySQLiteColumn,
>(schema: S, options: TableOptions<S, C> = {}) {
  return installedTable<ReturnType<typeof pluginTable<S, C>>>(
    recordTables(schema, options),
    "availabilityRule",
    "availabilityRuleTable"
  );
}
