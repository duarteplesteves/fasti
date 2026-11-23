import { expect } from "vitest";

import type {
  SchemaAdapter,
  UpdateRecordParams,
} from "../../adapter/contract.js";
import { mintBlockId } from "../../framework/plugins/blocks.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { ConformanceCase } from "../conformance-case.js";
import { storeBlock, newBlock } from "../fixtures.js";
import type { BlockRow } from "../fixtures.js";
import { blockFieldsOf, pluginRecords } from "../plugin-stores.js";

/**
 * Update a Block in its own unit of work.
 *
 * @returns A promise of the update's result: `changed` when the stored Block no longer equals `expected`.
 */
async function update<S extends AnySchema, Tx>(
  adapter: SchemaAdapter<S, Tx, "records">,
  expected: BlockRow<S>,
  changes: UpdateRecordParams["changes"]
) {
  return await adapter.withResourceLock(
    expected.resourceId,
    async (locked) => await locked.updateRecord("block", { changes, expected })
  );
}

/**
 * Delete a Block in its own unit of work, on its Resource.
 *
 * @returns A promise of the delete's result: `missing` when there was no such Block.
 */
async function remove<S extends AnySchema, Tx>(
  adapter: SchemaAdapter<S, Tx, "records">,
  block: BlockRow<S>
) {
  return await adapter.withResourceLock(
    block.resourceId,
    async (locked) => await locked.deleteRecord("block", block.id)
  );
}

/** Blocks (ADR 016), through `records` on `blocks()`'s table: save, read back, list by range, change, delete, undo on failure. */
export const blockCases: readonly ConformanceCase[] = [
  {
    name: "a Block round-trips every field: id, Instants to the millisecond, every Developer Field set or null",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = pluginRecords(ctx, "blocks");

      const withValues = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
      });

      const withNulls = newBlock(schema, {
        optionalFields: "null",
        resourceId: resources[1],
      });

      await storeBlock(adapter, withValues);
      await storeBlock(adapter, withNulls);

      expect(await adapter.getRecord("block", withValues.id)).toStrictEqual(
        withValues
      );
      expect(await adapter.getRecord("block", withNulls.id)).toStrictEqual(
        withNulls
      );
      expect(
        await adapter.listRecords("block", {
          overlapping: { from: withValues.start, to: withValues.end },
          resourceId: resources[0],
        })
      ).toStrictEqual([withValues]);
    },
    tags: ["blocks"],
  },
  {
    name: "reading an unknown Block id returns null",
    async run(ctx) {
      expect(
        await pluginRecords(ctx, "blocks").getRecord("block", mintBlockId())
      ).toBeNull();
    },
    tags: ["blocks"],
  },
  {
    name: "listing Blocks is half-open, keeps to one Resource, and sorts by start, then id",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = pluginRecords(ctx, "blocks");
      const from = Temporal.Instant.from("2030-06-03T10:00:00Z");
      const to = from.add({ hours: 4 });

      /**
       * A one-hour Block starting `hours` after `from`.
       *
       * @returns The Block row, not yet stored.
       */
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
          await storeBlock(adapter, b);
        })
      );

      const sameStart = [insideA, insideB].toSorted((a, b) =>
        a.id < b.id ? -1 : Number(a.id > b.id)
      );

      expect(
        await adapter.listRecords("block", {
          overlapping: { from, to },
          resourceId: resources[0],
        })
      ).toStrictEqual([straddlesFrom, ...sameStart, straddlesTo]);
    },
    tags: ["blocks"],
  },
  {
    name: "a throw after inserting a Block leaves nothing behind and keeps the reason",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = pluginRecords(ctx, "blocks");
      const reason = new Error("work failed");

      const block = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
      });

      await expect(
        adapter.withResourceLock(resources[0], async (locked) => {
          await locked.insertRecord("block", block);
          throw reason;
        })
      ).rejects.toBe(reason);

      expect(await adapter.getRecord("block", block.id)).toBeNull();
      expect(
        await adapter.listRecords("block", {
          overlapping: { from: block.start, to: block.end },
          resourceId: resources[0],
        })
      ).toStrictEqual([]);

      // The lock was released: the next unit of work runs and commits.
      await storeBlock(adapter, block);
      expect(await adapter.getRecord("block", block.id)).toStrictEqual(block);
    },
    tags: ["blocks"],
  },
  {
    name: "updating a Block with a matching expected applies the changes, Developer Fields included",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = pluginRecords(ctx, "blocks");

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

      await storeBlock(adapter, block);

      expect(await update(adapter, block, changes)).toStrictEqual({ ok: true });
      expect(await adapter.getRecord("block", block.id)).toStrictEqual({
        ...block,
        ...changes,
      });
    },
    tags: ["blocks"],
  },
  {
    name: "updating a Block with a stale or missing expected gives changed, and the row is untouched",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = pluginRecords(ctx, "blocks");

      const block = newBlock(schema, {
        optionalFields: "null",
        resourceId: resources[0],
      });

      const ghost = newBlock(schema, {
        optionalFields: "null",
        resourceId: resources[0],
      });

      await storeBlock(adapter, block);

      const hasOptional = Object.values(blockFieldsOf(schema)).some(
        (f) => !f.required
      );

      const filled = newBlock(schema, {
        optionalFields: "set",
        resourceId: block.resourceId,
      });

      const stale: BlockRow<typeof schema>[] = [
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
      expect(await adapter.getRecord("block", block.id)).toStrictEqual(block);
      expect(await adapter.getRecord("block", ghost.id)).toBeNull();
    },
    tags: ["blocks"],
  },
  {
    name: "deleting a Block removes it, and a second delete gives missing",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = pluginRecords(ctx, "blocks");

      const block = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
      });

      const kept = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
      });

      await storeBlock(adapter, block);
      await storeBlock(adapter, kept);

      expect(await remove(adapter, block)).toStrictEqual({ ok: true });
      expect(await adapter.getRecord("block", block.id)).toBeNull();
      expect(await adapter.getRecord("block", kept.id)).toStrictEqual(kept);
      expect(await remove(adapter, block)).toStrictEqual({
        ok: false,
        reason: "missing",
      });
    },
    tags: ["blocks"],
  },
  {
    name: "a throw after updating one Block and deleting another leaves both as they were",
    async run(ctx) {
      const { resources, schema } = ctx;
      const adapter = pluginRecords(ctx, "blocks");
      const reason = new Error("work failed");

      const moved = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
      });

      const deleted = newBlock(schema, {
        optionalFields: "set",
        resourceId: resources[0],
      });

      await storeBlock(adapter, moved);
      await storeBlock(adapter, deleted);

      await expect(
        adapter.withResourceLock(resources[0], async (locked) => {
          await locked.updateRecord("block", {
            changes: { end: moved.end.add({ hours: 1 }) },
            expected: moved,
          });
          await locked.deleteRecord("block", deleted.id);
          throw reason;
        })
      ).rejects.toBe(reason);

      expect(await adapter.getRecord("block", moved.id)).toStrictEqual(moved);
      expect(await adapter.getRecord("block", deleted.id)).toStrictEqual(
        deleted
      );
    },
    tags: ["blocks"],
  },
];
