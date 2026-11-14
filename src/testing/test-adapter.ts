import { describe, it } from "vitest";

import type { Adapter } from "../adapter/contract.js";
import type { ResourceIdOf } from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";
import { backstopCases } from "./cases/backstop.js";
import { changeCases } from "./cases/change.js";
import { lockCases } from "./cases/lock.js";
import { rollbackCases } from "./cases/rollback.js";
import { roundTripCases } from "./cases/round-trips.js";
import { ruleCases } from "./cases/rules.js";
import { searchCases } from "./cases/search.js";
import type { ConformanceCase } from "./conformance-case.js";

/** Params of {@link testAdapter} and {@link runCase}. */
export interface TestAdapterParams<S extends AnySchema, Tx> {
  /** Your schema, with your names and Developer Fields. */
  readonly schema: S;
  /** Called once per case. The Adapter must allow 20 concurrent units of work. */
  readonly makeAdapter: () => Adapter<Tx>;
  /** Empties the fasti tables before each case; your Resource rows stay. */
  readonly reset: () => Promise<void>;
  /** Two existing Resource ids, so Bookings satisfy your foreign key. */
  readonly resources: readonly [ResourceIdOf<S>, ResourceIdOf<S>];
  /** Opt-in groups: `backstop` only if your Adapter ships a database constraint. */
  readonly groups: { readonly backstop: boolean };
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
];

/** Run one case: reset, make a fresh Adapter for the schema, run it. Rejects when the case fails. */
export async function runCase<S extends AnySchema, Tx>(
  c: ConformanceCase,
  params: TestAdapterParams<S, Tx>
): Promise<void> {
  await params.reset();
  await c.run({
    adapter: params.makeAdapter()(params.schema),
    resources: params.resources,
    schema: params.schema,
  });
}

/**
 * Register the Conformance Suite as Vitest tests: one `it` per case.
 * Cases of a group you didn't opt into are registered as skipped.
 */
export function testAdapter<S extends AnySchema, Tx>(
  params: TestAdapterParams<S, Tx>
): void {
  describe("fasti Adapter conformance", () => {
    for (const c of conformanceCases) {
      const skipped = c.tags.includes("backstop") && !params.groups.backstop;

      it.skipIf(skipped)(c.name, async () => {
        await runCase(c, params);
      });
    }
  });
}
