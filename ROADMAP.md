# ROADMAP — fasti

The milestone plan from the v0.1 Core to a finished **Framework**: persistence through an **Adapter**, booking **Actions**, and a base lifecycle. Terms are defined in [`GLOSSARY.md`](./GLOSSARY.md); decisions are in [`docs/adr/`](./docs/adr/).

## Versions

- **Internal checkpoints** before `0.1.0` were tagged `v0.1.0-next.N` and published under the `next` dist-tag. Since `0.1.0`, Changesets versions every release: merging the Version PR publishes to `latest` and tags it. There are no more `next` prereleases.
- **Public releases** are `0.x` on `latest`, starting with `0.1.0`: the Core plus a thin `createScheduler` slice.
- **`1.0.0`** is the finished Framework.

Milestones marked _open_ carry questions that get decided when that milestone starts, before any of its building begins.

---

## 1. Claim the name — `0.1.0-next.0` (internal)

**Goal:** own the `@fastijs` npm scope by publishing today's Core, unchanged, under its new name.

**Scope:**

- Rename `better-schedule` → `fasti` everywhere: `package.json`, README, `GLOSSARY.md`, docs, the GitHub repo (GitHub redirects the old URL), and the `better-schedule/core` import path → `@fastijs/scheduler/core`.
- Package layout per [ADR 012](./docs/adr/012-one-package-with-subpaths.md), limited to what exists: export `@fastijs/scheduler/core` only. No root `@fastijs/scheduler` export until the Framework exists.
- A first GitHub Actions CI workflow: lint, typecheck, unit and property tests, build, `publint`, `attw`.
- The README notes that `latest` is a prerelease until `0.1.0`.
- A manual `npm publish --tag next --access public` as `@fastijs/scheduler` (npm rejects unscoped `fasti` as too similar to `fastify` and `fastq`; see ADR 012). Trusted publishing can only be set up once the package exists.

