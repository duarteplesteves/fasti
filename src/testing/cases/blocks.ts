import { expect } from "vitest";

import type { SchemaAdapter } from "../../adapter/contract.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { CaseContext, ConformanceCase } from "../conformance-case.js";
import { blockId, insertBlock, newBlock } from "../fixtures.js";

/** The Adapter with its Block verbs. Blocks cases only run for a schema with `block`, where GroupsOf<S> is "blocks". */
function withBlocks<S extends AnySchema, Tx>({
  adapter,
  schema,
}: CaseContext<S, Tx>): SchemaAdapter<S, Tx, "blocks"> {
  if (schema.block === null) {
    throw new Error("a blocks case ran on a schema without block");
  }

  // SAFETY: `schema.block` isn't null, so GroupsOf<S> is "blocks".
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the conditional type can't follow the runtime check.
  return adapter as SchemaAdapter<S, Tx, "blocks">;
}

/** Blocks (ADR 016): save, read back, list by range, undo on failure. */
export const blockCases: readonly ConformanceCase[] = [
  {
    name: "a Block round-trips every field: id, Instants to the millisecond, every Developer Field set or null",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = withBlocks(ctx);

      const withValues = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
      });

      const withNulls = newBlock(schema, {
        optionalFields: "null",
        resourceId: resources[1],
      });

      await insertBlock(adapter, withValues);
      await insertBlock(adapter, withNulls);

      expect(await adapter.getBlock(withValues.id)).toStrictEqual(withValues);
      expect(await adapter.getBlock(withNulls.id)).toStrictEqual(withNulls);
      expect(
        await adapter.listBlocks({
          overlapping: { from: withValues.start, to: withValues.end },
          resourceId: resources[0],
        })
      ).toStrictEqual([withValues]);
    },
    tags: ["blocks"],
  },
  {
    name: "getBlock of an unknown id returns null",
    async run(ctx) {
      expect(await withBlocks(ctx).getBlock(blockId())).toBeNull();
    },
    tags: ["blocks"],
  },
  {
    name: "listBlocks is half-open, keeps to one Resource, and sorts by start, then id",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = withBlocks(ctx);
      const from = Temporal.Instant.from("2030-06-03T10:00:00Z");
      const to = from.add({ hours: 4 });

      /** A one-hour Block starting `hours` after `from`. */
      function at(hours: number, resourceId = resources[0]) {
        return newBlock(schema, {
          optionalFields: "null",
          resourceId,
          start: from.add({ minutes: hours * 60 }),
        });
      }

      const endsAtFrom = at(-1);
      const straddlesFrom = at(-0.5);
      const insideA = at(1);
      const insideB = at(1);
      const straddlesTo = at(3.5);
      const startsAtTo = at(4);
      const otherResource = at(1, resources[1]);

      await Promise.all(
        [
          endsAtFrom,
          straddlesFrom,
          insideA,
          insideB,
          straddlesTo,
          startsAtTo,
          otherResource,
        ].map(async (b) => {
          await insertBlock(adapter, b);
        })
      );

      const sameStart = [insideA, insideB].toSorted((a, b) =>
        a.id < b.id ? -1 : Number(a.id > b.id)
      );

      expect(
        await adapter.listBlocks({
          overlapping: { from, to },
          resourceId: resources[0],
        })
      ).toStrictEqual([straddlesFrom, ...sameStart, straddlesTo]);
    },
    tags: ["blocks"],
  },
  {
    name: "a throw after an insertBlock leaves nothing behind and keeps the reason",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = withBlocks(ctx);
      const reason = new Error("work failed");

      const block = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
      });

      await expect(
        adapter.withResourceLock(resources[0], async (locked) => {
          await locked.insertBlock(block);
          throw reason;
        })
      ).rejects.toBe(reason);

      expect(await adapter.getBlock(block.id)).toBeNull();
      expect(
        await adapter.listBlocks({
          overlapping: { from: block.start, to: block.end },
          resourceId: resources[0],
        })
      ).toStrictEqual([]);

      // The lock was released: the next unit of work runs and commits.
      await insertBlock(adapter, block);
      expect(await adapter.getBlock(block.id)).toStrictEqual(block);
    },
    tags: ["blocks"],
  },
];
