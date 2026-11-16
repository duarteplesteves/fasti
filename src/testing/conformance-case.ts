import type { GroupsOf, SchemaAdapter } from "../adapter/contract.js";
import type { ResourceIdOf } from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";

/** Tags that group cases: `concurrency` cases test the lock; `backstop` cases are optional; `blocks` cases run only for a schema with `block`. */
export type CaseTag = "concurrency" | "backstop" | "blocks";

/** What a case runs against: a fresh Adapter on emptied tables. */
export interface CaseContext<S extends AnySchema, Tx> {
  /** The schema under test. */
  readonly schema: S;
  /** The Adapter, bound to `schema`, with the verb groups the schema needs. */
  readonly adapter: SchemaAdapter<S, Tx, GroupsOf<S>>;
  /** Two existing Resources. */
  readonly resources: readonly [ResourceIdOf<S>, ResourceIdOf<S>];
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
