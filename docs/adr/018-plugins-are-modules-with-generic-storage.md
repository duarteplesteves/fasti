# ADR 018: Plugins Are Modules With Generic Storage, and Availability and Blocks Become Plugins

**Status:** Accepted

**Date:** 2026-11-19

## Context

Availability and Blocks are already modules: each has its own table, Actions, a check and a contribution to slot finding. Waitlists, calendar sync and audit logs have the same shape. To extend the Framework without forking it, a third party must be able to build that shape. The hard part is storage. The Adapter contract is a closed set of domain verbs (ADR 008), and each new entity has added a verb group to every Adapter.

Options considered, for what a Plugin can contribute:

1. **Hooks and Policies only.** Small, but a waitlist or availability itself can't be written as a Plugin.
2. **Modules**, with their own storage and Actions as well.

And for how a Plugin's table reaches every Adapter:

1. **A generic record store in the Adapter contract.** The Plugin declares its tables as data, and every Adapter implements one verb group for any declared table.
2. **Each Plugin ships code for each Adapter.** That's every Plugin times every Adapter, and custom Adapters get no third-party Plugins.
3. **The Plugin writes through `tx` only.** It's tied to one ORM, and nothing checks it under concurrency.

## Decision

We choose modules with a generic record store.

- **A Plugin** is a named module with five optional parts: storage, Actions (under `scheduler.<name>`), Policies, free or busy time for slot finding, and Hooks (ADR 017).
- **Plugins are declared in `defineSchema({ plugins })`**, not on `createScheduler`. Tables and types both come from the schema, and tables are generated before any scheduler exists. The app's own `policies` and `hooks` stay on `createScheduler`.
- **Storage is one generic verb group** in the Adapter contract, for records that each belong to one Resource. The Resource Lock is per Resource, so a record without one couldn't be written race-free. The verbs are the ones Blocks and availability already use: get by id, list by Resource (and time range), insert, compare-and-set update, delete, and replace all of a Resource's rows. Tables are declared with the `column` helpers and built by the existing table helpers (Drizzle tables, `prismaModels`). The Conformance Suite tests the group once. This replaces ADR 008's "domain verbs only" for Plugin data. Bookings keep their own verbs and backstop.
- **Plugin Actions** get `lock` (the Resource Lock, with the Plugin's tables, `tx` and `now` inside) and `records` (reads) from fasti. They write only inside `lock`. `tx` isn't forbidden, but a Plugin that uses it works on that ORM only.
- **Plugin write Actions join `appliesTo` and `"*"`**, for the app's Hooks too (`"waitlist.join"`).
- **Availability and Blocks are rebuilt as first-party Plugins** on the same API, with no special cases left in the Framework. Availability is off until installed: without it, everything outside Bookings and Blocks is bookable, and `scheduler.availability` doesn't exist. `defineSchema({ block })` moves to `blocks({ fields })`.

Left open until checkpoint 9b starts: the generic record's shape (whether every table has a time range), how free and busy time feed slot finding, name clashes between Plugin Policies, the migration from `block`, and how custom Adapters opt into generic storage.

## Consequences

- **Positive:** A third-party Plugin runs on every Adapter, custom ones included, without its author writing per-Adapter code.
- **Positive:** Availability and Blocks prove the API: if it can't express them, it isn't finished.
- **Positive:** An app that needs no availability (a room open around the clock) stores no rules.
- **Negative:** Plugin data gets only the generic queries. A cross-Resource query needs `tx` and ties the Plugin to one ORM.
- **Negative:** Breaking changes in a `0.x` minor: existing apps add `availability()`, and `block` moves out of the schema.
- **Negative:** `defineSchema` stops being plain data (ADR 009), because Plugins carry functions.
