import { column } from "./column.js";
import type { AnyColumn, Column, ResourceIdColumn } from "./column.js";
import { checkPlugins, tablesOf } from "./table.js";
import type {
  InstallablePlugins,
  Plugin,
  TableDef,
  TableNamesOf,
} from "./table.js";

/** A Developer Field: an extra Booking column the developer declares. */
export interface FieldDef {
  /** The column type. */
  readonly type: AnyColumn;
  /** Whether a value is required; an optional field reads as `null` when unset. */
  readonly required: boolean;
}

/** An object with no keys: the default for "none declared" (no Fields, Statuses, Transitions, renames or tables). */
// oxlint-disable-next-line typescript/no-generated-empty-object-type -- "none declared" is exactly `{}`.
export type NoKeys = Record<never, never>;

/** Developer Fields by logical name. */
export type Fields = Readonly<Record<string, FieldDef>>;

const BOOKING_COLUMNS = ["id", "resourceId", "start", "end", "status"] as const;

/** fasti's own Booking columns, by logical name. */
export type BookingColumn = (typeof BOOKING_COLUMNS)[number];

/** The Statuses every schema has. */
export type BaseStatus = "booked" | "cancelled";

/** Declared Statuses beyond the base, each saying whether it blocks its slot. */
export type StatusDecls = Readonly<
  Record<string, { readonly blocking: boolean }>
>;

/** Every Status of a schema declaring `D`: the base ones plus the declared ones. */
export type StatusesOf<D extends StatusDecls> = BaseStatus | (keyof D & string);

/** A Transition table: each Status → the Statuses it may move to. */
export type TransitionTable<St extends string> = Readonly<
  Partial<Record<St, readonly St[]>>
>;

/** A resolved Transition table: every Status has an entry; one with none leaving it is terminal. */
export type Transitions<St extends string> = Readonly<
  Record<St, readonly St[]>
>;

/** The resolved table of `defineSchema`: `booked → cancelled` always added, `[]` for an undeclared Status. */
export type ResolveTransitions<T, St extends string> = {
  readonly [K in St]: K extends "booked"
    ? readonly (Extract<TargetsOf<T, K>, St> | "cancelled")[]
    : readonly Extract<TargetsOf<T, K>, St>[];
};

type TargetsOf<T, K extends PropertyKey> =
  T extends Readonly<Record<K, readonly (infer X)[]>> ? X : never;

/** The stored value of Status `K`: its rename in `N`, else its logical name. */
type StoredOf<N, K extends string> = K extends keyof N
  ? N[K] extends string
    ? N[K]
    : K
  : K;

/** Refuses a rename whose stored value another Status already has (I6). A non-literal value can't be checked here. */
type DistinctStored<N, St extends string> = {
  readonly [K in St]?: string extends StoredOf<N, K>
    ? string
    : StoredOf<N, K> extends StoredOf<N, Exclude<St, K>>
      ? never
      : string;
};

/**
 * Input to {@link defineSchema}. Every option has a default.
 *
 * @typeParam R - The Resource id column.
 * @typeParam F - The Developer Fields.
 * @typeParam D - The declared Statuses beyond the base.
 * @typeParam T - The declared Transitions.
 * @typeParam I - The Statuses `book` may create a Booking in.
 * @typeParam N - The stored Status values, by logical name.
 * @typeParam Ps - The installed Plugins.
 */
export interface DefineSchemaParams<
  R extends ResourceIdColumn,
  F extends Fields,
  D extends StatusDecls = NoKeys,
  T = NoKeys,
  I extends readonly string[] = readonly ["booked"],
  N = NoKeys,
  Ps extends readonly Plugin[] = readonly [],
