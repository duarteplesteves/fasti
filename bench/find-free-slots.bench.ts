import { describe, expect, test } from "vitest";

import { availableWindows } from "../src/core/availability.js";
import { checkResourceInputs } from "../src/core/checks.js";
import { findFreeSlots, freeGridSlots } from "../src/core/find-free-slots.js";
import { unwrap } from "../src/test-utils/results.js";
import { scenarios } from "./scenarios.js";

// The whole search, then the parts it's made of, so a change shows where it helped.
describe("findFreeSlots", () => {
  test.for(scenarios)("$name", async ({ search, slots }, { bench }) => {
    expect(unwrap(findFreeSlots(search))).toHaveLength(slots);

    await bench.compare(
      bench("findFreeSlots", () => {
        findFreeSlots(search);
      }),
      bench("expand rules", () => {
        availableWindows(search.rules, {
          end: search.to,
          start: search.from,
        });
      }),
      bench("grid + sweep", () => {
        freeGridSlots(search);
      }),
      bench("checks", () => {
        checkResourceInputs(search);
      })
    );
  });
});
