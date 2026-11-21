import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { expect } from "vitest";

import type {
  SchemaAdapter,
  StoredRecord,
  StoredValue,
  VerbGroup,
} from "../../adapter/contract.js";
import type { ResourceIdOf } from "../../adapter/records.js";
import type { Json, RecordColumn } from "../../schema/column.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { CaseContext, ConformanceCase } from "../conformance-case.js";
import { conformancePlugin } from "../conformance-plugin.js";
import { instant, valueOf } from "../fixtures.js";

/** A table of the conformance Plugin. */
type Table = keyof typeof conformancePlugin.tables;

const tables: readonly Table[] = ["conformanceTimed", "conformanceUntimed"];

/** A stored record on a known Resource. */
type On<S extends AnySchema> = StoredRecord & {
  readonly resourceId: ResourceIdOf<S>;
};

/** A JSON object. */
type JsonObject = Readonly<Record<string, Json>>;

/** The values a case reasons about, kept typed: the required `dates` and `json`, and a timed record's `start`. */
interface Known {
  readonly dates: readonly [
    Temporal.PlainDate,
    Temporal.PlainDate,
    Temporal.PlainDate,
  ];
  readonly json: JsonObject;
  readonly start: Temporal.Instant;
}

/** The Adapter with its record verbs. Records cases only run for a schema with the conformance Plugin, where GroupsOf<S> is "records". */
function withRecords<S extends AnySchema, Tx>({
  adapter,
  schema,
}: CaseContext<S, Tx>): SchemaAdapter<S, Tx, "records"> {
  if (!schema.plugins.includes(conformancePlugin)) {
    throw new Error("a records case ran on a schema without conformancePlugin");
  }

  // SAFETY: the Plugin declares tables, so GroupsOf<S> includes "records"; cast to every group, then narrowed by the return type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the conditional type can't follow the runtime check.
  return adapter as SchemaAdapter<S, Tx, VerbGroup>;
}

/** A random day in 2030. */
function date(): Temporal.PlainDate {
  return Temporal.PlainDate.from("2030-01-01").add({ days: randomInt(365) });
}

/** Fresh random {@link Known} values. */
function known(start = instant()): Known {
  return {
    dates: [date(), date(), date()],
    json: {
      list: [randomInt(1000), "x", null, { deep: [1.5, -2] }],
      nested: { id: randomUUID(), on: true },
    },
    start,
  };
}

/** A random value of a column kind; times to the millisecond, as every Adapter must keep them. */
function recordValue(type: RecordColumn): StoredValue {
  switch (type.kind) {
    case "date": {
      return date();
    }

    case "time": {
      return new Temporal.PlainTime(
        randomInt(24),
        randomInt(60),
        randomInt(60),
        randomInt(1000)
      );
    }

    case "json": {
      return known().json;
    }

    case "dates": {
      return known().dates;
    }

    case "text":
    case "uuid":
    case "integer":
    case "boolean":
    case "instant": {
      return valueOf(type);
    }

    default: {
      throw new Error(`Unknown column kind: ${JSON.stringify(type)}`);
    }
  }
}

/** A new record of `table` on `resourceId`; optional columns `null` unless `set`; `dates`, `json` and a timed record's range from `values`. */
function newRecord<S extends AnySchema>(
  table: Table,
  resourceId: ResourceIdOf<S>,
  optional: "set" | "null",
  values = known()
): On<S> {
  const { columns, timed } = conformancePlugin.tables[table];
  const { dates, json, start } = values;

  return {
    ...Object.fromEntries(
      Object.entries(columns).map(([name, def]) => [
        name,
        def.required || optional === "set" ? recordValue(def.type) : null,
      ])
    ),
    dates,
    id: randomUUID(),
    json,
    resourceId,
    ...(timed && { end: start.add({ hours: 1 }), start }),
  };
}

/** The columns a record can change: everything but `id` and `resourceId`. */
function changesOf({
  id: _id,
  resourceId: _resourceId,
  ...changes
}: StoredRecord): Readonly<Record<string, StoredValue>> {
  return changes;
}

/** `json` with every object's keys in reverse order: the same value, written differently. */
function reordered(json: Json): Json {
  if (Array.isArray(json)) {
    return json.map(reordered);
  }

  if (json instanceof Object) {
    return Object.fromEntries(
      Object.entries(json)
        .toReversed()
        .map(([k, v]) => [k, reordered(v)])
    );
  }

  return json;
}

