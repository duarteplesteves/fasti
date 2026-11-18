import assert from "node:assert/strict";

import { drizzleAdapter } from "@fastijs/scheduler/drizzle/pg";
import { Scheduler } from "@fastijs/scheduler/effect";
import type { TxOf } from "@fastijs/scheduler/effect";
import { Effect } from "effect";

import { db, pool, schema, weekdays } from "./schema.ts";

const adapter = drizzleAdapter(db);

class AppScheduler extends Scheduler<
  AppScheduler,
  typeof schema,
  TxOf<typeof adapter>,
  readonly []
>()("example/AppScheduler") {}

// A fresh Resource, so the script can run again.
const resourceId = crypto.randomUUID();

const slot = {
  end: Temporal.Instant.from("2030-06-03T09:30:00+01:00"),
  resourceId,
  start: Temporal.Instant.from("2030-06-03T09:00:00+01:00"),
};

const program = Effect.gen(function* bookAndCancel() {
  const scheduler = yield* AppScheduler;

  yield* scheduler.availability.set({ resourceId, rules: [weekdays] });

  const booking = yield* scheduler.book({
    ...slot,
    fields: { customerName: "Ada" },
  });

  assert.equal(booking.status, "booked");

  // Expected failures are in the error channel, tagged for catchTag.
  const conflicts = yield* scheduler
    .book({ ...slot, fields: { customerName: "Grace" } })
    .pipe(
      Effect.map(() => assert.fail("expected a SlotConflict")),
      Effect.catchTag("SlotConflict", (error) =>
        Effect.succeed(error.conflicts)
      )
    );

  assert.equal(conflicts[0]?.id, booking.id);

  const { alreadyCancelled } = yield* scheduler.cancel({ id: booking.id });
  assert.equal(alreadyCancelled, false);
});

try {
  await Effect.runPromise(
    program.pipe(
      Effect.provide(AppScheduler.layer({ policies: [], adapter, schema }))
    )
  );
} finally {
  await pool.end();
}

console.log("effect: ok");
