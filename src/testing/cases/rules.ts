import { expect } from "vitest";

import type { SchemaAdapter, StoredRecord } from "../../adapter/contract.js";
import type { ResourceIdOf } from "../../adapter/records.js";
import type { RuleRecord } from "../../framework/plugins/availability.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { ConformanceCase } from "../conformance-case.js";
import { ruleRow } from "../fixtures.js";
import { pluginRecords } from "../plugin-stores.js";

function date(iso: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(iso);
}

/** Three rules with distinct window starts, covering exceptions and effective dates set and unset. */
const rules: readonly [RuleRecord, RuleRecord, RuleRecord] = [
  {
    exceptions: [],
    recurrence: {
      daysOfWeek: [1, 2, 3, 4, 5],
      frequency: "weekly",
      interval: 1,
    },
    timeWindow: {
      end: Temporal.PlainTime.from("12:00"),
      start: Temporal.PlainTime.from("09:00"),
    },
    timezone: "Europe/Lisbon",
  },
  {
    effectiveFrom: date("2030-01-01"),
    effectiveTo: date("2030-12-31"),
    exceptions: [date("2030-04-25"), date("2030-12-25")],
    recurrence: { daysOfWeek: [2, 4], frequency: "weekly", interval: 2 },
    timeWindow: {
      end: Temporal.PlainTime.from("18:30:15.250"),
      start: Temporal.PlainTime.from("14:00"),
    },
    timezone: "America/New_York",
  },
  {
    effectiveFrom: date("2031-06-01"),
    exceptions: [date("2031-06-10")],
    recurrence: { daysOfWeek: [6], frequency: "weekly", interval: 1 },
    timeWindow: {
      end: Temporal.PlainTime.from("23:00"),
      start: Temporal.PlainTime.from("20:00"),
    },
    timezone: "Asia/Tokyo",
  },
];

/** Rows have no order to keep: compare them sorted by id. */
function byId(rows: readonly StoredRecord[]): StoredRecord[] {
  return rows.toSorted((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
}

/** Replace `resourceId`'s rules with `next` in one unit of work; the rows as written. */
async function replace<S extends AnySchema, Tx>(
  adapter: SchemaAdapter<S, Tx, "records">,
  resourceId: ResourceIdOf<S>,
  next: readonly RuleRecord[]
): Promise<StoredRecord[]> {
  const records = next.map((rule) => ruleRow(resourceId, rule));

  await adapter.withResourceLock(resourceId, async (locked) => {
    await locked.replaceRecords("availabilityRule", { records, resourceId });
  });

  return records;
}

/** `resourceId`'s rule rows, sorted by id. */
async function rowsOf<S extends AnySchema, Tx>(
  adapter: SchemaAdapter<S, Tx, "records">,
  resourceId: ResourceIdOf<S>
): Promise<StoredRecord[]> {
  return byId(await adapter.listRecords("availabilityRule", { resourceId }));
}

/** Rules: storing and replacing a Resource's AvailabilityRules, through `records` on `availability()`'s table. */
export const ruleCases: readonly ConformanceCase[] = [
  {
    name: "rules round-trip: several per Resource, with exceptions, effective dates set and unset",
    async run(ctx) {
      const { resources } = ctx;
      const adapter = pluginRecords(ctx, "availability");

      expect(await rowsOf(adapter, resources[0])).toStrictEqual([]);

      const written = await replace(adapter, resources[0], rules);

      expect(await rowsOf(adapter, resources[0])).toStrictEqual(byId(written));
    },
    tags: ["availability"],
  },
  {
    name: "replacing a Resource's rules replaces its whole set and touches no other Resource",
    async run(ctx) {
      const { resources } = ctx;
      const adapter = pluginRecords(ctx, "availability");

      const [first, second, third] = rules;

      await replace(adapter, resources[0], [first, second]);
      const kept = await replace(adapter, resources[1], [third]);
      const next = await replace(adapter, resources[0], [third]);

      expect(await rowsOf(adapter, resources[0])).toStrictEqual(next);
      expect(await rowsOf(adapter, resources[1])).toStrictEqual(kept);

      await replace(adapter, resources[0], []);

      expect(await rowsOf(adapter, resources[0])).toStrictEqual([]);
      expect(await rowsOf(adapter, resources[1])).toStrictEqual(kept);
    },
    tags: ["availability"],
  },
];
