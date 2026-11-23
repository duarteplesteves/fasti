import { describe, expect, it } from "vitest";

import type { BookingId } from "../core/types.js";
import { toConflicts } from "./occupancy.js";

function at(h: number): Temporal.Instant {
  return Temporal.Instant.from(
    `2026-01-05T${String(h).padStart(2, "0")}:00:00Z`
  );
}

function hit(id: string, start: number) {
  return {
    end: at(start + 1),
    // SAFETY: test ids only need to be distinct strings.
    id: id as BookingId,
    isBlocking: true,
    resourceId: "r",
    start: at(start),
  };
}

describe(toConflicts, () => {
  it("sorts by start, then id, and drops what the Core used", () => {
    const hits = [hit("b", 9), hit("c", 8), hit("a", 9)];
    const kinds = new Map(hits.map((h) => [h.id, "booking"] as const));

    expect(toConflicts(hits, kinds)).toStrictEqual([
      { end: at(9), id: "c", kind: "booking", start: at(8) },
      { end: at(10), id: "a", kind: "booking", start: at(9) },
      { end: at(10), id: "b", kind: "booking", start: at(9) },
    ]);
  });
});