> {
  /** The Resource id type; defaults to `column.text()`. */
  readonly resource?: { readonly idType: R };
  readonly booking?: {
    /** Developer Fields on the Booking; a name that collides with a Booking column, or `also` or `waived` (reserved), is a type error. */
    readonly fields?: F &
      Partial<Readonly<Record<BookingColumn | "also" | "waived", never>>>;
    /** Statuses beyond `booked` and `cancelled`, each with `blocking`; redeclaring a base Status is a type error. */
    readonly statuses?: D & Partial<Readonly<Record<BaseStatus, never>>>;
    /** The Transitions each Status may make (ADR 009); `booked → cancelled` is always added. */
    readonly transitions?: T &
      NoInfer<
        TransitionTable<StatusesOf<D>> &
          Readonly<Record<Exclude<keyof T, BaseStatus | keyof D>, never>>
      >;
    /** The Statuses `book` may create a Booking in; defaults to `["booked"]`. With more than one, `book` takes a `status`. */
    readonly initial?: I &
      NoInfer<readonly [StatusesOf<D>, ...StatusesOf<D>[]]>;
  };
  /** The Plugins, from `definePlugin`; their Actions appear on `scheduler.<name>`. Two with one name, one named after a scheduler key (`book`, …), two tables with one name (or one named `booking`), or a write Action with an `also` param (reserved) is a type error. */
  readonly plugins?: Ps & InstallablePlugins<Ps>;
  /** Physical names; each defaults to its logical name, and names of one kind must be distinct. A Plugin table is named by its logical name. */
  readonly names?: {
    readonly tables?: {
      readonly booking?: string;
      // oxlint-disable-next-line typescript/no-generated-empty-object-type -- `{}` without Plugin tables.
    } & Partial<Record<NoInfer<TableNamesOf<Ps>>, string>>;
    readonly columns?: {
      readonly booking?: Partial<
        Record<BookingColumn | NoInfer<keyof F>, string>
      >;
    } & {
      readonly [K in NoInfer<TableNamesOf<Ps>>]?: Partial<
        Record<ColumnNamesOf<TableIn<Ps, K>>, string>
      >;
    };
    /** Stored Status values; two Statuses sharing one is a type error. */
    readonly statuses?: N &
      Partial<Record<BaseStatus | NoInfer<keyof D & string>, string>> &
      NoInfer<DistinctStored<N, StatusesOf<D>>>;
  };
}

/** Plugin table `K` among the tables of Plugins `Ps`. */
type TableIn<
  Ps extends readonly Plugin[],
  K extends string,
> = Ps[number]["tables"] extends infer T
  ? T extends Readonly<Record<K, TableDef>>
    ? T[K]
    : never
  : never;

/** The logical column names of Plugin table `T`: fasti's own (`id`, `resourceId`, a timed table's `start` and `end`) and its declared ones. */
export type ColumnNamesOf<T extends TableDef> =
  | "id"
  | "resourceId"
  | (T["timed"] extends true ? "start" | "end" : never)
  | (keyof T["columns"] & string);

/**
 * A resolved schema: every default filled in, so nothing downstream handles a missing option.
 *
 * @typeParam R - The Resource id column.
 * @typeParam F - The Developer Fields.
 * @typeParam St - The Statuses.
 * @typeParam Tr - The resolved Transition table.
 * @typeParam In - The Statuses `book` may create a Booking in.
 * @typeParam Ps - The installed Plugins.
 */
export interface Schema<
  R extends ResourceIdColumn = ResourceIdColumn,
  F extends Fields = Fields,
  St extends string = BaseStatus,
  Tr extends Transitions<St> = Transitions<St>,
  In extends St = Extract<St, "booked">,
  Ps extends readonly Plugin[] = readonly [],
> {
  /** The Resource id type. */
  readonly resource: { readonly idType: R };
  /** The Developer Fields. */
  readonly booking: { readonly fields: F };
  /** Each Status: whether it blocks the slot, and its stored value. */
  readonly statuses: Readonly<
    Record<St, { readonly blocking: boolean; readonly stored: string }>
  >;
  /** Each Status → the Statuses it may move to; always includes `booked → cancelled`. */
  readonly transitions: Tr;
  /** The Statuses `book` may create a Booking in. */
  readonly initial: readonly [In, ...In[]];
  /** The installed Plugins, in order. */
  readonly plugins: Ps;
  /** Physical names, keyed by logical name: fasti's tables, then each Plugin table. */
  readonly names: {
    readonly tables: {
      readonly booking: string;
      // oxlint-disable-next-line typescript/no-generated-empty-object-type -- `{}` without Plugin tables.
    } & Readonly<Record<TableNamesOf<Ps>, string>>;
    readonly columns: {
      readonly booking: Readonly<Record<BookingColumn, string>> &
        Readonly<Record<keyof F, string>>;
    } & Readonly<Record<TableNamesOf<Ps>, Readonly<Record<string, string>>>>;
  };
}

/** A schema of any shape, for use as a constraint (`S extends AnySchema`). */
export type AnySchema = Schema<
  ResourceIdColumn,
  Fields,
  string,
  Transitions<string>,
  string,
  readonly Plugin[]
>;

/** The Statuses `book` may create a Booking of `S` in. */
export type InitialOf<S extends AnySchema> = S["initial"][number];

/** The Transitions `transition` can make: every declared one except into `cancelled`, which belongs to `cancel`. `to` is narrowed by `from`. */
export type TransitionEdge<S extends AnySchema> = {
  [K in keyof S["statuses"] & string]: [
    Exclude<S["transitions"][K][number], "cancelled">,
  ] extends [never]
    ? never
    : {
        /** The Status the Booking must be in now: a compare-and-set. */
        readonly from: K;
        /** The Status to move it to. */
        readonly to: Exclude<S["transitions"][K][number], "cancelled">;
      };
}[keyof S["statuses"] & string];

