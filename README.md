# fasti

A type-safe, stateless scheduling engine for TypeScript.

## Philosophy

- **Stateless pure functions** — You bring the data; the engine does the math.
- **Framework-agnostic** — Works in Node.js, Bun, Deno, and the browser.
- **Storage-agnostic** — Bring your own database, ORM, and persistence layer.
- **Temporal-native** — Built on the [Temporal API](https://tc39.es/proposal-temporal/docs/) for unambiguous date/time handling.

## Installation

```bash
npm install @fastijs/scheduler@next
# or
bun add @fastijs/scheduler@next
```

> **Prerelease.** Until `0.1.0` ships, every published version is an internal `0.1.0-next.N` prerelease, and npm's `latest` tag points at one of them. Expect breaking changes between them. See the [roadmap](./ROADMAP.md).

One package, several entry points:

| Import                         | What it holds                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `@fastijs/scheduler/core`      | The Core: the stateless functions below. No runtime dependencies.                     |
| `@fastijs/scheduler`           | `defineSchema` and the `column` helpers: your names, Resource id type and fields.     |
| `@fastijs/scheduler/adapter`   | The Adapter contract types and `defineAdapter`, for writing your own Adapter.         |
| `@fastijs/scheduler/memory`    | `memoryAdapter`, for tests and prototypes.                                            |
| `@fastijs/scheduler/drizzle/pg` | `drizzleAdapter`, the table builders and `backstopSql` (needs `drizzle-orm` 1.0 RC.5+). |
| `@fastijs/scheduler/testing`   | `testAdapter`, the Conformance Suite every Adapter must pass (needs `vitest`).         |

> **The Framework isn't there yet.** `createScheduler` and its Actions (booking, cancelling, rescheduling) arrive in a later checkpoint. Today the storage entry points give you the schema, the Adapters and the suite that proves them; nothing calls an Adapter for you yet. See the [roadmap](./ROADMAP.md).

fasti uses the global `Temporal` (Node.js 26+, Bun 1.4+). On runtimes without native Temporal, install a global polyfill before importing the package.

## Core Concepts

### Primitives

- **`AvailabilityRule`** — Abstract rule defining when a resource is available (e.g. "Tuesdays 09:00–17:00 Europe/Lisbon"). Always scoped to a single `resourceId`.
- **`Booking`** — An existing reservation that occupies a resource. The required `isBlocking` flag controls whether it consumes the slot.
- **`Slot`** — A candidate time window returned by the engine, with zoned start/end.
- **`ExpandedWindow`** — One concrete application of one rule on one calendar date (output of `expandRules`).

### Functions (v0.1)

| Function           | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `findFreeSlots`    | Enumerate available slots for a single resource               |
| `isSlotValid`      | Validate whether a specific slot is free for a resource       |
| `detectConflicts`  | Find overlapping blocking bookings for a candidate            |
| `expandRules`      | Expand abstract rules into concrete `ExpandedWindow`s         |
| `withBlockingFlag` | Set the required `isBlocking` on bookings from their `status` |
| `checkRule`        | Check one `AvailabilityRule` on its own, e.g. before saving it |

Every function except `checkRule` returns a `Result`: `{ ok: true, value }`, or `{ ok: false, error }` where `error` is an `InvalidParams` listing every problem in the input, each with a `path`. Invalid input is never thrown ([ADR 011](./docs/adr/011-effect-free-core-returns-results.md)). `checkRule` returns the issue list directly, empty when the rule is valid.

## Usage

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

### Relaxing availability

Pass `relax: ["availability"]` to also get Grid slots outside the rules. Each one is tagged in `waived`, so you can show it as "outside hours". Overlap with a blocking Booking is never relaxed ([ADR 014](./docs/adr/014-invariants-and-relaxable-policies.md)).

```typescript
const all = findFreeSlots({ ...params, relax: ["availability"] });
// all.value[i].waived: [] or [{ policy: "availability", detail: {} }]
```

### Rescheduling

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

### Migrating from `0.1.0-next.0`

`0.1.0-next.1` breaks every `0.1.0-next.0` call:

- **Results instead of throws.** Every function except `checkRule` returns `{ ok, value | error }` instead of the bare value, and reports invalid input as `InvalidParams` instead of throwing. `withBlockingFlag` also returns a `Result`, and reports a status listed as both blocking and non-blocking.
- **`findFreeSlots` options.** `options` is gone. `interval` and `timezone` are now required top-level params; `interval` no longer defaults to `duration`. `allowEndOverflow` is removed.
- **One Grid per query.** Slot starts are local midnight in `timezone` plus whole `interval`s, whatever rules produced them. A rule starting off the Grid (09:10 on a 15-minute Grid) gets its first slot at the next Grid time (09:15), not at 09:10. Slots are zoned in the query `timezone`.
- **`Slot.waived`.** Every slot carries `waived`, empty unless you pass `relax`.
- **New:** `checkRule`, `relax`, `excludeBookingId`, and the exported types `Result`, `InvalidParams`, `Issue`, `Recurrence`, `BookingId`, `CorePolicy` and `CoreViolations`. `Booking<Id>` keeps a branded id type through every function.

Stored `AvailabilityRule` and `Booking` data keeps the same shape.

### DST behavior

- **Spring-forward gap** — slots whose wall-clock start falls in the missing hour are dropped.
- **Fall-back overlap** — only the first occurrence of an ambiguous wall-clock time is emitted.

See [ADR 005](./docs/adr/005-dst-policy.md) for the rationale.

## Storage (preview)

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
  groups: { backstop: false }, // true only if your database has a constraint like backstopSql
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
