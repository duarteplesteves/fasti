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

## Amendment (2026-11-23): Plugins as built in checkpoint 9b

Checkpoint 9b (`0.7`) ships Plugins as decided above. It settles the five open questions, and one more about authoring:

- **The generic record's shape.** Every record has a fasti-owned `id` (UUIDv7, minted by fasti, branded per table as `RecordId<table>`; `BlockId` is `RecordId<"block">`) and `resourceId`. A table may be `timed`, which adds fasti-owned `start` and `end` and lets `list` take a half-open `overlapping` range. An untimed table (rules, a waitlist) has no times and is listed by Resource only. Declared columns are `Fields`, as Developer Fields are, and can't be named `id`, `resourceId`, `start` or `end`. Four column kinds join the `column` helpers for Plugins: `date`, `time`, `json<T>` and `dates`.
- **Free and busy time.** There is no mechanism for free time: a Plugin that limits when you can book brings a Policy, as `availability()` does. Busy time is a new part, a function from a range to `{ id, start, end }[]` tagged with a `kind`. It feeds the existing overlap Invariant and `findSlots` through the one place occupants enter the Core, and a `SlotConflict` names the `kind`. It's a function, not a table, so busy time can be computed (recurring Blocks). Busy time may overlap busy time. Plugins can't define new Invariants, only feed this one.
- **The reverse check is the Plugin's job.** fasti refuses a Booking over busy time, but can't see busy time being written. Inside `lock`, `conflicts({ start, end })` returns the blocking Bookings in the range, and a Plugin that writes busy time must refuse over them, as `blocks.create` does. Plugins are trusted code, like an Adapter, and the README says so.
- **Name clashes.** Plugin names, table names and Policy names each live in one flat namespace. A clash is a type error and a throw: in `defineSchema` for Plugins (also against scheduler keys such as `book`) and tables (also against `booking`), and in `createScheduler`/`layer` for Policies. This keeps `relax: ["availability"]` unchanged, and replaces `definePolicy`'s special ban on the name `availability`.
- **Plugin parts name no Transition edges.** A Plugin is defined before the schema, so it can't know the app's Statuses. Its Policies apply to `book`, `reschedule` and `cancel`; its Hooks to those, its own write Actions, or `"*"`. The app's own Policies and Hooks keep edges, and the app's `appliesTo` gains every installed Plugin's write Actions (`"blocks.create"`).
- **The migration.** `availability()` and `blocks({ fields })` build tables with `0.6`'s names, columns, types, nullability and foreign keys, checked against a `0.6` snapshot in CI, so upgrading needs no database migration. Code changes are in the changeset. Drizzle's `blockTable` and `availabilityRuleTable` stay one minor as deprecated aliases of `recordTables`.
- **How custom Adapters opt in.** One verb group, `"records"`, keyed by table name, replaces the `"blocks"` group and the base `getRules`/`replaceRules`: `getRecord` and `listRecords` on both handles, and `insertRecord`, `updateRecord` (compare-and-set), `deleteRecord` and `replaceRecords` on the locked one. `GroupsOf<S>` requires it exactly when an installed Plugin declares tables. The Conformance Suite tests it once, on `conformancePlugin`'s timed and untimed tables (ADR 008 amendment).

**Authoring: Effect-native, with a Promise face.** This applies ADR 010's "one Effect core, two faces" to people writing Plugins.

- **The native API is Effect** (`definePlugin` from `@fastijs/scheduler/effect`). `run`, `work`, `load` and `list` return Effects, and `lock` is the existing write unit, bound to the call's `also`. Services, the Clock, cancellation and typed errors flow with no conversion, and Plugin writes get `also`, Vetoes, Hooks and retries exactly as `book` does, with no new code path. `availability()` and `blocks()` are written this way, which let them move over nearly verbatim.
- **The Promise face** (`definePlugin` from the root) takes plain async functions returning `Result`-shaped values, so authors never need Effect. It wraps them into the native shape once, inside `definePlugin`: the caller's services, Logger and `AbortSignal` cross there, and nowhere else. Both build the same `Plugin` value, and its Actions appear in both scheduler forms. The test-only Plugins exist in both styles and pass the same tests.
- **Rejected:** a Promise-only API, where every call crosses between Effect and Promises twice and the first-party Plugins are rewritten; and declarative write Actions (`check`/`locate`/`work`), which force one unit per Action and three callbacks per write. The latter stayed the fallback for the Promise face, and wasn't needed.

**Typing.** A Plugin's types can't mention the schema, so its Resource id is the placeholder `PluginResourceId`, which the app's types replace deeply with the schema's Resource id type. A type lambda per Plugin was the fallback, and wasn't needed. A CI step (`typecheck:budget`) fails when a fixture with the built-in Plugins plus three more exceeds 145% of `0.6`'s type instantiations, or hits "excessively deep". It was set at 125% in the tracer and raised as busy time, Plugin Policies and Plugin Hooks landed; most of the rise is fasti's own source, which the no-Plugin baseline shows too. Actions take `run(params, tools)`, with the params type written on the first parameter, because TypeScript can't infer it from one property of a destructured context.

**Not yet:** an app Policy's `load` can't read Plugin tables (`reads` lost `getRules` and `listBlocks`), and the Promise face's `records` has `insert` only, with `update`, `delete` and `replace` on the native API only.

## Note (2026-11-23): busy-time writes stay unchecked by fasti

A security review (deepsec finding `d77c31ce75`) flagged that a Plugin can write busy time over a blocking Booking, because fasti doesn't check busy-time writes. We reviewed it and accept the risk, keeping the decision above: the reverse check is the Plugin's job, done with `conflicts()` inside `lock`, and Plugins are trusted code, like an Adapter. Checking every busy write in fasti would need fasti to see Plugin writes as busy time, which a computed busy source can't offer.

## Amendment (2026-11-24): fasti's tables are indexed by Resource and start

Every Adapter's tables now declare an index on the Resource id and `start` (`<table>_resource_start_idx`), or on the Resource id alone for an untimed Plugin table (`<table>_resource_idx`), named from the physical table so switching ORM needs no migration. Without it, reads of one Resource's rows scan the whole table, some while holding the Resource Lock. This ships in a minor after `0.7`, so the promise that `0.6` to `0.7` needs no migration holds. The parity tests now allow this one difference from `0.6`. fasti works without the indexes, only slower.