/** `record`, made with `values`, as another read could return it: JSON keys in another order, fresh PlainDates. */
function rewritten<S extends AnySchema>(record: On<S>, values: Known): On<S> {
  return {
    ...record,
    dates: values.dates.map((d) => Temporal.PlainDate.from(d.toString())),
    json: reordered(values.json),
  };
}

function byId(a: StoredRecord, b: StoredRecord): number {
  return a.id < b.id ? -1 : Number(a.id > b.id);
}

/** Insert each record in its own unit of work. */
async function insertAll<S extends AnySchema, Tx>(
  adapter: SchemaAdapter<S, Tx, "records">,
  table: Table,
  records: readonly On<S>[]
): Promise<void> {
  await Promise.all(
    records.map(async (r) => {
      await adapter.withResourceLock(r.resourceId, async (locked) => {
        await locked.insertRecord(table, r);
      });
    })
  );
}

/** `updateRecord` in its own unit of work. */
async function update<S extends AnySchema, Tx>(
  adapter: SchemaAdapter<S, Tx, "records">,
  table: Table,
  expected: On<S>,
  changes: Readonly<Record<string, StoredValue>>
) {
  return await adapter.withResourceLock(
    expected.resourceId,
    async (locked) => await locked.updateRecord(table, { changes, expected })
  );
}

/** `deleteRecord` in its own unit of work. */
async function remove<S extends AnySchema, Tx>(
  adapter: SchemaAdapter<S, Tx, "records">,
  table: Table,
  record: On<S>
) {
  return await adapter.withResourceLock(
    record.resourceId,
    async (locked) => await locked.deleteRecord(table, record.id)
  );
}

