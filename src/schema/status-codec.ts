import type { AnySchema } from "./define-schema.js";

/** Every Status lookup goes through here: logical ↔ stored values, and which Statuses block. */
export interface StatusCodec<St extends string> {
  /** Whether a Booking in this Status occupies its slot. */
  readonly isBlocking: (status: St) => boolean;
  /** The value stored for a Status: `"booked"` → `"CONFIRMED"`. */
  readonly toStored: (status: St) => string;
  /** The Status a stored value means, or `undefined` when the schema doesn't know it (the Adapter rejects). */
  readonly fromStored: (stored: string) => St | undefined;
  /** Stored values of the blocking Statuses. */
  readonly blockingStored: readonly string[];
  /** Every stored value. */
  readonly allStored: readonly string[];
  /** Whether `from → to` is a declared Transition. */
  readonly canMove: (from: St, to: St) => boolean;
}

/** The Status lookup table of a schema. Stored values are distinct, as `defineSchema` checks (I6). */
export function statusCodec<S extends AnySchema>(
  schema: S
): StatusCodec<keyof S["statuses"] & string> {
  type St = keyof S["statuses"] & string;

  // SAFETY: the keys of schema.statuses are exactly St.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.entries widens keys to string.
  const entries = Object.entries(schema.statuses) as [
    St,
    { readonly blocking: boolean; readonly stored: string },
  ][];

  const byStored = new Map(entries.map(([status, s]) => [s.stored, status]));

  function lookup(status: St) {
    const s = schema.statuses[status];

    if (s === undefined) {
      throw new Error(`Unknown Status "${status}"`);
    }

    return s;
  }

  return {
    allStored: entries.map(([, s]) => s.stored),
    canMove: (from, to) =>
      Object.hasOwn(schema.transitions, from) &&
      (schema.transitions[from]?.includes(to) ?? false),
    blockingStored: entries
      .filter(([, s]) => s.blocking)
      .map(([, s]) => s.stored),
    fromStored: (stored) => byStored.get(stored),
    isBlocking: (status) => lookup(status).blocking,
    toStored: (status) => lookup(status).stored,
  };
}
