# ADR 005: DST Policy for Slot Generation (v0.1)

**Status:** Accepted

**Date:** 2026-05-10

## Context

`AvailabilityRule` is timezone-aware. Rule windows are wall-clock times in a named IANA zone, while bookings are absolute `Temporal.Instant`s. Slot generation walks a wall-clock grid inside each expanded window, and DST transitions in the rule's zone produce two awkward cases:

- **Spring-forward gap.** On the day clocks jump forward (e.g. Europe/Lisbon, last Sunday of March, 01:00 → 02:00), a window of `01:00–04:00` contains wall-clock times like `01:30` that do not exist. A grid step landing on a non-existent local time has no corresponding `Instant`.
- **Fall-back overlap.** On the day clocks jump back (last Sunday of October, 02:00 → 01:00), a window of `00:00–04:00` contains the wall-clock hour `01:00–02:00` *twice* — once before the jump, once after. The window is 5 real hours of bookable time but only 4 wall-clock hours.

Three approaches were considered:

1. **Real-time correctness, asymmetric output.** Drop non-existent gap times; generate slots for both fall-back occurrences. Output count diverges from wall-clock expectations.
2. **Wall-clock predictability, lose some real time.** Drop non-existent gap times; generate slots for the first fall-back occurrence only. Output count matches naive `(window / interval)` arithmetic.
3. **Absolute grid.** Generate slots on a UTC grid and project to local time. Wall-clock alignment drifts across DST — breaks the "9 AM means 9 AM" expectation that makes the API intuitive.

Approach 3 was rejected immediately. Approaches 1 and 2 are both defensible.

## Decision

v0.1 adopts approach 2:

- **Spring-forward gap → drop the slot.** Grid candidates whose wall-clock start does not exist in the rule's zone are silently skipped. The next grid step proceeds normally. Constructed via `Temporal.ZonedDateTime` with `disambiguation: 'reject'`, treating the throw as "this slot does not exist."
- **Fall-back overlap → first occurrence only.** When the wall-clock grid step happens during a repeated hour, only the first occurrence (still under the pre-transition offset) generates a slot. The second occurrence's real-time bookable hour is not enumerated.

Both behaviours are documented in GLOSSARY.md as a v0.1 simplification.

## Consequences

- **Positive:** Slot counts match naive wall-clock arithmetic. Callers debugging "why do I see N slots?" can compute the answer from `(window / interval)` without DST exception handling.
- **Positive:** No "phantom duplicate" slots on fall-back day. UIs rendering a `09:00–10:00` slot column don't see two slots at `01:30` and have to disambiguate.
- **Negative:** Up to one hour of bookable real time on each fall-back day is invisible to the engine. Only matters for rules whose window includes the affected wall-clock range — typically `00:00–02:00` local. Most rules (business hours) are unaffected.
- **Future:** A v0.2 option (or a flag on `findFreeSlots`) can opt into approach 1 — `includeDstOverlap: true` — when callers care about every real-time bookable hour. Easy to add backwards-compatibly because the current behaviour is the strict subset.

## Amendment (2026-11-12)

Since ADR 014, `findFreeSlots` walks one Grid from local midnight in the query's required `timezone`, not a grid inside each rule's window. The two rules above now apply to that Grid in the query `timezone`: a Grid time in a spring-forward gap is dropped, and a repeated fall-back time is used only at its first occurrence. A rule's own timezone only decides its expanded windows, which are compared to Grid candidates by instant. The `disambiguation: 'reject'` construction is replaced by `'earlier'` plus a check that the wall-clock time survived, since `'reject'` also throws on the fall-back overlap.
