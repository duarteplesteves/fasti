import { describe, expect, it } from "vitest";

import { defineSchema } from "./define-schema.js";
import { statusCodec } from "./status-codec.js";

describe(statusCodec, () => {
  const codec = statusCodec(
    defineSchema({ names: { statuses: { booked: "CONFIRMED" } } })
  );

  it("maps logical Statuses to stored values and back", () => {
    expect(codec.toStored("booked")).toBe("CONFIRMED");
    expect(codec.fromStored("CONFIRMED")).toBe("booked");
    expect(codec.fromStored("cancelled")).toBe("cancelled");
  });

  it("rejects what the schema doesn't know: undefined for a stored value, a throw for a Status", () => {
    expect(codec.fromStored("booked")).toBeUndefined();
    expect(codec.fromStored("toString")).toBeUndefined();
    // @ts-expect-error not a Status of this schema
    expect(() => codec.isBlocking("held")).toThrow(/Unknown Status "held"/u);
  });

  it("knows which Statuses block", () => {
    expect(codec.isBlocking("booked")).toBeTruthy();
    expect(codec.isBlocking("cancelled")).toBeFalsy();
    expect(codec.blockingStored).toStrictEqual(["CONFIRMED"]);
    expect(codec.allStored).toStrictEqual(["CONFIRMED", "cancelled"]);
  });
});
