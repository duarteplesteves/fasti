import { setTimeout as sleep } from "node:timers/promises";

import { expect } from "vitest";

import type { LockedAdapter, StoredRecord } from "../../adapter/contract.js";
import { toCoreBooking } from "../../adapter/records.js";
import type {
  BookingChanges,
  BookingRecord,
  ResourceIdOf,
} from "../../adapter/records.js";
import { detectConflicts } from "../../core/detect-conflicts.js";
import type { BlockId, BookingId } from "../../core/types.js";
import type { AnySchema } from "../../schema/define-schema.js";
import { statusCodec } from "../../schema/status-codec.js";
import type { CaseContext, ConformanceCase } from "../conformance-case.js";
import { insert, newBlock, newBooking } from "../fixtures.js";
import type { BlockRow } from "../fixtures.js";
import { installs, lockedRecords } from "../plugin-stores.js";

/** Parallel units of work per race (spec: N = 20). */
const n = 20;

/** Races per case, each on a fresh slot. */
const repetitions = 3;

/** `block` rows as the Blocks they hold. */
function asBlocks<S extends AnySchema>(rows: StoredRecord[]): BlockRow<S>[] {
  // SAFETY: a `block` row holds a Block's columns, Developer Fields included.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the row type can't know its table.
  return rows as BlockRow<S>[];
}

