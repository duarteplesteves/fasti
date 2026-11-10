# ADR 011: The Core Is Effect-Free and Returns Typed Results

**Status:** Accepted

**Date:** 2026-11-10

## Context

The Core is pure, synchronous math (ADR 001), and until now every entry point threw a plain `Error` on invalid input. The failures were invisible in the types, and an unknown timezone escaped as Temporal's `RangeError` partway through expansion. The Framework is built on Effect and reports invalid input as a typed `InvalidParams` whose issues are defined once, in the Core (ADR 010). `fasti/core` must stay usable without a Framework instance and without knowing Effect.

Options considered:

1. **Effect in the Core**, so failures sit in the signature. Effect's strengths (dependencies, async work, resources, concurrency) are unused by pure math, and Core-only users would pay for the runtime.
2. **Keep throwing**, plus separate issue-returning checks for the Framework. Least churn, but expected failures stay out of the types.
3. **Parse first**: `parse…Params` returns a branded valid object that query functions accept, so queries can't fail. Correct by construction, but every call becomes two, several checks span params (`from < to`, `resourceId` matching every rule), and it contradicts ADR 010's "public params stay plain".
4. **Return the same result as plain Actions**, with no throwing variants.

## Decision

We choose option 4.

- `fasti/core` is plain TypeScript with zero runtime dependencies. There is no Effect variant; Effect users lift a result in one line.
- Every Core entry point returns `{ ok: true; value: T } | { ok: false; error: InvalidParams }`. Nothing the caller's data contains makes it throw; throwing is only for defects.
- `InvalidParams` covers every meaning check: rule validity, an unknown IANA timezone, a `resourceId` that doesn't match the query's, and any time range (Booking, candidate, slot) whose `end` isn't after its `start`.
- Checks collect all issues in one pass, skipping only checks an earlier issue makes meaningless. `issues` is a non-empty tuple.
- `checkRule(rule)` is exported and returns a readonly array of issues, empty when valid. Other checks stay internal until a developer needs them.
- The issue type is copied from Standard Schema and matches it structurally, so the Core has no dependency for it.
- `Result`, `InvalidParams` and `Issue` are defined in the Core, exported from `fasti/core`, and re-exported unchanged by `fasti`.

## Consequences

- **Positive:** One result pattern across the Core and the plain Framework; the compiler shows every expected failure.
- **Positive:** Core-only users pay nothing for Effect.
- **Negative:** Breaking change to every Core function, and pure queries need an `ok` check (`isSlotValid` returns `Result<boolean, InvalidParams>`).
