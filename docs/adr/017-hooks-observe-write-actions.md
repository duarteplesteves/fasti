# ADR 017: Hooks Observe Write Actions, Inside the Transaction or After the Commit

**Status:** Accepted

**Date:** 2026-11-19

## Context

Some code must run on every write, whatever the call site: a confirmation email for every new Booking, a calendar event for every move, an audit row for every change. `also` (ADR 015) runs per call, so each call site would have to remember it, and it runs before the commit, so an email sent from it can describe a Booking that a failed or retried commit never saved. Code written after `await scheduler.book(…)` already runs after the commit, but only at that one call site.

Options considered:

1. **A per-call `afterCommit` param** next to `also`. It does what the code after the `await` already does, and still has to be repeated at every call site.
2. **An onion pipeline** (`wrap(action, next)`, as in files-sdk). A wrapper could change params, skip `next` or replace the result, and so get around the Invariants, `relax`, or the order in which the Resource Lock is taken.
3. **Hooks registered once on the instance that observe write Actions**, inside the transaction or after the commit.

## Decision

We choose option 3.

- **Shape.** `defineHook(schema, { when, appliesTo, run })`, passed as `hooks` on `createScheduler` and `Scheduler.layer`. `hooks` is optional. `run` is a plain function returning `void | Promise<void>` in both forms, as a Policy's `load` and `check` are (ADR 014).
- **Observers only.** A Hook never changes an Action's params, value or errors, and can't Veto. A refusal belongs in a Policy or in `also`. Hooks add nothing to the `Scheduler` types.
- **What a Hook listens to.** `appliesTo` takes write Action names (`"book"`, `"reschedule"`, `"cancel"`, `"availability.set"`, `"blocks.create"`, …) and Transition edges, as a Policy's does, or `"*"` for every write Action. Unlike Policies, which ban a wildcard (ADR 014), Hooks allow one: a Policy applied by surprise refuses Bookings, while an audit log applied by surprise to a new edge is what the developer wants. Reads run no Hooks.
- **Context.** `run` gets what `also` gets for that Action (ADR 015), plus `action`, narrowed by `appliesTo`. After-commit Hooks get no `tx`.
- **Order.** `also` → in-transaction Hooks → commit → after-commit Hooks. Hooks from Plugins run first, in Plugin order, then the app's own, in array order. Each in-transaction Hook sees the earlier ones' writes on the same `tx`. Hooks have no names, and nothing guards against two Hooks doing the same thing.
- **`when: "inTransaction"`.** A throw rolls back the whole unit (fasti's write, `also` and earlier Hooks) and rejects the promise (a defect in the Effect form), like a throw in `also`. When the Adapter retries a unit, the Hook runs again, so it writes only through `tx`.
- **`when: "afterCommit"`.** It runs once, after the final commit, and is awaited before the Action returns. A failure is logged through Effect's logger and never changes the result, because the change is already saved.
- **No Hook runs** when nothing was saved: a Vetoed `also`, a failed check, or a repeat `cancel`.
- **No per-call `afterCommit` param.** Code after the `await` is the per-call form.

## Consequences

- **Positive:** Cross-cutting work is registered once, and Hooks can't weaken any check.
- **Positive:** On serverless platforms, which freeze a function once it responds, after-commit work still runs, and tests know when it has finished.
- **Negative:** Awaited after-commit Hooks add their time to every write's latency. A slow email provider slows `book`.
- **Negative:** After-commit Hooks are best effort. A crash between the commit and the Hook loses it. A Hook that must never be lost writes an outbox row from an in-transaction Hook instead.
- **Negative:** In-transaction Hooks run under the Resource Lock, so a slow one delays every other write to that Resource, as a slow `also` does.

## Amendment (2026-11-20): Hooks as built in checkpoint 9a

- **`defineHook(schema, adapter, { when, appliesTo, run })`.** The `adapter` argument only types an in-transaction Hook's `tx`: it is never called. Without it, `tx` could only be typed by a cast or a type argument the developer writes by hand (ADR 010's amendment rules out the cast). A Hook is typed by its `when`, so an after-commit Hook, which gets no `tx`, fits a scheduler over any Adapter, while an in-transaction one fits only a scheduler over an Adapter with the same `Tx`.
- **An after-commit failure is logged, and the next Hook still runs.** It goes to Effect's logger at error level (`"fasti: an after-commit Hook failed"`, annotated with `action`): the default console logger in the plain form, the caller's own `Logger` in the Effect form. One failing Hook, such as an email provider being down, must not stop an unrelated audit Hook after it. An interrupt isn't a Hook failure, and stops the rest.
- **Hooks are matched per call.** Each saved write filters `hooks` by `appliesTo` against the Action it ran, or the edge it took for a `transition`. Edge Hooks can't be matched ahead of the call, since the edge depends on the stored Status, and the list is small. No behaviour can tell this from matching once in `createScheduler`.

## Amendment (2026-11-24): Hooks outlive an interrupted caller

- **The unit and its after-commit Hooks run on a detached fiber that the caller waits for.** Interrupting the caller stops the wait only, at any point, a running Hook included: the unit still commits or rolls back on its own outcome, and after a commit every Hook runs. Before, the unit committed and its Hooks never ran. This replaces "an interrupt stops the rest" above for an interrupt of the caller.
- **The Hooks keep the caller's services and Logger.** A service scoped to the request may be closed by the time they run.
- **They are still best effort.** Hooks running in the background are lost when the process or a serverless function stops.
- **Rejected:** only documenting the loss, since a timeout is far more common than a crash; and an uninterruptible call, since a timeout would wait for the Hooks, and a Hook that hangs would hang the caller.
