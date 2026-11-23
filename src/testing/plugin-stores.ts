import type {
  DeleteRecordResult,
  GroupsOf,
  ListBookingsQuery,
  LockedAdapter,
  SchemaAdapter,
  StoredRecord,
  UpdateRecordResult,
  VerbGroup,
} from "../adapter/contract.js";
import type { ResourceIdOf, RuleRecord } from "../adapter/records.js";
import type { BlockId } from "../core/types.js";
import { uuidV7 } from "../framework/booking-id.js";
import type { AnySchema } from "../schema/define-schema.js";
import { tablesOf } from "../schema/table.js";
import type { Columns } from "../schema/table.js";
import type { CaseContext, ConformanceCase } from "./conformance-case.js";
import { conformancePlugin } from "./conformance-plugin.js";

/** A Block as the cases store it: `blocks()`'s `block` row, Developer Fields untyped. */
export type BlockRecord<S extends AnySchema> = {
  readonly id: BlockId;
  readonly resourceId: ResourceIdOf<S>;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
} & Readonly<Record<string, StoredRecord[string]>>;

/** The columns a Block update may change: anything but `id` and `resourceId`. */
export type BlockChanges<S extends AnySchema> = Partial<
  Omit<BlockRecord<S>, "id" | "resourceId">
>;

/** Whether `schema` installs the Plugin named `name`. */
export function installs(schema: AnySchema, name: string): boolean {
  return schema.plugins.some((p) => p.name === name);
}

/** Whether case `c` doesn't apply to `schema`: a `blocks` case without `blocks()`, an `availability` case without `availability()`, a `records` case without {@link conformancePlugin}. */
export function skipped(c: ConformanceCase, schema: AnySchema): boolean {
  return (
    (c.tags.includes("blocks") && !installs(schema, "blocks")) ||
    (c.tags.includes("availability") && !installs(schema, "availability")) ||
    (c.tags.includes("records") && !schema.plugins.includes(conformancePlugin))
  );
}

/** The Block Developer Fields of `schema`'s `blocks()` Plugin; none without it. */
export function blockFieldsOf(schema: AnySchema): Columns {
  return tablesOf(schema.plugins)["block"]?.columns ?? {};
}

/** The Block verbs, over `records`. */
export interface BlockReads<S extends AnySchema> {
  readonly getBlock: (id: BlockId) => Promise<BlockRecord<S> | null>;
  readonly listBlocks: (
    query: ListBookingsQuery<S>
  ) => Promise<BlockRecord<S>[]>;
}

/** The Block writes, over `records`. */
export interface BlockWrites<S extends AnySchema> {
  readonly insertBlock: (block: BlockRecord<S>) => Promise<void>;
  readonly updateBlock: (params: {
    readonly expected: BlockRecord<S>;
    readonly changes: BlockChanges<S>;
  }) => Promise<UpdateRecordResult>;
  readonly deleteBlock: (id: BlockId) => Promise<DeleteRecordResult>;
}

/** The Block verbs a case reads and locks with: `blocks()`'s table, through `records`. */
export interface BlockStore<S extends AnySchema, Tx> extends BlockReads<S> {
  readonly withResourceLock: <A>(
    resourceId: ResourceIdOf<S>,
    work: (locked: LockedBlocks<S, Tx>) => Promise<A>
  ) => Promise<A>;
}

/** A locked unit with the Block verbs beside the Adapter's own. */
export type LockedBlocks<S extends AnySchema, Tx> = Locked<S, Tx> &
  BlockReads<S> &
  BlockWrites<S>;

/** The Adapter's locked handle, as a case gets it. */
type Locked<S extends AnySchema, Tx> = LockedAdapter<S, Tx, GroupsOf<S>>;

/** The locked handle as the case types it. */
function asLocked<S extends AnySchema, Tx>(
  locked: LockedAdapter<S, Tx, VerbGroup>
): Locked<S, Tx> {
  // SAFETY: the same handle; GroupsOf<S> is a subset of every group.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the conditional type can't follow the constraint.
  return locked;
}

/** The Adapter with every verb group: a store is only built for a schema whose Plugins declare its table. */
function recordsOf<S extends AnySchema, Tx>(
  adapter: CaseContext<S, Tx>["adapter"]
): SchemaAdapter<S, Tx, VerbGroup> {
  // SAFETY: callers check the Plugin is installed, so GroupsOf<S> includes "records".
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the conditional type can't follow the runtime check.
  return adapter as SchemaAdapter<S, Tx, VerbGroup>;
}

