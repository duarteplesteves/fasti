# ADR 004: `isBlocking` is Required on Booking

**Status:** Accepted

**Date:** 2026-05-10

## Context

The engine determines whether an existing `Booking` consumes a slot via its `isBlocking` boolean. The original shape made `isBlocking` optional with a default of `true`, and provided a `withBlockingFlag()` helper to map a domain `status` string to the boolean.

The optional + default-true shape has a silent-failure mode: a caller who loads bookings from their store with a `status: 'CANCELLED'` field and forgets to map it will silently treat cancelled bookings as blocking, leading to slots that should be available being reported as taken. The bug only surfaces when a customer cannot book a slot they should be able to — far from the actual mistake.

We also considered eliminating `isBlocking` entirely in favour of a `blockingStatuses: string[]` parameter on the engine, deriving the decision at call time from each booking's `status` field. That shape was rejected: real-world "blocking-ness" is not always a function of a single status string (soft-delete timestamps, payment state, custom rules), and the boolean is the actual semantic the engine needs.

## Decision

`Booking.isBlocking` is a **required boolean**. There is no default.

The `withBlockingFlag()` helper retains its purpose (status-string → boolean mapping for the common case) but takes a required `default: 'blocking' | 'nonBlocking'` parameter to force the caller to declare how unmapped statuses are treated.

## Consequences

- **Positive:** TypeScript catches forgotten mappings at compile time. The silent-failure mode is impossible.
- **Positive:** The engine's contract is decoupled from any caller-specific status convention. Any blocking logic the caller wants (status string, soft-delete flag, payment state, composite predicate) reduces to the same boolean field.
- **Positive:** Boolean checks are cheaper than set lookups on status strings. Negligible in practice but conceptually cleaner.
- **Negative:** Callers must write a one-line mapping (`bookings.map(b => ({ ...b, isBlocking: ... }))`) when their source data uses status strings rather than blocking flags directly. The `withBlockingFlag()` helper covers the most common version of this.
- **Future:** A future framework layer may auto-derive `isBlocking` from a caller-supplied schema. That belongs above the core engine, not inside it.
