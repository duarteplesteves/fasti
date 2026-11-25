# The Core

The [Actions](./actions.md) are built on the Core: pure functions over rules and Bookings you pass in. Use them directly, from `@fastijs/scheduler/core`, when you keep Bookings yourself and only want the math. They need no database and have no dependencies.

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

## Functions

| Function           | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `findFreeSlots`    | Enumerate available slots for a single resource               |
| `isSlotValid`      | Validate whether a specific slot is free for a resource       |
| `detectConflicts`  | Find overlapping blocking bookings for a candidate            |
| `expandRules`      | Expand abstract rules into concrete `ExpandedWindow`s         |
| `withBlockingFlag` | Set the required `isBlocking` on bookings from their `status` |
| `checkRule`        | Check one `AvailabilityRule` on its own, e.g. before saving it |

Every function except `checkRule` returns a `Result`: `{ ok: true, value }`, or `{ ok: false, error }` where `error` is an `InvalidParams` listing every problem in the input, each with a `path`. Invalid input is never thrown ([ADR 011](../adr/011-effect-free-core-returns-results.md)). `checkRule` returns the issue list directly, empty when the rule is valid.

| Type                   | What it is                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| **`AvailabilityRule`** | When a Resource is available, e.g. "Tuesdays 09:00–17:00 Europe/Lisbon". Scoped to one `resourceId`. |
| **`Booking`**          | A reservation on a Resource. The required `isBlocking` says whether it takes its slot.               |
| **`Slot`**             | A free window, with zoned `start` and `end`.                                                         |
| **`ExpandedWindow`**   | One rule on one calendar date: what `expandRules` returns.                                           |

The same limits apply ([ADR 019](../adr/019-bounded-work-and-a-supported-date-range.md)), exported as constants: `MAX_GRID_TIMES` per `findFreeSlots` search, `MAX_DURATION_MINUTES`, `MAX_EXPAND_DAYS` per `expandRules` call, `MAX_RULES` and `MAX_EXCEPTIONS` per rule. Every date must fall in the years 0001–9999.

## Relaxing availability

Pass `relax: ["availability"]` to also get Grid slots outside the rules. Each one is tagged in `waived`, so you can show it as "outside hours". Overlap with a blocking Booking is never relaxed ([ADR 014](../adr/014-invariants-and-relaxable-policies.md)).

```typescript
const all = findFreeSlots({ ...params, relax: ["availability"] });
// all.value[i].waived: [] or [{ policy: "availability", detail: {} }]
```

## Rescheduling

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

## DST

- **Spring-forward gap** — slots whose wall-clock start falls in the missing hour are dropped.
- **Fall-back overlap** — only the first occurrence of an ambiguous wall-clock time is emitted.
- **Rule windows** — a window with an edge in the missing hour is clipped to the times that exist that day, in the rule's own timezone. One wholly inside it opens nothing.

See [ADR 005](../adr/005-dst-policy.md) for the rationale.
