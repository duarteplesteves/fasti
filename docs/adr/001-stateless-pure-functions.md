# ADR 001: Core Architecture — Stateless Pure Functions

**Status:** Accepted

**Date:** 2026-05-09

## Context

We need to decide the fundamental architecture of `fasti`. The target users are developers building scheduling tools who currently rebuild slot-finding and conflict-detection logic from scratch.

## Decision

The core engine will be **stateless pure functions**. Users bring their own data (rules, bookings) and the engine returns computed results (slots, conflicts). There is no internal state, no storage adapter, and no framework lifecycle.

## Consequences

- **Positive:** Framework-agnostic, storage-agnostic, trivial to test, fully tree-shakeable.
- **Positive:** Users can layer their own state, ORM, and framework on top without fighting the engine.
- **Negative:** Users must wire up persistence themselves (this is intentional — scheduling logic is the reusable part, not persistence).
- **Future:** A higher-level `framework` layer may be built later as an optional wrapper around the core.
