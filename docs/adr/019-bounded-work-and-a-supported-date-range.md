# ADR 019: Bounded Work and a Supported Date Range

**Status:** Accepted

**Date:** 2026-11-23

## Context

The Core does work in proportion to its input, and the input comes from callers. A one-year search on a 1-minute Grid has 527,040 Grid times and took 43 s. A one-year search on a 15-minute Grid with 3,000 Bookings took 26 s. A thousand rules, or a rule with millions of exceptions, costs as much as its size. And Temporal throws a `RangeError`, not a `Result`, when a date leaves its range (about ±271,821 years), so a `duration` of `Number.MAX_SAFE_INTEGER` or an `expandRules` that ends in year 275,760 escapes the typed errors (ADR 011).

A security review (deepsec) raised these as denial-of-service and overflow findings. ADR 014's spec already bounds the work of `isSlotValid`, `book` and `reschedule` by the slot rather than its span (fasti#215). What's left is the work a caller asks for directly: a search, a direct `expandRules`, and a rule set.

Options considered:

1. **Configurable limits**, on the schema or `createScheduler`, with defaults.
2. **Truncate**: return the first N slots and stop.
3. **Fixed limits that fail the call**, and a supported date range.

## Decision

We choose option 3.

- **The limits** are constants in the Core, exported from `@fastijs/scheduler/core`:
  - **10,000 Grid times per search**, in `findFreeSlots` and the Framework's `findSlots`. A search's Grid-time count is its span in minutes divided by `interval`; a DST day counts as 24 hours.
  - **`duration` at most 44,640 minutes (31 days)**, and a safe integer, like every other minute count.
  - **366 days per `expandRules` call**, inclusive. Only direct calls: `availableWindows` and the per-slot `windowsFor` are already bounded.
  - **100 rules per call**, wherever rules are checked, which also caps `availability.set`, since `set` replaces all of a Resource's rules.
  - **1,000 exceptions per rule.**
- **The supported date range is years 0001 to 9999.** Every Instant and PlainDate a caller passes must fall in it: a search's `from` and `to`, a Booking's `start` and `end`, a rule's `effectiveFrom`, `effectiveTo` and exceptions, and `expandRules`' `from` and `to`. The checks in `src/core/checks.ts` enforce it before any Temporal arithmetic, so no input reaches a `RangeError`. We never wrap expansion in a `try`/`catch`.
- **Over a limit, the call fails** with `InvalidParams`. The issue has a path, and its message names the limit and the way out: "Search covers 35,136 Grid times; the limit is 10,000. Split it into smaller ranges." Nothing is truncated: a partial list of slots looks like a full one, and would let an app say "no times left" when there are.
- **Fixed, not configurable.** An app that needs more pages instead. Searches partition: the slots of `[a, b)` and of `[b, c)` together are the slots of `[a, c)`, a property the test suite already checks. A setting would be one more thing to document, test and get wrong, and we know of no use case that paging doesn't cover.
- **Stored data** outside the range is invalid stored data, and fails as `AdapterError` (Invariant 6 of ADR 014's spec), as any other invalid row does.
- **No cap on a Booking's length** in `book` or `reschedule`: fasti#215 bounds that work already.

## Consequences

- **Positive:** Every caller-reachable path has bounded work and returns a `Result`. No Temporal `RangeError` escapes.
- **Positive:** The limits are public constants, so an app can page with them and check them in its own validation.
- **Negative:** A caller that searched a year at a time on a fine Grid must now page. That's a behaviour change in a patch release, which we accept because the old behaviour could take tens of seconds.
- **Negative:** A deployment that really needs more than 100 rules per Resource, or more than 1,000 exceptions per rule, has no setting to raise. If one shows up, we revisit this ADR.
