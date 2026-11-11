# ADR 015: The Developer's Own Writes Run Inside the Action's Transaction

**Status:** Accepted

**Date:** 2026-11-11

## Context

Developers need writes to their own data to commit or roll back together with an Action. Examples: taking a credit from a pack when a booking is made, creating an invoice that points at the booking, or refunding a credit on cancel. Such a write must also be able to stop the Action. If no credit is left, the booking must not exist. ADR 014 relies on this for limits that span Resources, which a Policy can't make race-free.

Options considered:

1. **The developer opens the transaction** and calls a scoped instance inside it (`scheduler.with(drizzleAdapter(tx)).book(…)`). This composes several Actions in one transaction, but:
   - fasti never sees the commit, so an `ok: true` can still be rolled back afterwards, and after-commit effects can't be fired;
   - writes made before the Resource Lock is taken can deadlock;
   - SQLite needs the developer to open an `immediate` transaction;
   - several Actions in one transaction take several Resource Locks, which is multi-resource atomic booking by the back door.
2. **Hooks on the instance** (`createScheduler({ hooks })`) that run on every call. A hook can't receive per-call input such as "this pack". Hooks that run on every call belong to the plugin system.
3. **A function passed on each call that fasti runs inside its own transaction.**

## Decision

We choose option 3.

- **`also`.** Every write Action (`book`, `reschedule`, `cancel`, `transition`, `availability.set`) takes an `also` function.
  - fasti takes the Resource Lock, checks the Invariants and Policies, and makes its own write. Then it calls `also` on the same transaction, before the commit.
  - It receives `{ tx, booking, previous, now }`. `previous` exists only on `reschedule`, `cancel` and `transition`. `now` is the instant the Policies saw. `availability.set` passes `{ tx, resourceId, rules, previous, now }` instead.
- **Veto.**
  - In the plain form, `also` returns the Core's `Result<A, E>`. A failure rolls everything back, and the Action returns `{ _tag: "Vetoed", reason: E }`. The developer's error is wrapped, so it can't clash with fasti's own tags.
  - A success adds `also: A` to the Action's value. Without `also`, the key doesn't exist.
  - In the Effect form, `also` returns `Effect<A, E, R>`. A failure becomes `Vetoed`, and `R` joins the Action's requirements. This is the one param where the two forms differ from ADR 010, because it is code rather than data.
- **A throw** inside `also` rolls everything back and rejects the promise (a defect in Effect). It is never an `AdapterError`, which keeps meaning that the Adapter failed.
- **A `cancel` that changes nothing** (the Booking is already cancelled) doesn't run `also`, so a refund can't happen twice. Its value is `{ booking, alreadyCancelled: true }`.
- **Adapters.** The type becomes `Adapter<Tx>`, and the `withResourceLock` handle carries `tx: Tx`: the ORM's own transaction for Drizzle and Prisma, and `undefined` for the in-memory Adapter. The Conformance Suite checks that a veto and a throw both leave no Booking behind.
- **Re-entry.** Calling an Action from inside `also` is unsupported and documented, with no runtime guard. It would take a second Resource Lock outside the transaction, and on the same Resource it deadlocks.
- **Developer Fields** need no `also`: `reschedule`, `cancel` and `transition` take a typed `fields` patch. There is no Action that only edits fields. Developer Fields don't affect scheduling, so the developer writes them directly with their ORM.

## Consequences

- **Positive:** The Resource Lock is always taken first, and fasti sees the commit, so after-commit effects can be added later without changing this API.
- **Positive:** A limit across Resources (sessions per pack) is race-free when written as a guarded update in `also` that vetoes when it changes no rows.
- **Negative:** `also` runs under the Resource Lock. A slow `also` delays every other write to that Resource.
- **Negative:** Several Actions can't share one transaction.
- **Negative:** The in-memory Adapter can't make the developer's own writes atomic, and databases without interactive transactions (Cloudflare D1) can't run `also` atomically at all.
