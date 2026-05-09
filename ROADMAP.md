# ROADMAP — better-schedule

This document captures features, concepts, and architectural directions discussed during design but intentionally deferred from v0.1. Items are grouped by likely release phase, but timelines are fluid.

---

## v0.2 — Core Engine Hardening

### Additional Recurrence Patterns
- **Daily recurrence** — simpler than weekly; useful for continuous services.
- **Monthly recurrence** — "first Monday of every month," "15th of every month." Harder due to variable month lengths and day-of-week drift.

### Buffer Time
- Configurable gaps between bookings (cleanup, travel, prep time).
- Buffers at start vs. end of booking.
- Conditional buffers (e.g., only between certain booking types).
- *Current workaround:* Inflate booking duration manually.

### Property-Based Testing
- Integrate `fast-check` or similar to generate random rules, bookings, and ranges.
- Catches edge cases in slot generation and conflict detection (DST transitions, leap years, timezone boundaries).

---

## v0.3 — Multi-Resource & Capacity

### Capacity > 1
- Resources that host multiple simultaneous bookings (gym classes, workshops, tour groups).
- `Resource.capacity: number` and `Booking.seats: number`.
- Conflict = sum of overlapping bookings' seats > resource capacity.

### Multi-Resource Atomic Bookings
- A single logical booking that blocks multiple resources simultaneously (doctor + consultation room + equipment).
- Requires all-or-nothing availability: if any resource is unavailable, the entire booking is invalid.
- *Current workaround:* Create separate single-resource bookings sharing a `groupId`.

---

## v1.0 — Framework Layer

### `createScheduler()` — Better-Auth-style API
An opinionated, configurable framework built on top of the pure-function core:

```typescript
import { createScheduler } from "better-schedule/framework";

const scheduler = createScheduler({
  storageAdapter: prismaAdapter,
  plugins: [emailReminders, stripePayments],
});
```

### Plugin System
- Hooks for `onBeforeBook`, `onAfterBook`, `onConflict`, `onCancel`.
- First-party plugins for common integrations (email, SMS, payments, calendar sync).

### Effect-TS Integration (Optional Adapter)
- An `@better-schedule/effect` package that wraps core functions in `Effect` for applications already using Effect-TS.
- Provides typed errors, structured concurrency, and composable scheduling pipelines.

### Booking Lifecycle & Transitions
- User-defined state machines for booking status flows.
- `validateTransition(currentStatus, proposedStatus, rules)` helper.
- Not part of core engine; belongs to framework layer.

### BookingGroup / Pack / Subscription Support
- Containers for multiple related bookings (course of 8 sessions, therapy plan, subscription with monthly limits).
- Group-level constraints: max bookings, minimum gaps between sessions, first vs. follow-up durations.

---

## v1.5 — Advanced Scheduling

### Continuous Slot Generation
- Currently v0.1 uses fixed-interval grid slots only.
- Future: "greedy" continuous slots where any start time is valid as long as duration fits and no conflict exists.
- Useful for flexible scheduling (e.g., coworking desks, rental equipment).

### Intelligent Search
- `findFirstAvailableSlot(resources[], constraints)` — search across multiple resources and return the earliest match.
- `optimizeSchedule(bookings[], rules[])` — rearrange existing bookings to minimize gaps ( NP-hard; heuristic-based).

### Recurring Booking Generation
- Given a pattern ("every Tuesday at 9:00 for 6 weeks"), generate a series of bookings with group linkage.
- Handle exceptions, rescheduling entire series vs. single occurrence.

---

## v2.0+ — Ecosystem & Scale

### Monorepo Migration
- If framework + plugins + adapters grow complex, migrate to `packages/core`, `packages/framework`, `packages/adapters/*`.
- Independent versioning per package.

### Bundled Build Outputs
- Move from `tsc`-only to `unbuild` or `rollup` for optimized, tree-shakeable bundles.
- Separate browser-optimized bundle (smaller polyfill, no Node-specific code).

### Documentation Site
- VitePress or similar for interactive examples, API reference, and recipe guides.
- Hosted at `better-schedule.dev` or similar.

### Release Automation
- Changesets for versioning and changelogs.
- Automated publishing to npm via GitHub Actions.
- CI matrix: Node LTS, Bun, Deno (when Temporal-native).

### Community Adapters
- Official storage adapters: Prisma, Drizzle, Supabase, Firebase.
- Official framework integrations: React hooks, Vue composables, Svelte stores.

---

## Maybe / Needs Validation

These ideas were discussed but lack conviction. Require real-world usage before commitment:

- **Booking consequences** — automated side effects when a booking is missed/cancelled (strikes, fees, pack deductions).
- **Waitlists** — automatically notify when a slot opens.
- **Overlapping rules** — multiple rules for the same resource on the same day with different priorities.
- **Rule inheritance** — resources inherit default rules but can override specific days.
- **Dynamic pricing** — slot pricing varies by time of day, demand, or resource.
- **AI-assisted scheduling** — suggest optimal slots based on historical patterns.

---

## How to Contribute to the Roadmap

Open an issue with the `[roadmap]` prefix describing:
1. The use case
2. Why it can't be solved with v0.1 primitives
3. Whether it belongs in core, framework, or an external adapter
