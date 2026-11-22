import type { FieldValues } from "../adapter/records.js";
import type { RecordColumn } from "./column.js";

/** A Plugin table column. */
export interface ColumnDef {
  /** The column type. */
  readonly type: RecordColumn;
  /** Whether a value is required; an optional column reads as `null` when unset. */
  readonly required: boolean;
}

/** Plugin table columns by logical name. */
export type Columns = Readonly<Record<string, ColumnDef>>;

/**
 * A Plugin table: its own columns, beside the fasti-owned `id` and `resourceId`, and on a timed table `start` and `end`.
 *
 * @typeParam C - Its columns.
 * @typeParam Tm - Whether it is timed.
 */
export interface TableDef<
  C extends Columns = Columns,
  Tm extends boolean = boolean,
> {
  /** `true`: each record has a half-open `start`/`end` range, owned by fasti, and lists can take `overlapping`. */
  readonly timed: Tm;
  /** The table's own columns; `required` maps to `NOT NULL`. None can be named `id`, `resourceId`, `start` or `end`. */
  readonly columns: C;
}

/** Plugin tables by logical name. */
export type Tables = Readonly<Record<string, TableDef>>;

declare const recordBrand: unique symbol;

/** The id of a record in Plugin table `T`: a UUIDv7 fasti mints, branded so ids of two tables can't mix. */
export type RecordId<T extends string> = string & {
  readonly [recordBrand]: T;
};

declare const resourceSlot: unique symbol;

/**
 * The Resource id in a Plugin's own types. A Plugin is written before any schema exists, so it can't name the
 * schema's id type; fasti puts that type in place of this one wherever it appears on the app's side.
 */
export interface PluginResourceId {
  readonly [resourceSlot]: "PluginResourceId";
}

/** A record of table `T` named `N`, as a Plugin sees it. */
export type RecordOf<N extends string, T extends TableDef> = {
  readonly id: RecordId<N>;
  readonly resourceId: PluginResourceId;
} & (T["timed"] extends true
  ? { readonly start: Temporal.Instant; readonly end: Temporal.Instant }
  : unknown) &
  Readonly<FieldValues<T["columns"]>>;

/** The columns fasti owns on every Plugin table: no table can declare one. */
const ownColumns = ["id", "resourceId", "start", "end"] as const;

/**
 * A Plugin, as `definePlugin` builds it and `defineSchema({ plugins })` installs it.
 *
 * @typeParam N - Its name: its Actions appear on `scheduler[N]`.
 * @typeParam T - Its tables.
 * @typeParam A - Its Actions, as written.
 */
export interface Plugin<
  N extends string = string,
  T extends Tables = Tables,
  A = unknown,
> {
  readonly name: N;
  readonly tables: T;
  readonly actions: A;
}

/** The logical names of every table the Plugins `Ps` declare. */
export type TableNamesOf<Ps extends readonly Plugin[]> =
  Ps[number] extends infer P
    ? P extends Plugin
      ? keyof P["tables"] & string
      : never
    : never;

/** Whether a schema's Plugins declare any table. */
export type HasTables<S extends { readonly plugins: readonly Plugin[] }> = [
  TableNamesOf<S["plugins"]>,
] extends [never]
  ? false
  : true;

/** The scheduler's own keys: a Plugin can't take one. */
const schedulerKeys = [
  "availability",
  "blocks",
  "book",
  "cancel",
  "findSlots",
  "reschedule",
  "transition",
] as const;

/** The scheduler's own keys, which no Plugin can be named. */
export type SchedulerKey = (typeof schedulerKeys)[number];

/** `unknown` when `Ps` can be installed together; `never` when a Plugin name repeats or is a scheduler key, or a table name repeats or is `booking`. */
export type InstallablePlugins<
  Ps extends readonly Plugin[],
  Names extends string = never,
  Taken extends string = "booking",
> = Ps extends readonly [
  infer H extends Plugin,
  ...infer Rest extends readonly Plugin[],
]
  ? [H["name"]] extends [Names | SchedulerKey]
    ? never
    : [keyof H["tables"] & Taken] extends [never]
      ? InstallablePlugins<
          Rest,
          Names | H["name"],
          Taken | (keyof H["tables"] & string)
        >
      : never
  : unknown;

/** Every table the Plugins declare, by logical name. */
export function tablesOf(plugins: readonly Plugin[]): Tables {
  return Object.fromEntries(plugins.flatMap((p) => Object.entries(p.tables)));
}

/** Throw when two Plugins share a name, a Plugin takes a scheduler key, two tables (or one and `booking`) share a name, or a table declares a column fasti owns. */
export function checkPlugins(plugins: readonly Plugin[]): void {
  const names = new Set<string>();
  const tables = new Set<string>();

  for (const { name, tables: own } of plugins) {
    if (schedulerKeys.some((k) => k === name)) {
      throw new Error(
        `defineSchema: a Plugin can't be named "${name}"; "${name}" is a scheduler key.`
      );
    }

    if (names.has(name)) {
      throw new Error(`defineSchema: two Plugins are named "${name}".`);
    }

    names.add(name);

    for (const table of Object.keys(own)) {
      if (table === "booking") {
        throw new Error(
          `defineSchema: Plugin "${name}" can't declare a table "booking"; "booking" is fasti's own table.`
        );
      }

      if (tables.has(table)) {
        throw new Error(`defineSchema: two tables are named "${table}".`);
      }

      tables.add(table);

      const taken = ownColumns.find((c) =>
        Object.hasOwn(own[table]?.columns ?? {}, c)
      );

      if (taken !== undefined) {
        throw new Error(
          `defineSchema: table "${table}" can't declare a column "${taken}"; "${taken}" is a column fasti owns.`
        );
      }
    }
  }
}
