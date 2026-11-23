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
import type { AnySchema, NoKeys } from "../schema/define-schema.js";
import type {
  BusyRange,
  Plugin,
  PluginResourceId,
  RecordId,
  RecordOf,
  TableDef,
  Tables,
} from "../schema/table.js";
import { uuidV7 } from "./booking-id.js";
import type { EffectLocked, EffectReads } from "./effect-adapter.js";
import type {
  AdapterError,
  ConflictingBooking,
  ErasedError,
  Vetoed,
} from "./errors.js";
import type { Form, ReadAction, WriteAction } from "./forms.js";
import type { Committed, HookEvent, WrittenContext } from "./hook.js";
import { conflictsAt } from "./occupancy.js";
import type { BusySource } from "./occupancy.js";
import type { LoadArgs, RunnablePolicy } from "./policy-pass.js";
import type { Candidate } from "./policy.js";
import type { ActionContext } from "./scheduler-service.js";
import {
  isBookingActionName,
  isNamedTarget,
  matchesTarget,
  pluginWriteNames,
} from "./target.js";
import type {
  BookingActionName,
  CalledTarget,
  WriteNamesOf,
} from "./target.js";
import { writeUnit } from "./write-unit.js";
import type { EffectAlso, Outcome, RunnableHook } from "./write-unit.js";

/** What `list` on Plugin table `T` takes: a Resource, and on a timed table an optional range. */
export type ListQuery<T extends TableDef> = {
  readonly resourceId: PluginResourceId;
} & (T["timed"] extends true
  ? {
      /** Only the records with `start < to && end > from`. */
      readonly overlapping?: {
        readonly from: Temporal.Instant;
        readonly to: Temporal.Instant;
      };
    }
  : { readonly overlapping?: never });

