import { describe, expect, it } from "vitest";

import { windowsFor } from "./availability.js";

describe(windowsFor, () => {
  it("asks for no windows around a slot too long for any to hold", () => {
    const start = Temporal.Instant.from("2026-01-01T00:00Z");
    let asked = 0;

    const windows = windowsFor(
      () => {
        asked += 1;

        return [];
      },
      { end: start.add({ hours: 49 }), start },
      new Map()
    );

    expect(windows).toStrictEqual([]);
    expect(asked).toBe(0);
  });
});
