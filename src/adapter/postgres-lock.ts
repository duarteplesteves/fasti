import { someCause } from "./retry.js";

/**
 * The first key of every fasti advisory lock ("fsti" in ASCII), so other advisory locks in the database don't collide.
 * Every Postgres Adapter locks with this key, so units through different Adapters on one Resource exclude each other.
 */
export const LOCK_NAMESPACE = 0x66_73_74_69;

/**
 * A transient SQLSTATE: 40001 serialization_failure or 40P01 deadlock_detected.
 *
 * @returns `true` when `state` is `40001` or `40P01`.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a field of a thrown object, whatever the driver put there.
function isTransientState(state: unknown): boolean {
  return state === "40001" || state === "40P01";
}

/**
 * A transient Postgres error anywhere on the `cause` chain, its SQLSTATE on `code` (node-postgres) or `sqlState`.
 *
 * @returns `true` when `error` or a link of its `cause` chain carries a transient SQLSTATE.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejection reason is whatever was thrown.
export function isPgTransient(error: unknown): boolean {
  return someCause(
    error,
    (e) =>
      ("code" in e && isTransientState(e.code)) ||
      ("sqlState" in e && isTransientState(e.sqlState))
  );
}
