import { describe, it } from "vitest";

import type { Adapter, GroupsOf } from "../adapter/contract.js";
import type { ResourceIdOf } from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";
import { backstopCases } from "./cases/backstop.js";
import { blockCases } from "./cases/blocks.js";
import { changeCases } from "./cases/change.js";
import { hookCases } from "./cases/hooks.js";
import { lockCases } from "./cases/lock.js";
import { recordCases } from "./cases/records.js";
import { rollbackCases } from "./cases/rollback.js";
import { roundTripCases } from "./cases/round-trips.js";
import { ruleCases } from "./cases/rules.js";
import { searchCases } from "./cases/search.js";
import { txCases } from "./cases/tx.js";
import type {
  ConformanceCase,
  RetryProbe,
  TxProbe,
} from "./conformance-case.js";
import { skipped as pluginSkipped } from "./plugin-stores.js";

/** Params of {@link testAdapter} and {@link runCase}. */
export interface TestAdapterParams<S extends AnySchema, Tx> {
  /** Your schema, with your names and Developer Fields. */
  readonly schema: S;
  /** Called once per case. The Adapter must allow 20 concurrent units of work, and implement `records` if `schema`'s Plugins declare tables. */
  readonly makeAdapter: () => Adapter<Tx, GroupsOf<S>>;
  /** Empties the fasti tables before each case; your Resource rows stay. */
  readonly reset: () => Promise<void>;
  /** Two existing Resource ids, so Bookings satisfy your foreign key. */
  readonly resources: readonly [ResourceIdOf<S>, ResourceIdOf<S>];
  /**
   * Opt-in groups: `backstop` only if your Adapter ships a database constraint; `tx` a probe over a table of your own, or `null` if `tx` is no transaction (e.g. in memory);
   * `retry` a value your Adapter retries as transient, or `null` if it never retries.
   * The `blocks` cases run iff `schema` installs `blocks()`, the `availability` cases iff it installs `availability()`, and the `records` cases iff it installs `conformancePlugin`.
   */
  readonly groups: {
    readonly backstop: boolean;
    readonly tx: TxProbe<Tx> | null;
    readonly retry: RetryProbe | null;
  };
}

/** Every Conformance Suite case. Filter by `tags` and run one with {@link runCase}. */
export const conformanceCases: readonly ConformanceCase[] = [
  ...roundTripCases,
  ...ruleCases,
  ...searchCases,
  ...changeCases,
  ...rollbackCases,
  ...lockCases,
  ...backstopCases,
  ...blockCases,
  ...recordCases,
  ...txCases,
  ...hookCases,
];

/** Run one case: reset, make a fresh Adapter for the schema, run it. Rejects when the case fails. */
export async function runCase<S extends AnySchema, Tx>(
  c: ConformanceCase,
  params: TestAdapterParams<S, Tx>
): Promise<void> {
  await params.reset();

  const unbound = params.makeAdapter();

  await c.run({
    adapter: unbound(params.schema),
    probe: params.groups.tx,
    resources: params.resources,
    retry: params.groups.retry,
    schema: params.schema,
    unbound,
  });
}

/**
 * Register the Conformance Suite as Vitest tests: one `it` per case.
 * Cases of a group you didn't opt into (`backstop: false`, `tx: null`, `retry: null`), and Plugin cases for a schema without their Plugin (`blocks()`, `availability()`, `conformancePlugin`), are registered as skipped.
 */
export function testAdapter<S extends AnySchema, Tx>(
  params: TestAdapterParams<S, Tx>
): void {
  describe("fasti Adapter conformance", () => {
    for (const c of conformanceCases) {
      const skipped =
        (c.tags.includes("backstop") && !params.groups.backstop) ||
        pluginSkipped(c, params.schema) ||
        (c.tags.includes("tx") && params.groups.tx === null) ||
        (c.tags.includes("retry") && params.groups.retry === null);

      it.skipIf(skipped)(c.name, async () => {
        await runCase(c, params);
      });
    }
  });
}
