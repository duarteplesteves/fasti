// The Promise face (ADR 010's second face, for Plugin authors): the root `definePlugin`, and `promiseFace`, the only
// place a Plugin's Promises cross into Effect.
import { Effect } from "effect";
import type { Context } from "effect";

import type { Result } from "../core/result.js";
import type {
  Plugin,
  PluginResourceId,
  RecordId,
  RecordOf,
  TableDef,
  Tables,
} from "../schema/table.js";
import { exitToResult } from "./create-scheduler.js";
import { AdapterError } from "./errors.js";
import type { Vetoed } from "./errors.js";
import type { NativeRead, NativeWrite, Written } from "./plugin.js";
import type { Outcome } from "./write-unit.js";

declare const contextType: unique symbol;

/** What a Promise-style Action resolves with: a {@link Result}, and for a write the context `also` gets, as a type only. */
export type Ran<V, E, C> = Result<V, E> & { readonly [contextType]?: C };

/** Resolve an Action with `value`. */
export function ok<V>(value: V): Ran<V, never, never> {
  return { ok: true, value };
}

/** Resolve an Action with the expected failure `error`. */
export function fail<E>(error: E): Ran<never, E, never> {
  return { error, ok: false };
}

/** What `work` resolves with: an {@link Outcome}, or `Failed` with an expected failure, which rolls the unit back. */
export type PluginOutcome<V, C, E> =
  | Outcome<V, C>
  | { readonly _tag: "Failed"; readonly error: E };

/** Typed reads on Plugin table `T` named `N`, as Promises; a rejection is an {@link AdapterError}. */
export interface PromiseTableReads<N extends string, T extends TableDef> {
  /** The record with this id, or `null` when there is none. */
  readonly get: (id: RecordId<N>) => Promise<RecordOf<N, T> | null>;
  /** Every record of the Resource, sorted by `id`. */
  readonly list: (query: {
    readonly resourceId: PluginResourceId;
  }) => Promise<readonly RecordOf<N, T>[]>;
}

/** Typed writes on Plugin table `T` named `N`, as Promises: only on a unit of work. */
export interface PromiseTableWrites<N extends string, T extends TableDef> {
  /** Store a new record; fasti mints its id. */
  readonly insert: (
    record: Omit<RecordOf<N, T>, "id">
  ) => Promise<RecordOf<N, T>>;
}

/** Reads on every table in `T`, by name, as Promises. */
export type PromiseReadsOf<T extends Tables> = {
  readonly [K in keyof T & string]: PromiseTableReads<K, T[K]>;
};

/** Reads and writes on every table in `T`, by name, as Promises: what a unit of work gets. */
export type PromiseStoreOf<T extends Tables> = {
  readonly [K in keyof T & string]: PromiseTableReads<K, T[K]> &
    PromiseTableWrites<K, T[K]>;
};

/** What `work` runs with: one unit of work under the Resource Lock. */
export interface PromiseUnit<T extends Tables> {
  /** The Plugin's tables, read and written on this unit: reads see its own writes. */
  readonly records: PromiseStoreOf<T>;
  /** The Adapter's transaction handle: an escape hatch that ties the Plugin to one ORM. */
  readonly tx: unknown;
  /** The Clock's time, read once on the unit: the same `now` `also` and the Hooks get. */
  readonly now: Temporal.Instant;
}

/**
 * Run `work` as one unit of work under the Resource Lock. On Done, the caller's `also` runs on the same unit, and its
 * value is merged into the result; NoOp, Failed or a rejection runs no `also`, and Failed or a rejection rolls back.
 */
export type PromiseLock<T extends Tables> = <V, C extends object, E = never>(
  resourceId: PluginResourceId,
  work: (unit: PromiseUnit<T>) => Promise<PluginOutcome<V, C, E>>
) => Promise<Ran<V, E | Vetoed<unknown> | AdapterError, C>>;

/** A Promise-style Plugin Action that only reads: no lock, no `also`. */
export interface ReadDef<T extends Tables, Pm, V, E> {
  readonly kind: "read";
  /** The Action, given the caller's params; `signal` aborts when the caller interrupts the call. */
  readonly run: (
    params: Pm,
    tools: {
      readonly records: PromiseReadsOf<T>;
      readonly signal: AbortSignal;
    }
  ) => Promise<Result<V, E>>;
}

