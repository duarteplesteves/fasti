import type { AnySchema, TransitionEdge } from "../schema/define-schema.js";
import { statusCodec } from "../schema/status-codec.js";

/** The Actions that change a Booking. */
const bookingActions = ["book", "reschedule", "cancel"] as const;

/** The Actions that change a Booking: what a Policy can name. */
export type BookingActionName = (typeof bookingActions)[number];

/** @deprecated Use {@link BookingActionName}. */
export type ActionTarget = BookingActionName;

/** The names of the write Actions in Plugin Actions `A`. */
export type WriteNamesOf<A> = {
  [K in keyof A & string]: A[K] extends { readonly kind: "write" } ? K : never;
}[keyof A & string];

/** Every installed Plugin's write Actions, as `<plugin>.<action>`. */
export type PluginWriteName<S extends AnySchema> =
  S["plugins"][number] extends infer Pl
    ? Pl extends {
        readonly name: infer N extends string;
        readonly actions: infer A;
      }
      ? `${N}.${WriteNamesOf<A>}`
      : never
    : never;

/** The write Actions named by name, what a Hook can name: the Booking Actions, and each Plugin's as `<plugin>.<action>`. `transition` is named by its edges. */
export type WriteActionName<S extends AnySchema> =
  | BookingActionName
  | PluginWriteName<S>;

/**
 * The write Actions of one Plugin, as `<plugin>.<action>`; its Actions are erased on AnySchema.
 *
 * @returns The names, as `<plugin>.<action>`.
 */
export function pluginWriteNames({
  actions,
  name,
}: {
  readonly actions: unknown;
  readonly name: string;
}): readonly string[] {
  // SAFETY: definePlugin stores each Action with its `kind`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Plugin keeps its Actions as written, typed `unknown` on AnySchema.
  const erased = actions as Readonly<Record<string, { readonly kind: string }>>;

  return Object.entries(erased)
    .filter(([, action]) => action.kind === "write")
    .map(([action]) => `${name}.${action}`);
}

/**
 * The write Actions `schema` has, by name: the runtime twin of {@link WriteActionName}. `transition` is named by its edges.
 *
 * @returns The names.
 */
export function writeActionNames<S extends AnySchema>(
  schema: S
): readonly WriteActionName<S>[] {
  const names: readonly string[] = [
    ...bookingActions,
    ...schema.plugins.flatMap(pluginWriteNames),
  ];

  // SAFETY: each Plugin's write Actions, as PluginWriteName lists them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the template type can't be built from runtime strings.
  return names as readonly WriteActionName<S>[];
}

/** A target as stored, its schema erased. */
type AnyTarget = string | { readonly from?: string; readonly to: string };

/**
 * Whether `target` is named (an Action) rather than a Transition edge; it doesn't check the name exists.
 *
 * @returns `true` when `target` is a string.
 */
export function isNamedTarget(
  target: string | { readonly to: string }
): target is string {
  return typeof target === "string";
}

/**
 * Whether `target` names an Action that changes a Booking.
 *
 * @returns `true` when `target` is `book`, `reschedule` or `cancel`.
 */
export function isBookingActionName(
  target: AnyTarget
): target is BookingActionName {
  return bookingActions.some((a) => a === target);
}

/** A Transition edge: `{ to }` is every declared edge into `to`, `{ from, to }` one edge. Edges into `cancelled` belong to `cancel`. */
export type EdgeTarget<S extends AnySchema> =
  | { readonly to: TransitionEdge<S>["to"]; readonly from?: never }
  | TransitionEdge<S>;

/** What a Policy can apply to: the Actions that change a Booking, and Transition edges. */
export type PolicyTarget<S extends AnySchema> =
  | BookingActionName
  | EdgeTarget<S>;

/** What a Hook can apply to: every write Action, and Transition edges. */
export type HookTarget<S extends AnySchema> =
  | WriteActionName<S>
  | EdgeTarget<S>;

/** What one call is: an Action by name, or the one edge a `transition` moves along. */
export type CalledTarget =
  | string
  | { readonly from: string; readonly to: string };

/**
 * Whether target `t` names `called`: an Action by name, an edge by `{ to }` or by `{ from, to }`.
 *
 * @returns `true` when `t` names `called`.
 */
export function matchesTarget(t: AnyTarget, called: CalledTarget): boolean {
  return isNamedTarget(t) || isNamedTarget(called)
    ? t === called
    : t.to === called.to && (t.from === undefined || t.from === called.from);
}

/** Throws unless every edge target in `appliesTo` is a declared Transition (never into `cancelled`); `owner` names the thrower in the message. */
export function checkEdgeTargets(
  schema: AnySchema,
  owner: string,
  appliesTo: readonly AnyTarget[]
): void {
  const { canMove } = statusCodec(schema);
  const froms = Object.keys(schema.transitions);

  for (const target of appliesTo) {
    if (isNamedTarget(target)) {
      continue;
    }

    const { from, to } = target;

    // Edges into `cancelled` belong to `cancel`.
    const declared =
      to !== "cancelled" &&
      (from === undefined
        ? froms.some((f) => canMove(f, to))
        : canMove(from, to));

    if (!declared) {
      throw new Error(
        `fasti: ${owner} applies to ${from ?? "*"} → ${to}, which isn't a declared Transition (use cancel for cancelled)`
      );
    }
  }
}
