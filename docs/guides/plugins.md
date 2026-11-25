# Plugins

A Plugin extends fasti without forking it: a waitlist, public holidays, a calendar sync, an audit log ([ADR 018](../adr/018-plugins-are-modules-with-generic-storage.md)). Install it in `defineSchema({ plugins })`. It can bring any of five parts:

| Part          | What it is                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Tables**    | Declared as data with the `column` helpers. Every Adapter stores them, and your table helpers (`recordTables`, `prismaModels`) build them. |
| **Actions**   | On `scheduler.<plugin>.<action>`, in both the plain and the Effect forms.                                                         |
| **Busy time** | Ranges on a Resource that no Booking may overlap.                                                                                 |
| **Policies**  | Rules about when a booking change is allowed, which a caller can relax by name.                                                   |
| **Hooks**     | As `defineHook`'s, run before yours.                                                                                              |

`availability()` and `blocks()` are Plugins built this way, with nothing special about them.

> Plugins are trusted code, like an Adapter: install only ones you'd let write to your database.

- [A small one](#a-small-one)
- [A full one: `holidays`](#a-full-one-holidays)
- [Busy time or a Policy?](#busy-time-or-a-policy)
- Reference: [tables](#tables), [Actions](#actions), [Hooks](#hooks), [names](#names)
- [In Effect](#in-effect)

## A small one

A Plugin needs only a `name` and `actions`, which can be empty. Busy time needn't be stored, either. This one closes every Resource on New Year's Day:

```typescript
import { createScheduler, definePlugin, defineSchema } from "@fastijs/scheduler";

const newYear = definePlugin({
  name: "newYear",
  actions: {},
  busy: {
    kind: "newYear",
    // The busy ranges that overlap `[from, to)`: computed here, not stored.
    list: async ({ overlapping: { from, to } }) => {
      const first = from.toZonedDateTimeISO("Europe/Lisbon").year;
      const last = to.toZonedDateTimeISO("Europe/Lisbon").year;

      return Array.from({ length: last - first + 1 }, (_, i) => {
        const start = Temporal.ZonedDateTime.from(`${first + i}-01-01T00:00[Europe/Lisbon]`);

        return {
          id: `new-year-${first + i}`,
          start: start.toInstant(),
          end: start.add({ days: 1 }).toInstant(),
        };
      }).filter(
        (day) =>
          Temporal.Instant.compare(day.start, to) < 0 &&
          Temporal.Instant.compare(from, day.end) < 0
      );
    },
  },
});

const schema = defineSchema({ plugins: [newYear] });
const scheduler = createScheduler({ adapter, schema });

await scheduler.book({ resourceId: "room-1", start: newYearsMorning, end: newYearsNoon });
// SlotConflict: [{ kind: "newYear", id: "new-year-2031", start, end }]
```

## A full one: `holidays`

`definePlugin` from `@fastijs/scheduler` takes plain async functions; you never need Effect. This Plugin, from [`examples/basic`](../../examples/basic/holidays.ts), uses all five parts to store holidays on a Resource:

```typescript
import { column, definePlugin, ok } from "@fastijs/scheduler";
import type { PluginResourceId, RecordId } from "@fastijs/scheduler";

export function holidays({ eveHours }: { readonly eveHours: number }) {
  return definePlugin({
    name: "holidays", // → scheduler.holidays
    tables: {
      // A timed table: fasti adds and owns `id`, `resourceId`, `start` and `end`.
      holiday: {
        columns: { name: { required: true, type: column.text() } },
        timed: true,
      },
    },
    actions: {
      add: {
        kind: "write",
        // Type the params on `run`; PluginResourceId becomes the schema's Resource id type.
        run: async (
          params: {
            readonly resourceId: PluginResourceId;
            readonly start: Temporal.Instant;
            readonly end: Temporal.Instant;
            readonly name: string;
          },
          { lock }
        ) =>
          // One unit of work under the Resource Lock: the caller's `also` and the Hooks run on it.
          await lock(params.resourceId, async ({ conflicts, records }) => {
            // Busy time must not cover a Booking: checking that is this Plugin's job.
            const hits = await conflicts(params);

            if (hits.length > 0) {
              return {
                _tag: "Failed",
                error: { _tag: "SlotConflict", conflicts: hits },
              } as const;
            }

            const holiday = await records.holiday.insert(params);

            return {
              _tag: "Done",
              context: { holiday }, // what `also` and the Hooks get
              value: holiday,
            } as const;
          }),
      },
      list: {
        kind: "read",
        run: async (
          params: { readonly resourceId: PluginResourceId },
          { records }
        ) => ok(await records.holiday.list({ resourceId: params.resourceId })),
      },
    },
    // Busy time: `book` refuses it with SlotConflict { kind: "holiday" }, and findSlots skips it. Nobody can relax it.
    busy: {
      kind: "holiday",
      list: async ({ overlapping, records, resourceId }) =>
        await records.holiday.list({ overlapping, resourceId }),
    },
    // A Policy: no Booking ending within `eveHours` of a holiday. Callers can relax it by name.
    policies: [
      {
        appliesTo: ["book", "reschedule"],
        check: (
          _candidate,
          next: readonly { readonly id: RecordId<"holiday"> }[]
        ) => (next[0] === undefined ? null : { holiday: next[0].id }),
        load: async ({ records, resourceId, to }) =>
          await records.holiday.list({
            overlapping: { from: to, to: to.add({ hours: eveHours }) },
            resourceId,
          }),
        name: "holidayEve",
      },
    ],
    hooks: [
      {
        appliesTo: ["holidays.add"],
        run: (event) => {
          if (event.action === "holidays.add") {
            console.log(`holiday added: ${event.holiday.name}`);
          }
        },
        when: "afterCommit",
      },
    ],
  });
}
```

Install it, migrate its table (`recordTables(schema)` includes `holiday`), and its Actions are typed like fasti's own:

```typescript
const schema = defineSchema({
  booking: { fields: { customerName: { required: true, type: column.text() } } },
  plugins: [availability(), holidays({ eveHours: 12 })],
});

const holiday = await scheduler.holidays.add({ resourceId, start, end, name: "Santo António" });
// { ok: true, value: { id, resourceId, start, end, name } }, or SlotConflict, Vetoed, AdapterError

await scheduler.book({ ...onTheHoliday, fields }); // SlotConflict: [{ kind: "holiday", id, start, end }]
await scheduler.book({ ...theEveBefore, fields }); // PolicyViolation: [{ policy: "holidayEve", detail: { holiday } }]
await scheduler.book({ ...theEveBefore, fields, relax: ["holidayEve"] }); // ok, with `waived`
```

## Busy time or a Policy?

A Plugin that says "not then" picks one:

|                  | Busy time                              | Policy                                       |
| ---------------- | -------------------------------------- | -------------------------------------------- |
| It means         | *Something is already there*           | *You're not supposed to then*                |
| Fails as         | `SlotConflict`, with the Plugin's `kind` | `PolicyViolation`, with the Policy's name  |
| Can be relaxed   | Never                                  | By name, and reported in `waived`            |
| In `findSlots`   | Skipped                                | Skipped, unless relaxed                      |
| Example          | Blocks, holidays                       | Opening hours, the eve of a holiday          |

- **Busy time** joins blocking Bookings in the overlap Invariant, for `book`, `reschedule` and a Transition into a blocking Status. It may overlap other busy time, from the same Plugin or another. `list` is a function over a range, so it can come from a table or be computed.
- **A Plugin Policy** applies to `"book"`, `"reschedule"` or `"cancel"`, never to Transitions, since a Plugin can't know your Statuses. It runs after the Invariants and before your own Policies, in Plugin order.

### Check `conflicts` before writing busy time

Busy time stops new Bookings from landing on it, but nothing stops busy time from landing on an existing Booking except the Plugin itself. Inside `lock`, `conflicts({ start, end })` returns the blocking Bookings in that range. `blocks.create` and `holidays.add` refuse with `SlotConflict` when it isn't empty.

> **A Plugin that writes busy time without calling `conflicts` can overlap a Booking**, and fasti won't notice: no database constraint spans the two tables. Check that a Plugin you install does it.

## Tables

- **Every record** has a fasti-owned `resourceId` and `id`: a UUIDv7, branded per table (`RecordId<"holiday">`), so a holiday id can't pass for a Block's.
- **A `timed: true` table** also gets `start` and `end`, and `list` takes `overlapping` (half-open), sorted by start, then id. An untimed one is listed by Resource only, sorted by id.
- **Column kinds:** `text`, `uuid`, `integer`, `boolean`, `instant`, and for Plugins `date` (`Temporal.PlainDate`), `time` (`Temporal.PlainTime`), `json<T>()` and `dates` (a list of `PlainDate`). An optional column is `null` when unset, and `insert` takes it as `null`.
- **Writes** exist only on the `records` inside `lock`; the `records` an Action gets outside it only read. Reads inside `lock` see the unit's own writes.
- **With plain async functions**, `records` inside `lock` can `insert`. `update` (compare-and-set), `delete` and `replace` are on the native, [Effect](#in-effect) API only for now.
- **`tx`** inside `lock` is your Adapter's transaction, as `unknown`: an escape hatch for a query the generic verbs don't offer, which ties the Plugin to that ORM.

## Actions

A `kind: "write"` Action writes through `lock(resourceId, work)`. The caller's `also`, the Hooks, the retries and `now` work exactly as on `book`. `work` returns one of:

| Outcome                                | Then                                                       |
| -------------------------------------- | ---------------------------------------------------------- |
| `{ _tag: "Done", value, context }`     | It's saved. `context` is what `also` and the Hooks get.    |
| `{ _tag: "NoOp", value }`               | Nothing changed: no `also`, no Hooks.                      |
| `{ _tag: "Failed", error }`            | The unit rolls back, and the Action fails with `error`.    |

Return what `lock` returns, or `fail(error)` to refuse before taking the lock.

A `kind: "read"` Action gets `records` and no lock, and returns `ok(value)` or `fail(error)`. It runs no `also` and no Hooks.

- An Action's errors are its own typed ones, plus `Vetoed` (from `also`) and `AdapterError`. A throw is a bug: the unit rolls back and the promise rejects.
- `run` gets a `signal` too, aborted when an Effect caller interrupts: a unit then rolls back, but your code between `lock` calls runs on.

## Hooks

A Plugin Hook applies to `"book"`, `"reschedule"`, `"cancel"`, its own write Actions (`"holidays.add"`), or `"*"`, which also covers Transitions. Narrow on `event.action` to read the Action's context. An in-transaction Hook gets `records` with writes on the unit, so it writes atomically on every Adapter.

Your own [`defineHook`](./hooks.md) can target any installed Plugin's write Actions, and `"*"` includes them.

## Names

Plugin names, table names and Policy names must each be unique. A Plugin can't take a scheduler key (`book`, `cancel`, `findSlots`, …), a table can't be called `booking`, and a column can't be `id`, `resourceId`, `start` or `end`. A clash is a type error, and throws in `defineSchema` (Policies: in `createScheduler`).

Whoever installs the Plugin can rename its tables and columns under `names`, by logical name: `names.tables.holiday`, `names.columns.holiday`.

## In Effect

`definePlugin` from `@fastijs/scheduler/effect` takes the same definition with Effects instead of Promises: `run`, `work`, `load` and `list` return Effects, `lock` is an Effect, and expected failures go through `Effect.fail`. Nothing crosses between Promises and Effect, so services, cancellation and typed errors flow straight through. `availability()` and `blocks()` are written this way.

Both styles build the same Plugin value, and its Actions appear in both scheduler forms. The body of `holidays.add`:

```typescript
import { definePlugin } from "@fastijs/scheduler/effect";

lock(params.resourceId, ({ conflicts, records }) =>
  Effect.gen(function* () {
    const hits = yield* conflicts(params);
    if (hits.length > 0) return yield* Effect.fail({ _tag: "SlotConflict", conflicts: hits } as const);
    const holiday = yield* records.holiday.insert(params);
    return { _tag: "Done", context: { holiday }, value: holiday } as const;
  })
);
```
