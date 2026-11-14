import { describe } from "vitest";

import {
  integerIdResources,
  integerIdSchema,
  textIdResources,
  textIdSchema,
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { testAdapter } from "../testing/index.js";
import { memoryAdapter } from "./index.js";

// Each case gets a fresh memoryAdapter(), so there is nothing to reset.
async function reset(): Promise<void> {}

describe("memoryAdapter, text ids", () => {
  testAdapter({
    groups: { backstop: false },
    makeAdapter: memoryAdapter,
    reset,
    resources: textIdResources,
    schema: textIdSchema,
  });
});

describe("memoryAdapter, uuid ids", () => {
  testAdapter({
    groups: { backstop: false },
    makeAdapter: memoryAdapter,
    reset,
    resources: uuidIdResources,
    schema: uuidIdSchema,
  });
});

describe("memoryAdapter, integer ids", () => {
  testAdapter({
    groups: { backstop: false },
    makeAdapter: memoryAdapter,
    reset,
    resources: integerIdResources,
    schema: integerIdSchema,
  });
});