/** Typed reads on Plugin table `T` named `N`. */
export interface TableReads<N extends string, T extends TableDef> {
  /** The record with this id, or `null` when there is none. */
  readonly get: (
    id: RecordId<N>
  ) => Effect.Effect<RecordOf<N, T> | null, AdapterError>;
  /** Every record of the Resource; a timed table's sorted by `start`, then `id`, another's by `id`. */
  readonly list: (
    query: ListQuery<T>
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
  /** The blocking Bookings on the locked Resource overlapping the half-open `[start, end)`, sorted by start, then id: refuse busy time over them yourself (Invariant 1). */
  readonly conflicts: (range: {
    readonly start: Temporal.Instant;
    readonly end: Temporal.Instant;
  }) => Effect.Effect<readonly ConflictingBooking[], AdapterError>;
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

/** What a Plugin Policy's `load` gets: the candidate's Resource and range (on `cancel`, the stored Booking's), the unit's `now`, and the Plugin's tables, read on the unit. */
export interface PluginLoadContext<T extends Tables> {
  readonly resourceId: PluginResourceId;
  readonly from: Temporal.Instant;
  readonly to: Temporal.Instant;
  readonly now: Temporal.Instant;
  readonly records: RecordReadsOf<T>;
}

/**
 * A Plugin Policy, natively: a relaxable rule, run under the lock before the app's Policies. Its name is unique across
 * the Plugins and the app. Write `check`'s `data` type (what `load` resolves with); `null` from `check` passes.
 */
export interface NativePolicy<T extends Tables> {
  readonly name: string;
  /** The Actions that run it; at least one. */
  readonly appliesTo: readonly [BookingActionName, ...BookingActionName[]];
  /** Runs once per Action call, under the Resource Lock: does the I/O. `null` for none: `check` then gets `undefined`. */
  readonly load:
    | ((ctx: PluginLoadContext<T>) => Effect.Effect<unknown, AdapterError>)
    | null;
  /** Runs once per candidate: `null` passes, anything else is the Violation's `detail`. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the Policy's own detail, typed where it's written.
  readonly check: (candidate: Candidate<AnySchema>, data: never) => unknown;
}

/** A Plugin's busy time, natively: ranges no blocking Booking may overlap (Invariant 1, not relaxable); they may overlap each other. */
export interface NativeBusy<T extends Tables> {
  /** Tags the Conflicts it causes in `SlotConflict`. */
  readonly kind: string;
  /** The busy ranges on `resourceId` overlapping the half-open `overlapping`. */
  readonly list: (ctx: {
    readonly records: RecordReadsOf<T>;
    readonly resourceId: PluginResourceId;
    readonly overlapping: {
      readonly from: Temporal.Instant;
      readonly to: Temporal.Instant;
    };
  }) => Effect.Effect<readonly BusyRange[], AdapterError>;
}

/**
 * What a Plugin Hook can apply to: `"*"`, or at least one Booking Action or write Action of its own, as
 * `<plugin>.<action>`. Its Action names are checked when it's defined, not by type: naming them by type would fix the
 * Actions' type before `definePlugin` infers it.
 */
export type PluginHookTargets<N extends string> =
  | "*"
  | readonly [
      BookingActionName | `${N}.${string}`,
      ...(BookingActionName | `${N}.${string}`)[],
    ];

/**
 * What a Plugin Hook observes: a Booking Action or Transition (over any schema, since a Plugin knows none), or one of
 * its own write Actions with its `also` context. Narrow it by `action`. It never sees another Plugin's writes.
 */
export type PluginHookEvent<N extends string, A> =
  | Extract<
      HookEvent<AnySchema, unknown>,
      { readonly action: BookingActionName | "transition" }
    >
  | {
      [K in WriteNamesOf<A>]: {
        readonly action: `${N}.${K}`;
        readonly tx: unknown;
        readonly now: Temporal.Instant;
      } & WrittenContext<A[K]>;
    }[WriteNamesOf<A>];

/**
 * A Plugin Hook, natively. It runs before the app's Hooks: `"inTransaction"` on the unit, after `also`, where it can
 * write its tables through `records` and a failure rolls the whole write back; `"afterCommit"` once, after the
 * commit, where a failure is logged.
 */
export type NativeHook<N extends string, A, T extends Tables> =
  | {
      readonly when: "inTransaction";
      readonly appliesTo: PluginHookTargets<N>;
      // oxlint-disable-next-line typescript/method-signature-style -- method syntax is bivariant, so a narrowed `run` is assignable.
      run(
        event: PluginHookEvent<N, A> & { readonly records: RecordStoreOf<T> }
      ): Effect.Effect<void>;
    }
  | {
      readonly when: "afterCommit";
      readonly appliesTo: PluginHookTargets<N>;
      // oxlint-disable-next-line typescript/method-signature-style -- as above.
      run(
        event: Committed<PluginHookEvent<N, A>> & {
          readonly records: RecordReadsOf<T>;
        }
      ): Effect.Effect<void>;
    };

/**
 * Whether a Plugin with write Actions `own` may observe `called`: a Booking Action, a Transition edge, or one of its own.
 *
 * @returns `true` when the Plugin may observe `called`.
 */
function observable(own: readonly string[], called: CalledTarget): boolean {
  return (
    !isNamedTarget(called) ||
    isBookingActionName(called) ||
    own.includes(called)
  );
}

/** Throws on a dot in Plugin `name` or an Action name, or unless each Hook applies to `"*"`, or to Booking Actions and its own write Actions only: plain-JS callers can pass what the types refuse. */
export function checkPluginHooks(
  name: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the Plugin's Actions, either style.
  actions: unknown,
  hooks: readonly { readonly appliesTo: "*" | readonly string[] }[]
): void {
  // A Hook target is `plugin.action`: a dot in either part makes two Actions one target (`a` + `b.c` = `a.b` + `c`).
  const dotted = [name, ...Object.keys(actions ?? {})].find((n) =>
    n.includes(".")
  );

  if (dotted !== undefined) {
    throw new Error(
      `fasti: Plugin ${name} can't use the name "${dotted}": Plugin and Action names have no dots`
    );
  }

  const own = pluginWriteNames({ actions, name });

  for (const { appliesTo } of hooks) {
    if (appliesTo === "*") {
      continue;
    }

    if (appliesTo.length === 0) {
      throw new Error(
        `fasti: a Hook of Plugin ${name} applies to nothing: name at least one target, or "*"`
      );
    }

    const wrong = appliesTo.find((t) => !observable(own, t));

    if (wrong !== undefined) {
      throw new Error(
        `fasti: a Hook of Plugin ${name} applies to ${wrong}, which is neither a Booking Action nor one of its write Actions`
      );
    }
  }
}

/** The Policies in tuple `P`, as a union; `never` when it's only the constraint (no `policies` given). */
export type PluginPolicies<P extends readonly { readonly name: string }[]> =
  string extends P[number]["name"] ? never : P[number];

/** The Conflict busy time `B` causes: its kind and its ranges' id type; `never` for no busy time (or only the constraint). */
export type BusyConflict<B> = B extends {
  readonly kind: infer K extends string;
  readonly list: (ctx: never) => infer Listed;
}
  ? string extends K
    ? never
    : {
        readonly kind: K;
        readonly id: RangeOf<Listed>["id"];
        readonly start: Temporal.Instant;
        readonly end: Temporal.Instant;
      }
  : never;

/** The range type a busy `list` resolves with, natively or as a Promise. */
type RangeOf<Listed> =
  Listed extends Effect.Effect<readonly (infer R extends BusyRange)[], unknown>
    ? R
    : Listed extends Promise<readonly (infer R extends BusyRange)[]>
      ? R
      : never;

/**
 * Define a Plugin, natively in Effect: tables stored by every Adapter with `records`, Actions on `scheduler.<name>`,
 * Policies run before the app's, and busy time no Booking may overlap.
 * Write each Action's params type on `run`'s first parameter; anything else in the Plugin's types that holds a Resource
 * id uses {@link PluginResourceId}, and the app sees the schema's own id type there.
 *
 * @returns The Plugin, to install in `defineSchema`'s `plugins`.
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
  // A has no default, and comes before T to allow that: a default stops a parameter being inferred from context-sensitive functions.
  const A extends NativeActions<T>,
  // P and B have no default either: left out, they're their constraints, which PluginPolicies and BusyConflict read as none.
  const P extends readonly NativePolicy<T>[],
  const B extends NativeBusy<T> | null,
  const T extends Tables = NoKeys,
>(def: {
  /** Its Actions appear on `scheduler[name]`; unique per schema, and not a scheduler key (`book`, …). */
  readonly name: N;
  /** Its tables, by logical name; unique per schema, and not `booking`. */
  readonly tables?: T;
  /** Its Actions, by name; `{}` for none. */
  readonly actions: A;
  /** Its Policies, run in this order before the app's; leave out for none. */
  readonly policies?: P;
  /** Its busy time; leave out for none. */
  readonly busy?: B;
  /** Its Hooks, run before the app's; leave out for none. */
  readonly hooks?: readonly NativeHook<NoInfer<N>, NoInfer<A>, NoInfer<T>>[];
}): Plugin<N, T, A, PluginPolicies<P>, BusyConflict<B>> {
  // SAFETY: T falls back to its default, `{}`, exactly when `tables` is absent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the default can't be tied to absence in the signature.
  const tables = (def.tables ?? {}) as T;
  const hooks = def.hooks ?? [];

  checkPluginHooks(def.name, def.actions, hooks);

  return {
    actions: def.actions,
    busy: def.busy ?? null,
    hooks,
    name: def.name,
    policies: def.policies ?? [],
    tables,
  };
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
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- any function: kept whole.
  | ((...args: never[]) => unknown);

/** `X` with every {@link PluginResourceId} in it replaced by `Id`; `readonly`, optional keys, arrays and tuples kept. */
export type Fill<Id, X> = unknown extends X
  ? X
  : X extends PluginResourceId
    ? Id
    : X extends Opaque
      ? X
      : Unchanged<X, { [K in keyof X]: Fill<Id, X[K]> }>;

/** `X` itself when filling changed nothing (no Resource id inside), so a Plugin's own named types reach the app as written; else `Filled`. */
type Unchanged<X, Filled> = [X] extends [Filled]
  ? [Filled] extends [X]
    ? X
    : Filled
  : Filled;

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
  ) => Effect.Effect<unknown, ErasedError>;
}

