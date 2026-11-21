import { Effect } from "effect";

import type {
  DeleteRecordResult,
  ListRecordsQuery,
  StoredRecord,
  StoredValue,
  UpdateRecordParams,
  UpdateRecordResult,
} from "../adapter/contract.js";
import type { ResourceIdOf } from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";
import type {
  Plugin,
  PluginResourceId,
  RecordId,
  RecordOf,
  TableDef,
  Tables,
} from "../schema/table.js";
import { uuidV7 } from "./booking-id.js";
import type { EffectLocked, EffectReads } from "./effect-adapter.js";
import type { AdapterError, Vetoed } from "./errors.js";
import type { Form, ReadAction, WriteAction } from "./forms.js";
import type { ActionContext } from "./scheduler-service.js";
import { writeUnit } from "./write-unit.js";
import type { EffectAlso, Outcome } from "./write-unit.js";

/** Typed reads on Plugin table `T` named `N`. */
export interface TableReads<N extends string, T extends TableDef> {
  /** The record with this id, or `null` when there is none. */
  readonly get: (
    id: RecordId<N>
  ) => Effect.Effect<RecordOf<N, T> | null, AdapterError>;
  /** Every record of the Resource; a timed table's sorted by `start`, then `id`, another's by `id`. */
  readonly list: (
    query: { readonly resourceId: PluginResourceId } & (T["timed"] extends true
      ? {
          /** Only the records with `start < to && end > from`. */
          readonly overlapping?: {
            readonly from: Temporal.Instant;
            readonly to: Temporal.Instant;
          };
        }
      : { readonly overlapping?: never })
  ) => Effect.Effect<readonly RecordOf<N, T>[], AdapterError>;
}

/** The columns `update` may change: anything but `id` and `resourceId`, since a record never changes Resource. */
export type RecordChanges<N extends string, T extends TableDef> = Partial<
  Omit<RecordOf<N, T>, "id" | "resourceId">
>;

/** Typed writes on Plugin table `T` named `N`: only on a unit of work. */
export interface TableWrites<N extends string, T extends TableDef> {
  /** Store a new record; fasti mints its id. */
  readonly insert: (
    record: Omit<RecordOf<N, T>, "id">
  ) => Effect.Effect<RecordOf<N, T>, AdapterError>;
  /** Change a record if it still equals `expected` (compare-and-set); `changed` when it doesn't, or is gone. */
  readonly update: (params: {
    readonly expected: RecordOf<N, T>;
    readonly changes: RecordChanges<N, T>;
  }) => Effect.Effect<UpdateRecordResult, AdapterError>;
  /** Remove a record; `missing` when there was none. */
  readonly delete: (
    id: RecordId<N>
  ) => Effect.Effect<DeleteRecordResult, AdapterError>;
  /** Replace every record of this table on one Resource; fasti mints the ids. */
  readonly replace: (params: {
    readonly resourceId: PluginResourceId;
    readonly records: readonly Omit<RecordOf<N, T>, "id" | "resourceId">[];
  }) => Effect.Effect<void, AdapterError>;
}

/** Reads on every table in `T`, by name. */
export type RecordReadsOf<T extends Tables> = {
  readonly [K in keyof T & string]: TableReads<K, T[K]>;
};

/** Reads and writes on every table in `T`, by name: what a unit of work gets. */
export type RecordStoreOf<T extends Tables> = {
  readonly [K in keyof T & string]: TableReads<K, T[K]> & TableWrites<K, T[K]>;
};

/** What `work` runs with: one unit of work under the Resource Lock. */
export interface Unit<T extends Tables> {
  /** The Plugin's tables, read and written on this unit: reads see its own writes. */
  readonly records: RecordStoreOf<T>;
  /** The Adapter's transaction handle: an escape hatch that ties the Plugin to one ORM. */
  readonly tx: unknown;
  /** The Clock's time, read once on the unit: the same `now` `also` and the Hooks get. */
  readonly now: Temporal.Instant;
}

declare const contextType: unique symbol;

/** What a write Action's `run` resolves with: the value, and the context `also` gets as a type only. */
export interface Written<V, C> {
  readonly value: V;
  readonly [contextType]?: C;
}

/**
 * Run `work` as one unit of work under the Resource Lock. On Done, the caller's `also` runs on the same unit with
 * `context`, `tx` and `now`, and its value is merged into the result; NoOp or a failure runs no `also`.
 */
export type Lock<T extends Tables> = <V, C extends object, E = never>(
  resourceId: PluginResourceId,
  work: (unit: Unit<T>) => Effect.Effect<Outcome<V, C>, E>
) => Effect.Effect<Written<V, C>, E | Vetoed<unknown> | AdapterError>;