/** Plugin records (the `records` verb group): save, read back, list, change, delete, replace, undo on failure. */
export const recordCases: readonly ConformanceCase[] = [
  {
    name: "a record round-trips on a timed and an untimed table: every column kind, set or null",
    async run(ctx) {
      const { resources } = ctx;
      const adapter = withRecords(ctx);

      for (const table of tables) {
        const withValues = newRecord(table, resources[0], "set");
        const withNulls = newRecord(table, resources[1], "null");

        // oxlint-disable-next-line no-await-in-loop -- two tables.
        await insertAll(adapter, table, [withValues, withNulls]);

        // oxlint-disable-next-line no-await-in-loop -- as above.
        expect(await adapter.getRecord(table, withValues.id)).toStrictEqual(
          withValues
        );
        // oxlint-disable-next-line no-await-in-loop -- as above.
        expect(await adapter.getRecord(table, withNulls.id)).toStrictEqual(
          withNulls
        );
        expect(
          // oxlint-disable-next-line no-await-in-loop -- as above.
          await adapter.listRecords(table, { resourceId: resources[1] })
        ).toStrictEqual([withNulls]);
        // oxlint-disable-next-line no-await-in-loop -- as above.
        expect(await adapter.getRecord(table, randomUUID())).toBeNull();
      }
    },
    tags: ["records"],
  },
  {
    name: "listRecords on a timed table is half-open with overlapping, keeps to one Resource, and sorts by start, then id",
    async run(ctx) {
      const { resources } = ctx;
      const adapter = withRecords(ctx);
      const table = "conformanceTimed";
      const from = Temporal.Instant.from("2030-06-03T10:00:00Z");
      const to = from.add({ hours: 4 });

      /** A one-hour record starting `hours` after `from`. */
      function at(hours: number, resourceId = resources[0]) {
        return newRecord(
          table,
          resourceId,
          "null",
          known(from.add({ minutes: hours * 60 }))
        );
      }

      const endsAtFrom = at(-1);
      const straddlesFrom = at(-0.5);
      const sameStart = [at(1), at(1)].toSorted(byId);
      const straddlesTo = at(3.5);
      const startsAtTo = at(4);

      await insertAll(adapter, table, [
        startsAtTo,
        ...sameStart,
        straddlesTo,
        endsAtFrom,
        straddlesFrom,
        at(1, resources[1]),
      ]);

      expect(
        await adapter.listRecords(table, {
          overlapping: { from, to },
          resourceId: resources[0],
        })
      ).toStrictEqual([straddlesFrom, ...sameStart, straddlesTo]);
      expect(
        await adapter.listRecords(table, { resourceId: resources[0] })
      ).toStrictEqual([
        endsAtFrom,
        straddlesFrom,
        ...sameStart,
        straddlesTo,
        startsAtTo,
      ]);
    },
    tags: ["records"],
  },
  {
    name: "listRecords on an untimed table keeps to one Resource and sorts by id",
    async run(ctx) {
      const { resources } = ctx;
      const adapter = withRecords(ctx);
      const table = "conformanceUntimed";

      const mine = Array.from({ length: 5 }, () =>
        newRecord(table, resources[0], "set")
      );

      await insertAll(adapter, table, [
        ...mine,
        newRecord(table, resources[1], "set"),
      ]);

      expect(
        await adapter.listRecords(table, { resourceId: resources[0] })
      ).toStrictEqual(mine.toSorted(byId));
    },
    tags: ["records"],
  },
  {
    name: "replaceRecords replaces one Resource's records of one table, and touches no other",
    async run(ctx) {
      const { resources } = ctx;
      const adapter = withRecords(ctx);
      const [r0, r1] = resources;
      const timed = "conformanceTimed";
      const untimed = "conformanceUntimed";
      const otherResource = newRecord(timed, r1, "set");
      const otherTable = newRecord(untimed, r0, "set");
      const start = instant();

      await insertAll(adapter, timed, [
        newRecord(timed, r0, "set"),
        newRecord(timed, r0, "null"),
        otherResource,
      ]);
      await insertAll(adapter, untimed, [otherTable]);

      const next = [
        newRecord(timed, r0, "set", known(start)),
        newRecord(timed, r0, "null", known(start.add({ hours: 1 }))),
      ];

      /** Replace r0's timed records with `records`. */
      async function replace(records: readonly On<typeof ctx.schema>[]) {
        await adapter.withResourceLock(r0, async (locked) => {
          await locked.replaceRecords(timed, { records, resourceId: r0 });
        });
      }

      await replace(next);

      expect(
        await adapter.listRecords(timed, { resourceId: r0 })
      ).toStrictEqual(next);
      expect(
        await adapter.listRecords(timed, { resourceId: r1 })
      ).toStrictEqual([otherResource]);
      expect(
        await adapter.listRecords(untimed, { resourceId: r0 })
      ).toStrictEqual([otherTable]);

      await replace([]);

      expect(
        await adapter.listRecords(timed, { resourceId: r0 })
      ).toStrictEqual([]);
    },
    tags: ["records"],
  },
  {
    name: "updateRecord with a matching expected applies the changes, nulls included; JSON in another key order and equal dates still match",
    async run(ctx) {
      const { resources } = ctx;
      const adapter = withRecords(ctx);

      for (const table of tables) {
        const [first, second, third] = [known(), known(), known()];
        const record = newRecord(table, resources[0], "set", first);

        const nulled = {
          ...record,
          ...changesOf(newRecord(table, resources[0], "null", second)),
        };

        const refilled = {
          ...record,
          ...changesOf(newRecord(table, resources[0], "set", third)),
        };

        // oxlint-disable-next-line no-await-in-loop -- two tables.
        await insertAll(adapter, table, [record]);

        expect(
          // oxlint-disable-next-line no-await-in-loop -- as above.
          await update(
            adapter,
            table,
            rewritten(record, first),
            changesOf(nulled)
          )
        ).toStrictEqual({ ok: true });
        // oxlint-disable-next-line no-await-in-loop -- as above.
        expect(await adapter.getRecord(table, record.id)).toStrictEqual(nulled);

        expect(
          // oxlint-disable-next-line no-await-in-loop -- as above.
          await update(
            adapter,
            table,
            rewritten(nulled, second),
            changesOf(refilled)
          )
        ).toStrictEqual({ ok: true });
        // oxlint-disable-next-line no-await-in-loop -- as above.
        expect(await adapter.getRecord(table, record.id)).toStrictEqual(
          refilled
        );
      }
    },
    tags: ["records"],
  },
  {
    name: "updateRecord with a changed or missing expected gives changed, and the record is untouched",
    async run(ctx) {
      const { resources } = ctx;
      const adapter = withRecords(ctx);

      for (const table of tables) {
        const values = known();
        const record = newRecord(table, resources[0], "set", values);
        const [first, second, third] = values.dates;

        const stale: On<typeof ctx.schema>[] = [
          { ...record, text: "another" },
          { ...record, textOpt: null },
          { ...record, json: { ...values.json, extra: 1 } },
          { ...record, dates: [first, second] },
          { ...record, dates: [first, second, third.add({ days: 1 })] },
          ...(table === "conformanceTimed"
            ? [{ ...record, start: values.start.add({ milliseconds: 1 }) }]
            : []),
          newRecord(table, resources[0], "set"),
        ];

        // oxlint-disable-next-line no-await-in-loop -- two tables.
        await insertAll(adapter, table, [record]);

        // oxlint-disable-next-line no-await-in-loop -- as above.
        const results = await Promise.all(
          stale.map(
            async (expected) =>
              await update(adapter, table, expected, { text: "changed" })
          )
        );

        expect(results).toStrictEqual(
          stale.map(() => ({ ok: false, reason: "changed" }))
        );
        // oxlint-disable-next-line no-await-in-loop -- as above.
        expect(await adapter.getRecord(table, record.id)).toStrictEqual(record);
      }
    },
    tags: ["records"],
  },
  {
    name: "deleteRecord removes the record, and a second delete gives missing",
    async run(ctx) {
      const { resources } = ctx;
      const adapter = withRecords(ctx);

      for (const table of tables) {
        const record = newRecord(table, resources[0], "set");
        const kept = newRecord(table, resources[0], "set");

        // oxlint-disable-next-line no-await-in-loop -- two tables.
        await insertAll(adapter, table, [record, kept]);

        // oxlint-disable-next-line no-await-in-loop -- as above.
        expect(await remove(adapter, table, record)).toStrictEqual({
          ok: true,
        });
        // oxlint-disable-next-line no-await-in-loop -- as above.
        expect(await adapter.getRecord(table, record.id)).toBeNull();
        // oxlint-disable-next-line no-await-in-loop -- as above.
        expect(await adapter.getRecord(table, kept.id)).toStrictEqual(kept);
        // oxlint-disable-next-line no-await-in-loop -- as above.
        expect(await remove(adapter, table, record)).toStrictEqual({
          ok: false,
          reason: "missing",
        });
      }
    },
    tags: ["records"],
  },
  {
    name: "a throw after every kind of record write leaves every record as it was and keeps the reason",
    async run(ctx) {
      const { resources } = ctx;
      const adapter = withRecords(ctx);
      const [r0] = resources;
      const timed = "conformanceTimed";
      const untimed = "conformanceUntimed";
      const reason = new Error("work failed");
      const moved = newRecord(timed, r0, "set");
      const deleted = newRecord(untimed, r0, "set");
      const replaced = newRecord(untimed, r0, "set");

      await insertAll(adapter, timed, [moved]);
      await insertAll(adapter, untimed, [deleted, replaced]);

      await expect(
        adapter.withResourceLock(r0, async (locked) => {
          await locked.insertRecord(timed, newRecord(timed, r0, "set"));
          await locked.updateRecord(timed, {
            changes: { text: "changed" },
            expected: moved,
          });
          await locked.deleteRecord(untimed, deleted.id);
          await locked.replaceRecords(untimed, {
            records: [newRecord(untimed, r0, "set")],
            resourceId: r0,
          });
          throw reason;
        })
      ).rejects.toBe(reason);

      expect(
        await adapter.listRecords(timed, { resourceId: r0 })
      ).toStrictEqual([moved]);
      expect(
        await adapter.listRecords(untimed, { resourceId: r0 })
      ).toStrictEqual([deleted, replaced].toSorted(byId));
    },
    tags: ["records"],
  },
  {
    name: "concurrent locked inserts on one Resource serialise: each unit sees every insert before it",
    async run(ctx) {
      const { resources } = ctx;
      const adapter = withRecords(ctx);
      const table = "conformanceUntimed";
      const n = 20;

      await Promise.all(
        Array.from({ length: n }, async () => {
          await adapter.withResourceLock(resources[0], async (locked) => {
            const before = await locked.listRecords(table, {
              resourceId: resources[0],
            });

            // Widen the race window between the read and the write.
            await sleep(2);
            await locked.insertRecord(table, {
              ...newRecord(table, resources[0], "null"),
              integer: before.length,
            });
          });
        })
      );

      const all = await adapter.listRecords(table, {
        resourceId: resources[0],
      });

      expect(
        all.map((r) => r["integer"]).toSorted((a, b) => Number(a) - Number(b))
      ).toStrictEqual(Array.from({ length: n }, (_, i) => i));
    },
    tags: ["concurrency", "records"],
  },
];
