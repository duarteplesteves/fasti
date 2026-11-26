# fasti

A type-safe scheduling framework for TypeScript that runs on your own database.

Give it opening hours and it finds free slots, takes bookings, moves and cancels them, and never books the same slot twice, even under concurrent requests. Your database, your tables, your backend: fasti is a library, not a service.

```typescript
// try.mts: needs no database. Run it with `node try.mts`.
import { availability, column, createScheduler, defineSchema } from "@fastijs/scheduler";
import { memoryAdapter } from "@fastijs/scheduler/memory";

const schema = defineSchema({
  booking: { fields: { customerName: { type: column.text(), required: true } } },
  plugins: [availability()], // opening hours
});

const scheduler = createScheduler({ adapter: memoryAdapter(), schema });

// Monday 3 June 2030, Lisbon time.
const at = (time: string) => Temporal.Instant.from(`2030-06-03T${time}+01:00`);

await scheduler.availability.set({
  resourceId: "room-1",
  rules: [
    {
      recurrence: { frequency: "weekly", interval: 1, daysOfWeek: [1, 2, 3, 4, 5] }, // Mon–Fri
      timeWindow: { start: Temporal.PlainTime.from("09:00"), end: Temporal.PlainTime.from("17:00") },
      timezone: "Europe/Lisbon",
    },
  ],
});

const slots = await scheduler.findSlots({
  resourceId: "room-1",
  from: at("00:00"),
  to: at("23:59"),
  duration: 30, // minutes
  interval: 30, // a slot can start every 30 minutes, from local midnight
  timezone: "Europe/Lisbon",
});
// { ok: true, value: [09:00–09:30, 09:30–10:00, … 16:30–17:00] }

const ada = await scheduler.book({
  resourceId: "room-1",
  start: at("09:00"),
  end: at("09:30"),
  fields: { customerName: "Ada" },
});
// { ok: true, value: { id, status: "booked", customerName: "Ada", … } }

const grace = await scheduler.book({
  resourceId: "room-1",
  start: at("09:15"),
  end: at("09:45"),
  fields: { customerName: "Grace" },
});
// { ok: false, error: { _tag: "SlotConflict", conflicts: [{ kind: "booking", id, start, end }] } }
```

**What you get**

