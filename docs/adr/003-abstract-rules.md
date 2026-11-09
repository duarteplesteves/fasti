# ADR 003: Availability Rules are Abstract

**Status:** Accepted

**Date:** 2026-05-09

## Context

Availability can be expressed as concrete windows or abstract patterns ("every Tuesday 9-5"). We must decide where recurrence expansion lives.

## Decision

`AvailabilityRule` is **abstract** (weekly recurrence + days + time window + timezone). A separate `expandRules()` pure function expands rules into concrete windows. The core slot-finding functions accept either abstract or concrete rules.

## Consequences

- **Positive:** Rules are concise and human-readable.
- **Positive:** Expansion is testable in isolation.
- **Positive:** Users can bring their own recurrence engine if they need more complexity (e.g. `rrule`).
- **Negative:** Two-step flow for advanced use cases (expand, then query).

## Amendment (2026-11-09)

The Decision above overstates the input surface. In v0.1 the query functions (`findFreeSlots`, `isSlotValid`) accept abstract `AvailabilityRule[]` only; pre-expanded `ExpandedWindow[]` is not a supported entry point. `expandRules()` remains a standalone utility, and accepting pre-expanded input is a possible future addition.
