import { describe, expect, it } from "vitest";

// The suite compares records with toStrictEqual, which is only sound if it tells
// Temporal values apart. Vitest 5 (the peer range) does; this guards our own upgrades.
describe("toEqual on Temporal values", () => {
  it("tells two different Instants apart", () => {
    expect({
      at: Temporal.Instant.from("2026-05-12T09:00:00.001Z"),
    }).not.toStrictEqual({
      at: Temporal.Instant.from("2026-05-12T09:00:00.002Z"),
    });
  });

  it("tells two different PlainDates and PlainTimes apart", () => {
    expect([Temporal.PlainDate.from("2026-05-12")]).not.toStrictEqual([
      Temporal.PlainDate.from("2026-05-13"),
    ]);
    expect(Temporal.PlainTime.from("09:00:00.001")).not.toStrictEqual(
      Temporal.PlainTime.from("09:00:00.002")
    );
  });
});
