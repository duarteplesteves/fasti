import { describe, expect, it } from "vitest";

import { isPgTransient } from "./postgres-lock.js";

describe(isPgTransient, () => {
  it.each([
    ["40001 on code", { code: "40001" }],
    ["40P01 on code", { code: "40P01" }],
    ["40001 on sqlState", { sqlState: "40001" }],
    ["40P01 on sqlState", { sqlState: "40P01" }],
    [
      "40P01 on sqlState two causes deep",
      new Error("outer", {
        cause: new Error("inner", { cause: { sqlState: "40P01" } }),
      }),
    ],
    [
      "40001 on code one cause deep",
      new Error("x", { cause: { code: "40001" } }),
    ],
  ])("is transient: %s", (_name, error) => {
    expect(isPgTransient(error)).toBeTruthy();
  });

  it.each([
    ["another code", { code: "23505" }],
    ["another sqlState", { sqlState: "P0001" }],
    ["no code", new Error("x")],
    ["a string", "40001"],
    ["null", null],
  ])("isn't transient: %s", (_name, error) => {
    expect(isPgTransient(error)).toBeFalsy();
  });

  it("ends the walk on a cause that loops back", () => {
    const error = new Error("loop");
    error.cause = error;

    expect(isPgTransient(error)).toBeFalsy();
  });
});
