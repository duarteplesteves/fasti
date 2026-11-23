import { SQL, is } from "drizzle-orm";
import { PgDialect, getTableConfig as pgConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteConfig } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

// What drizzle-kit diffs, per table: the parity fixture (I8) is these snapshots of 0.6's tables.

/** A column's default as text: the SQL for a database default, `"defaultFn"` for one Drizzle runs, `null` for none. */
function defaultOf(column: {
  readonly hasDefault: boolean;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Drizzle's own default, of any kind.
  readonly default: unknown;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- only whether Drizzle has one.
  readonly defaultFn: object | undefined;
}): string | null {
  if (!column.hasDefault) {
    return null;
  }

  if (column.defaultFn !== undefined) {
    return "defaultFn";
  }

  return is(column.default, SQL)
    ? new PgDialect().sqlToQuery(column.default).sql
    : JSON.stringify(column.default);
}

/** A Postgres table as drizzle-kit sees it: names, SQL types, nullability, keys, defaults and foreign keys. */
export function pgSnapshot(table: PgTable) {
  const config = pgConfig(table);

  return {
    checks: config.checks.map((c) => c.name),
    columns: config.columns.map((c) => ({
      columnType: c.columnType,
      default: defaultOf(c),
      dimensions: c.dimensions,
      name: c.name,
      notNull: c.notNull,
      primary: c.primary,
      sqlType: c.getSQLType(),
    })),
    foreignKeys: config.foreignKeys.map((fk) => {
      const ref = fk.reference();

      return {
        columns: ref.columns.map((c) => c.name),
        foreignColumns: ref.foreignColumns.map((c) => c.name),
        foreignTable: pgConfig(ref.foreignTable).name,
        onDelete: fk.onDelete ?? null,
        onUpdate: fk.onUpdate ?? null,
      };
    }),
    indexes: config.indexes.length,
    name: config.name,
    uniques: config.uniqueConstraints.length,
  };
}

/** A SQLite table as drizzle-kit sees it, as {@link pgSnapshot}. */
export function sqliteSnapshot(table: SQLiteTable) {
  const config = sqliteConfig(table);

  return {
    checks: config.checks.map((c) => c.name),
    columns: config.columns.map((c) => ({
      columnType: c.columnType,
      default: defaultOf(c),
      name: c.name,
      notNull: c.notNull,
      primary: c.primary,
      sqlType: c.getSQLType(),
    })),
    foreignKeys: config.foreignKeys.map((fk) => {
      const ref = fk.reference();

      return {
        columns: ref.columns.map((c) => c.name),
        foreignColumns: ref.foreignColumns.map((c) => c.name),
        foreignTable: sqliteConfig(ref.foreignTable).name,
        onDelete: fk.onDelete ?? null,
        onUpdate: fk.onUpdate ?? null,
      };
    }),
    indexes: config.indexes.length,
    name: config.name,
    uniques: config.uniqueConstraints.length,
  };
}
