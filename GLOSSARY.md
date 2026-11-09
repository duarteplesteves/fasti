# GLOSSARY.md — better-schedule

## Domain

**better-schedule** is a headless, type-safe scheduling engine for TypeScript.

It answers one question: *given a resource's availability rules and existing bookings, what time slots are free?* The engine is stateless, framework-agnostic, and storage-agnostic. Users bring their own data; the engine performs time-and-resource math.

---

## Purpose

Developers building scheduling tools (appointments, reservations, bookings) currently rebuild slot-finding, conflict detection, and recurrence expansion from scratch. Existing libraries handle dates (`date-fns`, `luxon`) or UI (FullCalendar), but none provide a reusable **scheduling logic** layer. better-schedule fills that gap.

---

## Ubiquitous Language

| Term | Definition | Notes |
|------|------------|-------|
| **Resource** | Anything that can be booked (person, room, machine, doctor, etc.). | Treated as an opaque, globally unique identifier (`resourceId`). The engine does not understand resource taxonomy; namespacing is the caller's responsibility. |
| **AvailabilityRule** | An abstract, recurring pattern defining when a Resource is available for booking. | Expressed as frequency (weekly), days of the week, time window, timezone, and effective date range. Concrete windows are generated on demand. |
| **Booking** | An existing reservation that occupies a Resource for a specific time range. | The engine uses `isBlocking` (not `status`) to determine if a booking consumes capacity. The engine knows nothing about booking lifecycle or business consequences. |
| **Slot** | A candidate time window returned by the engine that is both within an AvailabilityRule and free of conflicting Bookings. | Represents a bookable window. Returned with zoned start/end so the caller knows local wall-clock time. |
| **Capacity** | The number of simultaneous bookings a Resource can host. | **v0.1 constraint: capacity is always 1.** Multi-booking resources (classes, group events) are out of scope for the core engine. |
| **Blocking** | Whether a booking prevents another booking from occupying the same slot. | Determined by `isBlocking: boolean` on the Booking primitive. Defaults to `true`. The engine ignores `status` for conflict detection. |
| **Grid / Interval** | The fixed step size at which candidate slots are generated from an AvailabilityRule. | Defaults to the requested booking `duration`, but can be overridden (e.g., 15-minute grid for 30-minute bookings). |
| **Recurrence Expansion** | The process of converting an abstract AvailabilityRule into concrete, calendar-specific time windows. | Performed by `expandRules()` and exposed as a standalone utility. v0.1 query functions accept abstract `AvailabilityRule[]` only — pre-expanded input is not a supported entry point. |
| **ExpandedWindow** | One concrete application of one `AvailabilityRule` on one calendar date in that rule's timezone. Carries `resourceId`, zoned `start`, and zoned `end`. | Output of `expandRules()`. Not accepted as input to query functions in v0.1. See "Expansion Semantics" below for properties. |

---

## Key Concepts

### Stateless Core

The engine has no internal state, no storage adapter, and no side effects. Every function is a pure function: same inputs always produce same outputs. Persistence, frameworks, and business logic live outside the engine.

### Temporal-Native

All time representations use the TC39 Temporal API (the native global `Temporal`):
- **Absolute facts** (bookings, query boundaries) → `Temporal.Instant`
- **Local policy** (availability windows, slots shown to users) → `Temporal.ZonedDateTime` / `Temporal.PlainTime`
- **Calendar iteration** (effective dates, exceptions) → `Temporal.PlainDate`

### Single-Resource Queries

Every core query is scoped to a single Resource. Multi-resource orchestration ("find me any doctor") is the caller's or framework's responsibility.

### Expansion Semantics

`expandRules()` is a faithful, opinion-free expansion. For each input rule, it emits one `ExpandedWindow` per calendar date in `[from, to]` that satisfies the rule's recurrence, `effectiveFrom`/`effectiveTo`, `daysOfWeek`, and `exceptions`.

Properties of the output:

