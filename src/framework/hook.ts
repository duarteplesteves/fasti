import type { Adapter, GroupsOf } from "../adapter/contract.js";
import type { AnySchema, HasBlocks } from "../schema/define-schema.js";
import type { SetAvailabilityAlso } from "./availability.js";
import type {
  CreateBlockAlso,
  DeleteBlockAlso,
  UpdateBlockAlso,
} from "./blocks.js";
import type { BookAlso } from "./book.js";
import type { ChangeAlso } from "./booking.js";
import {
  checkEdgeTargets,
  isActionName,
  isBlockActionName,
  matchesTarget,
} from "./target.js";
import type { CalledTarget, HookTarget } from "./target.js";

/** What one saved write tells its Hooks: `also`'s context plus `action`. One variant per write Action. */
export type HookEvent<S extends AnySchema, Tx> =
  | ({ readonly action: "book" } & BookAlso<S, Tx>)
  | ({ readonly action: "reschedule" } & ChangeAlso<S, Tx>)
  | ({ readonly action: "cancel" } & ChangeAlso<S, Tx>)
  | ({ readonly action: "transition" } & ChangeAlso<S, Tx>)
  | ({ readonly action: "availability.set" } & SetAvailabilityAlso<S, Tx>)
  | (HasBlocks<S> extends true
      ?
          | ({ readonly action: "blocks.create" } & CreateBlockAlso<S, Tx>)
          | ({ readonly action: "blocks.update" } & UpdateBlockAlso<S, Tx>)
          | ({ readonly action: "blocks.delete" } & DeleteBlockAlso<S, Tx>)
      : never);

/** The events a Hook with targets `T` sees: names by `action`, edges as `"transition"`. */
type EventFor<
  S extends AnySchema,
  Tx,
  T extends HookTarget<S>,
> = T extends string
  ? Extract<HookEvent<S, Tx>, { readonly action: T }>
  : Extract<HookEvent<S, Tx>, { readonly action: "transition" }>;

/** An after-commit event: no `tx`, since the transaction is gone. */
export type Committed<E> = E extends unknown ? Omit<E, "tx"> : never;

/** What `appliesTo` takes: `"*"` for every write Action, or at least one target. */
type HookTargets<S extends AnySchema> =
  | "*"
  | readonly [HookTarget<S>, ...HookTarget<S>[]];

/** The targets in `A`: `"*"` is every one. */
type TargetsOf<S extends AnySchema, A extends HookTargets<S>> = A extends "*"
  ? HookTarget<S>
  : A extends readonly (infer T extends HookTarget<S>)[]
    ? T
    : never;

/** When a Hook runs: in the Action's transaction, or once after the commit. */
type HookWhen = "inTransaction" | "afterCommit";

/** Params of {@link defineHook}; `when` picks the event `run` gets. */
export interface DefineHookParams<
  S extends AnySchema,
  Tx,
  A extends HookTargets<S>,
  W extends HookWhen,
> {
  /**
   * `"inTransaction"`: on the Action's transaction, after `also`; a throw rolls the whole write back, and the Action rejects with it.
   * `"afterCommit"`: once, after the commit, awaited; a failure is logged and never changes the result.
   */
  readonly when: W;
  /** Write Action names, Transition edges, or `"*"` for every write Action. Reads never run Hooks. */
  readonly appliesTo: A;
  readonly run: (
    event: W extends "inTransaction"
      ? EventFor<S, Tx, TargetsOf<S, A>>
      : Committed<EventFor<S, Tx, TargetsOf<S, A>>>
  ) => void | Promise<void>;
}

/** A Hook from {@link defineHook}, over a schema `S` and an Adapter whose transaction handle is `Tx`, with `appliesTo` `A`, run `W`. An after-commit one never mentions `Tx`, so it fits a scheduler over any Adapter. */
export type Hook<
  S extends AnySchema,
  Tx,
  A extends HookTargets<S>,
  W extends HookWhen,
> = DefineHookParams<S, Tx, A, W>;

/** Any Hook over `S` and `Tx`: what `hooks` takes. `run` is a method so a Hook narrowed by `appliesTo` fits. */
export type AnyHookOf<S extends AnySchema, Tx> =
  | {
      readonly when: "inTransaction";
      readonly appliesTo: HookTargets<S>;
      // oxlint-disable-next-line typescript/method-signature-style -- method syntax is bivariant, so a narrowed `run` is assignable.
      run(event: HookEvent<S, Tx>): void | Promise<void>;
    }
  | {
      readonly when: "afterCommit";
      readonly appliesTo: HookTargets<S>;
      // oxlint-disable-next-line typescript/method-signature-style -- as above.
      run(event: Committed<HookEvent<S, Tx>>): void | Promise<void>;
    };

/**
 * A Hook: `run` observes every saved write it applies to, in the Action's transaction or after the commit.
 * The `adapter` only types `tx`; it is never called.
 * Throws on an empty `appliesTo`, an unknown name, `blocks.*` on a schema without `block`, an undeclared edge, or an edge into `cancelled`.
 *
 * @example
 * ```ts
 * const confirm = defineHook(schema, adapter, {
 *   when: "afterCommit",
 *   appliesTo: ["book"],
 *   run: async ({ booking }) => { await sendConfirmation(booking); },
 * });
 * const scheduler = createScheduler({ schema, adapter, hooks: [confirm] });
 * ```
 */
export function defineHook<
  S extends AnySchema,
  Tx,
  const A extends HookTargets<S>,
  const W extends HookWhen,
>(
  schema: S,
  _adapter: Adapter<Tx, GroupsOf<S>>,
  params: DefineHookParams<S, Tx, A, W>
): Hook<S, Tx, A, W> {
  const { appliesTo } = params;

  if (appliesTo === "*") {
    return params;
  }

  // Plain-JS callers can pass what the types refuse.
  if (appliesTo.length === 0) {
    throw new Error(
      'fasti: a Hook applies to nothing: name at least one target, or "*"'
    );
  }

  for (const target of appliesTo) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- an unknown name is a string too, so isActionName can't tell it from an edge; checkEdgeTargets checks the edges.
    if (typeof target !== "string") {
      continue;
    }

    if (!isActionName(target)) {
      throw new Error(
        `fasti: a Hook applies to ${target}, which isn't a write Action`
      );
    }

    if (isBlockActionName(target) && schema.block === null) {
      throw new Error(
        `fasti: a Hook applies to ${target}, but the schema has no block`
      );
    }
  }

  checkEdgeTargets(schema, "a Hook", appliesTo);

  return params;
}

/** Whether a Hook with targets `appliesTo` runs on a call to `called`. */
export function hookApplies(
  { appliesTo }: { readonly appliesTo: HookTargets<AnySchema> },
  called: CalledTarget
): boolean {
  return appliesTo === "*" || appliesTo.some((t) => matchesTarget(t, called));
}
