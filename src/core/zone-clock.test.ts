import { describe, expect, it } from "vitest";

import { zoneClock } from "./zone-clock.js";

/** When `timezone`'s clock shows each of `times`, asked in order, or the jump over it. */
function timesOf(timezone: string, times: readonly string[]): string[] {
  const clock = zoneClock(timezone);

  return times.map((time) => {
    const localMs = Date.parse(`${time}Z`);
    const { offsetMs, startMs } = clock(localMs);
    const ms = localMs - offsetMs;

    return ms < startMs
      ? `jump ${new Date(startMs).toISOString()}`
      : new Date(ms).toISOString();
  });
}

describe(zoneClock, () => {
  it("gives a time in a gap the moment the clocks jump", () => {
    expect(
      timesOf("Europe/Lisbon", [
        "2026-03-29T00:59:59.999",
        "2026-03-29T01:00",
        "2026-03-29T01:59:59.999",
        "2026-03-29T02:00",
      ])
    ).toStrictEqual([
      "2026-03-29T00:59:59.999Z",
      "jump 2026-03-29T01:00:00.000Z",
      "jump 2026-03-29T01:00:00.000Z",
      "2026-03-29T01:00:00.000Z",
    ]);
  });

  it("gives a repeated time its first occurrence, also after a later one", () => {
    // The Azores repeat 00:00–01:00 that day.
    expect(
      timesOf("Atlantic/Azores", [
        "2026-10-25T00:30",
        "2026-10-25T01:00",
        "2026-10-25T00:30",
      ])
    ).toStrictEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T02:00:00.000Z",
      "2026-10-25T00:30:00.000Z",
    ]);
  });

  it("jumps over a whole day", () => {
    expect(
      timesOf("Pacific/Apia", [
        "2011-12-29T23:59",
        "2011-12-30T12:00",
        "2011-12-31T00:00",
      ])
    ).toStrictEqual([
      "2011-12-30T09:59:00.000Z",
      "jump 2011-12-30T10:00:00.000Z",
      "2011-12-30T10:00:00.000Z",
    ]);
  });

  it("goes back years, and forward again", () => {
    expect(
      timesOf("Europe/Lisbon", [
        "2026-07-01T12:00",
        "2020-01-01T12:00",
        "2026-07-01T12:00",
      ])
    ).toStrictEqual([
      "2026-07-01T11:00:00.000Z",
      "2020-01-01T12:00:00.000Z",
      "2026-07-01T11:00:00.000Z",
    ]);
  });

  it("works where the clocks never change", () => {
    expect(
      timesOf("Etc/UTC", ["0001-01-01T00:00", "9999-12-31T23:59"])
    ).toStrictEqual(["0001-01-01T00:00:00.000Z", "9999-12-31T23:59:00.000Z"]);
  });
});