/** A Plugin Action that only reads: no lock, no `also`. */
export interface NativeRead<T extends Tables, Pm, V, E> {
  readonly kind: "read";
  /** The Action, given the caller's params. */
  readonly run: (
    params: Pm,
    tools: { readonly records: RecordReadsOf<T> }
  ) => Effect.Effect<V, E>;
}

/** A Plugin Action that writes: through `lock`, which runs the caller's `also`. */
export interface NativeWrite<T extends Tables, Pm, V, C, E> {
  readonly kind: "write";
  /** The Action, given the caller's params; `records` reads outside any unit. Resolve with what `lock` resolves with. */
  readonly run: (
    params: Pm,
    tools: { readonly records: RecordReadsOf<T>; readonly lock: Lock<T> }
  ) => Effect.Effect<Written<V, C>, E>;
}

/** A Plugin's Actions over its tables `T`, by name. */
export type NativeActions<T extends Tables> = Readonly<
  Record<
    string,
    | NativeRead<T, never, unknown, unknown>
    | NativeWrite<T, never, unknown, object, unknown>
  >
>;

/**
 * Define a Plugin, natively in Effect: tables stored by every Adapter with `records`, and Actions on `scheduler.<name>`.
 * Write each Action's params type on `run`'s first parameter; anything else in the Plugin's types that holds a Resource
 * id uses {@link PluginResourceId}, and the app sees the schema's own id type there.
 *
 * @example
 * ```ts
 * const notes = definePlugin({
 *   name: "notes",
 *   tables: { note: { columns: { text: { type: column.text(), required: true } } } },
 *   actions: {
 *     add: {
 *       kind: "write",
 *       run: (params: { readonly resourceId: PluginResourceId; readonly text: string }, { lock }) =>
 *         lock(params.resourceId, ({ records }) =>
 *           Effect.map(records.note.insert(params), (note) => ({ _tag: "Done", value: note, context: { note } }) as const)),
 *     },
 *   },
 * });
 * ```
 */
export function definePlugin<
  const N extends string,
  // A has no default, and comes before T to allow that: a default on A stops `run`'s tools being typed from T.
  const A extends NativeActions<T>,
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- "no tables" is exactly `{}`.
  const T extends Tables = Record<never, never>,
>(def: {
  /** Its Actions appear on `scheduler[name]`; unique per schema, and not a scheduler key (`book`, …). */
  readonly name: N;
  /** Its tables, by logical name; unique per schema, and not `booking`. */
  readonly tables?: T;
  /** Its Actions, by name; `{}` for none. */
  readonly actions: A;
}): Plugin<N, T, A> {
  // SAFETY: T falls back to its default, `{}`, exactly when `tables` is absent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the default can't be tied to absence in the signature.
  const tables = (def.tables ?? {}) as T;

  return { actions: def.actions, name: def.name, tables };
}

// ── App side: a Plugin's types with the schema's Resource id in place of PluginResourceId (approach A, R1).

/** Values that `Fill` keeps as they are: nothing inside them can be a Resource id. */
type Opaque =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  // oxlint-disable-next-line typescript/no-invalid-void-type -- an Action may resolve with nothing.
  | void
  | { readonly [Symbol.toStringTag]: `Temporal.${string}` }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- any function: kept whole.
  | ((...args: never[]) => unknown);

/** `X` with every {@link PluginResourceId} in it replaced by `Id`; `readonly`, optional keys, arrays and tuples kept. */
export type Fill<Id, X> = unknown extends X
  ? X
  : X extends PluginResourceId
    ? Id
    : X extends Opaque
      ? X
      : { [K in keyof X]: Fill<Id, X[K]> };

/** Plugin Action `Ac` as the app calls it, in form `F`, over Resource ids `Id` and transaction handle `Tx`. */
type AppAction<Id, Tx, F extends Form, Ac> = Ac extends {
  readonly kind: "write";
  readonly run: (
    params: infer Pm,
    tools: never
  ) => Effect.Effect<Written<infer V, infer C>, infer E>;
}
  ? WriteAction<
      F,
      Fill<Id, Pm>,
      Fill<Id, C> & { readonly tx: Tx; readonly now: Temporal.Instant },
      Fill<Id, V>,
      Fill<Id, Exclude<E, Vetoed<unknown> | AdapterError>> | AdapterError
    >
  : Ac extends {
        readonly kind: "read";
        readonly run: (
          params: infer Pm,
          tools: never
        ) => Effect.Effect<infer V, infer E>;
      }
    ? ReadAction<
        F,
        Fill<Id, Pm>,
        Fill<Id, V>,
        Fill<Id, Exclude<E, AdapterError>> | AdapterError
      >
    : never;

