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

Everything is imported from `@fastijs/scheduler/core`. The package has no root export yet.

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
