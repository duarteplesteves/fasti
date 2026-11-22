// The type-check budget's fixture: `baseline.fixture.ts` plus four Plugins (`waitlist` written with the Promise face,
// `holidays` with busy time and a Policy) installed and called in both forms.
import { Effect } from "effect";

import {
  Scheduler as EffectScheduler,
  definePlugin,
} from "../../src/effect/index.js";
import type { PluginResourceId } from "../../src/effect/index.js";
import {
  column,
  createScheduler,
  defineHook,
  definePlugin as definePromisePlugin,
  definePolicy,
  defineSchema,
  fail,
  notice,
  ok,
} from "../../src/index.js";
import { memoryAdapter } from "../../src/memory/index.js";
import { holidays } from "../../src/test-utils/holidays-plugin.js";
import { notes } from "../../src/test-utils/notes-plugin.js";

/** A Plugin with two tables and an Action on each. */
const tags = definePlugin({
  actions: {
    tag: {
      timed: false,
      kind: "write",
      run: (
        params: {
          readonly resourceId: PluginResourceId;
          readonly label: string;
        },
        { lock }
      ) =>
        lock(params.resourceId, ({ records }) =>
          Effect.map(
            records.tag.insert({ ...params, weight: null }),
            (tag) => ({
              _tag: "Done" as const,
              context: { tag },
              value: tag,
            })
          )
        ),
    },
    colours: {
      kind: "read",
      run: (params: { readonly resourceId: PluginResourceId }, { records }) =>
        records.colour.list(params),
    },
  },
  name: "tags",
  tables: {
    colour: {
      columns: { hex: { required: true, type: column.text() } },
      timed: false,
    },
    tag: {
      timed: false,
      columns: {
        label: { required: true, type: column.text() },
        weight: { required: false, type: column.integer() },
      },
    },
  },
});

/** A Promise-style Plugin whose write can end in NoOp, and whose read fails with its own error. */
const waitlist = definePromisePlugin({
  actions: {
    join: {
      kind: "write",
      run: async (
        params: {
          readonly resourceId: PluginResourceId;
          readonly customer: string;
          readonly at: Temporal.Instant;
        },
        { lock }
      ) =>
        await lock(params.resourceId, async ({ records }) => {
          const all = await records.entry.list(params);
          const found = all.find((e) => e.customer === params.customer);

          if (found !== undefined) {
            return { _tag: "NoOp", value: found } as const;
          }

          const entry = await records.entry.insert({
            at: params.at,
            customer: params.customer,
            resourceId: params.resourceId,
          });

          return { _tag: "Done", context: { entry }, value: entry } as const;
        }),
    },
    next: {
      kind: "read",
      run: async (
        params: { readonly resourceId: PluginResourceId },
        { records }
      ) => {
        const [first] = await records.entry.list(params);

        return first === undefined
          ? fail({ _tag: "WaitlistEmpty" } as const)
          : ok(first);
      },
    },
  },
  name: "waitlist",
  tables: {
    entry: {
      timed: false,
      columns: {
        at: { required: true, type: column.instant() },
        customer: { required: true, type: column.text() },
      },
    },
  },
});

type StaffId = string & { readonly __brand: "StaffId" };

const adapter = memoryAdapter();

const schema = defineSchema({
  block: { fields: { title: { required: true, type: column.text() } } },
  booking: {
    fields: { customer: { required: true, type: column.text() } },
    statuses: { inProgress: { blocking: true } },
    transitions: { booked: ["inProgress"] },
  },
  plugins: [notes({ max: 3 }), tags, waitlist, holidays({ eveHours: 1 })],
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
    relax: ["maxPerDay", "holidayEve"],
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

/** Every Plugin Action, plain form. */
export async function usePlugins() {
  const note = await scheduler.notes.add({
    also: ({ note: added, now }) => ({ ok: true, value: [added.id, now] }),
    resourceId: staff,
    text: "hi",
  });

  const tag = await scheduler.tags.tag({ label: "vip", resourceId: staff });

  const joined = await scheduler.waitlist.join({
    also: ({ entry }) => ({ ok: true, value: entry.customer }),
    at: start,
    customer: "Ann",
    resourceId: staff,
  });

  return [
    note,
    tag,
    joined,
    await scheduler.notes.list({ resourceId: staff }),
    await scheduler.tags.colours({ resourceId: staff }),
    await scheduler.waitlist.next({ resourceId: staff }),
  ] as const;
}

class AppScheduler extends EffectScheduler<
  AppScheduler,
  typeof schema,
  undefined,
  typeof policies
>()("bench/AppScheduler") {}

export const effectApp = Effect.gen(function* app() {
  const service = yield* AppScheduler;

  const booking = yield* service.book({
    fields: { customer: "Ann" },
    end,
    resourceId: staff,
    start,
  });

  const note = yield* service.notes.add({
    also: ({ note: added }) => Effect.succeed(added.resourceId),
    resourceId: booking.resourceId,
    text: "hi",
  });

  return [
    note,
    yield* service.tags.tag({ label: "vip", resourceId: staff }),
    yield* service.waitlist.join({
      at: start,
      customer: "Ann",
      resourceId: staff,
    }),
    yield* service.waitlist.next({ resourceId: staff }),
  ] as const;
}).pipe(Effect.provide(AppScheduler.layer({ adapter, policies, schema })));
