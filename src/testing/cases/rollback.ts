import { expect } from "vitest";

import type { LockedAdapter } from "../../adapter/contract.js";
import type { BookingChanges } from "../../adapter/records.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { CaseContext, ConformanceCase } from "../conformance-case.js";
import { insert, newBooking } from "../fixtures.js";

const rule = {
  exceptions: [],
  recurrence: { daysOfWeek: [1], frequency: "weekly", interval: 1 },
  timeWindow: {
    end: Temporal.PlainTime.from("17:00"),
    start: Temporal.PlainTime.from("09:00"),
  },
  timezone: "UTC",
} as const;

/** Run `write` in a unit of work that then throws; assert the call rejects with that same error. */
async function throwAfter<S extends AnySchema, Tx>(
  { adapter, resources }: CaseContext<S, Tx>,
  write: (locked: LockedAdapter<S, Tx>) => Promise<void>
): Promise<void> {
  const reason = new Error("work failed");

  await expect(
    adapter.withResourceLock(resources[0], async (locked) => {
      await write(locked);
      throw reason;
    })
  ).rejects.toBe(reason);
}

/** Undo on failure (ADR 008): a unit of work that rejects leaves nothing behind and releases the lock. */
export const rollbackCases: readonly ConformanceCase[] = [
  {
    name: "a throw after an insert, an update or a replaceRules leaves nothing behind, keeps the reason, and the next unit of work runs",
    async run(ctx) {
      const { adapter, resources, schema } = ctx;

      const existing = newBooking(schema, {
        optionalFields: "null",
        resourceId: resources[0],
        status: "booked",
      });

      await insert(adapter, existing);

      const fresh = newBooking(schema, {
        optionalFields: "null",
        resourceId: resources[0],
        status: "booked",
      });

      // SAFETY: "cancelled" is a base Status, valid in every schema.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript can't check a literal against Partial of a generic record.
      const changes = { status: "cancelled" } as BookingChanges<typeof schema>;

      await throwAfter(ctx, async (l) => {
        expect(await l.insertBooking(fresh)).toStrictEqual({ ok: true });
      });
      await throwAfter(ctx, async (l) => {
        // The update must apply, or there would be nothing to undo.
        expect(
          await l.updateBooking({ changes, expected: existing })
        ).toStrictEqual({ ok: true });
      });
      await throwAfter(ctx, async (l) => {
        await l.replaceRules({ resourceId: resources[0], rules: [rule] });
      });

      expect(await adapter.getBooking(fresh.id)).toBeNull();
      expect(await adapter.getBooking(existing.id)).toStrictEqual(existing);
      expect(await adapter.getRules(resources[0])).toStrictEqual([]);

      // The lock was released: the next unit of work on the same Resource runs and commits.
      await insert(adapter, fresh);
      expect(await adapter.getBooking(fresh.id)).toStrictEqual(fresh);
    },
    tags: [],
  },
];