/** A candidate time range. */
interface Slot {
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

/** Repetition `rep`'s one-hour slot; slots of different repetitions never overlap. */
function slotFor(rep: number): Slot {
  const start = Temporal.Instant.from("2030-06-03T09:00:00Z").add({
    hours: 2 * rep,
  });

  return { end: start.add({ hours: 1 }), start };
}

/** A new blocking Booking at `slot`. */
function bookingAt<S extends AnySchema>(
  schema: S,
  resourceId: ResourceIdOf<S>,
  slot: Slot
): BookingRecord<S> {
  return {
    ...newBooking(schema, {
      optionalFields: "null",
      resourceId,
      status: "booked",
    }),
    ...slot,
  };
}

/**
 * Read–check–write, as the Framework will: list the slot's occupants, check them with the Core,
 * sleep to widen the race window, then write. `"won"` only when the write succeeds.
 */
async function claim<S extends AnySchema, Tx>(
  { schema }: CaseContext<S, Tx>,
  locked: LockedAdapter<S, Tx>,
  {
    resourceId,
    slot,
  }: { readonly resourceId: ResourceIdOf<S>; readonly slot: Slot },
  write: () => Promise<{ readonly ok: boolean }>
): Promise<"won" | "lost"> {
  const codec = statusCodec(schema);
  const query = { overlapping: { from: slot.start, to: slot.end }, resourceId };
  const existing = await locked.listBookings(query);

  // Blocks occupy time too, when the schema has them.
  const blocks = installs(schema, "blocks")
    ? asBlocks<S>(await lockedRecords(locked).listRecords("block", query))
    : [];

  const conflicts = detectConflicts<BookingId | BlockId>({
    bookings: [
      ...existing.map((b) => toCoreBooking(codec, b)),
      ...blocks.map(({ end, id, start }) => ({
        end,
        id,
        isBlocking: true,
        resourceId: String(resourceId),
        start,
      })),
    ],
    candidate: slot,
    resourceId: String(resourceId),
  });

  if (!conflicts.ok) {
    throw new Error(`detectConflicts: ${JSON.stringify(conflicts.error)}`);
  }

  if (conflicts.value.length > 0) {
    return "lost";
  }

  await sleep(5);

  const { ok } = await write();

  return ok ? "won" : "lost";
}

/** What occupies a Resource at a slot, from committed state: blocking Bookings, and Blocks when the schema has them. */
async function occupiedAt<S extends AnySchema, Tx>(
  { adapter, schema }: CaseContext<S, Tx>,
  resourceId: ResourceIdOf<S>,
  slot: Slot
): Promise<(BookingRecord<S> | BlockRow<S>)[]> {
  const codec = statusCodec(schema);
  const query = { overlapping: { from: slot.start, to: slot.end }, resourceId };
  const bookings = await adapter.listBookings(query);

  const blocks = installs(schema, "blocks")
    ? await adapter.withResourceLock(resourceId, async (locked) =>
        asBlocks<S>(await lockedRecords(locked).listRecords("block", query))
      )
    : [];

  return [...bookings.filter((b) => codec.isBlocking(b.status)), ...blocks];
}

/** The Resource Lock (ADR 008): locked units of work on one Resource never interleave. Each case fails against an Adapter that skips it. */
export const lockCases: readonly ConformanceCase[] = [
  {
    name: "locked units of work on one Resource never run at the same time",
    async run({ adapter, resources }) {
      const log: ("enter" | "exit")[] = [];

      await Promise.all(
        Array.from({ length: n }, async () => {
          await adapter.withResourceLock(resources[0], async () => {
            log.push("enter");
            await sleep(2);
            log.push("exit");
          });
        })
      );

      expect(log).toStrictEqual(
        Array.from({ length: n }, () => ["enter", "exit"]).flat()
      );
    },
    tags: ["concurrency"],
  },
  {
    name: "parallel read–check–insert bookings of one slot: exactly one wins",
    async run(ctx) {
      const { adapter, resources, schema } = ctx;
      const [r0] = resources;

      for (let rep = 0; rep < repetitions; rep += 1) {
        const slot = slotFor(rep);

        // oxlint-disable-next-line no-await-in-loop -- each repetition is its own race.
        const results = await Promise.all(
          Array.from(
            { length: n },
            async () =>
              await adapter.withResourceLock(r0, async (locked) => {
                const booking = bookingAt(schema, r0, slot);

                return await claim(
                  ctx,
                  locked,
                  { resourceId: r0, slot },
                  async () => await locked.insertBooking(booking)
                );
              })
          )
        );

        // Count successes, not only rows: a copy-and-swap store without the lock keeps just the last writer.
        expect(results.filter((r) => r === "won")).toHaveLength(1);
        // oxlint-disable-next-line no-await-in-loop -- read back this repetition's slot.
        expect(await occupiedAt(ctx, r0, slot)).toHaveLength(1);
      }
    },
    tags: ["concurrency"],
  },
  {
    name: "a cross-Resource reschedule racing bookings at the destination: exactly one wins, never two at that time",
    async run(ctx) {
      const { adapter, resources, schema } = ctx;
      const [from, to] = resources;

      for (let rep = 0; rep < repetitions; rep += 1) {
        const moving = newBooking(schema, {
          optionalFields: "null",
          resourceId: from,
          status: "booked",
        });

        // oxlint-disable-next-line no-await-in-loop -- each repetition is its own race.
        await insert(adapter, moving);

        const slot = slotFor(rep);

        // SAFETY: the change moves base fields to values valid in every schema.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript can't check a literal against Partial of a generic record.
        const changes = { ...slot, resourceId: to } as BookingChanges<
          typeof schema
        >;

        // Only the destination is locked. The reschedule sits at a different place in each race.
        // oxlint-disable-next-line no-await-in-loop -- each repetition is its own race.
        const results = await Promise.all(
          Array.from(
            { length: n },
            async (_, i) =>
              await adapter.withResourceLock(to, async (locked) => {
                const booking = bookingAt(schema, to, slot);

                return await claim(
                  ctx,
                  locked,
                  { resourceId: to, slot },
                  i === rep
                    ? async () =>
                        await locked.updateBooking({
                          changes,
                          expected: moving,
                        })
                    : async () => await locked.insertBooking(booking)
                );
              })
          )
        );

        expect(results.filter((r) => r === "won")).toHaveLength(1);
        // oxlint-disable-next-line no-await-in-loop -- read back this repetition's slot.
        expect(await occupiedAt(ctx, to, slot)).toHaveLength(1);
      }
    },
    tags: ["concurrency"],
  },
  {
    name: "a Block write racing bookings of one slot: exactly one wins",
    async run(ctx) {
      const { adapter, resources, schema } = ctx;
      const [r0] = resources;

      for (let rep = 0; rep < repetitions; rep += 1) {
        const slot = slotFor(rep);

        const block = {
          ...newBlock(schema, { optionalFields: "null", resourceId: r0 }),
          ...slot,
        };

        // The Block write sits at a different place in each race.
        // oxlint-disable-next-line no-await-in-loop -- each repetition is its own race.
        const results = await Promise.all(
          Array.from(
            { length: n },
            async (_, i) =>
              await adapter.withResourceLock(r0, async (locked) => {
                const booking = bookingAt(schema, r0, slot);

                return await claim(
                  ctx,
                  locked,
                  { resourceId: r0, slot },
                  i === rep
                    ? async () => {
                        await lockedRecords(locked).insertRecord(
                          "block",
                          block
                        );

                        return { ok: true };
                      }
                    : async () => await locked.insertBooking(booking)
                );
              })
          )
        );

        expect(results.filter((r) => r === "won")).toHaveLength(1);

        // oxlint-disable-next-line no-await-in-loop -- read back this repetition's slot.
        expect(await occupiedAt(ctx, r0, slot)).toHaveLength(1);
      }
    },
    tags: ["blocks", "concurrency"],
  },
];
