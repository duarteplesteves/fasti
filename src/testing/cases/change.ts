import { expect } from "vitest";

import type { SchemaAdapter } from "../../adapter/contract.js";
import type { BookingChanges, BookingRecord } from "../../adapter/records.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { ConformanceCase } from "../conformance-case.js";
import { insert, newBooking, ruleRow } from "../fixtures.js";
import { installs, pluginRecords } from "../plugin-stores.js";

/**
 * Changes written against `AnySchema`: TypeScript can't check a literal against `Partial` of a generic record.
 *
 * @returns `changes`, typed for `S`.
 */
function asChanges<S extends AnySchema>(
  changes: BookingChanges<AnySchema>
): BookingChanges<S> {
  // SAFETY: the cases only change base fields to values valid in every schema (base Statuses, the context's Resources).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  return changes as BookingChanges<S>;
}

async function update<S extends AnySchema, Tx>(
  adapter: SchemaAdapter<S, Tx>,
  expected: BookingRecord<S>,
  changes: BookingChanges<AnySchema>
) {
  return await adapter.withResourceLock(
    expected.resourceId,
    async (locked) =>
      await locked.updateBooking({ changes: asChanges<S>(changes), expected })
  );
}

/** Change (`updateBooking`, compare-and-set) and read-your-writes. */
export const changeCases: readonly ConformanceCase[] = [
  {
    name: "updateBooking with a matching expected applies the changes",
    async run({ adapter, resources, schema }) {
      const b = newBooking(schema, {
        optionalFields: "set",
        resourceId: resources[0],
        status: "booked",
      });

      await insert(adapter, b);

      const changes = { end: b.end.add({ minutes: 15 }), status: "cancelled" };

      expect(await update(adapter, b, changes)).toStrictEqual({ ok: true });
      expect(await adapter.getBooking(b.id)).toStrictEqual({
        ...b,
        ...changes,
      });
    },
    tags: [],
  },
  {
    name: "updateBooking with a stale expected (any logical or Developer Field) gives changed, and the row is untouched",
    async run({ adapter, resources, schema }) {
      const b = newBooking(schema, {
        optionalFields: "null",
        resourceId: resources[0],
        status: "booked",
      });

      await insert(adapter, b);

      // `b` has every optional Developer Field null; `filled` has them set, so it differs on those.
      const hasOptional = Object.values(schema.booking.fields).some(
        (f) => !f.required
      );

      const filled = newBooking(schema, {
        optionalFields: "set",
        resourceId: b.resourceId,
        status: b.status,
      });

      const stale: BookingRecord<typeof schema>[] = [
        { ...b, start: b.start.add({ milliseconds: 1 }) },
        { ...b, end: b.end.subtract({ milliseconds: 1 }) },
        { ...b, status: "cancelled" },
        { ...b, resourceId: resources[1] },
        ...(hasOptional
          ? [{ ...filled, end: b.end, id: b.id, start: b.start }]
          : []),
      ];

      const results = await Promise.all(
        stale.map(
          async (expected) =>
            await update(adapter, expected, { status: "cancelled" })
        )
      );

      expect(results).toStrictEqual(
        stale.map(() => ({ ok: false, reason: "changed" }))
      );

      expect(await adapter.getBooking(b.id)).toStrictEqual(b);
    },
    tags: [],
  },
  {
    name: "updateBooking of a missing row gives changed",
    async run({ adapter, resources, schema }) {
      const ghost = newBooking(schema, {
        optionalFields: "null",
        resourceId: resources[0],
        status: "booked",
      });

      expect(
        await update(adapter, ghost, { status: "cancelled" })
      ).toStrictEqual({ ok: false, reason: "changed" });
      expect(await adapter.getBooking(ghost.id)).toBeNull();
    },
    tags: [],
  },
  {
    name: "updateBooking can move a Booking to another Resource",
    async run({ adapter, resources, schema }) {
      const b = newBooking(schema, {
        optionalFields: "null",
        resourceId: resources[0],
        status: "booked",
      });

      await insert(adapter, b);

      expect(
        await update(adapter, b, { resourceId: resources[1] })
      ).toStrictEqual({ ok: true });

      const overlapping = { from: b.start, to: b.end };

      expect(
        await adapter.listBookings({ overlapping, resourceId: resources[0] })
      ).toStrictEqual([]);
      expect(
        await adapter.listBookings({ overlapping, resourceId: resources[1] })
      ).toStrictEqual([{ ...b, resourceId: resources[1] }]);
    },
    tags: [],
  },
  {
    name: "updateBooking can change a Booking into a blocking Status",
    async run({ adapter, resources, schema }) {
      const b = newBooking(schema, {
        optionalFields: "null",
        resourceId: resources[0],
        status: "cancelled",
      });

      await insert(adapter, b);

      expect(await update(adapter, b, { status: "booked" })).toStrictEqual({
        ok: true,
      });
      expect(await adapter.getBooking(b.id)).toStrictEqual({
        ...b,
        status: "booked",
      });
    },
    tags: [],
  },
  {
    name: "reads inside a unit of work see that unit's own writes",
    async run(ctx) {
      const { adapter, resources, schema } = ctx;

      const b = newBooking(schema, {
        optionalFields: "null",
        resourceId: resources[0],
        status: "booked",
      });

      const overlapping = { from: b.start, to: b.end };

      const rule = {
        exceptions: [],
        recurrence: { daysOfWeek: [1], frequency: "weekly", interval: 1 },
        timeWindow: {
          end: Temporal.PlainTime.from("17:00"),
          start: Temporal.PlainTime.from("09:00"),
        },
        timezone: "UTC",
      } as const;

      async function bookingWrites(
        locked: Parameters<Parameters<typeof adapter.withResourceLock>[1]>[0]
      ): Promise<void> {
        await locked.insertBooking(b);
        expect(await locked.getBooking(b.id)).toStrictEqual(b);
        expect(
          await locked.listBookings({ overlapping, resourceId: resources[0] })
        ).toStrictEqual([b]);

        await locked.updateBooking({
          changes: asChanges({ status: "cancelled" }),
          expected: b,
        });
        expect(await locked.getBooking(b.id)).toStrictEqual({
          ...b,
          status: "cancelled",
        });
      }

      // With availability(), its records too.
      if (!installs(schema, "availability")) {
        await adapter.withResourceLock(resources[0], bookingWrites);

        return;
      }

      const records = [ruleRow(resources[0], rule)];

      await pluginRecords(ctx, "availability").withResourceLock(
        resources[0],
        async (locked) => {
          await bookingWrites(locked);
          await locked.replaceRecords("availabilityRule", {
            records,
            resourceId: resources[0],
          });
          expect(
            await locked.listRecords("availabilityRule", {
              resourceId: resources[0],
            })
          ).toStrictEqual(records);
        }
      );
    },
    tags: [],
  },
];
