# ADR 006: Single-Resource Scoping via Required `resourceId`

**Status:** Accepted

**Date:** 2026-05-10

## Context

The core engine is scoped to single-resource queries: `findFreeSlots`, `isSlotValid`, and `detectConflicts` each operate on one resource at a time. Multi-resource orchestration ("find me any free doctor") is a framework-layer concern.

The earlier params shape did not encode this constraint: `findFreeSlots` accepted `rules: AvailabilityRule[]` and `bookings: Booking[]`, both of which carry their own `resourceId`. There was no top-level resource identity on the params, so:

- Multi-resource inputs were syntactically valid but semantically undefined.
- An empty `rules` array carried no resource identity at all.
- The single-resource invariant lived in prose (GLOSSARY.md) rather than in the type system.

Three options were considered:

1. **Required `resourceId` on params, throw on mismatch.** Adds a redundant-seeming field, but encodes the contract in the type.
2. **No top-level field; throw at runtime if input arrays contain mixed `resourceId`s.** Cheaper-looking, but pushes the contract from type to runtime check.
3. **Group internally by `resourceId` and return slots per group.** Implicitly accepts mixed inputs and changes the engine's semantics from single- to multi-resource. Conflicts with the stated scope.

## Decision

`FindFreeSlotsParams`, `IsSlotValidParams`, and `DetectConflictsParams` carry a required `resourceId: string`. The engine validates that every input rule's and booking's `resourceId` matches the params' `resourceId`, throwing on mismatch.

`ExpandRulesParams` is the deliberate exception: rule expansion is naturally multi-resource (batch rendering a calendar for many resources), so it accepts rules with mixed `resourceId`s and emits a flat `ExpandedWindow[]`. Callers group by `resourceId` themselves.

## Consequences

- **Positive:** The single-resource contract is self-documenting in the type signature. No reader has to find the prose constraint in GLOSSARY.md.
- **Positive:** Empty-input cases are well-defined. `findFreeSlots({ resourceId: "doc-1", rules: [], bookings: [], ... })` unambiguously means "no slots for doc-1," not "no slots for some unspecified resource."
- **Positive:** Caller mistakes (mixing resources in one call) fail loudly at the engine boundary rather than producing subtly-wrong results downstream.
- **Negative:** Slight syntactic redundancy — the resource is named at the top level and also present on every rule/booking in the input. Acceptable cost for the guarantee.
- **Future:** When a framework layer introduces multi-resource convenience APIs (`findFirstAvailableSlot(resources[], ...)`), it does so as a separate function that calls the single-resource core multiple times. The core's invariant is preserved.
