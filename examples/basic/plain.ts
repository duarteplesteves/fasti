import assert from "node:assert/strict";

import { createScheduler } from "@fastijs/scheduler";
import type { Result } from "@fastijs/scheduler";
import { drizzleAdapter } from "@fastijs/scheduler/drizzle/pg";
import { and, eq, gt, sql } from "drizzle-orm";

import { db, pack, pool, schema, weekdays } from "./schema.ts";

/** The value of an Action that must succeed; anything else fails the script. */
function valueOf<A, E>(result: Result<A, E>): A {
  if (!result.ok) {
    throw new Error("unexpected failure", { cause: result.error });
  }

  return result.value;
}

const scheduler = createScheduler({ adapter: drizzleAdapter(db), schema });

// A fresh Resource, so the script can run again.
const resourceId = crypto.randomUUID();

valueOf(await scheduler.availability.set({ resourceId, rules: [weekdays] }));

// Monday 3 June 2030, 30-minute slots on a 30-minute grid.
const day = {
  from: Temporal.Instant.from("2030-06-03T00:00:00+01:00"),
  to: Temporal.Instant.from("2030-06-04T00:00:00+01:00"),
};

const slots = valueOf(
  await scheduler.findSlots({
    ...day,
    duration: 30,
    interval: 30,
    resourceId,
    timezone: "Europe/Lisbon",
  })
);

const [first] = slots;

assert.ok(first);

assert.equal(first.start.toPlainTime().toString(), "09:00:00");

const slot = {
  end: first.end.toInstant(),
  resourceId,
  start: first.start.toInstant(),
};

const booking = valueOf(
  await scheduler.book({ ...slot, fields: { customerName: "Ada" } })
);

assert.equal(booking.status, "booked");

const again = await scheduler.book({
  ...slot,
  fields: { customerName: "Grace" },
});

assert.ok(!again.ok);

assert.equal(again.error._tag, "SlotConflict");

assert.deepEqual(
  again.error.conflicts.map((conflict) => conflict.id),
  [booking.id]
);

const evening = await scheduler.book({
  end: Temporal.Instant.from("2030-06-03T21:00:00+01:00"),
  fields: { customerName: "Grace" },
  resourceId,
  start: Temporal.Instant.from("2030-06-03T20:00:00+01:00"),
});

assert.ok(!evening.ok);

assert.equal(evening.error._tag, "PolicyViolation");

const cancelled = valueOf(await scheduler.cancel({ id: booking.id }));

assert.equal(cancelled.alreadyCancelled, false);

// The slot is free again.
const grace = valueOf(
  await scheduler.book({ ...slot, fields: { customerName: "Grace" } })
);

// A Block makes the Resource unbookable over lunch, 12:00–14:00.
const lunch = valueOf(
  await scheduler.blocks.create({
    end: Temporal.Instant.from("2030-06-03T14:00:00+01:00"),
    fields: { reason: "lunch" },
    resourceId,
    start: Temporal.Instant.from("2030-06-03T12:00:00+01:00"),
  })
);

const overLunch = await scheduler.book({
  end: Temporal.Instant.from("2030-06-03T13:00:00+01:00"),
  fields: { customerName: "Grace" },
  resourceId,
  start: Temporal.Instant.from("2030-06-03T12:30:00+01:00"),
});

assert.ok(!overLunch.ok);

assert.equal(overLunch.error._tag, "SlotConflict");

assert.deepEqual(
  overLunch.error.conflicts.map(({ id, kind }) => ({ id, kind })),
  [{ id: lunch.id, kind: "block" }]
);

// findSlots hides every slot that overlaps the Block.
const afterLunch = valueOf(
  await scheduler.findSlots({
    ...day,
    duration: 30,
    interval: 30,
    resourceId,
    timezone: "Europe/Lisbon",
  })
);

const starts = afterLunch.map((s) => s.start.toPlainTime().toString());

assert.ok(starts.includes("11:30:00"));
assert.ok(!starts.includes("12:00:00"));
assert.ok(!starts.includes("13:30:00"));
assert.ok(starts.includes("14:00:00"));

/** 3 June 2030 at `time`, Lisbon. */
function at(time: string): Temporal.Instant {
  return Temporal.Instant.from(`2030-06-03T${time}:00+01:00`);
}

// Grace moves to 10:00: same id, same Status, and 09:00 is free again.
const moved = valueOf(
  await scheduler.reschedule({
    end: at("10:30"),
    id: grace.id,
    start: at("10:00"),
  })
);

assert.equal(moved.id, grace.id);
assert.equal(moved.status, "booked");
assert.ok(moved.start.equals(at("10:00")));

// `also`: each Booking spends a credit from a pack, in the same transaction.
const packId = crypto.randomUUID();

await db.insert(pack).values({ id: packId, remaining: 1 });

/** Book `[start, end)` paid from the pack; vetoed when no credit is left. */
function bookFromPack(start: Temporal.Instant, end: Temporal.Instant) {
  return scheduler.book({
    also: async ({ tx }) => {
      // A guarded update: race-free, and it changes no row when the pack is empty.
      const spent = await tx
        .update(pack)
        .set({ remaining: sql`${pack.remaining} - 1` })
        .where(and(eq(pack.id, packId), gt(pack.remaining, 0)))
        .returning({ remaining: pack.remaining });

      const [row] = spent;

      return row === undefined
        ? { error: "no credits left" as const, ok: false as const }
        : { ok: true as const, value: row.remaining };
    },
    end,
    fields: { customerName: "Ada" },
    resourceId,
    start,
  });
}

const paid = valueOf(await bookFromPack(slot.start, slot.end));

assert.equal(paid.also, 0); // credits left

const unpaid = await bookFromPack(at("11:00"), at("11:30"));

assert.ok(!unpaid.ok);
assert.deepEqual(unpaid.error, { _tag: "Vetoed", reason: "no credits left" });

// The veto rolled the Booking back: 11:00 is still free.
valueOf(
  await scheduler.book({
    end: at("11:30"),
    fields: { customerName: "Grace" },
    resourceId,
    start: at("11:00"),
  })
);

await pool.end();

console.log("plain: ok");
