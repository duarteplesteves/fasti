# GLOSSARY.md — fasti

## Domain

**fasti** is a type-safe scheduling **Framework** for TypeScript, built around a pure **Core**.

The **Core** answers one question: *given a resource's availability rules and existing bookings, what time slots are free?* It is stateless, framework-agnostic, and storage-agnostic. The **Framework** sits between the developer's system and their own database: configured with an **Adapter**, it exposes **Actions** that read and write scheduling data, using the Core for the math.

---

## Purpose

Developers building scheduling tools (appointments, reservations, bookings) currently rebuild slot-finding, conflict detection, and recurrence expansion from scratch. Existing libraries handle dates (`date-fns`, `luxon`) or UI (FullCalendar), but none provide a reusable **scheduling logic** layer. fasti fills that gap.

---

## Ubiquitous Language

### Layers

| Term | Definition | Notes |
|------|------------|-------|
| **Framework** | The configurable instance a developer creates and calls from their backend; it owns scheduling operations against the developer's database. | _Avoid_: SDK, engine (for the whole package). Built on the Core; never replaces it. |
| **Core** | The pure scheduling math: stateless functions over rules and bookings, with no storage or side effects. | Usable on its own, without a Framework instance. _Avoid_: engine (as a synonym for the whole package). |
| **Adapter** | The bridge between the Framework and the developer's own database. | The developer owns the database; the Adapter only reads and writes through it. A **first-party Adapter** ships with fasti; a **custom Adapter** is written by the developer against the same contract, for tables that differ from the Logical Model by more than names. |
| **Resource Lock** | The exclusive right to change one Resource's bookings and availability for the length of one unit of work. | Every write Action holds one; reads don't. Promised per Resource only: an Adapter may lock more broadly, never more narrowly. _Avoid_: mutex. |
| **Conformance Suite** | The published tests every Adapter must pass to count as correct, including concurrency tests against a real database. | Applies equally to first-party and custom Adapters. No opt-outs except explicitly optional groups. |
| **Logical Model** | The entities and fields the Framework stores through an Adapter: Booking and AvailabilityRule. | Named independently of the developer's physical tables and columns, which can be renamed. Resources are not part of it; they stay in the developer's own tables. |
| **Developer Field** | A field the developer declares on a Booking (e.g. a customer id), which the Framework stores and types but never interprets. | _Avoid_: metadata, custom data. |
| **Action** | A server-side operation exposed by a Framework instance (e.g. booking, cancelling). | Called directly from the developer's backend. _Avoid_: endpoint (HTTP exposure is a separate, later concern). |

### Scheduling

| Term | Definition | Notes |
|------|------------|-------|
| **Resource** | Anything that can be booked (person, room, machine, doctor, etc.). | Treated as an opaque, globally unique identifier (`resourceId`). The engine does not understand resource taxonomy; namespacing is the caller's responsibility. |
| **AvailabilityRule** | An abstract, recurring pattern defining when a Resource is available for booking. | Expressed as a recurrence, time window, timezone, and effective date range. The recurrence is one value discriminated by `frequency` (only `weekly` today: interval and days of the week), so a new frequency is a new kind of recurrence, not a data migration. Concrete windows are generated on demand. |
| **Booking** | An existing reservation that occupies a Resource for a specific time range. | The engine uses `isBlocking` (not `status`) to determine if a booking consumes capacity. The engine knows nothing about booking lifecycle or business consequences. |
| **Slot** | A candidate time window on the query's Grid, starting in the queried `[from, to)`, that fits inside an expanded AvailabilityRule window and is free of conflicting Bookings. | Represents a bookable window. Returned with start/end zoned in the query `timezone`, so the caller knows local wall-clock time. Its end may pass `to`. |
| **Capacity** | The number of simultaneous bookings a Resource can host. | **v0.1 constraint: capacity is always 1.** Multi-booking resources (classes, group events) are out of scope for the core engine. |
| **Blocking** | Whether a booking prevents another booking from occupying the same slot. | Determined by `isBlocking: boolean` on the Booking primitive. Defaults to `true`. The engine ignores `status` for conflict detection. |
| **Grid / Interval** | The candidate slot starts of a query: local midnight in the query's required `timezone` plus whole steps of the required `interval` (minutes), each day. | One Grid per query, whatever rules made the slots (ADR 014). Independent of `duration` (e.g., a 15-minute grid for 30-minute bookings). A rule starting off the Grid (09:10 on a 15-minute grid) gets its first slot at the next Grid time (09:15). |
| **Recurrence Expansion** | The process of converting an abstract AvailabilityRule into concrete, calendar-specific time windows. | Performed by `expandRules()` and exposed as a standalone utility. v0.1 query functions accept abstract `AvailabilityRule[]` only — pre-expanded input is not a supported entry point. |
| **ExpandedWindow** | One concrete application of one `AvailabilityRule` on one calendar date in that rule's timezone. Carries `resourceId`, zoned `start`, and zoned `end`. | Output of `expandRules()`. Not accepted as input to query functions in v0.1. See "Expansion Semantics" below for properties. |

### Lifecycle