/** A stored row as a Block. */
function asBlock<S extends AnySchema>(row: StoredRecord): BlockRecord<S> {
  // SAFETY: a `block` row holds a Block's columns, Developer Fields included.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- the field names are only known at runtime.
  return row as unknown as BlockRecord<S>;
}

/** A Block as a stored row. */
function asRow<S extends AnySchema>(
  block: BlockRecord<S> | BlockChanges<S>
): StoredRecord {
  // SAFETY: a Block's values are all StoredValues.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- see above.
  return block as unknown as StoredRecord;
}

/** The Block reads over `r`'s `records`. */
function blockReads<S extends AnySchema, Tx>(
  r: SchemaAdapter<S, Tx, VerbGroup> | LockedAdapter<S, Tx, VerbGroup>
): BlockReads<S> {
  return {
    getBlock: async (id) => {
      const row = await r.getRecord("block", id);

      return row === null ? null : asBlock<S>(row);
    },
    listBlocks: async (query) => {
      const rows = await r.listRecords("block", query);

      return rows.map((row) => asBlock<S>(row));
    },
  };
}

/** The Block verbs on a locked handle of a schema installing `blocks()`, over its `records`. */
export function blockVerbs<S extends AnySchema, Tx>(
  handle: LockedAdapter<S, Tx, GroupsOf<S>> | LockedAdapter<S, Tx>
): BlockReads<S> & BlockWrites<S> {
  // SAFETY: callers check `blocks()` is installed, so the handle has the record verbs.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- the conditional type can't follow the runtime check.
  const locked = handle as unknown as LockedAdapter<S, Tx, VerbGroup>;

  return {
    ...blockReads(locked),
    deleteBlock: async (id) => await locked.deleteRecord("block", id),
    insertBlock: async (block) => {
      await locked.insertRecord("block", asRow(block));
    },
    updateBlock: async ({ changes, expected }) =>
      await locked.updateRecord("block", {
        changes: asRow(changes),
        expected: asRow(expected),
      }),
  };
}

/** The `blocks()` Plugin's `block` table, as the old Block verbs: what the `blocks` cases check, now through `records`. */
export function blockStore<S extends AnySchema, Tx>({
  adapter,
  schema,
}: Pick<CaseContext<S, Tx>, "adapter" | "schema">): BlockStore<S, Tx> {
  if (!installs(schema, "blocks")) {
    throw new Error("a blocks case ran on a schema without blocks()");
  }

  const raw = recordsOf(adapter);

  return {
    ...blockReads(raw),
    withResourceLock: async (resourceId, work) =>
      await raw.withResourceLock(
        resourceId,
        async (locked) =>
          await work({ ...asLocked(locked), ...blockVerbs(locked) })
      ),
  };
}

/** The rule verbs, over `records`. */
export interface RuleStore<S extends AnySchema, Tx> {
  readonly getRules: (resourceId: ResourceIdOf<S>) => Promise<RuleRecord[]>;
  readonly withResourceLock: <A>(
    resourceId: ResourceIdOf<S>,
    work: (locked: LockedRules<S, Tx>) => Promise<A>
  ) => Promise<A>;
}

/** A locked unit with the rule verbs beside the Adapter's own. */
export type LockedRules<S extends AnySchema, Tx> = Locked<S, Tx> & {
  readonly getRules: (resourceId: ResourceIdOf<S>) => Promise<RuleRecord[]>;
  readonly replaceRules: (params: {
    readonly resourceId: ResourceIdOf<S>;
    readonly rules: readonly RuleRecord[];
  }) => Promise<void>;
};

/** A stored `availabilityRule` row as its rule; unset effective dates absent. */
function asRule(row: StoredRecord): RuleRecord {
  // SAFETY: an `availabilityRule` row holds a rule's columns, of their kinds.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- read as the row it is.
  const r = row as unknown as {
    readonly recurrence: RuleRecord["recurrence"];
    readonly windowStart: Temporal.PlainTime;
    readonly windowEnd: Temporal.PlainTime;
    readonly timezone: string;
    readonly effectiveFrom: Temporal.PlainDate | null;
    readonly effectiveTo: Temporal.PlainDate | null;
    readonly exceptions: readonly Temporal.PlainDate[];
  };

  return {
    exceptions: r.exceptions,
    recurrence: r.recurrence,
    timeWindow: { end: r.windowEnd, start: r.windowStart },
    timezone: r.timezone,
    ...(r.effectiveFrom !== null && { effectiveFrom: r.effectiveFrom }),
    ...(r.effectiveTo !== null && { effectiveTo: r.effectiveTo }),
  };
}

