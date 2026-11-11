# fasti

A type-safe, stateless scheduling engine for TypeScript.

## Philosophy

- **Stateless pure functions** — You bring the data; the engine does the math.
- **Framework-agnostic** — Works in Node.js, Bun, Deno, and the browser.
- **Storage-agnostic** — Bring your own database, ORM, and persistence layer.
- **Temporal-native** — Built on the [Temporal API](https://tc39.es/proposal-temporal/docs/) for unambiguous date/time handling.

## Installation

```bash
npm install fasti@next
# or
bun add fasti@next
```

> **Prerelease.** Until `0.1.0` ships, every published version is an internal `0.1.0-next.N` prerelease, and npm's `latest` tag points at one of them. Expect breaking changes between them. See the [roadmap](./ROADMAP.md).

Everything is imported from `fasti/core`. The package has no root export yet.

fasti uses the global `Temporal` (Node.js 26+, Bun 1.4+). On runtimes without native Temporal, install a global polyfill before importing the package.

## Core Concepts

### Primitives

- **`AvailabilityRule`** — Abstract rule defining when a resource is available (e.g. "Tuesdays 09:00–17:00 Europe/Lisbon"). Always scoped to a single `resourceId`.
- **`Booking`** — An existing reservation that occupies a resource. The required `isBlocking` flag controls whether it consumes the slot.
- **`Slot`** — A candidate time window returned by the engine, with zoned start/end.
- **`ExpandedWindow`** — One concrete application of one rule on one calendar date (output of `expandRules`).

### Functions (v0.1)

| Function           | Purpose                                                  |
| ------------------ | -------------------------------------------------------- |
| `findFreeSlots`    | Enumerate available slots for a single resource          |
| `isSlotValid`      | Validate whether a specific slot is free for a resource  |
| `detectConflicts`  | Find overlapping blocking bookings for a candidate       |
| `expandRules`      | Expand abstract rules into concrete `ExpandedWindow`s    |
| `withBlockingFlag` | Tag a list of bookings with a default `isBlocking` value |

## Usage

```typescript
import { findFreeSlots, withBlockingFlag } from "fasti/core";

const rules = [
  {
    resourceId: "doc-1",
    recurrence: {
      frequency: "weekly" as const,
      interval: 1,
      daysOfWeek: [2, 4], // Tuesday, Thursday
    },
    timeWindow: {
      start: Temporal.PlainTime.from("09:00"),
      end: Temporal.PlainTime.from("17:00"),
    },
    timezone: "Europe/Lisbon",
  },
];

// Stamp incoming bookings (e.g. from an external source) with their blocking semantics.
const bookings = withBlockingFlag(rawBookings, { default: "blocking" });

const slots = findFreeSlots({
  resourceId: "doc-1",
  rules,
  bookings,
  duration: 30,
  from: Temporal.Instant.from("2026-06-01T00:00:00Z"),
  to: Temporal.Instant.from("2026-06-30T23:59:59Z"),
  options: {
    interval: 15, // candidate cadence in minutes (defaults to `duration`)
    allowEndOverflow: false, // drop slots whose end exceeds the window (default)
  },
});
```

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