/** A Promise-style Plugin Action that writes: through `lock`, which runs the caller's `also`. */
export interface WriteDef<T extends Tables, Pm, V, C, E> {
  readonly kind: "write";
  /**
   * The Action, given the caller's params; `records` reads outside any unit. Resolve with what `lock` resolves with.
   * `signal` aborts when the caller interrupts the call: a unit then rolls back, but code between `lock` calls runs on.
   */
  readonly run: (
    params: Pm,
    tools: {
      readonly records: PromiseReadsOf<T>;
      readonly lock: PromiseLock<T>;
      readonly signal: AbortSignal;
    }
  ) => Promise<Ran<V, E, C>>;
}

/** A Promise-style Plugin's Actions over its tables `T`, by name. */
export type PromiseActions<T extends Tables> = Readonly<
  Record<
    string,
    | ReadDef<T, never, unknown, unknown>
    | WriteDef<T, never, unknown, object, unknown>
  >
>;

/** Promise-style Actions `A` as the native Actions `promiseFace` makes of them: the app types both alike. */
export type NativeOf<T extends Tables, A> = {
  readonly [K in keyof A]: A[K] extends {
    readonly kind: "write";
    readonly run: (
      params: infer Pm,
      tools: never
    ) => Promise<Ran<infer V, infer E, infer C>>;
  }
    ? NativeWrite<T, Pm, V, C, E>
    : A[K] extends {
          readonly kind: "read";
          readonly run: (
            params: infer Pm,
            tools: never
          ) => Promise<Result<infer V, infer E>>;
        }
      ? NativeRead<T, Pm, V, E>
      : never;
};

// ── promiseFace: the Promise-style Actions as native ones. Types are erased here; NativeOf types the result.

/** A record handle verb, either side of the crossing. */
type Verb<R> = (...args: readonly never[]) => R;

/** Record handles by table, then verb. */
type Handles<R> = Readonly<Record<string, Readonly<Record<string, Verb<R>>>>>;

/** A Promise-style Action, its types erased. */
interface ErasedDef {
  readonly kind: "read" | "write";
  readonly run: (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the Plugin's own params, typed by the Plugin.
    params: unknown,
    tools: {
      readonly records: Handles<Promise<unknown>>;
      readonly lock: ErasedPromiseLock;
      readonly signal: AbortSignal;
    }
  ) => Promise<Result<unknown, unknown>>;
}

type ErasedPromiseLock = (
  resourceId: PluginResourceId,
  work: (unit: {
    readonly records: Handles<Promise<unknown>>;
    readonly tx: unknown;
    readonly now: Temporal.Instant;
  }) => Promise<PluginOutcome<unknown, object, unknown>>
) => Promise<Result<unknown, unknown>>;

/** The tools a native Action's `run` gets, its types erased. */
interface ErasedTools {
  readonly records: Handles<Effect.Effect<unknown, AdapterError>>;
  readonly lock: (
    resourceId: PluginResourceId,
    work: (unit: {
      readonly records: Handles<Effect.Effect<unknown, AdapterError>>;
      readonly tx: unknown;
      readonly now: Temporal.Instant;
    }) => Effect.Effect<Outcome<unknown, object>, unknown>
  ) => Effect.Effect<Written<unknown, object>, unknown>;
}

/** Run `effect` with the caller's `services`: interrupted on `signal`; a typed failure becomes `error`, a defect or interrupt rejects. */
async function settle<A, E>(
  services: Context.Context<never>,
  signal: AbortSignal,
  effect: Effect.Effect<A, E>
): Promise<Result<A, E>> {
  return exitToResult(
    await Effect.runPromiseExitWith(services)(effect, { signal })
  );
}

/** An {@link AdapterError} stays the failure; anything else thrown is a defect. */
function adapterErrorOrDie(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever a Plugin's Promise rejected with.
  thrown: unknown
): Effect.Effect<never, AdapterError> {
  return thrown instanceof AdapterError
    ? Effect.fail(thrown)
    : Effect.die(thrown);
}

/** Await `run`: a rejection with an {@link AdapterError} is that failure; any other rejection is a defect. */
function attempt<A>(
  run: (signal: AbortSignal) => Promise<A>
): Effect.Effect<A, AdapterError> {
  return Effect.tryPromise({ catch: (thrown) => thrown, try: run }).pipe(
    Effect.catch(adapterErrorOrDie)
  );
}

/** A resolved {@link Result} as an Effect. */
function fromResult<A, E>(result: Result<A, E>): Effect.Effect<A, E> {
  return result.ok ? Effect.succeed(result.value) : Effect.fail(result.error);
}

