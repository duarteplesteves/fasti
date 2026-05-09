# better-schedule

A type-safe, stateless scheduling engine for TypeScript.

## Philosophy

- **Stateless pure functions** — You bring the data; the engine does the math.
- **Framework-agnostic** — Works in Node.js, Bun, Deno, and the browser.
- **Storage-agnostic** — Bring your own database, ORM, and persistence layer.
- **Temporal-native** — Built on the [Temporal API](https://tc39.es/proposal-temporal/docs/) for unambiguous date/time handling.

## Installation

```bash
npm install better-schedule
# or
bun add better-schedule
```

## Core Concepts

### Primitives

- **`Resource`** — Anything that can be booked (a person, room, machine, etc.).
- **`AvailabilityRule`** — Abstract rule defining when a resource is available (e.g. "Tuesdays 09:00–17:00 Europe/Lisbon").
- **`Booking`** — An existing reservation that occupies a resource.
- **`Slot`** — A candidate time window returned by the engine.

### Functions (v0.1)

| Function          | Purpose                                     |
| ----------------- | ------------------------------------------- |
| `findFreeSlots`   | Enumerate available slots for booking       |
| `isSlotValid`     | Validate whether a specific slot is free    |
| `detectConflicts` | Find overlapping bookings for a candidate   |
| `expandRules`     | Expand abstract rules into concrete windows |

## Usage

```typescript
import { Temporal, } from "@js-temporal/polyfill";
import { findFreeSlots, } from "better-schedule/core";

const slots = findFreeSlots({
  rules: [
    {
      resourceId: "doc-1",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        daysOfWeek: [2, 4,], // Tuesday, Thursday
      },
      timeWindow: {
        start: Temporal.PlainTime.from("09:00",),
        end: Temporal.PlainTime.from("17:00",),
      },
      timezone: "Europe/Lisbon",
    },
  ],
  bookings: [],
  duration: 30,
  from: Temporal.Instant.from("2026-06-01T00:00:00Z",),
  to: Temporal.Instant.from("2026-06-30T23:59:59Z",),
},);
```

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
