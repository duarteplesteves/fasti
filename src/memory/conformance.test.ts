import { describe, expect, it } from "vitest";

import {
  integerIdResources,
  integerIdSchema,
  textIdResources,
  textIdSchema,
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { conformanceCases, runCase, testAdapter } from "../testing/index.js";
import { memoryAdapter } from "./index.js";
import { createMemoryAdapter } from "./memory-adapter.js";

// Each case gets a fresh memoryAdapter(), so there is nothing to reset.
async function reset(): Promise<void> {}

function lockOffAdapter() {
  return createMemoryAdapter({ lock: false });
}

const concurrencyCases = conformanceCases.filter((c) =>
  c.tags.includes("concurrency")
);

describe.each([
  ["text ids", textIdSchema, textIdResources],
  ["uuid ids", uuidIdSchema, uuidIdResources],
  ["integer ids", integerIdSchema, integerIdResources],
] as const)("memoryAdapter, %s", (_label, schema, resources) => {
  const params = {
    groups: { backstop: false },
    makeAdapter: memoryAdapter,
    reset,
    resources,
    schema,
  };

  testAdapter(params);

  // Negative control: without the lock each concurrency case must fail, or the suite can't catch a missing lock.
  // Blocks cases are skipped without `block`, so a failure there would prove nothing.
  it.fails.each(
    concurrencyCases.filter(
      (c) => schema.block !== null || !c.tags.includes("blocks")
    )
  )("[lock off] $name", async (c) => {
    await expect(
      runCase(c, { ...params, makeAdapter: lockOffAdapter })
    ).resolves.toBeUndefined();
  });
});