function physicalNames<K extends PropertyKey>(
  logical: readonly K[],
  renamed: Partial<Record<K, string>> | undefined
): Record<K, string> {
  // SAFETY: the entries cover every key in `logical`, which is all of K.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fromEntries can't keep the key type.
  return Object.fromEntries(
    logical.map((name) => [
      name,
      (renamed && Object.hasOwn(renamed, name) ? renamed[name] : undefined) ??
        String(name),
    ])
  ) as Record<K, string>;
}

/**
 * The physical names of every Plugin table and its columns (fasti's own and its declared ones), by logical name.
 *
 * @returns The physical names: `tables` by table, `columns` by table then column.
 */
function resolvePluginNames(
  plugins: readonly Plugin[],
  // Plain data, read by logical table name: TableNamesOf<Ps> keys the Plugin tables' entries.
  names:
    | {
        readonly tables?: Partial<Record<string, string>>;
        readonly columns?: Partial<
          Record<string, Partial<Record<string, string>>>
        >;
      }
    | undefined
) {
  const pluginTables = Object.entries(tablesOf(plugins));

  return {
    columns: Object.fromEntries(
      pluginTables.map(([table, def]) => [
        table,
        physicalNames(
          [
            "id",
            "resourceId",
            ...(def.timed ? ["start", "end"] : []),
            ...Object.keys(def.columns),
          ],
          names?.columns?.[table]
        ),
      ])
    ),
    tables: physicalNames(
      pluginTables.map(([table]) => table),
      names?.tables
    ),
  };
}

/** Throw when two logical names share one physical name: a definition-time defect. */
function assertDistinct(
  kind: string,
  names: Readonly<Record<string, string>>
): void {
  const seen = new Map<string, string>();

  for (const [logical, physical] of Object.entries(names)) {
    const other = seen.get(physical);

    if (other !== undefined) {
      throw new Error(
        `defineSchema: "${other}" and "${logical}" share the ${kind} "${physical}"; each must have its own.`
      );
    }

    seen.set(physical, logical);
  }
}

/** Throw when `status` isn't a Status of the schema: a definition-time defect. */
function assertStatus(
  where: string,
  statuses: readonly string[],
  status: string
): void {
  if (!statuses.includes(status)) {
    throw new Error(
      `defineSchema: \`${where}\` names "${status}", which isn't a Status.`
    );
  }
}

/** Throw on a Developer Field named after a column fasti owns, or a key write Actions reserve on their value. */
function assertNotReserved(
  kind: string,
  fields: Fields,
  reserved: readonly string[]
): void {
  const name = reserved.find((r) => Object.hasOwn(fields, r));

  if (name !== undefined) {
    throw new Error(
      `defineSchema: a ${kind} Developer Field can't be named "${name}"; it is reserved.`
    );
  }
}

/** The lifecycle as declared in `booking`, untyped; `defineSchema` checks it here and types it. */
interface Lifecycle {
  readonly statuses: Readonly<
    Record<string, { readonly blocking: boolean; readonly stored: string }>
  >;
  readonly transitions: Readonly<Record<string, readonly string[]>>;
  readonly initial: readonly string[];
}

/**
 * Resolve and check Statuses, Transitions and initial Statuses (ADR 009).
 *
 * @returns The resolved Statuses, Transitions and initial Statuses.
 */
function resolveLifecycle(
  booking:
    | {
        readonly statuses?: StatusDecls;
        readonly transitions?: unknown;
        readonly initial?: readonly string[];
      }
    | undefined,
  renamed: Partial<Record<string, string>> | undefined
): Lifecycle {
  const blocking = new Map([
    ["booked", true],
    ["cancelled", false],
  ]);

  for (const [status, decl] of Object.entries(booking?.statuses ?? {})) {
    if (blocking.has(status)) {
      throw new Error(
        `defineSchema: "${status}" is a base Status; it can't be redeclared.`
      );
    }

    // Plain-JS callers can leave it out; a silent non-blocking Status would let overlaps through.
    if (![true, false].includes(decl.blocking)) {
      throw new TypeError(
        `defineSchema: Status "${status}" needs \`blocking: true\` or \`blocking: false\`.`
      );
    }

    blocking.set(status, decl.blocking);
  }

  const names = [...blocking.keys()];
  const stored = physicalNames(names, renamed);

  assertDistinct("stored value", stored);

  // SAFETY: TransitionTable is a record of Status arrays; its names are checked next.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the declared table is generic; read it as plain data.
  const table = (booking?.transitions ?? {}) as Readonly<
    Record<string, readonly string[]>
  >;

  for (const [from, to] of Object.entries(table)) {
    for (const status of [from, ...to]) {
      assertStatus("transitions", names, status);
    }
  }

  const initial = booking?.initial ?? ["booked"];

  if (initial.length === 0) {
    throw new Error("defineSchema: `initial` needs at least one Status.");
  }

  for (const status of initial) {
    assertStatus("initial", names, status);
  }

  return {
    initial: [...initial],
    statuses: Object.fromEntries(
      names.map((status) => [
        status,
        {
          blocking: blocking.get(status) ?? false,
          stored: stored[status] ?? status,
        },
      ])
    ),
    transitions: Object.fromEntries(
      names.map((from) => {
        const to = Object.hasOwn(table, from) ? (table[from] ?? []) : [];

        return [
          from,
          from === "booked" && !to.includes("cancelled")
            ? [...to, "cancelled"]
            : [...to],
        ];
      })
    ),
  };
}