- **No double bookings.** Every write runs in one transaction, under a lock on its Resource.
- **Errors as values.** Expected failures come back typed, in `{ ok: false, error }`. Only bugs throw.
- **Your data, typed.** Your own columns, Statuses, table names and id types, with no codegen.
- **Correct time.** Built on [Temporal](https://tc39.es/proposal-temporal/docs/), timezones and [DST](./docs/guides/core.md#dst) included.
- **Plain async or Effect.** The same API in [both styles](./docs/guides/effect.md).

**What it doesn't do:** a UI, emails, payments, Bookings shared by several customers (a Resource takes one at a time), or booking several Resources in one call. There is no `getBooking` or `listBookings` Action yet: read through your own database meanwhile. See the [roadmap](./ROADMAP.md).

## Contents

- [Install](#install)
- [Quickstart on Postgres](#quickstart-on-postgres)
- [How it works](#how-it-works)
- [Which piece do I need?](#which-piece-do-i-need)
- [Features by example](#features-by-example): [Actions](#actions), [Policies](#policies), [Blocks](#blocks), [Statuses](#statuses), [`also`](#also), [Hooks](#hooks), [Plugins](#plugins)
- [Databases](#databases)
- [Documentation](#documentation)

## Install

```bash
npm install @fastijs/scheduler
# or
bun add @fastijs/scheduler
```

fasti needs a runtime with native `Temporal`: **Node.js 26+ or Bun 1.4+**.

**Using a coding agent?** The package ships a `fasti` skill that points the agent to these docs and the mistakes to avoid. Link it from `node_modules` with `npx skills experimental_sync`, so it updates with the package, or install it from GitHub with `npx skills add duarteplesteves/fasti --skill fasti`.

## Quickstart on Postgres

With [Drizzle](https://orm.drizzle.team) (`drizzle-orm` 1.0 RC.5+). For SQLite, Prisma or your own storage, see [Databases](#databases). A full, runnable version that CI runs on every push is in [`examples/basic`](./examples/basic).

**1. Define your schema and tables.**

```typescript
// schema.ts
import { availability, column, defineSchema } from "@fastijs/scheduler";
import { bookingTable, recordTables } from "@fastijs/scheduler/drizzle/pg";

export const schema = defineSchema({
  // Developer Fields: your own columns on each Booking.
  booking: { fields: { customerName: { type: column.text(), required: true } } },
  // Opening hours. Without this Plugin, every time outside a Booking is bookable.
  plugins: [availability()],
});

export const tables = {
  ...recordTables(schema), // one table per Plugin table: here `availabilityRule`
  booking: bookingTable(schema),
};
```

**2. Migrate.** fasti never changes your database schema. Add `tables` to your drizzle-kit schema, migrate as usual, then add [the backstop](./docs/guides/databases.md#the-backstop): a constraint that stops overlaps even from writes outside fasti.

**3. Create the scheduler and book.**

```typescript
import { createScheduler } from "@fastijs/scheduler";
import { drizzleAdapter } from "@fastijs/scheduler/drizzle/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const db = drizzle({ client: new Pool({ connectionString: process.env.DATABASE_URL }) });
const scheduler = createScheduler({ adapter: drizzleAdapter(db), schema });

const result = await scheduler.book({
  resourceId: "room-1",
  start: Temporal.Instant.from("2030-06-03T09:00:00+01:00"),
  end: Temporal.Instant.from("2030-06-03T09:30:00+01:00"),
  fields: { customerName: "Ada" },
});

if (result.ok) {
  console.log(`booked ${result.value.id}`);
} else {
  switch (result.error._tag) {
    case "SlotConflict": // taken: error.conflicts says by what
    case "PolicyViolation": // e.g. outside opening hours: error.violations
    case "InvalidParams": // a bad call: error.issues, each with a `path`
    case "AdapterError": // the database failed: error.cause
      console.error(result.error);
  }
}
```

## How it works

A few words are used throughout (the full list is in the [glossary](./GLOSSARY.md)):

| Term         | Meaning                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| **Resource** | Anything bookable: a person, a room, a machine. fasti only knows its `resourceId`.        |
| **Booking**  | A `[start, end)` range on one Resource, with a Status and your own fields.                |
| **Slot**     | A free range `findSlots` returns, ready to book.                                          |
| **Action**   | A method on the scheduler: `book`, `cancel`, `findSlots`, …                               |
| **Adapter**  | What connects fasti to your database.                                                     |

Every write Action goes through the same steps. This is `book`:

```text
 book(params)
   1. Are the params valid?                           no → InvalidParams
 ┌ transaction, under the Resource's lock ──────────────────────────────────────────
 │ 2. Invariants: is the slot free?                   no → SlotConflict
 │ 3. Policies: opening hours, notice, your own       no → PolicyViolation
 │ 4. Save the Booking
 │ 5. `also`: your own writes for this call           refused → Vetoed, rolled back
 │ 6. In-transaction Hooks                            throw → rolled back
 └ commit ──────────────────────────────────────────────────────────────────────────
   7. After-commit Hooks, e.g. a confirmation email   fail → logged, Booking kept
   → { ok: true, value: booking }
```

The split between 2 and 3 matters most ([ADR 014](./docs/adr/014-invariants-and-relaxable-policies.md)):

- An **Invariant** is never skippable. No caller can double-book a Resource.
- A **Policy** is a rule you can skip by name on one call. Staff can book outside hours when your backend passes `relax: ["availability"]`.

`findSlots` applies both, so a slot it offers is one `book` accepts, unless something changed in between.

## Which piece do I need?

| I want to…                                                   | Use                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Set opening hours                                            | The [`availability()`](./docs/guides/actions.md#opening-hours) Plugin       |
| Block out lunch, a vacation or a meeting                     | The [`blocks()`](./docs/guides/blocks.md) Plugin                            |
| Refuse past or last-minute bookings                          | The prebuilt [`notice`](./docs/guides/policies.md#notice) Policy            |
| Enforce my own rule ("max 4 a day")                          | A [Policy](./docs/guides/policies.md)                                       |
| Let staff break a rule on one call                           | [`relax`](./docs/guides/policies.md#relax-and-waived)                       |
| Add requests, no-shows or check-ins                          | [Statuses and Transitions](./docs/guides/statuses.md)                       |
| Spend a credit or take stock together with the booking       | [`also`](./docs/guides/also.md)                                             |
| Refuse a booking based on my own tables                      | [`also`](./docs/guides/also.md), with a veto                                |
| Write an audit row on every change                           | An [in-transaction Hook](./docs/guides/hooks.md#in-the-transaction)         |
| Send an email after every booking                            | An [after-commit Hook](./docs/guides/hooks.md#after-the-commit)             |
| Show the times a Booking could move to                       | `findSlots` with [`excludeBookingId`](./docs/guides/actions.md#findslots)   |
| Add a whole feature, with its own tables and Actions         | A [Plugin](./docs/guides/plugins.md)                                        |
| Rename tables or columns, or use my own id type              | [`defineSchema`](./docs/guides/schema.md)                                   |
| Only do the slot math, on data I already have                | [The Core](./docs/guides/core.md)                                           |

## Features by example

Each example stands alone. `at` and `scheduler` are as in the first one, `adapter` is your Adapter, `slot` stands for `{ resourceId, start, end }`, and `fields` for your Developer Fields.

### Actions

| Action                               | What it does                                                     |
| ------------------------------------ | ---------------------------------------------------------------- |
| `findSlots`                          | Lists the free slots on a Resource                               |
| `book`                               | Creates a Booking                                                |
| `reschedule`                         | Moves a Booking in time, or to another Resource                  |
| `cancel`                             | Cancels a Booking and frees its slot; safe to repeat             |
| `transition`                         | Moves a Booking to another [Status](#statuses)                   |
| `availability.set`, `.get`           | Replaces or reads opening hours, with `availability()`           |
| `blocks.create`, `.update`, `.delete`, `.list` | Manages [Blocks](#blocks), with `blocks()`             |

```typescript
const moved = await scheduler.reschedule({ id: booking.id, start: at("10:00"), end: at("10:30") });

const cancelled = await scheduler.cancel({ id: booking.id });
// { ok: true, value: { booking, alreadyCancelled: false } }
```

→ [Actions](./docs/guides/actions.md): params, values and errors of each, limits, and mapping errors to HTTP.

### Policies

A Policy is a rule about when a booking change is allowed. Use the prebuilt `notice`, or write your own:

```typescript
import { createScheduler, definePolicy, notice } from "@fastijs/scheduler";

const onTheHour = definePolicy(schema, {
  name: "onTheHour",
  appliesTo: ["book"],
  // null passes; anything else is the reason it failed.
  check: ({ start }) => {
    const { minute } = start.toZonedDateTimeISO("Europe/Lisbon");
    return minute === 0 ? null : { minute };
  },
});

const scheduler = createScheduler({
  adapter,
  schema,
  policies: [
    onTheHour,
    notice(schema, { appliesTo: ["book", "reschedule"], minimum: 120 }), // 2 hours ahead
  ],
});

await scheduler.book({ ...halfPastNine, fields });
// { ok: false, error: { _tag: "PolicyViolation", violations: [{ policy: "onTheHour", detail: { minute: 30 } }] } }

await scheduler.book({ ...halfPastNine, fields, relax: ["onTheHour"] });
// { ok: true, value: { …booking, waived: [{ policy: "onTheHour", detail: { minute: 30 } }] } }
```

Without `notice`, starts in the past are bookable.

→ [Policies](./docs/guides/policies.md): rules that read the database, rules on cancelling or Transitions, and what `relax` can't do.

### Blocks

A Block makes a Resource unbookable for a while, and no caller can relax it. Install it with `plugins: [availability(), blocks({ fields: { reason: { type: column.text(), required: true } } })]`:

```typescript
await scheduler.blocks.create({
  resourceId: "room-1",
  start: at("12:00"),
  end: at("14:00"),
  fields: { reason: "lunch" },
});

await scheduler.book({ resourceId: "room-1", start: at("12:30"), end: at("13:00"), fields });
// { ok: false, error: { _tag: "SlotConflict", conflicts: [{ kind: "block", … }] } }
```

→ [Blocks](./docs/guides/blocks.md)

### Statuses

`booked` (takes its slot) and `cancelled` (frees it) are built in. Declare your own, and the moves allowed between them:

```typescript
const schema = defineSchema({
  booking: {
    statuses: {
      noShow: { blocking: false },
      request: { blocking: false }, // doesn't take its slot
    },
    transitions: {
      booked: ["noShow"], // booked → cancelled is always there
      request: ["booked", "cancelled"],
    },
    initial: ["booked", "request"], // what `book` may create
  },
});

await scheduler.book({ ...slot, status: "request" });
await scheduler.transition({ id, from: "request", to: "booked" }); // SlotConflict if it was taken meanwhile
await scheduler.transition({ id, from: "request", to: "noShow" }); // type error: not declared
```

→ [Statuses and Transitions](./docs/guides/statuses.md)

### `also`

Your own writes, in the same transaction as fasti's. Return a failure and the whole thing rolls back:

```typescript
const result = await scheduler.book({
  ...slot,
  fields,
  also: async ({ tx, booking }) => {
    const spent = await spendCredit(tx, booking.id); // your own query, on your own table

    return spent
      ? { ok: true as const, value: "paid" as const }
      : { ok: false as const, error: "no credits left" as const };
  },
});
// Saved:   { ok: true, value: { …booking, also: "paid" } }
// Refused: { ok: false, error: { _tag: "Vetoed", reason: "no credits left" } }, and no Booking
```

→ [`also`](./docs/guides/also.md): a race-free credit pack, retries, and what each Action passes.

### Hooks

`also` runs on one call. A Hook is registered once and runs on every change, wherever it was made:

```typescript
const confirm = defineHook(schema, adapter, {
  when: "afterCommit", // or "inTransaction", with your `tx`
  appliesTo: ["book"],
  run: async ({ booking }) => {
    await sendConfirmation(booking);
  },
});

const scheduler = createScheduler({ adapter, hooks: [confirm], schema });
```

After-commit Hooks run once and aren't retried. If an email must never be lost, see [the outbox](./docs/guides/hooks.md#when-it-must-never-be-lost).

→ [Hooks](./docs/guides/hooks.md)

### Plugins

A Plugin packages tables, Actions, busy time, Policies and Hooks. `availability()` and `blocks()` are Plugins with nothing special about them. You could write this one, with plain async functions:

```typescript
const schema = defineSchema({
  plugins: [availability(), holidays({ eveHours: 12 })],
});

await scheduler.holidays.add({ resourceId, start, end, name: "Santo António" });
await scheduler.book(onTheHoliday); // SlotConflict: [{ kind: "holiday", … }]
await scheduler.book(theEveBefore); // PolicyViolation: [{ policy: "holidayEve", … }]
```

→ [Plugins](./docs/guides/plugins.md), which builds `holidays` step by step.

## Databases

| Database            | Adapter                             | Notes                                                                    |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| Postgres, Drizzle   | `@fastijs/scheduler/drizzle/pg`     | `drizzle-orm` 1.0 RC.5+. Includes the overlap backstop.                   |
| SQLite, Drizzle     | `@fastijs/scheduler/drizzle/sqlite` | libsql file databases, one writer process. No backstop.                   |
| Postgres, Prisma 8  | `@fastijs/scheduler/prisma`         | Experimental while Prisma 8 is an RC.                                     |
| In memory           | `@fastijs/scheduler/memory`         | For tests and prototypes.                                                 |
| Anything else       | `@fastijs/scheduler/adapter`        | [Write your own](./docs/guides/custom-adapter.md) and prove it with the published tests. |

→ [Databases](./docs/guides/databases.md): setup, indexes, the backstop and each database's limits.

## Documentation

**Guides**

| Guide                                                    | Read it to                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| [Actions](./docs/guides/actions.md)                      | Look up an Action's params, value, errors and limits                |
| [Schema](./docs/guides/schema.md)                        | Add fields, rename tables and columns, type your ids                |
| [Statuses and Transitions](./docs/guides/statuses.md)    | Model your own booking lifecycle                                    |
| [Policies](./docs/guides/policies.md)                    | Decide when a booking change is allowed                             |
| [Blocks](./docs/guides/blocks.md)                        | Make a Resource unbookable for a while                              |
| [`also`](./docs/guides/also.md)                          | Write your own rows in fasti's transaction, or veto it              |
| [Hooks](./docs/guides/hooks.md)                          | Run code on every change                                            |
| [Plugins](./docs/guides/plugins.md)                      | Write your own extension                                            |
| [Effect](./docs/guides/effect.md)                        | Use fasti as an Effect service                                      |
| [Databases](./docs/guides/databases.md)                  | Set up Postgres or SQLite                                           |
| [Custom Adapters](./docs/guides/custom-adapter.md)       | Connect another database, and test it                               |
| [The Core](./docs/guides/core.md)                        | Use the slot math alone, with no database                           |
| [Migrating](./docs/guides/migrating.md)                  | Upgrade from `0.6`                                                  |

**Reference:** [glossary](./GLOSSARY.md) · [decision records](./docs/adr/) · [changelog](./CHANGELOG.md) · [roadmap](./ROADMAP.md)

**Entry points**

| Import                              | What it holds                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@fastijs/scheduler`                | `createScheduler`, `defineSchema`, `column`, `definePolicy`, `notice`, `defineHook`, `definePlugin`, `availability`, `blocks`, and the error types |
| `@fastijs/scheduler/effect`         | `Scheduler`, the Effect form of the Actions, and the native `definePlugin`                                |
| `@fastijs/scheduler/drizzle/pg`     | `drizzleAdapter`, `bookingTable`, `recordTables`, `backstopSql`                                           |
| `@fastijs/scheduler/drizzle/sqlite` | `drizzleAdapter`, `bookingTable`, `recordTables` (also needs `@libsql/client`)                            |
| `@fastijs/scheduler/prisma`         | `prismaAdapter`, `prismaModels`, `backstopSql`                                                            |
| `@fastijs/scheduler/memory`         | `memoryAdapter`                                                                                           |
| `@fastijs/scheduler/adapter`        | `defineAdapter` and the Adapter contract types                                                            |
| `@fastijs/scheduler/testing`        | `testAdapter`, the Conformance Suite every Adapter must pass (needs `vitest`)                             |
| `@fastijs/scheduler/core`           | The Core: stateless functions, no runtime dependencies                                                    |

## Development

```bash
nub install          # dependencies
nub run check        # lint and format
nub run typecheck    # types, tests included
nub run test         # unit tests
nub run bench        # benchmarks; also `bun --bun run bench`. Compare runs by `min`: garbage collection skews the mean
nub run build        # then `nub run publint` and `nub run attw` check the published package
```

## License

MIT
