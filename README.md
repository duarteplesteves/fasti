# better-schedule

A type-safe, stateless scheduling engine for TypeScript.

## Philosophy

- **Stateless pure functions** — You bring the data; the engine does the math.
- **Framework-agnostic** — Works in Node.js, Bun, Deno, and the browser.
- **Storage-agnostic** — Bring your own database, ORM, and persistence layer.
- **Temporal-native** — Built on the [Temporal API](https://tc39.es/proposal-temporal/docs/) for unambiguous date/time handling.

## Installation

```bash
npm install better-schedule @js-temporal/polyfill
# or
bun add better-schedule @js-temporal/polyfill
```

`@js-temporal/polyfill` is a peer dependency. It's required until TC39 Temporal lands in every runtime the package targets.

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
import { Temporal } from "@js-temporal/polyfill";
import { findFreeSlots, withBlockingFlag } from "better-schedule";

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

# Type-check
bun run check

# Run tests
bun run test

# Build
bun run build
```

## License

MIT