/** Every installed Plugin's Actions, on `scheduler.<plugin>`, in form `F`. */
export type PluginActionsOf<S extends AnySchema, Tx, F extends Form> = {
  readonly [Pl in S["plugins"][number] as Pl["name"]]: {
    readonly [K in keyof Pl["actions"]]: AppAction<
      ResourceIdOf<S>,
      Tx,
      F,
      Pl["actions"][K]
    >;
  };
};

// ── Runtime: the Plugins' Actions, bound to one scheduler.

/** An Action as a Plugin stores it, its types erased: the app-side types come from {@link PluginActionsOf}. */
interface ErasedAction {
  readonly kind: "read" | "write";
  readonly run: (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the Plugin's own params, typed by the Plugin.
    params: unknown,
    // oxlint-disable-next-line anti-slop/no-object-parameters -- the tools, typed by NativeRead/NativeWrite.
    tools: object
  ) => Effect.Effect<unknown, unknown>;
}

/** A {@link Unit} with its record handles erased. */
interface ErasedUnit {
  readonly records: object;
  readonly tx: unknown;
  readonly now: Temporal.Instant;
}

/** A Plugin Action bound to a scheduler: what the Effect form's `scheduler.<plugin>.<name>` runs. */
type BoundAction = (
  // oxlint-disable-next-line anti-slop/no-object-parameters -- typed by PluginActionsOf at the call site.
  params: object
) => Effect.Effect<unknown, unknown, unknown>;

/** The record handles on `tables`: reads from `reads`, and writes on `locked` when given. */
function handles<S extends AnySchema, Tx>(
  tables: readonly string[],
  reads: EffectReads<S>,
  locked: EffectLocked<S, Tx> | null
): object {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      {
        get: (id: string) => reads.getRecord(table, id),
        list: (query: ListRecordsQuery<S>) => reads.listRecords(table, query),
        ...(locked && {
          delete: (id: string) => locked.deleteRecord(table, id),
          insert: (fields: Readonly<Record<string, StoredValue>>) => {
            const record: StoredRecord = { ...fields, id: uuidV7() };

            return Effect.as(locked.insertRecord(table, record), record);
          },
          replace: ({
            records,
            resourceId,
          }: {
            readonly resourceId: ResourceIdOf<S>;
            readonly records: readonly Readonly<Record<string, StoredValue>>[];
          }) =>
            locked.replaceRecords(table, {
              records: records.map((fields) => ({
                ...fields,
                id: uuidV7(),
                resourceId,
              })),
              resourceId,
            }),
          update: (params: UpdateRecordParams) =>
            locked.updateRecord(table, params),
        }),
      },
    ])
  );
}

/** Bind `action` of a Plugin with `tables` to `ctx`; `name` is `<plugin>.<action>`, as Hooks and logs see it. */
function bind<S extends AnySchema, Tx>(
  ctx: ActionContext<S, Tx>,
  name: string,
  tables: readonly string[],
  action: ErasedAction
): BoundAction {
  const records = handles(tables, ctx.adapter, null);

  if (action.kind === "read") {
    // Suspended, so a throw in `run` is a defect of the Effect, not of the call that builds it.
    return (params) => Effect.suspend(() => action.run(params, { records }));
  }

  return ({
    also,
    ...params
  }: {
    readonly also?: EffectAlso<object, Tx, unknown>;
  }) => {
    function lock(
      resourceId: ResourceIdOf<S>,
      work: (
        unit: ErasedUnit
      ) => Effect.Effect<Outcome<unknown, object>, unknown>
    ) {
      return Effect.map(
        writeUnit(
          ctx,
          { action: name, resourceId },
          (locked, now) =>
            work({
              now,
              records: handles(tables, locked, locked),
              tx: locked.tx,
            }),
          also
        ),
        (value) => ({ value })
      );
    }

    return Effect.map(
      Effect.suspend(() => action.run(params, { lock, records })),
      // SAFETY: a write Action's `run` resolves with a Written, by NativeWrite.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the Action is erased here.
      (written) => (written as Written<unknown, never>).value
    );
  };
}

/** Every installed Plugin's Actions bound to `ctx`, by Plugin name, then Action name. */
export function pluginActions<S extends AnySchema, Tx>(
  ctx: ActionContext<S, Tx>
): Readonly<Record<string, Readonly<Record<string, BoundAction>>>> {
  return Object.fromEntries(
    ctx.schema.plugins.map(({ actions, name, tables }) => {
      // SAFETY: `definePlugin` builds `actions` as NativeActions, whose members are ErasedActions with their types erased.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Plugin keeps its Actions as written, typed `unknown` on AnySchema.
      const erased = actions as Readonly<Record<string, ErasedAction>>;
      const names = Object.keys(tables);

      return [
        name,
        Object.fromEntries(
          Object.entries(erased).map(([actionName, action]) => [
            actionName,
            bind(ctx, `${name}.${actionName}`, names, action),
          ])
        ),
      ];
    })
  );
}
