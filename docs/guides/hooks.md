# Hooks

[`also`](./also.md) runs at one call site. A Hook is registered once and runs on every write it applies to, wherever it's called from: a confirmation email for every new Booking, an audit row for every change ([ADR 017](../adr/017-hooks-observe-write-actions.md)). Put side effects in Hooks, so a new call site can't forget them.

A Hook only observes: it can't change an Action's params, value or errors, or refuse one. To refuse, use a [Policy](./policies.md) or `also`.

|                     | `inTransaction`                      | `afterCommit`                       |
| ------------------- | ------------------------------------ | ----------------------------------- |
| Good for            | Audit rows, outbox rows              | Emails, webhooks, cache busting     |
| Gets `tx`           | Yes                                  | No: the transaction is gone         |
| Runs                | Maybe more than once, on a retry     | Once, after the final commit        |
| If it throws        | The whole write rolls back           | It's logged; the write stays saved  |
| The Action waits    | Yes, holding the Resource Lock       | Yes, with the lock released         |

## In the transaction

```typescript
import { createScheduler, defineHook } from "@fastijs/scheduler";

const adapter = drizzleAdapter(db);

// Every change to a Booking leaves a row in an audit table of your own.
const audit = defineHook(schema, adapter, {
  when: "inTransaction",
  appliesTo: ["book", "reschedule", "cancel"],
  run: async ({ action, booking, now, tx }) => {
    await tx.insert(auditLog).values({
      action,
      at: new Date(now.epochMilliseconds),
      bookingId: booking.id,
    });
  },
});
```

- It runs on the Action's `tx`, after `also`, under the Resource Lock: a slow one delays every other write to that Resource.
- A throw rolls the whole write back (fasti's, `also`'s, and the Hooks' before it), and the Action rejects with what was thrown (a defect in the Effect form).
- Like `also`, it may run more than once, so write only through `tx`.

## After the commit

```typescript
const confirm = defineHook(schema, adapter, {
  when: "afterCommit",
  appliesTo: ["book"],
  run: async ({ booking }) => {
    await sendConfirmation(booking);
  },
});

const scheduler = createScheduler({ adapter, hooks: [audit, confirm], schema });
```

- A failure never changes the result: the write is already saved. It's logged at error level through Effect's logger (the console, or your own `Logger` in the Effect form), annotated with `action`, and the next Hook still runs.
- The Action waits for it, so a slow email provider slows `book`. In return, on a serverless platform it has finished before you respond, and a test knows when it's done.

### When it must never be lost

An after-commit Hook isn't retried. If the process dies between the commit and the Hook, the email is never sent, though the Booking is saved. Instead, insert an outbox row in the transaction, and send it from a background job:

```typescript
const outbox = defineHook(schema, adapter, {
  when: "inTransaction",
  appliesTo: ["book"],
  run: async ({ booking, tx }) => {
    await tx.insert(emailOutbox).values({ template: "confirmation", bookingId: booking.id });
  },
});
```

After an interrupt (Effect form), after-commit Hooks run in the background, so a serverless platform that freezes the function once it responds can still lose them.

## `appliesTo`

At least one target, or `"*"`:

| Target                          | Runs on                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `"book"`, `"reschedule"`, `"cancel"`, `"transition"` | that Action                                            |
| `"availability.set"`, `"blocks.create"`, `"<plugin>.<action>"` | an installed Plugin's write Action           |
| `{ to: "noShow" }`              | every declared Transition into that Status                                  |
| `{ from: "booked", to: "noShow" }` | that one Transition                                                      |
| `"*"`                           | every write Action, Plugins' included, and ones a later schema change adds  |

Transitions into `cancelled` belong to `"cancel"`. An unknown name, a Plugin that isn't installed, an undeclared Transition or an empty `appliesTo` is a type error, and `defineHook` throws on it.

`run` gets what that Action's [`also` gets](./also.md#what-it-gets), plus `action`. Narrow on `action` when a Hook has several targets:

```typescript
const log = defineHook(schema, adapter, {
  when: "afterCommit",
  appliesTo: ["book", "reschedule"],
  run: (event) => {
    if (event.action === "reschedule") {
      console.log(`moved from ${event.previous.start} to ${event.booking.start}`);
    } else {
      console.log(`booked at ${event.booking.start}`);
    }
  },
});
```

A Transition's event has `action: "transition"`.

## Order

`also` → in-transaction Hooks → commit → after-commit Hooks.

- Within each kind, Plugins' Hooks run first, in Plugin order, then yours, in `hooks` order. Each in-transaction Hook sees the earlier ones' writes on `tx`.
- A Hook runs only when something was saved: never on a veto, a typed failure such as `SlotConflict`, or a repeat `cancel`. A `blocks.update` that changes nothing still runs them. Reads run no Hooks.
- Hooks run whether or not the call passed `also`, and add nothing to the Action's value or types.

## The `adapter` argument

`defineHook` takes the Adapter only to type `tx`; it never calls it. An in-transaction Hook fits only a scheduler over an Adapter with the same `tx`; an after-commit one fits any.

In the Effect form, pass `hooks` to `layer`: `AppScheduler.layer({ adapter, hooks: [audit, confirm], schema })`. `run` stays a plain function there.