/**
 * Resolve a schema definition: physical names, the Resource id type, Developer Fields and Statuses.
 *
 * @typeParam R - The Resource id column; defaults to `column.text()`.
 * @typeParam F - The Developer Fields.
 * @typeParam D - The declared Statuses beyond the base.
 * @typeParam T - The declared Transitions.
 * @typeParam I - The initial Statuses; `["booked"]` when `initial` is absent.
 * @typeParam N - The stored Status values.
 * @typeParam Ps - The installed Plugins.
 * @returns The resolved schema, to pass to `createScheduler` and the Adapters.
 * @throws When a base Status is redeclared, `transitions` or `initial` names an unknown Status, `initial` is empty,
 * a Developer Field is named `also` (or a Booking one `waived` or after a Booking column), Plugins or their tables clash by name, two Statuses share a stored value (I6), or two columns of one table, or two tables, share a physical name.
 */
export function defineSchema<
  R extends ResourceIdColumn = Column<"text", string>,
  F extends Fields = NoKeys,
  const D extends StatusDecls = NoKeys,
  const T = NoKeys,
  const I extends readonly string[] = readonly ["booked"],
  const N = NoKeys,
  const Ps extends readonly Plugin[] = readonly [],
>(
  params: DefineSchemaParams<R, F, D, T, I, N, Ps>
): Schema<
  R,
  F,
  StatusesOf<D>,
  ResolveTransitions<T, StatusesOf<D>>,
  I[number] & StatusesOf<D>,
  Ps
> {
  type St = StatusesOf<D>;

  const { names } = params;
  // SAFETY: R falls back to its default, Column<"text", string>, exactly when `resource` is absent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the default can't be tied to absence in the signature.
  const idType = (params.resource?.idType ?? column.text()) as R;
  // SAFETY: F falls back to its default, no fields, exactly when `fields` is absent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above, for F.
  const fields = (params.booking?.fields ?? {}) as F;
  // SAFETY: Ps falls back to its default, no Plugins, exactly when `plugins` is absent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above, for Ps.
  const plugins = (params.plugins ?? []) as Ps;

  checkPlugins(plugins);

  assertNotReserved("Booking", fields, [...BOOKING_COLUMNS, "also", "waived"]);

  // SAFETY: resolveLifecycle has an entry for every St, adds booked → cancelled, and checks that transitions and initial name only St.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the Status names are only known at runtime.
  const lifecycle = resolveLifecycle(params.booking, names?.statuses) as Pick<
    Schema<R, F, St, ResolveTransitions<T, St>, I[number] & St>,
    "initial" | "statuses" | "transitions"
  >;

  const bookingColumns = physicalNames<BookingColumn | keyof F>(
    [...BOOKING_COLUMNS, ...Object.keys(fields)],
    names?.columns?.booking
  );

  const tables = physicalNames(["booking"], names?.tables);

  const { columns: pluginColumns, tables: pluginTableNames } =
    resolvePluginNames(plugins, names);

  assertDistinct("column name", bookingColumns);

  for (const columns of Object.values(pluginColumns)) {
    assertDistinct("column name", columns);
  }

  assertDistinct("table name", { ...tables, ...pluginTableNames });

  return {
    booking: { fields },
    // SAFETY: one entry per Plugin table, keyed by its logical name, which is all TableNamesOf<Ps> adds.
    names: {
      columns: {
        booking: bookingColumns,
        ...pluginColumns,
      },
      tables: { ...tables, ...pluginTableNames },
    } as Schema<
      R,
      F,
      St,
      ResolveTransitions<T, St>,
      I[number] & St,
      Ps
    >["names"],
    plugins,
    resource: { idType },
    ...lifecycle,
  };
}
