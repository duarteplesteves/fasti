import { expect } from "vitest";

import type { SchemaAdapter } from "../../adapter/contract.js";
import type { ResourceIdOf, RuleRecord } from "../../adapter/records.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { ConformanceCase } from "../conformance-case.js";

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

/** Rules have no order: compare them sorted by window start (distinct in every fixture). */
function byStart(rs: readonly RuleRecord[]): RuleRecord[] {
  return rs.toSorted((a, b) =>
    Temporal.PlainTime.compare(a.timeWindow.start, b.timeWindow.start)
  );
}

async function replace<S extends AnySchema, Tx>(
  adapter: SchemaAdapter<S, Tx>,
  resourceId: ResourceIdOf<S>,
  next: readonly RuleRecord[]
): Promise<void> {
  await adapter.withResourceLock(resourceId, async (locked) => {
    await locked.replaceRules({ resourceId, rules: next });
  });
}

/** Rules: storing and replacing a Resource's AvailabilityRules. */
export const ruleCases: readonly ConformanceCase[] = [
  {
    name: "rules round-trip: several per Resource, with exceptions, effective dates set and unset",
    async run({ adapter, resources }) {
      expect(await adapter.getRules(resources[0])).toStrictEqual([]);

      await replace(adapter, resources[0], rules);

      expect(byStart(await adapter.getRules(resources[0]))).toStrictEqual(
        byStart(rules)
      );
    },
    tags: [],
  },
  {
    name: "replaceRules replaces one Resource's whole set and touches no other Resource",
    async run({ adapter, resources }) {
      const [first, second, third] = rules;

      await replace(adapter, resources[0], [first, second]);
      await replace(adapter, resources[1], [third]);
      await replace(adapter, resources[0], [third]);

      expect(await adapter.getRules(resources[0])).toStrictEqual([third]);
      expect(await adapter.getRules(resources[1])).toStrictEqual([third]);

      await replace(adapter, resources[0], []);

      expect(await adapter.getRules(resources[0])).toStrictEqual([]);
      expect(await adapter.getRules(resources[1])).toStrictEqual([third]);
    },
    tags: [],
  },
];