1. **No merging.** Touching or overlapping windows from different rules are emitted as separate `ExpandedWindow`s. E.g. rules `Tue 9–12` + `Tue 12–17` on the same Tuesday produce two windows, not one.
2. **No provenance.** `ExpandedWindow` carries no reference back to the source rule. Callers who need traceability do their own bookkeeping.
3. **Flat, sorted output.** A single `ExpandedWindow[]`, sorted ascending by `start` (Instant order). Ties broken lexicographically by `resourceId`.
4. **Unlike query functions, `expandRules` is multi-resource.** It accepts rules for different `resourceId`s and emits a single flat array; callers group by `resourceId` themselves if needed.

---

## Business Rules / Invariants

1. **A slot is free iff:**
   - Its start time falls within an expanded AvailabilityRule window for the Resource.
   - Its entire duration fits within that window.
   - It does not overlap with any Booking where `isBlocking === true`.

2. **Capacity is always 1 in v0.1.**
   Two bookings for the same Resource at overlapping times is always a conflict.

3. **The engine does not interpret `status`.**
   The caller maps their domain statuses to `isBlocking` before invoking the engine (e.g., `CONFIRMED` → `true`, `CANCELLED` → `false`).

4. **AvailabilityRules are abstract and timezone-aware.**
   A rule declares its own IANA timezone. When comparing bookings (absolute Instants) against rules (local time + zone), the engine converts consistently.

5. **Slot generation uses a fixed grid.**
   Slots start at `ruleStart + n * interval`. The `interval` defaults to the requested `duration`.

6. **Single-resource scoping is enforced.**
   `findFreeSlots`, `isSlotValid`, and `detectConflicts` take a required `resourceId`. Every input rule and booking must match it; the engine throws on mismatch. `expandRules` is the exception — it accepts mixed `resourceId`s and groups them in its output.

7. **Rule validity is checked synchronously.**
   The engine throws on construction-quality issues at the start of every entry point: `start >= end`, `effectiveTo < effectiveFrom`, empty `daysOfWeek`, values outside 1–7, duplicates, `recurrence.interval < 1`. Cross-day windows (`start > end` interpreted as wrapping past midnight) are **out of scope for v0.1** — split into two rules.

8. **DST policy (v0.1 simplification).**
   - **Spring-forward gap** (e.g. Lisbon, last Sunday March, 01:00 → 02:00): if a grid candidate's start time falls in the gap, the slot is dropped. The next grid step is generated normally.
   - **Fall-back overlap** (e.g. last Sunday October, 02:00 → 01:00): only the **first occurrence** of the repeated wall-clock hour generates slots. The second occurrence's real-time bookable hour is lost in v0.1. Documented limitation; revisit in v0.2 if real usage requires double-occurrence slots.
   - `exceptions: PlainDate[]` are interpreted as dates in the **rule's `timezone`**, not UTC.

---

## Out of Scope (Core Engine)

These concerns belong to the caller, the framework layer, or future versions:

- **Booking lifecycle** (PENDING → CONFIRMED → COMPLETED, consequences for missed bookings)
- **Capacity > 1** (group classes, shared resources)
- **Multi-resource atomic bookings** (booking a doctor + room simultaneously)
- **Payment, pricing, packs, subscriptions**
- **Reminders, notifications, email**
- **UI rendering** (calendars, date pickers)
- **Persistence** (databases, ORMs, caching)

---

## Architecture Decisions

| ADR | Topic | Status |
|-----|-------|--------|
| [ADR 001](./docs/adr/001-stateless-pure-functions.md) | Core is stateless pure functions | Accepted |
| [ADR 002](./docs/adr/002-temporal-api.md) | Date/time via Temporal API + polyfill | Accepted |
| [ADR 003](./docs/adr/003-abstract-rules.md) | AvailabilityRule is abstract, expanded on demand | Accepted |
| [ADR 004](./docs/adr/004-blocking-required.md) | `isBlocking` is required on Booking | Accepted |
| [ADR 005](./docs/adr/005-dst-policy.md) | DST policy: drop on gap, first occurrence on overlap | Accepted |
| [ADR 006](./docs/adr/006-single-resource-scoping.md) | Single-resource scoping via required `resourceId` | Accepted |

