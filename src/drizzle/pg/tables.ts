import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
export interface TableOptions<S extends AnySchema, C extends AnyPgColumn> {
  /**
   * Your Resource column, e.g. `() => staff.id`, for a foreign key with `ON DELETE RESTRICT`.
   * Its type must hold the schema's Resource id type. Without it there is no foreign key.
   */
  readonly references?: () => C & Accepts<C["_"]["data"], ResourceIdOf<S>>;
}

/**
 * A Postgres column of a schema column kind. Instants are `timestamptz` to the millisecond (I7);
 * dates are `date` strings, times `time`, JSON `jsonb` (compared by value), dates lists `date[]`.
 *
 * @returns The column builder.
 */
function pgColumn(type: RecordColumn, name: string) {
  switch (type.kind) {
    case "date": {
      return date(name, { mode: "string" });
    }

    case "time": {
      return time(name);
    }

    case "json": {
      return jsonb(name);
    }

    case "dates": {
      return date(name, { mode: "string" }).array();
    }

    case "text": {
      return text(name);
    }

    case "uuid": {
      return uuid(name);
    }

    case "integer": {
      return integer(name);
    }

    case "boolean": {
      return boolean(name);
    }

    case "instant": {
      return timestamp(name, {
        mode: "date",
        precision: 3,
        withTimezone: true,
      });
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
function resourceIdColumn<S extends AnySchema, C extends AnyPgColumn>(
  schema: S,
  name: string,
  options: TableOptions<S, C>
) {
  const col = pgColumn(schema.resource.idType, name).notNull();

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
      const col = pgColumn(def.type, names[field] ?? field);

      return [field, def.required ? col.notNull() : col];
    })
  );
}

/**
 * The Booking table of `schema`, with your physical names, for your drizzle-kit schema file.
 * Columns are keyed by logical name. Status is `text` with a `CHECK` over its stored values,
 * so declaring a Status changes the table: generate a migration, and re-run `backstopSql` if it blocks.
 *
 * @returns The Drizzle table.
 */
export function bookingTable<
  S extends AnySchema,
  C extends AnyPgColumn = AnyPgColumn,
>(schema: S, options: TableOptions<S, C> = {}) {
  const names = schema.names.columns.booking;

  const resourceId = resourceIdColumn(schema, names.resourceId, options);

  const columns = {
    id: uuid(names.id).primaryKey(),
    resourceId,
    start: pgColumn({ kind: "instant" }, names.start).notNull(),
    end: pgColumn({ kind: "instant" }, names.end).notNull(),
    status: text(names.status).notNull(),
    ...fieldColumns(schema.booking.fields, names),
  };

  const stored = statusCodec(schema).allStored.map(sqlLiteral).join(", ");
  const table = schema.names.tables.booking;

  return pgTable(table, columns, (self) => [
    index(`${table}_resource_start_idx`).on(self.resourceId, self.start),
    // DDL takes no bind parameters, so the stored values go in as escaped literals.
    check(`${table}_status_check`, sql`${self.status} in (${sql.raw(stored)})`),
  ]);
}

/**
 * One Plugin table, with your physical names: `id` (fasti mints it; the database default stays unless `idDefault: false`, as on 0.6's tables, R4), `resourceId`, a timed table's range, then its columns. Indexed by Resource, and `start` when timed.
 *
 * @returns The Drizzle table.
 */
function pluginTable<S extends AnySchema, C extends AnyPgColumn>(
  schema: S,
  name: string,
  { columns, idDefault = true, timed }: TableDef,
  options: TableOptions<S, C>
) {
  const names = physicalColumns(schema, name);
  const id = uuid(names("id")).primaryKey();

  const table = physicalTable(schema, name);

  return pgTable(
    table,
    {
      id: idDefault ? id.defaultRandom() : id,
      resourceId: resourceIdColumn(schema, names("resourceId"), options),
      ...(timed && {
        start: pgColumn({ kind: "instant" }, names("start")).notNull(),
        end: pgColumn({ kind: "instant" }, names("end")).notNull(),
      }),
      ...fieldColumns(
        columns,
        Object.fromEntries(Object.keys(columns).map((c) => [c, names(c)]))
      ),
    },
    (self) => [
      self.start === undefined
        ? index(`${table}_resource_idx`).on(self.resourceId)
        : index(`${table}_resource_start_idx`).on(self.resourceId, self.start),
    ]
  );
}

/**
 * The tables of every Plugin `schema` installs, by logical name, for your drizzle-kit schema file.
 * Table and column names are your physical ones; columns are keyed by logical name. `references` gives each its Resource foreign key.
 *
 * @returns The Drizzle tables, by logical name.
 */
export function recordTables<
  S extends AnySchema,
  C extends AnyPgColumn = AnyPgColumn,
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
  C extends AnyPgColumn = AnyPgColumn,
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
  C extends AnyPgColumn = AnyPgColumn,
>(schema: S, options: TableOptions<S, C> = {}) {
  return installedTable<ReturnType<typeof pluginTable<S, C>>>(
    recordTables(schema, options),
    "availabilityRule",
    "availabilityRuleTable"
  );
}
