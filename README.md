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
| `@fastijs/scheduler`            | `createScheduler`, `defineSchema`, the `column` helpers and the error types.            |
| `@fastijs/scheduler/effect`     | `Scheduler`, the Effect form of the Actions.                                            |
| `@fastijs/scheduler/drizzle/pg` | `drizzleAdapter`, the table builders and `backstopSql` (needs `drizzle-orm` 1.0 RC.5+). |
| `@fastijs/scheduler/memory`     | `memoryAdapter`, for tests and prototypes.                                              |
| `@fastijs/scheduler/adapter`    | The Adapter contract types and `defineAdapter`, for writing your own Adapter.           |
| `@fastijs/scheduler/testing`    | `testAdapter`, the Conformance Suite every Adapter must pass (needs `vitest`).          |
| `@fastijs/scheduler/core`       | The Core: the stateless functions under [The Core](#the-core). No runtime dependencies. |

fasti uses the global `Temporal` (Node.js 26+, Bun 1.4+). On runtimes without native Temporal, install a global polyfill before importing the package.


## Quickstart

The full, runnable version is [`examples/basic`](./examples/basic), which CI runs against Postgres on every push.

**1. Define your schema and tables.** `defineSchema` names your tables, columns and Statuses and declares your Developer Fields: your own columns on each Booking. Every option has a default; see [Defining your schema](#defining-your-schema).

```typescript
import { column, createScheduler, defineSchema } from "@fastijs/scheduler";
import {
  availabilityRuleTable,
  bookingTable,
  drizzleAdapter,
} from "@fastijs/scheduler/drizzle/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export const schema = defineSchema({
  booking: {
    fields: { customerName: { required: true, type: column.text() } },
  },
});

export const tables = {
  availabilityRule: availabilityRuleTable(schema),
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
    case "PolicyViolation": // outside availability
    case "InvalidParams": // result.error.issues, each with a `path`
    case "AdapterError": // the database failed; result.error.cause
  }
} else {
  await scheduler.cancel({ id: result.value.id });
}
```

| Action             | Value                                    | Errors (`_tag`)                                                       |
| ------------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| `book`             | the `Booking`, `status: "booked"`        | `InvalidParams`, `SlotConflict`, `PolicyViolation`, `AdapterError`    |
| `cancel`           | `{ booking, alreadyCancelled }`          | `BookingNotFound`, `AdapterError`                                     |
| `findSlots`        | `Slot[]`, zoned in `timezone`            | `InvalidParams`, `AdapterError`                                       |
| `availability.set` | `{ rules }`, replacing the whole set     | `InvalidParams`, `AdapterError`                                       |
| `availability.get` | the stored rules                         | `AdapterError`                                                        |

- An overlap is checked before availability, so an overlapping Booking outside hours is a `SlotConflict` alone ([ADR 014](./docs/adr/014-invariants-and-relaxable-policies.md)).
- Domain errors are plain objects with no `message`, safe to send to a client as JSON. `AdapterError` is an `Error` whose `cause` is your driver's error ([ADR 010](./docs/adr/010-action-results-and-two-forms.md)).
- `cancel` is idempotent. `book` is not: each call mints a new id, so dedupe retries in your backend.

## Effect

The same Actions, with the same params, values and errors, as Effects. Declare your own service class and provide its `layer`:

```typescript
import { Scheduler } from "@fastijs/scheduler/effect";
import { Effect } from "effect";

class AppScheduler extends Scheduler<AppScheduler, typeof schema>()("app/Scheduler") {}

const program = Effect.gen(function* bookOne() {
  const scheduler = yield* AppScheduler;

  return yield* scheduler
    .book({ end, fields: { customerName: "Ada" }, resourceId: "room-1", start })
    .pipe(Effect.catchTag("SlotConflict", (error) => Effect.succeed(error.conflicts)));
});

await Effect.runPromise(
  program.pipe(Effect.provide(AppScheduler.layer({ adapter: drizzleAdapter(db), schema })))
);
```

Expected failures go to the error channel, tagged for `Effect.catchTag`; a bug in fasti dies. Interrupting the fiber doesn't cancel a unit of work already running in the Adapter: it finishes, then commits or rolls back.

## Blocks

A Block makes a Resource unbookable for a while: a vacation, a lunch, a meeting. It is its own entity, not a kind of Booking, with its own Developer Fields and no Status: you create, change and delete it ([ADR 016](./docs/adr/016-block-is-its-own-entity.md)).

**Declare it in the schema.** Blocks are opt-in: `block` turns them on, with its Developer Fields (`fields: {}` for none). A schema without `block` has no Block table and no `scheduler.blocks`.

```typescript
export const schema = defineSchema({
  block: { fields: { reason: { required: true, type: column.text() } } },
  booking: {
    fields: { customerName: { required: true, type: column.text() } },
  },
});

export const tables = {
  availabilityRule: availabilityRuleTable(schema),
  block: blockTable(schema), // from @fastijs/scheduler/drizzle/pg; takes `references` like the others
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
    conflict.kind; // "booking" | "block": narrow on it; conflict.id is a BookingId or a BlockId
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
- The overlap check runs both ways, under the Resource Lock: `book` refuses a slot over a Block, and `blocks.create` or `blocks.update` refuse a range over a blocking Booking. Both are a `SlotConflict`, whose items carry `kind: "booking" | "block"` with ids and times only. Like the Booking overlap, it can't be relaxed.
- Blocks may overlap each other, and no Policy applies to their writes: a Block outside availability is fine.
- The Effect form has the same `blocks` Actions; failures are tagged for `Effect.catchTag`.

**Writes outside fasti.** The [backstop](#drizzle-on-postgres) `EXCLUDE` constraint works within one table, so no database constraint stops a Booking from overlapping a Block. fasti's lock keeps its own Actions safe, but a row you write to either table yourself can create a Booking/Block overlap that nothing catches. A later `blocks.update` that changes only `fields` doesn't re-check, so such an overlap stays.

**In a custom Adapter.** A schema with `block` needs an Adapter that implements the Block verb group, and the types enforce it: declare it as `Adapter<Tx, "blocks">` (or `defineAdapter<Tx, "blocks">`) and add `getBlock` and `listBlocks` to the reads, and `insertBlock`, `updateBlock` (compare-and-set, `"changed"`) and `deleteBlock` (`"missing"`) to the locked handle. See [Writing a custom Adapter](#writing-a-custom-adapter). `testAdapter` runs the Conformance Suite's Blocks cases whenever your schema declares `block`.

## Your writes in the same transaction (`also`)

Every write Action (`book`, `cancel`, `availability.set`, `blocks.create`, `blocks.update`, `blocks.delete`) takes an optional `also`. fasti calls it after its own write, on the same unit of work, with the Adapter's `tx` and the Clock's `now` ([ADR 015](./docs/adr/015-developer-writes-inside-the-action-transaction.md)):

```ts
const result = await scheduler.book({
  resourceId,
  start,
  end,
  also: async ({ tx, booking }) => {
    await tx.insert(auditLog).values({ bookingId: booking.id });
    return { ok: true, value: "logged" };
  },
});
// result.value is the Booking plus `also: "logged"`.
```

- `also` may be sync or async, and returns a `Result`. Its `value` comes back on the Action's value as `also` (a `blocks.delete` value is `{ also }`).
- Returning `{ ok: false, error }` vetoes: everything rolls back, fasti's write included, and the Action fails with `{ _tag: "Vetoed", reason: error }`. A throw also rolls back, and the promise rejects with what was thrown.
- Write only through `tx`: anything else isn't part of the unit and won't roll back. On the memory Adapter `tx` is `undefined`.
- `also` may run more than once. The Drizzle Adapter reruns the whole unit, `also` included, when it fails with a deadlock or a serialization failure (`40P01`, `40001`), up to 3 attempts. When they run out, it fails as on the last attempt: an `AdapterError` if fasti's write failed, a rejection if `also` threw. Another reason to write only through `tx`.
- What each Action passes, besides `tx` and `now`: `book` gets `booking`; `cancel` gets `booking` and `previous`; `availability.set` gets `rules` and `previous`; `blocks.create` gets `block`; `blocks.update` gets `block` and `previous`; `blocks.delete` gets `previous`.
- `also` runs only when something changed. A repeat `cancel` writes nothing, skips `also`, and its value (`alreadyCancelled: true`) has no `also` key. A `blocks.update` that changes nothing still runs it, with `block === previous`.

## Not yet

`0.1.0` books and cancels. These are planned (see the [roadmap](./ROADMAP.md)):

- `reschedule` and Status Transitions beyond `booked` and `cancelled`.
- Policies beyond availability, `relax` on the Actions, and `notice` (past starts are bookable today).
- `getBooking` and `listBookings` Actions; read through your own database meanwhile.
- Retrying transient database errors.

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

`defineSchema` is the one place you name your tables, columns and stored Status values, pick the Resource id type and declare Developer Fields. Every option has a default.

```typescript
import { column, defineSchema } from "@fastijs/scheduler";

type StaffId = number & { readonly __brand: "StaffId" };

export const schema = defineSchema({
  resource: { idType: column.integer<StaffId>() },
  booking: {
    fields: { customerId: { type: column.uuid(), required: true } },
  },
  names: {
    tables: { booking: "appointments" },
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
  availabilityRuleTable,
  bookingTable,
  drizzleAdapter,
} from "@fastijs/scheduler/drizzle/pg";

export const staff = pgTable("staff", { id: integer().primaryKey() });
export const appointments = bookingTable(schema, { references: () => staff.id });
export const hours = availabilityRuleTable(schema, { references: () => staff.id });

const adapter = drizzleAdapter(db);
```

**The backstop.** `backstopSql(schema)` returns the statements for an `EXCLUDE` constraint so no two blocking Bookings overlap on one Resource, even when a write skips fasti's lock. Drizzle can't express `EXCLUDE`, so add it as a custom migration after the one that creates the tables:

```bash
npx drizzle-kit generate --custom --name=fasti-backstop
```

Then paste each statement from `backstopSql(schema)` into the generated file, separated by `--> statement-breakpoint`. drizzle-kit doesn't know about this constraint: later generated migrations neither include nor drop it. If you rename the Booking table, its columns or a blocking Status, drop the old constraint and add a new one yourself. The constraint assumes a capacity of one Booking per Resource at a time.

### Writing a custom Adapter

If your tables differ from fasti's by more than names, write your own Adapter against the contract in `@fastijs/scheduler/adapter` ([ADR 008](./docs/adr/008-adapter-contract.md)). It is a few `async` verbs over whole records, plus `withResourceLock`, which runs a unit of work in one transaction that excludes every other locked unit on the same Resource. Writes exist only on the handle passed into that unit of work. A sketch, with the bodies left out:

```typescript
import { defineAdapter } from "@fastijs/scheduler/adapter";

export const myAdapter = defineAdapter<MyTx>((schema) => ({
  getBooking: async (id) => /* BookingRecord | null */,
  listBookings: async ({ resourceId, overlapping }) => /* sorted by start, then id */,
  getRules: async (resourceId) => /* RuleRecord[] */,
  withResourceLock: async (resourceId, work) =>
    db.transaction(async (tx) => {
      await lock(tx, resourceId);
      return work({
        tx,
        getBooking, listBookings, getRules, // the same reads, through tx
        insertBooking: async (booking) => /* { ok: true } or { ok: false, reason: "conflict" } */,
        updateBooking: async ({ expected, changes }) => /* compare-and-set; "changed" if the row moved on */,
        replaceRules: async ({ resourceId, rules }) => { /* replace the whole set */ },
        // With `defineAdapter<MyTx, "blocks">`: getBlock and listBlocks here and above, plus insertBlock, updateBlock, deleteBlock.
      });
    }),
}));
```

Expected outcomes (`conflict`, `changed`) are returned as values; anything else rejects with an `Error`, carrying your driver's error as `cause` when the driver failed. Records use logical names (`start`, `"booked"`); map them to your columns and stored values inside the Adapter.

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
  },
});
```

It registers one test per case, including the concurrency cases that catch a missing or broken lock. To run a subset, filter `conformanceCases` by `tags` and call `runCase` yourself.

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
