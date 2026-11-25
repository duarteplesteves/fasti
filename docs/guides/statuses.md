# Statuses and Transitions

Every Booking has a Status. Two ship with fasti: `booked`, which blocks its slot, and `cancelled`, which doesn't. Declare your own, and the Transitions between them, in `defineSchema` ([ADR 009](../adr/009-booking-lifecycle.md)):

```typescript
export const schema = defineSchema({
  booking: {
    fields: { customerName: { type: column.text(), required: true } },
    statuses: {
      request: { blocking: false }, // doesn't hold its slot
      inProgress: { blocking: true },
      done: { blocking: false },
      noShow: { blocking: false },
    },
    transitions: {
      request: ["booked", "cancelled"],
      booked: ["inProgress", "noShow"], // booked → cancelled is always there
      inProgress: ["done"], // can't be cancelled
      cancelled: ["booked"], // un-cancel
    },
    initial: ["booked", "request"], // the Statuses `book` may create in; default ["booked"]
  },
});
```

That schema declares this lifecycle:

```text
 (book) ──► request ──► booked ──► inProgress ──► done
                 │       │ ▲  └──► noShow
                 ▼       ▼ │
                 └──► cancelled

 (book) ──► booked, too: `initial` lists both
```

Using it:

```typescript
// `status` is required here, since `initial` has two.
const request = await scheduler.book({ ...slot, fields, status: "request" });

// Accept it. Moving into a blocking Status checks overlap again, so this can be a SlotConflict.
await scheduler.transition({ id, from: "request", to: "booked" });

await scheduler.transition({ id, from: "booked", to: "done" }); // type error: no booked → done

// cancel is the only way into `cancelled`.
await scheduler.cancel({ id });
```

## Rules

- **`blocking` is all fasti reads.** A blocking Status takes part in the overlap check, `findSlots` and the [backstop](./databases.md#the-backstop). A non-blocking one leaves its slot free.
- **Booking into a non-blocking Status** skips the overlap check, so two requests can be for the same slot. Availability still applies.
- **Terminal Statuses** are those with no Transitions leaving them, such as `done`.
- **`cancel`** works only from a Status with a Transition to `cancelled`. From any other, it's `TransitionNotDeclared`.
- **`scheduler.transition`** exists when some declared Transition doesn't end in `cancelled`.
- **Stored values** can be renamed under `names.statuses`, the base ones included.
- **Mistakes are type errors**, and throw in `defineSchema`: redeclaring `booked` or `cancelled`, naming an unknown Status, or two Statuses sharing a stored value.

To put a condition on a Transition, such as "a no-show only after the start", use a [Policy on the edge](./policies.md#on-transitions).

## Changing Statuses later

On Drizzle and Prisma, adding a Status or flipping its `blocking` needs a migration. Your migration tool generates the `CHECK` change, but [the backstop](./databases.md#the-backstop) you redo by hand. If you don't:

- a new blocking Status isn't covered by the backstop;
- a Status flipped to non-blocking still has its overlaps refused, as `SlotConflict`.
