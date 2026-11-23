import type { FieldValues } from "../adapter/records.js";
import type { RecordId } from "../core/types.js";
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
  /** Whether the table keeps a database default on `id` (fasti mints ids either way); defaults to `true`. `false` only to match a table that never had one. */
  readonly idDefault?: boolean;
}

/** Plugin tables by logical name. */
export type Tables = Readonly<Record<string, TableDef>>;

export type { RecordId } from "../core/types.js";

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

/** A range a Booking can't overlap, from a Plugin's busy time. */
export interface BusyRange<Id extends string = string> {
  readonly id: Id;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

/** A Plugin Policy as a Plugin stores it: native, its types erased. */
export interface InstalledPolicy {
  readonly name: string;
  readonly appliesTo: readonly ("book" | "reschedule" | "cancel")[];
  // An Effect that fails only with AdapterError, by NativePolicy: erased, since only the Effect layer imports effect (ADR 012).
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- see above.
  readonly load: ((ctx: never) => unknown) | null;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the Policy's own detail, opaque here.
  readonly check: (candidate: never, data: never) => unknown;
}

/** A Plugin's busy time as a Plugin stores it: native, its types erased. */
export interface InstalledBusy {
  readonly kind: string;
  // An Effect of BusyRanges that fails only with AdapterError, by NativeBusy: erased as in InstalledPolicy.
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- see above.
  readonly list: (ctx: never) => unknown;
}

/** A Plugin Hook as a Plugin stores it: native, its types erased. */
export interface InstalledHook {
  readonly when: "inTransaction" | "afterCommit";
  /** `"*"`, or Booking Action names and the Plugin's own write Actions as `<plugin>.<action>`. */
  readonly appliesTo: "*" | readonly string[];
  // An Effect that never fails, by NativeHook: erased as in InstalledPolicy.
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- see above.
  readonly run: (event: never) => unknown;
}

declare const pluginTypes: unique symbol;

/**
 * A Plugin, as `definePlugin` builds it and `defineSchema({ plugins })` installs it.
 *
 * @typeParam N - Its name: its Actions appear on `scheduler[N]`.
 * @typeParam T - Its tables.
 * @typeParam A - Its Actions, as written.
 * @typeParam P - Its Policies, as written: a union, `never` for none.
 * @typeParam C - The Conflict its busy time causes, `never` without busy time.
 */
export interface Plugin<
  N extends string = string,
  T extends Tables = Tables,
  A = unknown,
  P = unknown,
  C = unknown,
> {
  readonly name: N;
  readonly tables: T;
  readonly actions: A;
  /** Its Policies, natively; `P` types them for the app. */
  readonly policies: readonly InstalledPolicy[];
  /** Its busy time, natively, or `null`; `C` types its Conflicts for the app. */
  readonly busy: InstalledBusy | null;
  /** Its Hooks, natively: they run before the app's. */
  readonly hooks: readonly InstalledHook[];
  /** `P` and `C`, as types only. */
  readonly [pluginTypes]?: { readonly policies: P; readonly conflict: C };
}

/** The Policies of Plugin `Pl`, as written; `never` when it has none (or isn't known). */
export type PoliciesOf<Pl> = Pl extends {
  readonly [pluginTypes]?: { readonly policies: infer P };
}
  ? unknown extends P
    ? never
    : P
  : never;

/** The Conflicts the busy time of Plugin `Pl` causes; `never` without (or when it isn't known). */
export type BusyConflictOf<Pl> = Pl extends {
  readonly [pluginTypes]?: { readonly conflict: infer C };
}
  ? unknown extends C
    ? never
    : C
  : never;

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
  "book",
  "cancel",
  "findSlots",
  "reschedule",
  "transition",
] as const;

/** The scheduler's own keys, which no Plugin can be named. */
export type SchedulerKey = (typeof schedulerKeys)[number];

/** The names of the Policies in union `P`. */
type NamesOf<P> = P extends { readonly name: infer Nm extends string }
  ? Nm
  : never;

/** The names of Plugin `Pl`'s Policies (a union of Plugins: all of theirs). */
export type PolicyNamesOf<Pl> = NamesOf<PoliciesOf<Pl>>;

/** `unknown` when `Ps` can be installed together; `never` when a Plugin name repeats or is a scheduler key, a table name repeats or is `booking`, or a Policy name repeats across Plugins. */
export type InstallablePlugins<
  Ps extends readonly Plugin[],
  Names extends string = never,
  Taken extends string = "booking",
  Policies = never,
> = Ps extends readonly [
  infer H extends Plugin,
  ...infer Rest extends readonly Plugin[],
]
  ? [H["name"]] extends [Names | SchedulerKey]
    ? never
    : [(keyof H["tables"] & Taken) | (PolicyNamesOf<H> & Policies)] extends [
          never,
        ]
      ? InstallablePlugins<
          Rest,
          Names | H["name"],
          Taken | (keyof H["tables"] & string),
          Policies | PolicyNamesOf<H>
        >
      : never
  : unknown;

/** The physical name of Plugin table `table` on a resolved schema; its logical name when the schema has none for it. */
export function physicalTable(
  schema: {
    readonly names: { readonly tables: Readonly<Record<string, string>> };
  },
  table: string
): string {
  return schema.names.tables[table] ?? table;
}

/** The physical column names of Plugin table `table` on a resolved schema, by logical name; a column's logical name when it has none. */
export function physicalColumns(
  schema: {
    readonly names: {
      readonly columns: Readonly<
        Partial<Record<string, Readonly<Record<string, string>>>>
      >;
    };
  },
  table: string
): (column: string) => string {
  const names = schema.names.columns[table];

  return (column) => names?.[column] ?? column;
}

/** Every table the Plugins declare, by logical name. */
export function tablesOf(plugins: readonly Plugin[]): Tables {
  return Object.fromEntries(plugins.flatMap((p) => Object.entries(p.tables)));
}

/** Throw when two Plugins share a name, a Plugin takes a scheduler key, a Plugin Policy applies to nothing, two tables (or one and `booking`) share a name, or a table declares a column fasti owns. */
export function checkPlugins(plugins: readonly Plugin[]): void {
  const names = new Set<string>();
  const tables = new Set<string>();

  for (const { name, policies, tables: own } of plugins) {
    // Plain-JS callers can get past the non-empty tuple type.
    const idle = policies.find((p) => p.appliesTo.length === 0);

    if (idle !== undefined) {
      throw new Error(
        `defineSchema: Plugin "${name}"'s Policy "${idle.name}" must apply to at least one Action.`
      );
    }

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
