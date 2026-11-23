import { expect } from "vitest";

import type { AnySchema } from "../../schema/define-schema.js";
import type { ConformanceCase } from "../conformance-case.js";
import { blockId, insertBlock, newBlock } from "../fixtures.js";
import { blockFieldsOf, blockStore as withBlocks } from "../plugin-stores.js";
import type {
  BlockChanges,
  BlockRecord,
  BlockStore,
} from "../plugin-stores.js";

/** `updateBlock` in its own unit of work. */
async function update<S extends AnySchema, Tx>(
  adapter: BlockStore<S, Tx>,
  expected: BlockRecord<S>,
  changes: BlockChanges<S>
) {
  return await adapter.withResourceLock(
    expected.resourceId,
    async (locked) => await locked.updateBlock({ changes, expected })
  );
}

/** `deleteBlock` in its own unit of work, on the Block's Resource. */
async function remove<S extends AnySchema, Tx>(
  adapter: BlockStore<S, Tx>,
  block: BlockRecord<S>
) {
  return await adapter.withResourceLock(
    block.resourceId,
    async (locked) => await locked.deleteBlock(block.id)
  );
}

/** Blocks (ADR 016), through `records` on `blocks()`'s table: save, read back, list by range, change, delete, undo on failure. */
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
  {
    name: "updateBlock with a matching expected applies the changes, Developer Fields included",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = withBlocks(ctx);

      const block = newBlock(schema, {
        optionalFields: "null",
        resourceId: resources[0],
      });

      // Same Resource, every optional Developer Field set: changes the range and those fields.
      const {
        id: _id,
        resourceId: _resourceId,
        ...changes
      } = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
        start: block.start.add({ minutes: 30 }),
      });

      await insertBlock(adapter, block);

      expect(await update(adapter, block, changes)).toStrictEqual({ ok: true });
      expect(await adapter.getBlock(block.id)).toStrictEqual({
        ...block,
        ...changes,
      });
    },
    tags: ["blocks"],
  },
  {
    name: "updateBlock with a stale or missing expected gives changed, and the row is untouched",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = withBlocks(ctx);

      const block = newBlock(schema, {
        optionalFields: "null",
        resourceId: resources[0],
      });

      const ghost = newBlock(schema, {
        optionalFields: "null",
        resourceId: resources[0],
      });

      await insertBlock(adapter, block);

      const hasOptional = Object.values(blockFieldsOf(schema)).some(
        (f) => !f.required
      );

      const filled = newBlock(schema, {
        optionalFields: "set",
        resourceId: block.resourceId,
      });

      const stale: BlockRecord<typeof schema>[] = [
        { ...block, start: block.start.add({ milliseconds: 1 }) },
        { ...block, end: block.end.subtract({ milliseconds: 1 }) },
        ...(hasOptional
          ? [{ ...filled, end: block.end, id: block.id, start: block.start }]
          : []),
        ghost,
      ];

      const end = block.end.add({ hours: 1 });

      const results = await Promise.all(
        stale.map(async (expected) => await update(adapter, expected, { end }))
      );

      expect(results).toStrictEqual(
        stale.map(() => ({ ok: false, reason: "changed" }))
      );
      expect(await adapter.getBlock(block.id)).toStrictEqual(block);
      expect(await adapter.getBlock(ghost.id)).toBeNull();
    },
    tags: ["blocks"],
  },
  {
    name: "deleteBlock removes the Block, and a second delete gives missing",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = withBlocks(ctx);

      const block = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
      });

      const kept = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
      });

      await insertBlock(adapter, block);
      await insertBlock(adapter, kept);

      expect(await remove(adapter, block)).toStrictEqual({ ok: true });
      expect(await adapter.getBlock(block.id)).toBeNull();
      expect(await adapter.getBlock(kept.id)).toStrictEqual(kept);
      expect(await remove(adapter, block)).toStrictEqual({
        ok: false,
        reason: "missing",
      });
    },
    tags: ["blocks"],
  },
  {
    name: "a throw after updateBlock and deleteBlock leaves both Blocks as they were",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = withBlocks(ctx);
      const reason = new Error("work failed");

      const moved = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
      });

      const deleted = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
      });

      await insertBlock(adapter, moved);
      await insertBlock(adapter, deleted);

      await expect(
        adapter.withResourceLock(resources[0], async (locked) => {
          await locked.updateBlock({
            changes: { end: moved.end.add({ hours: 1 }) },
            expected: moved,
          });
          await locked.deleteBlock(deleted.id);
          throw reason;
        })
      ).rejects.toBe(reason);

      expect(await adapter.getBlock(moved.id)).toStrictEqual(moved);
      expect(await adapter.getBlock(deleted.id)).toStrictEqual(deleted);
    },
    tags: ["blocks"],
  },
];