/** A rule as a stored `availabilityRule` row on `resourceId`; `exceptions` may be left out. */
function ruleRow(
  resourceId: string | number,
  rule: Omit<RuleRecord, "exceptions"> & {
    readonly exceptions?: RuleRecord["exceptions"];
  }
): StoredRecord {
  // SAFETY: the recurrence is plain JSON data.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- an interface has no index signature.
  const recurrence = rule.recurrence as unknown as StoredRecord[string];

  return {
    effectiveFrom: rule.effectiveFrom ?? null,
    effectiveTo: rule.effectiveTo ?? null,
    exceptions: rule.exceptions ?? [],
    id: uuidV7(),
    recurrence,
    resourceId,
    timezone: rule.timezone,
    windowEnd: rule.timeWindow.end,
    windowStart: rule.timeWindow.start,
  };
}

/** The `availability()` Plugin's `availabilityRule` table, as the old rule verbs: what the rule cases check, now through `records`. */
export function ruleStore<S extends AnySchema, Tx>({
  adapter,
  schema,
}: Pick<CaseContext<S, Tx>, "adapter" | "schema">): RuleStore<S, Tx> {
  if (!installs(schema, "availability")) {
    throw new Error(
      "an availability case ran on a schema without availability()"
    );
  }

  const raw = recordsOf(adapter);

  function rulesOn(
    r: SchemaAdapter<S, Tx, VerbGroup> | LockedAdapter<S, Tx, VerbGroup>
  ) {
    return async (resourceId: ResourceIdOf<S>) => {
      const rows = await r.listRecords("availabilityRule", { resourceId });

      return rows.map(asRule);
    };
  }

  return {
    getRules: rulesOn(raw),
    withResourceLock: async (resourceId, work) =>
      await raw.withResourceLock(
        resourceId,
        async (locked) =>
          await work({
            ...asLocked(locked),
            getRules: rulesOn(locked),
            replaceRules: async ({ resourceId: id, rules }) => {
              await locked.replaceRecords("availabilityRule", {
                records: rules.map((rule) => ruleRow(id, rule)),
                resourceId: id,
              });
            },
          })
      ),
  };
}

/** Replace `resourceId`'s rules on a locked handle, through `records` on `availability()`'s table: test setup for a schema installing it. */
export async function replaceRules<S extends AnySchema, Tx>(
  handle: LockedAdapter<S, Tx, GroupsOf<S>> | LockedAdapter<S, Tx>,
  {
    resourceId,
    rules,
  }: {
    readonly resourceId: ResourceIdOf<S>;
    readonly rules: readonly Parameters<typeof ruleRow>[1][];
  }
): Promise<void> {
  // SAFETY: callers install `availability()`, so the handle has the record verbs.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- the conditional type can't follow the caller's schema.
  const locked = handle as unknown as LockedAdapter<S, Tx, VerbGroup>;

  await locked.replaceRecords("availabilityRule", {
    records: rules.map((rule) => ruleRow(resourceId, rule)),
    resourceId,
  });
}

/** `resourceId`'s rules, read through `records` on `availability()`'s table. */
export async function getRules<S extends AnySchema, Tx>(
  handle:
    | SchemaAdapter<S, Tx, GroupsOf<S>>
    | SchemaAdapter<S, Tx>
    | LockedAdapter<S, Tx, GroupsOf<S>>
    | LockedAdapter<S, Tx>,
  resourceId: ResourceIdOf<S>
): Promise<RuleRecord[]> {
  // SAFETY: callers install `availability()`, so the handle has the record verbs.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- the conditional type can't follow the caller's schema.
  const reads = handle as unknown as SchemaAdapter<S, Tx, VerbGroup>;

  const rows = await reads.listRecords("availabilityRule", { resourceId });

  return rows.map(asRule);
}