/** Native record handles as Promises, run with the caller's services; a failure rejects with its AdapterError. */
function promised(
  handles: Handles<Effect.Effect<unknown, AdapterError>>,
  services: Context.Context<never>,
  signal: AbortSignal
): Handles<Promise<unknown>> {
  return Object.fromEntries(
    Object.entries(handles).map(([table, verbs]) => [
      table,
      Object.fromEntries(
        Object.entries(verbs).map(([name, verb]) => [
          name,
          async (...args: readonly never[]) => {
            const result = await settle(services, signal, verb(...args));

            if (!result.ok) {
              throw result.error;
            }

            return result.value;
          },
        ])
      ),
    ])
  );
}

/** One Promise-style Action as a native one: the caller's services and the call's AbortSignal cross with it. */
function nativeRun(def: ErasedDef) {
  return (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the Plugin's own params, typed by the Plugin.
    params: unknown,
    tools: ErasedTools
  ): Effect.Effect<unknown, unknown> =>
    Effect.flatMap(Effect.context(), (services) =>
      attempt(async (signal) => {
        const records = promised(tools.records, services, signal);

        async function lock(
          ...[resourceId, work]: Parameters<ErasedPromiseLock>
        ): ReturnType<ErasedPromiseLock> {
          return await settle(
            services,
            signal,
            Effect.map(
              tools.lock(resourceId, (unit) =>
                attempt(
                  async () =>
                    await work({
                      ...unit,
                      records: promised(unit.records, services, signal),
                    })
                ).pipe(
                  Effect.flatMap((outcome) => {
                    // The call was interrupted while `work` ran: roll back even if it ignored the signal.
                    if (signal.aborted) {
                      return Effect.interrupt;
                    }

                    return outcome._tag === "Failed"
                      ? Effect.fail(outcome.error)
                      : Effect.succeed(outcome);
                  })
                )
              ),
              (written) => written.value
            )
          );
        }

        return await def.run(params, { lock, records, signal });
      }).pipe(
        Effect.flatMap(fromResult),
        // A native write resolves with a Written; a read with its value.
        Effect.map((value) => (def.kind === "write" ? { value } : value))
      )
    );
}

/** Promise-style Actions as native ones: the one Promise/Effect crossing (Risk R2). */
function promiseFace(actions: Readonly<Record<string, ErasedDef>>): Readonly<
  Record<
    string,
    {
      readonly kind: "read" | "write";
      readonly run: ReturnType<typeof nativeRun>;
    }
  >
> {
  return Object.fromEntries(
    Object.entries(actions).map(([name, def]) => [
      name,
      { kind: def.kind, run: nativeRun(def) },
    ])
  );
}

/**
 * Define a Plugin with plain async functions: tables stored by every Adapter with `records`, and Actions on
 * `scheduler.<name>`. It builds the same Plugin as the native `definePlugin` from `@fastijs/scheduler/effect`, and the app
 * types its Actions alike. Write each Action's params type on `run`'s first parameter, with {@link PluginResourceId}
 * for the Resource id.
 *
 * @example
 * ```ts
 * const notes = definePlugin({
 *   name: "notes",
 *   tables: { note: { columns: { text: { type: column.text(), required: true } } } },
 *   actions: {
 *     add: {
 *       kind: "write",
 *       run: async (params: { readonly resourceId: PluginResourceId; readonly text: string }, { lock }) =>
 *         await lock(params.resourceId, async ({ records }) => {
 *           const note = await records.note.insert(params);
 *           return { _tag: "Done", value: note, context: { note } } as const;
 *         }),
 *     },
 *   },
 * });
 * ```
 */
export function definePlugin<
  const N extends string,
  // A has no default, and comes before T to allow that: a default on A stops `run`'s tools being typed from T.
  const A extends PromiseActions<T>,
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- "no tables" is exactly `{}`.
  const T extends Tables = Record<never, never>,
>(def: {
  /** Its Actions appear on `scheduler[name]`; unique per schema, and not a scheduler key (`book`, …). */
  readonly name: N;
  /** Its tables, by logical name; unique per schema, and not `booking`. */
  readonly tables?: T;
  /** Its Actions, by name; `{}` for none. */
  readonly actions: A;
}): Plugin<N, T, NativeOf<T, A>> {
  // SAFETY: T falls back to its default, `{}`, exactly when `tables` is absent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the default can't be tied to absence in the signature.
  const tables = (def.tables ?? {}) as T;

  // SAFETY: each ReadDef/WriteDef is an ErasedDef with its types erased (`never` params can't be compared with `unknown`).
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- the Actions are erased across the crossing.
  const erased = def.actions as unknown as Readonly<Record<string, ErasedDef>>;

  // SAFETY: promiseFace makes the native Actions NativeOf<T, A> names: the same params, value, context and errors.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- see above.
  const actions = promiseFace(erased) as unknown as NativeOf<T, A>;

  return { actions, name: def.name, tables };
}