**Not in scope:** any Core API change, including the fix for [findFreeSlots ignores the time of day in from/to](https://github.com/duarteplesteves/fasti/issues/19).

**Test of done:** CI is green on `main`; `npm view @fastijs/scheduler dist-tags` shows `next: 0.1.0-next.0`; the tag `v0.1.0-next.0` is pushed.

## 2. Core reshaped — `0.1.0-next.N` (internal)

**Goal:** settle the Core's public signatures once, before anything is built on them.

**Scope:**

- Every entry point returns `Result` with `InvalidParams`, and `checkRule` is exported ([ADR 011](./docs/adr/011-effect-free-core-returns-results.md)).
- One slot grid from local midnight, with required `interval` and `timezone` ([ADR 014](./docs/adr/014-invariants-and-relaxable-policies.md)).
- The fix for [findFreeSlots ignores the time of day in from/to](https://github.com/duarteplesteves/fasti/issues/19).
- Recurrence is stored as one `frequency`-discriminated value, so a new frequency needs no migration.
- Excluding one Booking from the conflict check, needed for rescheduling.
- `waived` tagging per slot.
- Branded ids in the Core's public types, for ids the Framework owns.

**Test of done:** unit and property tests pass; `@fastijs/scheduler/core` has zero runtime dependencies; `publint` and `attw` pass.

## 3. Adapter contract — `0.1.0-next.N` (internal)

**Goal:** prove the Adapter contract on a real database before any Action exists.

**Scope:**

- `@fastijs/scheduler`: `defineSchema` and the `column` helpers.
- `@fastijs/scheduler/adapter`: the contract types ([ADR 008](./docs/adr/008-adapter-contract.md)).
- `@fastijs/scheduler/memory`: the in-memory Adapter.
- `@fastijs/scheduler/testing`: the Conformance Suite.
- `@fastijs/scheduler/drizzle/pg`: the Drizzle Adapter on Postgres.
- A CI job with a Postgres 18 service container ([ADR 013](./docs/adr/013-integration-tests-on-real-databases.md)).

**Test of done:** the Conformance Suite passes on the in-memory and Drizzle Postgres Adapters, and the lock-off negative control fails as expected (`test.fails`).

## 4. Thin Framework — `0.1.0` (public)

**Goal:** the first public release: the Core plus a thin `createScheduler` slice.

**Scope:**

- `createScheduler({ schema, adapter })` with `book`, `cancel`, `findSlots` and `scheduler.availability.set/get`, in both the plain form and the `@fastijs/scheduler/effect` form ([ADR 010](./docs/adr/010-action-results-and-two-forms.md)).
- The two base Statuses (`booked`, `cancelled`), the overlap invariant, and the always-present `availability` Policy.
- Docs: a README quickstart, TSDoc on every public export, and an `examples/` app.
- Release infrastructure:
  - Changesets for versions and changelogs.
  - npm trusted publishing with provenance from GitHub Actions; no more manual publishes.
  - Bun added next to Node 26 in the unit-test matrix; Conformance stays on Node 26.
  - Databases: latest versions only.

**Test of done:** the Conformance Suite on Postgres and the `examples/` app both run green in CI; `0.1.0` is published on `latest` by the release workflow.

## 5. Blocks — `0.2` (public)

**Goal:** periods when a Resource isn't bookable, beyond availability-rule exceptions. This comes first after the public release because it touches the Logical Model, so it should land while few developers have tables to migrate.

**Scope** ([ADR 016](./docs/adr/016-block-is-its-own-entity.md)):

- The **Block**: its own Logical Model entity with its own Developer Fields, opt-in through `defineSchema({ block: { fields } })`. One-off `[start, end)` Instant ranges; no Status, no recurrence.
- The overlap Invariant covers Blocks both ways, under the Resource Lock: `book` can't overlap a Block, and a Block can't be written over a blocking Booking. `findSlots` hides slots that overlap a Block.
- `scheduler.blocks.create / update / delete / list`, in both forms.
- `SlotConflict` items carry `kind: "booking" | "block"` (a breaking type change, flagged in the changeset).
- The optional Block verb group in the Adapter contract, required by the types exactly when the schema declares `block`; `blockTable(schema)` in the Drizzle Adapter; the in-memory Adapter; an optional Blocks group in the Conformance Suite.
- No Core change.

**Test of done:** the Conformance Suite, Blocks group included, passes on the in-memory and Drizzle Postgres Adapters.

## 6. Full lifecycle — `0.3` (public)

**Goal:** the complete base lifecycle.

**Scope:** `reschedule`, `transition({ id, from, to })`, developer Statuses ([ADR 009](./docs/adr/009-booking-lifecycle.md)), and `also` on every write Action ([ADR 015](./docs/adr/015-developer-writes-inside-the-action-transaction.md)). Spec: [#98](https://github.com/duarteplesteves/fasti/issues/98).

## 7. Policies — `0.4` (public)

**Goal:** the developer's own booking rules.

**Scope:** `definePolicy`, the required `policies` list, per-call `relax` and `waived`, and the prebuilt `notice` Policy ([ADR 014](./docs/adr/014-invariants-and-relaxable-policies.md)). This milestone comes after the lifecycle because `relax` is typed per Action and per Transition edge.

## 8. Adapter breadth — `0.5` (public)

**Goal:** the rest of the first-party Adapters.

**Scope:** `@fastijs/scheduler/drizzle/sqlite`; `@fastijs/scheduler/prisma` on Prisma 8. Prisma 8 is an RC (GA expected Dec 2026–Jan 2027). If it isn't GA by `1.0`, the Prisma Adapter ships marked experimental, and the label goes in a `1.x` once GA lands.

**Test of done:** the Conformance Suite passes on each new Adapter in CI.

## 9. Plugin system — `0.6` (public)

**Goal:** extend the Framework without forking it.

**Open:**

- Hooks or an ordered pipeline.
- How plugins extend types.
- After-commit effects of Actions and Transitions (emails, calendar sync): best effort, never rolled back.
- Hooks that run on every call, such as an audit log.
- Whether availability (its rules, its Actions and its `availability` Policy) becomes a plugin the developer turns on, and whether Blocks, opt-in through the schema since `0.2`, move to the same mechanism. Without availability, everything outside Blocks and Bookings is bookable.

## 10. Finished Framework — `1.0.0` (public)

**Goal:** a stable Framework.

**Scope:**

- A docs website in a `website/` folder of this repo, with code samples type-checked in CI. **Open:** the tool and the hosting.
- An API freeze.
- No milestone above left with an open question.

---

## Beyond the Framework

Deferred past `1.0`, in no order.

- **Capacity > 1.** Guard: nothing in the Adapter contract or Conformance Suite assumes capacity 1; the Postgres `EXCLUDE` backstop is documented as capacity-1 only.
- **Multi-resource atomic bookings.** Workaround: several `book` calls linked by a Developer Field such as `groupId`.
- **Multi-resource convenience Actions** ("find any free Resource", e.g. `findFirstAvailableSlot`), built on single-resource queries ([ADR 006](./docs/adr/006-single-resource-scoping.md)).
- **Buffers**, as a Policy. Workaround: inflate the booking's duration.
- **Monthly recurrence.** Guard: recurrence is already one `frequency`-discriminated value (milestone 2).
- **Recurring booking series.**
- **Holds that expire**: a Status that blocks only until a deadline; it has to fit with ADR 009's "blocking comes from Status alone".
- **Cloudflare D1**: no interactive transactions, so no Resource Lock. Likeliest route: a Durable Object per Resource as the lock.
- **Cross-day availability windows.** Workaround: two rules.
- **DST fall-back double-occurrence opt-in** ([ADR 005](./docs/adr/005-dst-policy.md)).
- **Continuous slots**: free intervals instead of a grid.
- **Performance benchmarks.**
- **First-party integration plugins** (email, SMS, payments, calendar sync).
- **Waitlists**, as an after-commit effect of `cancel`.
- **Date overrides**: one date's hours changed, adding or removing time, as part of AvailabilityRule and so relaxable through the `availability` Policy. Today's whole-day `exceptions` are the crude form.
- **Block writes that cancel overlapping Bookings**: opt-in per call, in the same unit of work, instead of being refused. Deferred from milestone 6. Workaround: `cancel` the Bookings, then create the Block; a Booking made in between gets the Block refused, which fails safe.
- **Recurring Blocks**, using AvailabilityRule's `frequency`-discriminated recurrence. They matter once availability can be turned off (milestone 9); until then, recurring busy time can be left out of the rules. Guard: `SlotConflict`'s `kind: "block"` doesn't assume a Block is one stored row.
