# fasti

A type-safe, stateless scheduling engine for TypeScript.

## Philosophy

- **Stateless pure functions** — You bring the data; the engine does the math.
- **Framework-agnostic** — Works in Node.js, Bun, Deno, and the browser.
- **Storage-agnostic** — Bring your own database, ORM, and persistence layer.
- **Temporal-native** — Built on the [Temporal API](https://tc39.es/proposal-temporal/docs/) for unambiguous date/time handling.

## Installation

```bash
npm install @fastijs/scheduler
# or
bun add @fastijs/scheduler
```

One package, several entry points:

| Import                          | What it holds                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `@fastijs/scheduler`            | `createScheduler`, `defineSchema`, `definePolicy`, `notice`, `defineHook`, `definePlugin`, the `availability()` and `blocks()` Plugins, the `column` helpers and the error types. |
| `@fastijs/scheduler/effect`     | `Scheduler`, the Effect form of the Actions, and the native `definePlugin`.             |
| `@fastijs/scheduler/drizzle/pg` | `drizzleAdapter`, the table builders and `backstopSql` (needs `drizzle-orm` 1.0 RC.5+). |
| `@fastijs/scheduler/drizzle/sqlite` | The same names as `drizzle/pg`, for libsql file databases (needs `drizzle-orm` 1.0 RC.5+ and `@libsql/client`). |
| `@fastijs/scheduler/prisma`     | `prismaAdapter`, `prismaModels` and `backstopSql`, for Prisma 8 on Postgres. Experimental while Prisma 8 is an RC. |
| `@fastijs/scheduler/memory`     | `memoryAdapter`, for tests and prototypes.                                              |
| `@fastijs/scheduler/adapter`    | The Adapter contract types and `defineAdapter`, for writing your own Adapter.           |
| `@fastijs/scheduler/testing`    | `testAdapter`, the Conformance Suite every Adapter must pass (needs `vitest`).          |
| `@fastijs/scheduler/core`       | The Core: the stateless functions under [The Core](#the-core). No runtime dependencies. |

fasti uses the global `Temporal` (Node.js 26+, Bun 1.4+). On runtimes without native Temporal, install a global polyfill before importing the package.


## Quickstart

The full, runnable version is [`examples/basic`](./examples/basic), which CI runs against Postgres on every push.

**1. Define your schema and tables.** `defineSchema` names your tables, columns and Statuses, declares your Developer Fields (your own columns on each Booking) and installs [Plugins](#plugins). `availability()` adds opening hours; leave it out and every time outside Bookings is bookable. Every option has a default; see [Defining your schema](#defining-your-schema).

```typescript
import {
  availability,
  column,
  createScheduler,
  defineSchema,
} from "@fastijs/scheduler";
import {
  bookingTable,
  drizzleAdapter,
  recordTables,
} from "@fastijs/scheduler/drizzle/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export const schema = defineSchema({
  booking: {
    fields: { customerName: { required: true, type: column.text() } },
  },
  plugins: [availability()],
});

export const tables = {
  ...recordTables(schema), // every Plugin table: here `availabilityRule`
  booking: bookingTable(schema),
};
```

**2. Migrate.** fasti never runs DDL. Add `tables` to your drizzle-kit schema and migrate them as usual, then add the statements from `backstopSql(schema)` as a custom migration ([the backstop](#drizzle-on-postgres)).

**3. Book.** Every Action returns `{ ok: true, value }` or `{ ok: false, error }`. Only bugs reject the promise.

```typescript
const db = drizzle({ client: new Pool({ connectionString: process.env.DATABASE_URL }) });
const scheduler = createScheduler({ adapter: drizzleAdapter(db), schema });

await scheduler.availability.set({
  resourceId: "room-1",
  rules: [
    {
      recurrence: { daysOfWeek: [1, 2, 3, 4, 5], frequency: "weekly", interval: 1 },
      timeWindow: {
        end: Temporal.PlainTime.from("17:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: "Europe/Lisbon",
    },
  ],
});

const slots = await scheduler.findSlots({
  duration: 30, // minutes
  from: Temporal.Instant.from("2030-06-03T00:00:00+01:00"),
  interval: 30, // grid step in minutes, from local midnight in `timezone`
  resourceId: "room-1",
  timezone: "Europe/Lisbon", // anchors the grid and zones the returned slots
  to: Temporal.Instant.from("2030-06-04T00:00:00+01:00"),
});

const result = await scheduler.book({
  end: Temporal.Instant.from("2030-06-03T09:30:00+01:00"),
  fields: { customerName: "Ada" },
  resourceId: "room-1",
  start: Temporal.Instant.from("2030-06-03T09:00:00+01:00"),
});

if (!result.ok) {
  switch (result.error._tag) {
    case "SlotConflict": // result.error.conflicts: [{ kind, id, start, end }]
    case "PolicyViolation": // result.error.violations: [{ policy: "availability", detail: {} }]
    case "InvalidParams": // result.error.issues, each with a `path`
    case "AdapterError": // the database failed; result.error.cause
  }
} else {
  await scheduler.cancel({ id: result.value.id });
}
```

| Action             | Value                                    | Errors (`_tag`)                                                       |
| ------------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| `book`             | the `Booking`, in its initial Status     | `InvalidParams`, `SlotConflict`, `PolicyViolation`, `AdapterError`    |
| `reschedule`       | the moved `Booking`, same id and Status  | `InvalidParams`, `BookingNotFound`, `StatusMismatch`, `SlotConflict`, `PolicyViolation`, `AdapterError` |
| `cancel`           | `{ booking, alreadyCancelled }`          | `InvalidParams`, `BookingNotFound`, `TransitionNotDeclared`, `PolicyViolation`, `AdapterError` |
| `transition`       | the `Booking`, in its new Status         | `InvalidParams`, `BookingNotFound`, `StatusMismatch`, `SlotConflict`, `PolicyViolation`, `AdapterError` |
| `findSlots`        | `Slot[]`, zoned in `timezone`            | `InvalidParams`, `BookingNotFound`, `AdapterError`                    |
| `availability.set` | `{ rules }`, replacing the whole set     | `InvalidParams`, `AdapterError`                                       |
| `availability.get` | the stored rules                         | `AdapterError`                                                        |

`availability.set` and `.get` exist because the schema installs `availability()`; every other Plugin adds its Actions under its own name the same way.

- An overlap is checked before availability, so an overlapping Booking outside hours is a `SlotConflict` alone ([ADR 014](./docs/adr/014-invariants-and-relaxable-policies.md)).
- `PolicyViolation` is in an Action's error type only when some [Policy](#policies) applies to it and isn't relaxed. With `availability()` installed, its `availability` Policy applies to `book` and `reschedule`.
- Domain errors are plain objects with no `message`, safe to send to a client as JSON. `AdapterError` is an `Error` whose `cause` is your driver's error ([ADR 010](./docs/adr/010-action-results-and-two-forms.md)).
- `cancel` is idempotent. `book` is not: each call mints a new id, so dedupe retries in your backend.
- `transition({ id, from, to })` moves a Booking along a declared Transition, compare-and-set on `from`: if the stored Status isn't `from`, it's a `StatusMismatch` carrying the stored one. `to` is narrowed by `from`, and `cancelled` is never a `to` (use `cancel`). It exists when some declared Transition doesn't end in `cancelled`. Moving into a blocking Status from a non-blocking one re-checks overlap; availability is never checked. `cancel` from a Status with no Transition to `cancelled` gives `TransitionNotDeclared`. Both take a partial `fields` patch.
- `reschedule({ id, start, end, resourceId?, fields? })` moves a blocking Booking in time, or to another Resource when you pass `resourceId`. It ignores the Booking itself in the overlap check and takes the lock on the destination only. A Booking in a non-blocking Status (e.g. `cancelled`) gives `StatusMismatch { id, status }`.
- `findSlots({ ..., excludeBookingId })` leaves that Booking out of the overlap check and judges each slot with the `reschedule` Policies, so a UI can offer only the times `reschedule` accepts. An id that names no Booking is `BookingNotFound`.
- Given an [`also`](#your-writes-in-the-same-transaction-also), every write Action can also fail with `Vetoed`.

## Effect

The same Actions, with the same params, values and errors, as Effects. Declare your own service class and provide its `layer`:

```typescript
import { Scheduler } from "@fastijs/scheduler/effect";
import type { TxOf } from "@fastijs/scheduler/effect";
import { Effect } from "effect";

const adapter = drizzleAdapter(db);

class AppScheduler extends Scheduler<AppScheduler, typeof schema, TxOf<typeof adapter>>()("app/Scheduler") {}

const program = Effect.gen(function* bookOne() {
  const scheduler = yield* AppScheduler;

  return yield* scheduler
    .book({ end, fields: { customerName: "Ada" }, resourceId: "room-1", start })
    .pipe(Effect.catchTag("SlotConflict", (error) => Effect.succeed(error.conflicts)));
});

await Effect.runPromise(
  program.pipe(Effect.provide(AppScheduler.layer({ adapter, schema })))
);
```

The third type parameter is your Adapter's transaction handle, the `tx` an `also` gets. The optional fourth is your [Policies](#policies) tuple, `typeof policies` for a `const policies = [...] as const` you pass to `layer`. Leave both out for none. In this form `also` returns an Effect: it may require your own services (they join the Action's requirements), and its `now` comes from Effect's `Clock`, so `TestClock` controls it.

Expected failures go to the error channel, tagged for `Effect.catchTag`; a bug in fasti dies. Interrupting the fiber doesn't cancel a unit of work already running in the Adapter: it finishes, then commits or rolls back.

## Blocks

A Block makes a Resource unbookable for a while: a vacation, a lunch, a meeting. It is its own entity, not a kind of Booking, with its own Developer Fields and no Status: you create, change and delete it ([ADR 016](./docs/adr/016-block-is-its-own-entity.md)).

**Install the Plugin.** Blocks are a first-party [Plugin](#plugins): `blocks({ fields })` turns them on, with their Developer Fields (`fields: {}` for none). A schema without it has no Block table and no `scheduler.blocks`.

```typescript
import { availability, blocks, column, defineSchema } from "@fastijs/scheduler";

export const schema = defineSchema({
  booking: {
    fields: { customerName: { required: true, type: column.text() } },
  },
  plugins: [
    availability(),
    blocks({ fields: { reason: { required: true, type: column.text() } } }),
  ],
});

export const tables = {
  ...recordTables(schema), // `availabilityRule` and `block`; takes `references` like bookingTable
  booking: bookingTable(schema),
};
```

Rename the table and its columns under `names`: `names.tables.block`, `names.columns.block`.

**Block out time.**

```typescript
await scheduler.blocks.create({
  end: Temporal.Instant.from("2030-06-03T14:00:00+01:00"),
  fields: { reason: "lunch" },
  resourceId: "room-1",
  start: Temporal.Instant.from("2030-06-03T12:00:00+01:00"),
});

// Now `book` over 12:00–14:00 is a SlotConflict, and `findSlots` hides those slots.
const overLunch = await scheduler.book({
  end: Temporal.Instant.from("2030-06-03T13:00:00+01:00"),
  fields: { customerName: "Grace" },
  resourceId: "room-1",
  start: Temporal.Instant.from("2030-06-03T12:30:00+01:00"),
});
if (!overLunch.ok && overLunch.error._tag === "SlotConflict") {
  for (const conflict of overLunch.error.conflicts) {
    conflict.kind; // "booking" | "block" (plus any other Plugin's busy kind): narrow on it
  }
}
```

| Action          | Value                                                      | Errors (`_tag`)                                                   |
| --------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `blocks.create` | the `Block`: `{ id, resourceId, start, end, ...fields }`   | `InvalidParams`, `SlotConflict`, `AdapterError`                   |
| `blocks.update` | the updated `Block`                                        | `InvalidParams`, `SlotConflict`, `BlockNotFound`, `AdapterError`  |
| `blocks.delete` | nothing                                                    | `BlockNotFound`, `AdapterError`                                   |
| `blocks.list`   | the Blocks overlapping `[from, to)`, sorted by start, then id | `InvalidParams`, `AdapterError`                                |

- A Block is a half-open `[start, end)` range of Instants: no timezone, no recurrence. It may be in the past.
- `update` takes the `id`, and optionally a new `start` and `end` (together) and the `fields` to change. It can't move a Block to another Resource.
- Blocks are [busy time](#plugins). The overlap check runs both ways, under the Resource Lock: `book` refuses a slot over a Block, and `blocks.create` or `blocks.update` refuse a range over a blocking Booking. Both are a `SlotConflict`, whose items carry `kind: "booking" | "block"` with ids and times only. Like the Booking overlap, it can't be relaxed.
- Blocks may overlap each other, and no Policy applies to their writes: a Block outside availability is fine.
- The Effect form has the same `blocks` Actions; failures are tagged for `Effect.catchTag`.

**Writes outside fasti.** The [backstop](#drizzle-on-postgres) `EXCLUDE` constraint works within one table, so no database constraint stops a Booking from overlapping a Block. fasti's lock keeps its own Actions safe, but a row you write to either table yourself can create a Booking/Block overlap that nothing catches. A later `blocks.update` that changes only `fields` doesn't re-check, so such an overlap stays.

**In a custom Adapter.** Blocks are stored through the `records` verb group, like every Plugin table: see [Writing a custom Adapter](#writing-a-custom-adapter). `testAdapter` runs the Conformance Suite's Blocks cases whenever your schema installs `blocks()`.

## Statuses and Transitions

Two Statuses ship: `booked`, which blocks its slot, and `cancelled`, which doesn't. Declare your own in `defineSchema`, with the Transitions between them ([ADR 009](./docs/adr/009-booking-lifecycle.md)):

```typescript
export const schema = defineSchema({
  booking: {
    fields: { customerName: { required: true, type: column.text() } },
    statuses: {
      inProgress: { blocking: true },
      noShow: { blocking: false },
      done: { blocking: false },
      request: { blocking: false },
    },
    transitions: {
      request: ["booked", "cancelled"],
      booked: ["inProgress", "noShow"], // booked → cancelled is always there
      inProgress: ["done"], // inProgress can't be cancelled
      cancelled: ["booked"], // un-cancel
    },
    initial: ["booked", "request"], // the Statuses `book` may create in; default ["booked"]
  },
});

const request = await scheduler.book({ ...slot, fields, status: "request" }); // `status` is required: `initial` has two

await scheduler.transition({ id, from: "request", to: "booked" }); // re-checks overlap: `booked` blocks
await scheduler.transition({ id, from: "booked", to: "done" }); // type error: no booked → done
```

- `blocking` is all fasti reads from a Status. A blocking Status takes part in the overlap check, `findSlots` and the backstop; a non-blocking one frees its slot.
- A Status with no Transitions leaving it is terminal. `cancel` is the only way into `cancelled`, and works only from Statuses with a Transition to it; from any other, it fails with `TransitionNotDeclared`.
- `book` takes `status` only when `initial` has more than one entry. Booking into a non-blocking Status skips the overlap check, but availability still applies.
- `scheduler.transition` exists when some declared Transition doesn't end in `cancelled`. A schema that declares only Statuses, or only Transitions into `cancelled`, has no `transition`.
- Stored values can be renamed under `names.statuses`, like the base ones. Redeclaring `booked` or `cancelled`, naming an unknown Status in `transitions` or `initial`, or two Statuses sharing a stored value is a type error, and throws in `defineSchema`.
- On Drizzle and Prisma, the Status `CHECK` constraint and `backstopSql` list your Statuses: adding one, or flipping its `blocking`, needs a migration. Your migration tool generates the `CHECK` change; the backstop you redo by hand ([the backstop](#drizzle-on-postgres)). If you don't, a new blocking Status isn't covered by it, and a Status flipped to non-blocking still has its overlaps refused, as `SlotConflict`.

## Your writes in the same transaction (`also`)

Every write Action (`book`, `reschedule`, `cancel`, `transition`, and every Plugin write Action, such as `availability.set` and `blocks.create`, `blocks.update`, `blocks.delete`) takes an optional `also`. fasti calls it after its own write, on the same unit of work, with the Adapter's `tx` and the Clock's `now` ([ADR 015](./docs/adr/015-developer-writes-inside-the-action-transaction.md)):

```typescript
// Each Booking spends a credit from a prepaid pack, a table of your own.
const result = await scheduler.book({
  ...slot,
  fields: { customerName: "Ada" },
  also: async ({ tx }) => {
    // A guarded update: race-free, and it changes no row when the pack is empty.
    const [row] = await tx
      .update(pack)
      .set({ remaining: sql`${pack.remaining} - 1` })
      .where(and(eq(pack.id, packId), gt(pack.remaining, 0)))
      .returning({ remaining: pack.remaining });

    return row === undefined
      ? { ok: false as const, error: "no credits left" as const }
      : { ok: true as const, value: row.remaining };
  },
});
// ok: the Booking plus `also`, the credits left.
// Vetoed: { _tag: "Vetoed", reason: "no credits left" }, and no Booking was stored.
```

- `also` may be sync or async, and returns a `Result`. Its `value` comes back on the Action's value as `also` (a `blocks.delete` value is `{ also }`).
- Returning `{ ok: false, error }` vetoes: everything rolls back, fasti's write included, and the Action fails with `{ _tag: "Vetoed", reason: error }`. A throw also rolls back, and the promise rejects with what was thrown.
- Write only through `tx`: anything else isn't part of the unit and won't roll back. On the memory Adapter `tx` is `undefined`.
- `also` may run more than once. The Drizzle Adapter reruns the whole unit, `also` included, when it fails with a deadlock or a serialization failure (`40P01`, `40001`), up to 3 attempts. When they run out, it fails as on the last attempt: an `AdapterError` if fasti's write failed, a rejection if `also` threw. So a deadlock hit by a query inside a plain `also` rejects the promise rather than returning `AdapterError`. Another reason to write only through `tx`.
- Side effects that can't roll back, such as an email or a webhook, don't belong in `also`: send them from an after-commit [Hook](#hooks), or after the call returns `ok`. If one must never be lost, insert an outbox row through `tx` and send it from a background job.
- `also` runs under the Resource Lock, so a slow `also` delays every other write to that Resource. Don't call an Action from inside it: that's unsupported, and on the same Resource it deadlocks.
- What each Action passes, besides `tx` and `now`: `book` gets `booking`; `reschedule`, `cancel` and `transition` get `booking` and `previous`; `availability.set` gets `resourceId`, `rules` and `previous`; `blocks.create` gets `block`; `blocks.update` gets `block` and `previous`; `blocks.delete` gets `previous`. Any other Plugin write Action gets the `context` its `lock` returned.
- `also` runs only when something changed. A repeat `cancel` writes nothing, skips `also`, and its value (`alreadyCancelled: true`) has no `also` key. A `blocks.update` that changes nothing still runs it, with `block === previous`.
- `also` is a reserved name: a Booking or Block Developer Field can't be called `also`.
- A Plugin's own write Actions get `also` the same way, whether the Plugin was written in Effect or with plain async functions.

## Hooks

`also` runs at one call site. A Hook is registered once and runs on every write it applies to, wherever it's called from: a confirmation email for every new Booking, an audit row for every change ([ADR 017](./docs/adr/017-hooks-observe-write-actions.md)). Put side effects in Hooks rather than at your call sites, so a new call site can't forget them.

A Hook observes: it can't change an Action's params, value or errors, and it can't refuse one. A refusal belongs in a [Policy](#policies) or in `also`.

**In the transaction.** `when: "inTransaction"` runs on the Action's `tx`, after `also`, under the Resource Lock:

```typescript
import { createScheduler, defineHook } from "@fastijs/scheduler";

const adapter = drizzleAdapter(db);

// Every change to a Booking leaves a row in an audit table of your own.
const audit = defineHook(schema, adapter, {
  when: "inTransaction",
  appliesTo: ["book", "reschedule", "cancel"],
  run: async ({ action, booking, now, tx }) => {
    await tx.insert(auditLog).values({
      action,
      at: new Date(now.epochMilliseconds),
      bookingId: booking.id,
    });
  },
});
```

- A throw rolls the whole write back (fasti's write, `also`, and the Hooks before it), and the Action rejects with what was thrown (a defect in the Effect form).
- Like `also`, it may run more than once when the Adapter retries the unit, so write only through `tx`.
- It runs under the Resource Lock: a slow one delays every other write to that Resource.

**After the commit.** `when: "afterCommit"` runs once, after the final commit, and the Action waits for it before returning. It gets no `tx`: the transaction is gone.

```typescript
const confirm = defineHook(schema, adapter, {
  when: "afterCommit",
  appliesTo: ["book"],
  run: async ({ booking }) => {
    await sendConfirmation(booking);
  },
});

const scheduler = createScheduler({ adapter, hooks: [audit, confirm], schema });
```

- A failure never changes the result: the write is already saved. It's logged at error level through Effect's logger (the console, or your own `Logger` in the Effect form), annotated with `action`, and the next Hook still runs.
- Since the Action waits for it, its time adds to the write's latency: a slow email provider slows `book`. In return, on a serverless platform it has finished before you respond, and a test knows when it's done.

> **An after-commit Hook can be lost.** It isn't retried, and if the process dies between the commit and the Hook, the email is never sent, though the Booking is saved. If it must never be lost, insert an outbox row from an in-transaction Hook and send it from a background job.

**`appliesTo`.** At least one target, or `"*"`:

- Write Action names: `"book"`, `"reschedule"`, `"cancel"`, `"transition"`, and `"<plugin>.<action>"` for every installed Plugin's write Actions: `"availability.set"` with `availability()`, `"blocks.create"`, `"blocks.update"`, `"blocks.delete"` with `blocks()`.
- Transition edges, as a Policy takes them: `{ to }` for every declared edge into `to`, or `{ from, to }` for one. Edges into `cancelled` belong to `"cancel"`.
- `"*"` for every write Action, Plugin ones included, and ones a later schema change adds. Unlike Policies, Hooks allow it: an audit log that picks up a new edge is what you want.

The event `run` gets is what that Action's `also` gets (see [`also`](#your-writes-in-the-same-transaction-also)), plus `action`, narrowed by `appliesTo`: an edge's event has `action: "transition"`. An unknown name, a Plugin Action whose Plugin isn't installed (`blocks.*` without `blocks()`), an undeclared edge or an edge into `cancelled` is a type error, and `defineHook` throws on it, as on an empty `appliesTo`.

**When Hooks run, and in what order.**

- `also` → in-transaction Hooks → commit → after-commit Hooks. Within each kind, the Plugins' Hooks run first, in Plugin order, then yours, in `hooks` order. Each in-transaction Hook sees the earlier ones' writes on `tx`.
- A Hook runs only when something was saved: never on a Veto, a typed failure such as `SlotConflict` or `PolicyViolation`, or a repeat `cancel`. A `blocks.update` that changes nothing still runs them, as it runs `also`. Reads run no Hooks.
- Hooks run whether or not the call passed `also`, and add nothing to the Action's value or types.

**`adapter`.** `defineHook` takes the Adapter only to type `tx`; it never calls it. An in-transaction Hook fits only a scheduler over an Adapter with the same `tx`, while an after-commit one fits any. In the Effect form, pass `hooks` to `layer`: `AppScheduler.layer({ adapter, hooks: [audit, confirm], schema })`. `run` stays a plain function there.

## Policies

fasti splits its checks in two ([ADR 014](./docs/adr/014-invariants-and-relaxable-policies.md)). **Invariants** always hold and can't be skipped: meaningful params, no overlap, a declared Transition, and a Booking that exists in the expected Status. Everything else is a **Policy**: a named rule the caller can relax on one call. Policies come from your `policies` and from installed Plugins, such as `availability` on `book` and `reschedule` with `availability()`. Nothing else runs by default.

```typescript
import { createScheduler, definePolicy, notice } from "@fastijs/scheduler";

const lisbonDay = (instant: Temporal.Instant) =>
  instant.toZonedDateTimeISO("Europe/Lisbon").toPlainDate();

const maxFourPerDay = definePolicy(schema, {
  name: "maxFourPerDay", // what relax, PolicyViolation and waived call it
  appliesTo: ["book"], // the Actions and Transition edges that run it
  // Optional. Once per call, under the Resource Lock on writes: does the I/O.
  load: ({ from, reads, resourceId, to }) =>
    reads.listBookings({
      overlapping: {
        from: from.toZonedDateTimeISO("Europe/Lisbon").startOfDay().toInstant(),
        to: to.toZonedDateTimeISO("Europe/Lisbon").startOfDay().add({ days: 1 }).toInstant(),
      },
      resourceId,
    }),
  // Once per candidate: one on a write, one per Grid slot in findSlots. Synchronous, no I/O.
  check: (candidate, bookings) => {
    const count = bookings.filter(
      (b) => b.status === "booked" && lisbonDay(b.start).equals(lisbonDay(candidate.start))
    ).length;

    return count >= 4 ? { count } : null; // null passes; anything else is the Violation's detail
  },
});

// Two hours' notice; 0 would still refuse past starts.
const twoHoursNotice = notice(schema, { appliesTo: ["book", "reschedule"], minimum: 120 });

const scheduler = createScheduler({
  adapter: drizzleAdapter(db),
  policies: [maxFourPerDay, twoHoursNotice],
  schema,
});

const fifth = await scheduler.book({ ...slot, fields });
// { ok: false, error: { _tag: "PolicyViolation", violations: [{ policy: "maxFourPerDay", detail: { count: 4 } }] } }

const staff = await scheduler.book({ ...slot, fields, relax: ["maxFourPerDay"] });
// { ok: true, value: { ...booking, waived: [{ policy: "maxFourPerDay", detail: { count: 4 } }] } }
```

**`load` and `check`.** `load` reads, `check` decides. They are split so `findSlots` can judge hundreds of slots with one query per Policy, not one per slot. `load` gets `{ resourceId, from, to, now, reads }`: the candidate's Resource and range (the stored Booking's on `cancel` and Transition edges; the whole search, `[from, to + duration)`, in `findSlots`). `reads` holds `getBooking` and `listBookings`, as Promises. Plugin data isn't in `reads`; a Plugin's own Policies read its tables. `check` gets the candidate and what `load` returned (`undefined` without `load`); `detail`'s type is inferred from it.

**`appliesTo`.** Action names and Transition edges, at least one. The candidate `check` gets is narrowed to them:

| Target                    | Candidate                                                     |
| ------------------------- | ------------------------------------------------------------- |
| `"book"`                  | `{ action, resourceId, start, end, now }`                     |
| `"reschedule"`            | `{ action, resourceId, start, end, previous, now }`: `resourceId` is the destination, `previous` the stored Booking |
| `"cancel"`                | `{ action, booking, now }`: the stored Booking                |
| `{ to }` / `{ from, to }` | `{ action: "transition", booking, from, to, now }`: every declared edge into `to`, or that one edge |

```typescript
// With the Statuses above: a no-show can only be recorded once the Booking has started.
const noShowAfterStart = definePolicy(schema, {
  name: "noShowAfterStart",
  appliesTo: [{ to: "noShow" }],
  check: ({ booking, now }) =>
    Temporal.Instant.compare(now, booking.start) < 0 ? { start: booking.start } : null,
});
```

Edges into `cancelled` belong to `"cancel"`. An undeclared edge, `{ to }` with no declared edge into it or an empty `appliesTo` is a type error, and `definePolicy` throws on it. Policy names are unique across your `policies` and every installed Plugin's (`availability` is taken once `availability()` is installed): a clash is a type error, and `createScheduler` throws.

**`relax`, `waived` and `PolicyViolation`.**

- The Invariants run first. If one fails, its error comes back alone: an overlapping Booking that also breaks a Policy is a `SlotConflict`.
- Then every applicable Policy runs, relaxed ones included: the Plugins' first, in Plugin order (so `availability` first when it's installed first), then yours. Every unrelaxed one that broke is in `PolicyViolation.violations`, each with `detail` typed by its `policy`. Nothing is written, and `also` doesn't run.
- `relax: [...names]` is typed per Action and per Transition edge, so it lists only the Policies that apply. An unknown name is `InvalidParams` at `["relax", i]`, before any database call. There is no `"all"`: a Policy you add later is never relaxed by old code.
- With `relax`, the value carries `waived`: the relaxed Policies that actually broke, `[]` when none did. Without `relax`, there is no `waived` key. Log it to see who booked outside hours. On `cancel`, only `alreadyCancelled: false` carries it: a repeat `cancel` runs no Policy and no `also`.
- `waived`, like `also`, is a reserved name: a Booking Developer Field can't be called `waived`.

**`notice`.** The prebuilt Policy, written with `definePolicy`: `notice(schema, { minimum, appliesTo, name? })` breaks when the start is before `now + minimum`, with `detail: { earliest }`.

- `minimum` is whole minutes, at least 0; anything else throws. `0` still refuses a start in the past, which fasti otherwise accepts: without `notice`, past starts are bookable.
- On `book` and `reschedule` it compares the candidate's start; on `cancel` and Transition edges, the stored Booking's.
- `name` defaults to `"notice"`. Rename it to register more than one and relax each on its own:

  ```typescript
  notice(schema, { name: "bookingNotice", minimum: 120, appliesTo: ["book", "reschedule"] });
  notice(schema, { name: "cancelNotice", minimum: 24 * 60, appliesTo: ["cancel"] });
  ```

- To test a Policy on its own, call its `check` directly with a candidate and a fixed `now`.

**`findSlots` agrees with the writes.** It runs the same Policies on each Grid slot: `book`'s, or `reschedule`'s (with `previous`) when you pass `excludeBookingId`. A slot that breaks an unrelaxed Policy is hidden. With `relax`, a slot that breaks only relaxed Policies is listed with them in `waived`, so `relax: ["availability"]` lists the Grid slots outside the rules. A slot it lists, `book` (or `reschedule`, with `excludeBookingId`) with the same `relax` accepts, at the same `now`.

**`now`.** Each unit of work reads the Clock once, at its start, and every Policy and `also` see that `now`. A retry (the Booking changed while fasti was locking it, or a Drizzle deadlock) re-runs the whole unit with a fresh `now`, so `load` and `check` never decide on stale data. That also means time moves between calls: a slot `findSlots` listed at 13:59 can be refused by `notice` at 14:01.

**What `load` can't do.**

- `load` gets fasti's reads, not your Adapter's `tx`, so it can't read your own tables inside the unit of work. A check on your own data ("this customer's tier allows evenings") belongs in [`also`](#your-writes-in-the-same-transaction-also), vetoing the Action. It won't show in `findSlots`.
- A Policy is race-free only for the Resource whose lock it runs under. A limit across Resources (sessions per pack) can be overfilled by concurrent bookings on different Resources: make it a guarded update in `also`.
- A read that fails in `load` is an `AdapterError`. Anything else thrown from `load` or `check` is a bug: the unit rolls back and the promise rejects.

## Plugins

A Plugin extends fasti without forking it: a waitlist, public holidays, a calendar sync, an audit log ([ADR 018](./docs/adr/018-plugins-are-modules-with-generic-storage.md)). You install it in `defineSchema({ plugins })`, and it can bring any of five parts, each optional:

- **Tables**, declared as data with the `column` helpers. Every Adapter stores them, custom ones included, and your table helpers (`recordTables`, `prismaModels`) build them.
- **Actions**, on `scheduler.<plugin>.<action>`, in both the plain and the Effect forms.
- **Busy time**: ranges on a Resource that no Booking may overlap.
- **Policies**: rules about when a Booking change is allowed, which a caller can relax by name.
- **Hooks**, as `defineHook`'s, run before yours.

`availability()` and `blocks()` are Plugins built this way, with nothing special about them. Plugins are trusted code, like an Adapter: install only ones you'd let write to your database.

**Write one.** `definePlugin` from `@fastijs/scheduler` takes plain async functions; you never need Effect. This one, from [`examples/basic`](./examples/basic/holidays.ts), stores holidays on a Resource:

```typescript
import { column, definePlugin, ok } from "@fastijs/scheduler";
import type { PluginResourceId, RecordId } from "@fastijs/scheduler";

export function holidays({ eveHours }: { readonly eveHours: number }) {
  return definePlugin({
    name: "holidays", // → scheduler.holidays
    tables: {
      // A timed table: fasti adds and owns `id`, `resourceId`, `start` and `end`.
      holiday: {
        columns: { name: { required: true, type: column.text() } },
        timed: true,
      },
    },
    actions: {
      add: {
        kind: "write",
        // Type the params on `run`; PluginResourceId becomes the schema's Resource id type.
        run: async (
          params: {
            readonly resourceId: PluginResourceId;
            readonly start: Temporal.Instant;
            readonly end: Temporal.Instant;
            readonly name: string;
          },
          { lock }
        ) =>
          // One unit of work under the Resource Lock: the caller's `also` and the Hooks run on it.
          await lock(params.resourceId, async ({ conflicts, records }) => {
            // Busy time must not cover a Booking: checking that is this Plugin's job.
            const hits = await conflicts(params);

            if (hits.length > 0) {
              return {
                _tag: "Failed",
                error: { _tag: "SlotConflict", conflicts: hits },
              } as const;
            }

            const holiday = await records.holiday.insert(params);

            return {
              _tag: "Done",
              context: { holiday }, // what `also` and the Hooks get
              value: holiday,
            } as const;
          }),
      },
      list: {
        kind: "read",
        run: async (
          params: { readonly resourceId: PluginResourceId },
          { records }
        ) => ok(await records.holiday.list({ resourceId: params.resourceId })),
      },
    },
    // Busy time: `book` refuses it with SlotConflict { kind: "holiday" }, and findSlots skips it. Nobody can relax it.
    busy: {
      kind: "holiday",
      list: async ({ overlapping, records, resourceId }) =>
        await records.holiday.list({ overlapping, resourceId }),
    },
    // A Policy: no Booking ending within `eveHours` of a holiday. Callers can relax it by name.
    policies: [
      {
        appliesTo: ["book", "reschedule"],
        check: (
          _candidate,
          next: readonly { readonly id: RecordId<"holiday"> }[]
        ) => (next[0] === undefined ? null : { holiday: next[0].id }),
        load: async ({ records, resourceId, to }) =>
          await records.holiday.list({
            overlapping: { from: to, to: to.add({ hours: eveHours }) },
            resourceId,
          }),
        name: "holidayEve",
      },
    ],
    hooks: [
      {
        appliesTo: ["holidays.add"],
        run: (event) => {
          if (event.action === "holidays.add") {
            console.log(`holiday added: ${event.holiday.name}`);
          }
        },
        when: "afterCommit",
      },
    ],
  });
}
```

Install it, migrate its table (`recordTables(schema)` includes `holiday`), and its Actions are typed like fasti's own:

```typescript
const schema = defineSchema({
  booking: { fields: { customerName: { required: true, type: column.text() } } },
  plugins: [availability(), holidays({ eveHours: 12 })],
});

const holiday = await scheduler.holidays.add({ resourceId, start, end, name: "Santo António" });
// { ok: true, value: { id, resourceId, start, end, name } }, or SlotConflict, Vetoed, AdapterError

await scheduler.book({ ...onTheHoliday, fields }); // SlotConflict: [{ kind: "holiday", id, start, end }]
await scheduler.book({ ...theEveBefore, fields }); // PolicyViolation: [{ policy: "holidayEve", detail: { holiday } }]
await scheduler.book({ ...theEveBefore, fields, relax: ["holidayEve"] }); // ok, with `waived`
```

**Two lanes: busy time and Policies.** A Plugin that says "not then" picks one:

- **Busy time** means *something is already there*. It joins blocking Bookings in the overlap Invariant: `book`, `reschedule` and a Transition into a blocking Status refuse it with `SlotConflict`, tagged with the Plugin's `kind`, and `findSlots` skips it. No caller can relax it. Busy time may overlap other busy time, from the same Plugin or another. `list` is a function over a range, so it can come from a table, as here, or be computed. Blocks are busy time.
- **A Policy** means *you're not supposed to then*. It runs after the Invariants, like yours, and the caller can relax it by name, see it in `waived`, and get the same answer from `findSlots`. Opening hours are a Policy: `availability()`'s. A Plugin Policy applies to `"book"`, `"reschedule"` or `"cancel"`, never to Transition edges, since a Plugin can't know your Statuses. It runs before your own Policies, in Plugin order.

**`conflicts()`.** Busy time stops new Bookings from landing on it, but nothing stops busy time from landing on an existing Booking except the Plugin itself. Inside `lock`, `conflicts({ start, end })` returns the blocking Bookings in that range, under the Resource Lock; `blocks.create` and `holidays.add` refuse with `SlotConflict` when it isn't empty.

> **A Plugin that writes busy time without calling `conflicts()` can overlap a Booking**, and fasti won't notice: no database constraint spans the two tables. Check that a Plugin you install does it.

**Tables.**

- Every record has a fasti-owned `id` (a UUIDv7, branded per table: `RecordId<"holiday">`, so a holiday id can't pass for a Block's) and `resourceId`. A `timed: true` table also gets `start` and `end`, and `list` takes `overlapping` (half-open), sorted by start, then id. An untimed one is listed by Resource only, sorted by id.
- Column kinds: `text`, `uuid`, `integer`, `boolean`, `instant`, and for Plugins `date` (`Temporal.PlainDate`), `time` (`Temporal.PlainTime`), `json<T>()` and `dates` (a list of `PlainDate`). An optional column is `null` when unset, and `insert` takes it as `null`.
- Writes exist only on the `records` inside `lock`; the `records` an Action gets outside it only read. Reads inside `lock` see the unit's own writes.
- With plain async functions, `records` inside `lock` can `insert`; `update` (compare-and-set), `delete` and `replace` are on the native, Effect API only for now.
- `tx` inside `lock` is your Adapter's transaction, as `unknown`: an escape hatch for a query the generic verbs don't offer, which ties the Plugin to that ORM.
- Rename a Plugin table and its columns under `names`, by logical name: `names.tables.holiday`, `names.columns.holiday`.

**Actions.**

- `kind: "write"` Actions write through `lock(resourceId, work)`. `work` returns `Done` (a `value`, and the `context` that `also` and the Hooks get), `NoOp` (nothing changed: no `also`, no Hooks) or `Failed` (a typed `error`; the unit rolls back). The caller's `also`, the Hooks, the retries and `now` work exactly as on `book`. Return what `lock` returns, or `fail(error)` to refuse before taking the lock.
- `kind: "read"` Actions get `records` and no lock, and return `ok(value)` or `fail(error)`. They run no `also` and no Hooks.
- An Action's errors are its own typed ones, plus `Vetoed` (from `also`) and `AdapterError`. A throw is a bug: the unit rolls back and the promise rejects.
- `run` gets a `signal` too, aborted when an Effect caller interrupts: a unit then rolls back, but your code between `lock` calls runs on.

**Hooks.** A Plugin Hook applies to `"book"`, `"reschedule"`, `"cancel"`, its own write Actions (`"holidays.add"`), or `"*"`, which also covers Transitions. Narrow on `event.action` to read the Action's context. An in-transaction Hook gets `records` with writes on the unit, so it writes atomically on every Adapter. Your own `defineHook` can target any installed Plugin's write Actions, and `"*"` includes them.

**Names.** Plugin names, table names and Policy names must each be unique. A Plugin can't take a scheduler key (`book`, `cancel`, `findSlots`, …), a table can't be called `booking`, and a column can't be `id`, `resourceId`, `start` or `end`. A clash is a type error, and throws in `defineSchema` (Policies: in `createScheduler`).

**Natively, in Effect.** `definePlugin` from `@fastijs/scheduler/effect` takes the same definition with Effects instead of Promises: `run`, `work`, `load` and `list` return Effects, `lock` is an Effect, and expected failures go through `Effect.fail`. Nothing crosses between Promises and Effect, so services, cancellation and typed errors flow straight through. `availability()` and `blocks()` are written this way. Both styles build the same Plugin value, and its Actions appear in both scheduler forms.

```typescript
import { definePlugin } from "@fastijs/scheduler/effect";

lock(params.resourceId, ({ conflicts, records }) =>
  Effect.gen(function* () {
    const hits = yield* conflicts(params);
    if (hits.length > 0) return yield* Effect.fail({ _tag: "SlotConflict", conflicts: hits } as const);
    const holiday = yield* records.holiday.insert(params);
    return { _tag: "Done", context: { holiday }, value: holiday } as const;
  })
);
```

### Migrating from `0.6`

The tables don't change, so there is no database migration: `availability()` and `blocks()` build the same tables, columns and foreign keys as `0.6`. The code changes:

- **Opening hours are a Plugin.** Add `plugins: [availability()]` to keep `scheduler.availability`, the `availability` Policy and `relax: ["availability"]`. Without it, everything outside Bookings and busy time is bookable.
- **`block: { fields }` becomes `blocks({ fields })`** in `plugins`. `scheduler.blocks`, `kind: "block"` and the `blocks.*` Hook targets stay.
- **Drizzle:** `blockTable(schema)` and `availabilityRuleTable(schema)` become `recordTables(schema).block` and `.availabilityRule` (same `references` option). The old names still work in `0.7`, deprecated.
- **Custom Adapters:** replace `getRules`, `replaceRules` and the Block verbs with the [`records` group](#writing-a-custom-adapter), and `"blocks"` with `"records"` in `Adapter<Tx, …>`.
- **Policies:** `load`'s `reads` no longer has `getRules` or `listBlocks`, and nothing replaces them yet: a Plugin's Policies read only its own tables. If yours read rules or Blocks, read them through your own database in `also` meanwhile.
- **`definePolicy`** no longer reserves the name `availability`; names are unique across your Policies and the installed Plugins'.
- **The Conformance Suite** runs the Blocks cases when your test schema installs `blocks()`, the rule cases (new tag `availability`) when it installs `availability()`, and the new `records` cases when it installs `conformancePlugin`. Rules used to be tested on every schema.

## Not yet

These are planned (see the [roadmap](./ROADMAP.md)):

- `getBooking` and `listBookings` Actions; read through your own database meanwhile.

## The Core

The Actions are built on the Core: pure functions over rules and Bookings you pass in. Use them directly when you keep Bookings yourself.

### Concepts

#### Primitives

- **`AvailabilityRule`** — Abstract rule defining when a resource is available (e.g. "Tuesdays 09:00–17:00 Europe/Lisbon"). Always scoped to a single `resourceId`.
- **`Booking`** — An existing reservation that occupies a resource. The required `isBlocking` flag controls whether it consumes the slot.
- **`Slot`** — A candidate time window returned by the engine, with zoned start/end.
- **`ExpandedWindow`** — One concrete application of one rule on one calendar date (output of `expandRules`).

#### Functions

| Function           | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `findFreeSlots`    | Enumerate available slots for a single resource               |
| `isSlotValid`      | Validate whether a specific slot is free for a resource       |
| `detectConflicts`  | Find overlapping blocking bookings for a candidate            |
| `expandRules`      | Expand abstract rules into concrete `ExpandedWindow`s         |
| `withBlockingFlag` | Set the required `isBlocking` on bookings from their `status` |
| `checkRule`        | Check one `AvailabilityRule` on its own, e.g. before saving it |

Every function except `checkRule` returns a `Result`: `{ ok: true, value }`, or `{ ok: false, error }` where `error` is an `InvalidParams` listing every problem in the input, each with a `path`. Invalid input is never thrown ([ADR 011](./docs/adr/011-effect-free-core-returns-results.md)). `checkRule` returns the issue list directly, empty when the rule is valid.

### Usage

```typescript
import {
  checkRule,
  findFreeSlots,
  isSlotValid,
  withBlockingFlag,
} from "@fastijs/scheduler/core";
import type { AvailabilityRule } from "@fastijs/scheduler/core";

const rule: AvailabilityRule = {
  resourceId: "doc-1",
  recurrence: {
    frequency: "weekly",
    interval: 1,
    daysOfWeek: [2, 4], // Tuesday, Thursday
  },
  timeWindow: {
    start: Temporal.PlainTime.from("09:00"),
    end: Temporal.PlainTime.from("17:00"),
  },
  timezone: "Europe/Lisbon",
};

// Check a rule before you store it.
const ruleIssues = checkRule(rule); // [] when valid

// Map your own statuses to the required `isBlocking` flag.
const flagged = withBlockingFlag(rawBookings, {
  blocking: ["CONFIRMED"],
  nonBlocking: ["CANCELLED"],
  default: "blocking", // for any other status
});
if (!flagged.ok) throw new Error(flagged.error.issues[0].message);

const result = findFreeSlots({
  resourceId: "doc-1",
  rules: [rule],
  bookings: flagged.value,
  duration: 30, // minutes
  from: Temporal.Instant.from("2026-06-01T00:00:00Z"),
  to: Temporal.Instant.from("2026-07-01T00:00:00Z"), // slots start in [from, to)
  interval: 15, // required: grid step in minutes, from local midnight in `timezone`
  timezone: "Europe/Lisbon", // required: anchors the grid and zones the returned slots
});

if (result.ok) {
  for (const slot of result.value) {
    console.log(slot.start.toString(), slot.waived); // waived is [] here
  }
} else {
  for (const issue of result.error.issues) {
    console.error(issue.path, issue.message);
  }
}
```

#### Relaxing availability

Pass `relax: ["availability"]` to also get Grid slots outside the rules. Each one is tagged in `waived`, so you can show it as "outside hours". Overlap with a blocking Booking is never relaxed ([ADR 014](./docs/adr/014-invariants-and-relaxable-policies.md)).

```typescript
const all = findFreeSlots({ ...params, relax: ["availability"] });
// all.value[i].waived: [] or [{ policy: "availability", detail: {} }]
```

#### Rescheduling

`findFreeSlots`, `isSlotValid` and `detectConflicts` take `excludeBookingId`, which leaves one Booking out of the overlap check, so a Booking doesn't conflict with itself when you move it.

```typescript
const canMove = isSlotValid({
  resourceId: "doc-1",
  slot: { start: newStart, end: newEnd },
  rules: [rule],
  bookings,
  excludeBookingId: booking.id,
}); // { ok: true, value: true } when the new time is free
```

#### Migrating from `0.1.0-next.0`

`0.1.0-next.1` breaks every `0.1.0-next.0` call:

- **Results instead of throws.** Every function except `checkRule` returns `{ ok, value | error }` instead of the bare value, and reports invalid input as `InvalidParams` instead of throwing. `withBlockingFlag` also returns a `Result`, and reports a status listed as both blocking and non-blocking.
- **`findFreeSlots` options.** `options` is gone. `interval` and `timezone` are now required top-level params; `interval` no longer defaults to `duration`. `allowEndOverflow` is removed.
- **One Grid per query.** Slot starts are local midnight in `timezone` plus whole `interval`s, whatever rules produced them. A rule starting off the Grid (09:10 on a 15-minute Grid) gets its first slot at the next Grid time (09:15), not at 09:10. Slots are zoned in the query `timezone`.
- **`Slot.waived`.** Every slot carries `waived`, empty unless you pass `relax`.
- **New:** `checkRule`, `relax`, `excludeBookingId`, and the exported types `Result`, `InvalidParams`, `Issue`, `Recurrence`, `BookingId`, `CorePolicy` and `CoreViolations`. `Booking<Id>` keeps a branded id type through every function.

Stored `AvailabilityRule` and `Booking` data keeps the same shape.

#### DST behavior

- **Spring-forward gap** — slots whose wall-clock start falls in the missing hour are dropped.
- **Fall-back overlap** — only the first occurrence of an ambiguous wall-clock time is emitted.

See [ADR 005](./docs/adr/005-dst-policy.md) for the rationale.

## Storage

### Defining your schema

`defineSchema` is the one place you name your tables, columns and stored Status values, pick the Resource id type, declare Developer Fields and install [Plugins](#plugins). Every option has a default.

```typescript
import { column, defineSchema } from "@fastijs/scheduler";

type StaffId = number & { readonly __brand: "StaffId" };

export const schema = defineSchema({
  resource: { idType: column.integer<StaffId>() },
  booking: {
    fields: { customerId: { type: column.uuid(), required: true } },
  },
  plugins: [availability()],
  names: {
    tables: { booking: "appointments", availabilityRule: "hours" }, // Plugin tables by logical name
    columns: { booking: { start: "starts_at", end: "ends_at" } },
    statuses: { booked: "CONFIRMED", cancelled: "CANCELLED" },
  },
});
```

### Drizzle on Postgres

Build your tables from the schema and let your own drizzle-kit migrate them; fasti never runs DDL. `references` adds a foreign key to your own Resource table.

```typescript
import { pgTable, integer } from "drizzle-orm/pg-core";
import {
  bookingTable,
  drizzleAdapter,
  recordTables,
} from "@fastijs/scheduler/drizzle/pg";

export const staff = pgTable("staff", { id: integer().primaryKey() });
export const appointments = bookingTable(schema, { references: () => staff.id });
// One Drizzle table per Plugin table, by logical name: here `availabilityRule`.
export const { availabilityRule } = recordTables(schema, { references: () => staff.id });

const adapter = drizzleAdapter(db);
```

**The backstop.** `backstopSql(schema)` returns the statements for an `EXCLUDE` constraint so no two blocking Bookings overlap on one Resource, even when a write skips fasti's lock. Drizzle can't express `EXCLUDE`, so add it as a custom migration after the one that creates the tables:

```bash
npx drizzle-kit generate --custom --name=fasti-backstop
```

Then paste each statement from `backstopSql(schema)` into the generated file, separated by `--> statement-breakpoint`. drizzle-kit doesn't know about this constraint: later generated migrations neither include nor drop it. If you rename the Booking table, its columns or a blocking Status, or add, remove or flip a blocking Status, drop the old constraint and add the new statements from `backstopSql(schema)` in a new custom migration. Declared Statuses also change the `CHECK` constraint on `status`, which drizzle-kit generates for you. The constraint assumes a capacity of one Booking per Resource at a time.

### Drizzle on SQLite

The same names and shapes as `drizzle/pg`, so moving between the two is an import change. Instants are stored as integer milliseconds, Plugin `date` and `time` columns as ISO text, `json` and `dates` columns as JSON text, and Status as `text` with a `CHECK` over its stored values.

```typescript
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import {
  bookingTable,
  drizzleAdapter,
  recordTables,
} from "@fastijs/scheduler/drizzle/sqlite";

export const staff = sqliteTable("staff", { id: integer().primaryKey() });
export const appointments = bookingTable(schema, { references: () => staff.id });
export const { availabilityRule } = recordTables(schema, { references: () => staff.id });

const db = drizzle({ client: createClient({ url: "file:app.db" }) });
const adapter = drizzleAdapter(db);
```

- **The lock is the whole database.** Units on one `db` run one after another, each inside `BEGIN IMMEDIATE`, so writes to different Resources take turns. Waiting never blocks the event loop.
- **One writer process per file.** Another process writing to the same file makes units fail with `SQLITE_BUSY` instead of waiting. Cross-process writes wait on a libsql fix ([#142](https://github.com/duarteplesteves/fasti/issues/142)).
- **File databases only.** `:memory:` and embedded replicas get a single connection, so a read during a unit of work fails. Turso isn't tested.
- **Leave libsql's `timeout` unset.** A busy timeout blocks Node's event loop while it waits.
- **Use WAL** (`PRAGMA journal_mode = WAL`, once, in your own setup). fasti never runs it (ADR 007).
- **Foreign keys** from `references` are enforced only with `PRAGMA foreign_keys = ON` on each connection.
- **No backstop.** SQLite has no `EXCLUDE` constraint, so a write to the bookings table outside fasti isn't caught by the database.
- **Async drivers only.** A database on better-sqlite3, `node:sqlite` or `bun:sqlite` is a type error: their transactions can't stay open across an `await`. Switch to libsql: a different `drizzle(…)` import and client, with the same file, tables and queries. Sync drivers are on the [roadmap](./ROADMAP.md#beyond-the-framework).

### Prisma on Postgres

Experimental while Prisma 8 is a release candidate. Postgres only. Spread `prismaModels` into your contract and let Prisma's tooling create the tables; fasti never runs DDL. It includes a model for every Plugin table.

```typescript
import { defineContract } from "@prisma/orm-postgres/contract-builder";
import postgres from "@prisma/orm-postgres/runtime";
import { prismaAdapter, prismaModels } from "@fastijs/scheduler/prisma";

export const contract = defineContract({}, (helpers) => {
  const staff = helpers
    .model("staff", {
      fields: { id: helpers.field.column(helpers.type.Int()).id() },
    })
    .sql({ table: "staff" });

  return {
    models: {
      staff,
      ...prismaModels(schema, helpers, { references: { model: staff, field: "id" } }),
    },
  };
});

const db = postgres({ contract, url: process.env.DATABASE_URL });
const adapter = prismaAdapter(db);
```

It takes the same advisory lock as the Drizzle Postgres Adapter, so units through either Adapter on one Resource exclude each other. A unit that fails with a serialization failure or deadlock reruns whole, `also` included, up to 3 attempts. `tx` is Prisma's own transaction.

**The backstop.** Prisma can't express `EXCLUDE` either: create a raw SQL migration with `prisma migration new` and paste the statements from `backstopSql(schema)`. The same rules as on [Drizzle](#drizzle-on-postgres) apply when you rename or change blocking Statuses.

### Writing a custom Adapter

If your tables differ from fasti's by more than names, write your own Adapter against the contract in `@fastijs/scheduler/adapter` ([ADR 008](./docs/adr/008-adapter-contract.md)). It is a few `async` verbs over whole records, plus `withResourceLock`, which runs a unit of work in one transaction that excludes every other locked unit on the same Resource. Writes exist only on the handle passed into that unit of work. A sketch, with the bodies left out:

```typescript
import { defineAdapter } from "@fastijs/scheduler/adapter";

export const myAdapter = defineAdapter<MyTx, "records">((schema) => ({
  getBooking: async (id) => /* BookingRecord | null */,
  listBookings: async ({ resourceId, overlapping }) => /* sorted by start, then id */,
  // The "records" group: every Plugin table, by logical name (schema.tables).
  getRecord: async (table, id) => /* StoredRecord | null */,
  listRecords: async (table, { resourceId, overlapping }) => /* timed: by start, then id; untimed: by id */,
  withResourceLock: async (resourceId, work) =>
    db.transaction(async (tx) => {
      await lock(tx, resourceId);
      return work({
        tx,
        getBooking, listBookings, getRecord, listRecords, // the same reads, through tx
        insertBooking: async (booking) => /* { ok: true } or { ok: false, reason: "conflict" } */,
        updateBooking: async ({ expected, changes }) => /* compare-and-set; "changed" if the row moved on */,
        insertRecord: async (table, record) => { /* fasti minted record.id */ },
        updateRecord: async (table, { expected, changes }) => /* compare-and-set; "changed" */,
        deleteRecord: async (table, id) => /* { ok: true } or { ok: false, reason: "missing" } */,
        replaceRecords: async (table, { resourceId, records }) => { /* replace that Resource's rows */ },
      });
    }),
}));
```

The `"records"` group stores every Plugin's tables, present and future, so you write it once. A schema whose Plugins declare tables (`availability()`, `blocks()`, …) needs it, and the types enforce it; a schema with none doesn't. `schema.tables` lists each table's physical name, whether it's `timed` (fasti-owned `start` and `end`), and its columns with their kinds: `text`, `uuid`, `integer`, `boolean`, `instant`, `date` (`Temporal.PlainDate`), `time` (`Temporal.PlainTime`), `json` and `dates` (a list of `PlainDate`). Compare `json` values by content, not by key order.

Expected outcomes (`conflict`, `changed`, `missing`) are returned as values; anything else rejects with an `Error`, carrying your driver's error as `cause` when the driver failed. Records use logical names (`start`, `"booked"`); map them to your columns and stored values inside the Adapter.

### Running the Conformance Suite

Prove your Adapter with `testAdapter` in a Vitest file, against a real database:

```typescript
import { testAdapter } from "@fastijs/scheduler/testing";

testAdapter({
  schema,
  makeAdapter: () => myAdapter, // called per case; must allow 20 concurrent units of work
  reset: async () => {
    /* empty the fasti tables; keep your Resource rows */
  },
  resources: [staffA, staffB], // two Resource ids that exist in your database
  groups: {
    backstop: false, // true only if your database has a constraint like backstopSql
    // Proves writes through `tx` share fasti's unit of work; null if your `tx` is no transaction.
    tx: {
      write: async (tx) => { /* insert one row in a table of your own through tx */ },
      count: async () => { /* count those rows, outside any transaction */ },
    },
    // A value your Adapter retries as transient, e.g. a serialization failure; null if it never retries.
    retry: { transient: () => ({ code: "40001" }) },
  },
});
```

It registers one test per case, including the concurrency cases that catch a missing or broken lock, the `records` cases (round-trips of every column kind, half-open `overlapping`, compare-and-set, rollback) when your test schema installs `conformancePlugin` from `@fastijs/scheduler/testing` (do, if you implement `"records"`), the Blocks and availability cases when it installs `blocks()` and `availability()`, and the Hook cases that prove an in-transaction Hook's throw rolls the write back and a transient retry runs after-commit Hooks once. To run a subset, filter `conformanceCases` by `tags` and call `runCase` yourself.

## Architecture Decisions

See the [decision record](./docs/adr/) for detailed ADRs on primitives, date handling, and API shape.

## Development

```bash
# Install dependencies
bun install

# Lint and format check
bun run check

# Type-check (including tests)
bun run typecheck

# Run tests
bun run test

# Build, then check the published package
bun run build
bun run publint
bun run attw
```

## License

MIT
