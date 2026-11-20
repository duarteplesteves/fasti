import type { Adapter, GroupsOf, SchemaAdapter } from "../adapter/contract.js";
import type { ResourceIdOf } from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";

/** Tags that group cases: `concurrency` cases test the lock; `backstop` cases are optional; `blocks` cases run only for a schema with `block`; `tx` cases run only with a {@link TxProbe}; `retry` cases run only with a {@link RetryProbe}. */
export type CaseTag = "concurrency" | "backstop" | "blocks" | "tx" | "retry";

/** A row of the developer's own, written through `tx`: proves `tx` is fasti's transaction (ADR 015). */
export interface TxProbe<Tx> {
  /** Insert one probe row through `tx`. */
  readonly write: (tx: Tx) => Promise<void>;
  /** Count probe rows, outside any transaction. */
  readonly count: () => Promise<number>;
}

/** A value your Adapter treats as transient and retries: the Postgres Adapters' is `{ code: "40001" }`. */
export interface RetryProbe {
  /** A fresh transient value; a `retry` case throws it from an in-transaction Hook. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- a transient value is whatever your driver throws.
  readonly transient: () => unknown;
}

/** What a case runs against: a fresh Adapter on emptied tables. */
export interface CaseContext<S extends AnySchema, Tx> {
  /** The schema under test. */
  readonly schema: S;
  /** The Adapter, bound to `schema`, with the verb groups the schema needs. */
  readonly adapter: SchemaAdapter<S, Tx, GroupsOf<S>>;
  /** Two existing Resources. */
  readonly resources: readonly [ResourceIdOf<S>, ResourceIdOf<S>];
  /** The `tx` probe; `null` when the `tx` group is skipped. */
  readonly probe: TxProbe<Tx> | null;
  /** The same Adapter, unbound, so a case can `createScheduler` over it (e.g. with Hooks). */
  readonly unbound: Adapter<Tx, GroupsOf<S>>;
  /** The retry probe; `null` when the `retry` group is skipped. */
  readonly retry: RetryProbe | null;
}

/** One Conformance Suite case, as data: run it alone with `runCase`. */
export interface ConformanceCase {
  /** What the case checks. */
  readonly name: string;
  /** The groups it belongs to. */
  readonly tags: readonly CaseTag[];
  /** Run the case; it fails by rejecting. */
  readonly run: <S extends AnySchema, Tx>(
    ctx: CaseContext<S, Tx>
  ) => Promise<void>;
}
