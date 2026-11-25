# Schema

`defineSchema` is the one place you declare your fields, name your tables, pick the Resource id type and install [Plugins](./plugins.md). Every option has a default, so `defineSchema({})` works.

```typescript
import { availability, column, defineSchema } from "@fastijs/scheduler";

type StaffId = number & { readonly __brand: "StaffId" };

export const schema = defineSchema({
  // Your Resource ids: here your own branded integer. Default: column.text().
  resource: { idType: column.integer<StaffId>() },

  booking: {
    // Developer Fields: your own columns, typed on every Booking. fasti stores them and never reads them.
    fields: {
      customerId: { type: column.uuid(), required: true },
      note: { type: column.text(), required: false },
    },
    // Also here: `statuses`, `transitions` and `initial`. See Statuses and Transitions.
  },

  plugins: [availability()],

  // Physical names, if yours differ. Each defaults to its logical name.
  names: {
    tables: { booking: "appointments", availabilityRule: "hours" },
    columns: { booking: { start: "starts_at", end: "ends_at" } },
    statuses: { booked: "CONFIRMED", cancelled: "CANCELLED" },
  },
});
```

Code always uses the logical names; only the database sees the physical ones:

```typescript
const result = await scheduler.book({
  resourceId: staffId, // a StaffId: a plain number is a type error
  start,
  end,
  fields: { customerId }, // `note` is optional
});
// value: { id, resourceId, start, end, status: "booked", customerId, note: null }
// stored in "appointments", with starts_at, ends_at and status "CONFIRMED"
```

- **Field types:** `column.text()`, `uuid()`, `integer()`, `boolean()` and `instant()`. Give one a type argument to adopt your own brand: `column.uuid<CustomerId>()`.
- **Reserved field names:** fasti's own columns (`id`, `resourceId`, `start`, `end`, `status`), `also` and `waived`.
- **Plugin tables** are renamed the same way, by logical name: `names.tables.block`, `names.columns.block`.

Next: [Statuses and Transitions](./statuses.md), or [build the tables](./databases.md).