| Term | Definition | Notes |
|------|------------|-------|
| **Status** | Where a Booking stands in its lifecycle. Each Status either blocks or doesn't, and that is all the Framework reads from it. | Two **base Statuses** ship with the Framework: `booked` (blocks) and `cancelled` (doesn't). The developer declares any others, each saying whether it blocks. Meanings such as completed or no-show stay with the developer. The Core never sees a Status, only whether a Booking blocks. |
| **Transition** | A declared move of a Booking from one Status to another. | Only declared Transitions are allowed; a Status with none leaving it is terminal. A Transition into a blocking Status must pass the overlap check. _Avoid_: status change (for a move that isn't declared). |

### Booking checks

| Term | Definition | Notes |
|------|------------|-------|
| **Invariant** | A check the Framework always enforces and no caller can relax. | Exactly four: params are meaningful, no overlap with a blocking Booking on the same Resource, the Transition is declared, and the Booking exists with the expected Status. |
| **Policy** | A named rule about when a booking change is allowed, which a caller may relax on a single call. | **availability** (inside the Resource's AvailabilityRules) is always present, because it enforces rules the developer stored. Every other Policy applies only if the developer lists it: the prebuilt **notice** (a minimum lead time before the start; zero forbids past starts), or one they write (buffers, limits, a Transition's preconditions). _Avoid_: rule (taken by AvailabilityRule), constraint, built-in. |
| **Waived** | The relaxed Policies a slot or a successful booking change actually broke. | Reported so the developer can show or log the exception (e.g. "booked outside hours"). |
| **Relax** | To skip named Policies for one Action call, decided by the developer's backend. | Only Policies can be relaxed, never Invariants, and only by name. _Avoid_: override, bypass. |
| **Veto** | The developer's refusal, from inside an Action's transaction, that undoes the whole Action. | E.g. no credit left on a pack, so the Booking is never made. Reported as `Vetoed`. _Avoid_: reject, abort. |

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
   - Its start is a Grid time and falls in the queried `[from, to)`.
   - Its entire duration (start to start + `duration`, by instant) fits within one expanded AvailabilityRule window for the Resource, in any rule timezone.
   - It does not overlap with any Booking where `isBlocking === true`.

2. **Capacity is always 1 in v0.1.**
   Two bookings for the same Resource at overlapping times is always a conflict.

3. **The engine does not interpret `status`.**
   The caller maps their domain statuses to `isBlocking` before invoking the engine (e.g., `CONFIRMED` → `true`, `CANCELLED` → `false`).

4. **AvailabilityRules are abstract and timezone-aware.**
   A rule declares its own IANA timezone. When comparing bookings (absolute Instants) against rules (local time + zone), the engine converts consistently.

5. **Slot generation uses one fixed grid.**
   Candidate starts are `00:00 + n × interval` wall-clock in the query `timezone`, on each local date overlapping `[from, to)`, stopping before the next local midnight. `interval` and `timezone` are required; `interval` does not default to `duration`. At most one slot per Grid instant, sorted by start.

6. **Single-resource scoping is enforced.**
   `findFreeSlots`, `isSlotValid`, and `detectConflicts` take a required `resourceId`. Every input rule and booking must match it; a mismatch is reported as an `InvalidParams` issue at that item's `resourceId`, never thrown. `expandRules` is the exception — it accepts mixed `resourceId`s and groups them in its output.

7. **Invalid input is reported, never thrown.**
   Every entry point checks its input before computing, and reports all problems found rather than the first: a rule whose window doesn't end after it starts, `effectiveTo < effectiveFrom`, empty `daysOfWeek`, values outside 1–7, duplicates, `recurrence.interval < 1`, an unknown or fixed-offset timezone, any time range whose end isn't after its start, and a `withBlockingFlag` status listed as both blocking and non-blocking. The result is `{ ok: false, error: InvalidParams }` with every issue and its path; a check is skipped only when an earlier issue makes it meaningless. `checkRule(rule)` runs the rule checks on their own. Cross-day windows (`start > end` interpreted as wrapping past midnight) are **out of scope for v0.1** — split into two rules. See ADR 011.

8. **DST policy (v0.1 simplification).**
   Applied to the Grid in the query `timezone` (ADR 014), not to each rule's timezone.
   - **Spring-forward gap** (e.g. Lisbon, last Sunday March, 01:00 → 02:00): if a Grid time falls in the gap, it is dropped. The next grid step is generated normally.
   - **Fall-back overlap** (e.g. last Sunday October, 02:00 → 01:00): only the **first occurrence** of the repeated wall-clock hour is a Grid time. The second occurrence's real-time bookable hour is lost in v0.1. Documented limitation; revisit in v0.2 if real usage requires double-occurrence slots.
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
| [ADR 007](./docs/adr/007-hybrid-schema-ownership.md) | Hybrid schema ownership: Framework owns the Logical Model, developer owns the database | Accepted |
| [ADR 008](./docs/adr/008-adapter-contract.md) | The Adapter contract is domain verbs plus a Resource Lock; checks stay in the Framework | Accepted |
| [ADR 009](./docs/adr/009-booking-lifecycle.md) | The booking lifecycle is declared as data and enforced by the Framework | Accepted |
| [ADR 010](./docs/adr/010-action-results-and-two-forms.md) | Actions return typed results in a plain form and an Effect form | Accepted |
| [ADR 011](./docs/adr/011-effect-free-core-returns-results.md) | The Core is Effect-free and returns typed results | Accepted |
| [ADR 014](./docs/adr/014-invariants-and-relaxable-policies.md) | Four Invariants, everything else a Policy the caller can relax | Accepted |
| [ADR 015](./docs/adr/015-developer-writes-inside-the-action-transaction.md) | The developer's own writes run inside the Action's transaction | Accepted |

