import type {
  AnySchema,
  HasBlocks,
  TransitionEdge,
} from "../schema/define-schema.js";
import { statusCodec } from "../schema/status-codec.js";

/** The Actions that change a Booking. */
const bookingActions = ["book", "reschedule", "cancel"] as const;

/** The Actions that write a Block; only on a schema with `block`. */
const blockActions = [
  "blocks.create",
  "blocks.update",
  "blocks.delete",
] as const;

/** The Actions that change a Booking: what a Policy can name. */
export type BookingActionName = (typeof bookingActions)[number];

/** @deprecated Use {@link BookingActionName}. */
export type ActionTarget = BookingActionName;

/** The write Actions named by name, what a Hook can name: `blocks.*` only when the schema has `block`. `transition` is named by its edges. */
export type WriteActionName<S extends AnySchema> =
  | BookingActionName
  | "availability.set"
  | (HasBlocks<S> extends true ? (typeof blockActions)[number] : never);

/** Every write Action named by name, whatever the schema. */
const writeActions = [
  ...bookingActions,
  "availability.set",
  ...blockActions,
] as const;

/** A write Action's name, whatever the schema. */
type AnyActionName = (typeof writeActions)[number];

/** A target as stored, its schema erased. */
type AnyTarget =
  | AnyActionName
  | { readonly from?: string; readonly to: string };

/** Whether `target` names a write Action rather than a Transition edge. */
export function isActionName(
  target: string | { readonly to: string }
): target is AnyActionName {
  return writeActions.some((a) => a === target);
}

/** Whether `target` names an Action that changes a Booking. */
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
  | AnyActionName
  | { readonly from: string; readonly to: string };

/** Whether target `t` names `called`: an Action by name, an edge by `{ to }` or by `{ from, to }`. */
export function matchesTarget(t: AnyTarget, called: CalledTarget): boolean {
  return isActionName(t) || isActionName(called)
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
    if (isActionName(target)) {
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
