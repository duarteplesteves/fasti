import { describe, expect, it } from "vitest";

import { serialize } from "./queue.js";

describe(serialize, () => {
  it("runs units one after another, in call order, even when an earlier one rejects", async () => {
    const run = serialize();
    const log: string[] = [];
    const gate = Promise.withResolvers<undefined>();

    const first = run(async () => {
      log.push("first start");
      await gate.promise;
      log.push("first end");
      throw new Error("first failed");
    });

    const second = run(async () => {
      log.push("second");

      return await Promise.resolve(2);
    });

    // The second waits for the first, however long it takes.
    await Promise.resolve();
    expect(log).toStrictEqual(["first start"]);

    gate.resolve(undefined);

    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe(2);
    expect(log).toStrictEqual(["first start", "first end", "second"]);
  });

  it("gives each serialize() its own line", async () => {
    const gate = Promise.withResolvers<undefined>();

    // A unit blocked on one line doesn't hold up another line.
    void serialize()(async () => {
      await gate.promise;
    });

    await expect(
      serialize()(async () => await Promise.resolve("free"))
    ).resolves.toBe("free");
    gate.resolve(undefined);
  });
});
