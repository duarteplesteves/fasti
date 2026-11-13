import { describe, expect, it } from "vitest";

import * as root from "./index.js";

describe("root export surface", () => {
  it("exports defineSchema and column, and not the Core", () => {
    expect(Object.keys(root).toSorted()).toStrictEqual([
      "column",
      "defineSchema",
    ]);
  });
});