/** A {@link Unit} with its record handles erased. */
interface ErasedUnit {
  readonly records: object;
  readonly tx: unknown;
  readonly now: Temporal.Instant;
  readonly conflicts: Unit<Tables>["conflicts"];
}

/** A Plugin Action bound to a scheduler: what the Effect form's `scheduler.<plugin>.<name>` runs. `R` is what its `also` requires, as for the built-in Actions. */
type BoundAction = <R = never>(params: {
  readonly also?: EffectAlso<object, unknown, R>;
}) => Effect.Effect<unknown, ErasedError, R>;

/**
 * The record handles on `tables`: reads from `reads`, and writes on `locked` when given.
 *
 * @returns The handles, keyed by table name.
 */
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

/**
 * Bind `action` of a Plugin with `tables` to `ctx`; `name` is `<plugin>.<action>`, as Hooks and logs see it.
 *
 * @returns The bound Action, taking the caller's params.
 */
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

  return <R = never>({
    also,
    ...params
  }: {
    readonly also?: EffectAlso<object, Tx, R>;
  }) => {
    function lock(
      resourceId: ResourceIdOf<S>,
      work: (
        unit: ErasedUnit
      ) => Effect.Effect<Outcome<unknown, object>, ErasedError>
    ) {
      return Effect.map(
        writeUnit(
          ctx,
          { action: name, resourceId },
          (locked, now) =>
            work({
              conflicts: ({ end, start }) =>
                Effect.map(
                  conflictsAt(ctx, locked, {
                    end,
                    excludeBookingId: null,
                    // Not "booking": busy time may overlap busy time, so only Bookings come back.
                    kind: "busy",
                    resourceId,
                    start,
                  }),
                  (found) =>
                    found.filter(
                      (c): c is ConflictingBooking => c.kind === "booking"
                    )
                ),
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

/**
 * Every installed Plugin's Actions bound to `ctx`, by Plugin name, then Action name.
 *
 * @returns The bound Actions.
 */
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

/**
 * Every installed Plugin's busy time, as busy sources: each reads its Plugin's tables on the unit.
 *
 * @returns The busy sources, in install order.
 */
export function pluginBusy(
  plugins: AnySchema["plugins"]
): readonly BusySource[] {
  return plugins.flatMap(({ busy, tables }) =>
    busy === null
      ? []
      : [
          {
            kind: busy.kind,
            list: (reads, { overlapping, resourceId }) =>
              // SAFETY: `list` was written against its Plugin's tables, which `handles` reads, with the Resource id in
              // PluginResourceId's place; a NativeBusy fails only with AdapterError.
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the busy time is erased here.
              busy.list({
                overlapping,
                records: handles(Object.keys(tables), reads, null),
                resourceId,
              } as never) as Effect.Effect<readonly BusyRange[], AdapterError>,
          },
        ]
  );
}

/**
 * Every installed Plugin's Policies, in install order, as the Policy pass runs them: each `load` reads its Plugin's tables on the unit.
 *
 * @returns The Policies, ready for the Policy pass.
 */
export function pluginPolicies<S extends AnySchema>(
  plugins: S["plugins"]
): readonly RunnablePolicy<S>[] {
  return plugins.flatMap(({ policies, tables }) =>
    policies.map(({ appliesTo, check, load, name }) => ({
      appliesTo,
      check,
      load:
        load &&
        ((reads: EffectReads<S>, ctx: LoadArgs<S>) =>
          // SAFETY: `load` was written against its Plugin's tables, which `handles` reads, with the Resource id in
          // PluginResourceId's place; a NativePolicy fails only with AdapterError.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the Policy is erased here.
          load({
            ...ctx,
            records: handles(Object.keys(tables), reads, null),
          } as never) as Effect.Effect<unknown, AdapterError>),
      name,
    }))
  );
}

/**
 * Every installed Plugin's Hooks, in install order, as `writeUnit` runs them: each sees its Plugin's tables (written on
 * the unit in a transaction, read through `reads` after the commit), and only Booking Actions, Transitions and its own
 * write Actions, even on `"*"`.
 *
 * @returns The Hooks, ready for `writeUnit`.
 */
export function pluginHooks<S extends AnySchema, Tx>(
  plugins: S["plugins"],
  reads: EffectReads<S>
): readonly RunnableHook<S, Tx>[] {
  return plugins.flatMap((plugin) => {
    const tables = Object.keys(plugin.tables);
    const own = pluginWriteNames(plugin);

    return plugin.hooks.map(({ appliesTo, run, when }): RunnableHook<S, Tx> => {
      // SAFETY: `run` was written against its Plugin's event and tables, which the event below carries; a NativeHook never fails.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-object-parameters -- the Hook is erased here.
      const erased = run as (event: object) => Effect.Effect<void>;

      // Even on "*": a Plugin never sees another Plugin's writes.
      function applies(called: CalledTarget): boolean {
        return (
          observable(own, called) &&
          (appliesTo === "*" || appliesTo.some((t) => matchesTarget(t, called)))
        );
      }

      return when === "inTransaction"
        ? {
            applies,
            run: (event, locked) =>
              erased({
                ...event,
                records: handles(tables, locked, locked),
                tx: locked.tx,
              }),
            when,
          }
        : {
            applies,
            run: (event) =>
              erased({ ...event, records: handles(tables, reads, null) }),
            when,
          };
    });
  });
}
