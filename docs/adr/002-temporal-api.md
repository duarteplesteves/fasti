# ADR 002: Date/Time Handling via Temporal API

**Status:** Accepted

**Date:** 2026-05-09

## Context

Date and time math is the hardest part of scheduling (DST transitions, timezone conversions, ambiguous times). We must choose a date representation that is unambiguous and future-proof.

## Decision

The engine will use the **Temporal API** (TC39 proposal) via `@js-temporal/polyfill`. Public types use `Temporal.Instant` for absolute times and `Temporal.ZonedDateTime` for local wall-clock times.

## Consequences

- **Positive:** Unambiguous semantics. `Instant` for absolute facts, `ZonedDateTime` for user-facing slots.
- **Positive:** Future-proof as runtimes adopt Temporal natively.
- **Negative:** Requires a polyfill (~100KB) until native support is universal.
- **Mitigation:** Polyfill is bundled as a direct dependency in v0.1; will be removed in a future major version.
