// The type-check baseline: a typical app on availability() and blocks() only, the built-ins of 0.6. `plugins.fixture.ts` is this app plus three Plugins.
import { Effect } from "effect";

import { Scheduler as EffectScheduler } from "../../src/effect/index.js";
import {
  availability,
  blocks,
  column,
  createScheduler,
  defineHook,
  definePolicy,
  defineSchema,
  notice,
} from "../../src/index.js";
import { memoryAdapter } from "../../src/memory/index.js";

type StaffId = string & { readonly __brand: "StaffId" };

const adapter = memoryAdapter();

const schema = defineSchema({
  plugins: [
    availability(),
    blocks({ fields: { title: { required: true, type: column.text() } } }),
  ],
  booking: {
    fields: { customer: { required: true, type: column.text() } },
    statuses: { inProgress: { blocking: true } },
    transitions: { booked: ["inProgress"] },
  },
  resource: { idType: column.uuid<StaffId>() },
});

const maxPerDay = definePolicy(schema, {
  appliesTo: ["book"],
  check: (candidate) =>
    candidate.start.equals(candidate.end) ? { reason: "empty" } : null,
  name: "maxPerDay",
});

const policies = [
  notice(schema, { appliesTo: ["book", "reschedule"], minimum: 60 }),
  maxPerDay,
] as const;

const audit = defineHook(schema, adapter, {
  appliesTo: "*",
  run: (event) => {
    console.log(event.action);
  },
  when: "afterCommit",
});

const scheduler = createScheduler({
  adapter,
  hooks: [audit],
  policies,
  schema,
});

declare const staff: StaffId;
declare const start: Temporal.Instant;
declare const end: Temporal.Instant;

/** Every built-in Action, plain form. */
export async function useBuiltins() {
  const booked = await scheduler.book({
    also: ({ booking }) => ({ ok: true, value: booking.id }),
    fields: { customer: "Ann" },
    end,
    relax: ["maxPerDay"],
    resourceId: staff,
    start,
  });

  if (booked.ok) {
    await scheduler.transition({
      from: "booked",
      id: booked.value.id,
      to: "inProgress",
    });
    await scheduler.reschedule({ end, id: booked.value.id, start });
    await scheduler.cancel({ id: booked.value.id });
  }

  await scheduler.availability.get({ resourceId: staff });
  await scheduler.blocks.create({
    end,
    fields: { title: "off" },
    resourceId: staff,
    start,
  });
  await scheduler.findSlots({
    duration: 60,
    interval: 30,
    from: start,
    resourceId: staff,
    timezone: "Europe/Lisbon",
    to: end,
  });
}

class AppScheduler extends EffectScheduler<
  AppScheduler,
  typeof schema,
  undefined,
  typeof policies
>()("bench/AppScheduler") {}

export const effectApp = Effect.gen(function* app() {
  const service = yield* AppScheduler;

  return yield* service.book({
    fields: { customer: "Ann" },
    end,
    resourceId: staff,
    start,
  });
}).pipe(Effect.provide(AppScheduler.layer({ adapter, policies, schema })));
