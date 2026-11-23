import type {
  GroupsOf,
  LockedAdapter,
  SchemaAdapter,
  VerbGroup,
} from "../adapter/contract.js";
import type { AnySchema } from "../schema/define-schema.js";
import { tablesOf } from "../schema/table.js";
import type { Columns } from "../schema/table.js";
import type { CaseContext, ConformanceCase } from "./conformance-case.js";
import { conformancePlugin } from "./conformance-plugin.js";

/**
 * Whether `schema` installs the Plugin named `name`.
 *
 * @returns `true` when it does.
 */
export function installs(schema: AnySchema, name: string): boolean {
  return schema.plugins.some((p) => p.name === name);
}

/**
 * Whether case `c` doesn't apply to `schema`: a `blocks` case without `blocks()`, an `availability` case without `availability()`, a `records` case without {@link conformancePlugin}.
 *
 * @returns `true` when the case is skipped.
 */
export function skipped(c: ConformanceCase, schema: AnySchema): boolean {
  return (
    (c.tags.includes("blocks") && !installs(schema, "blocks")) ||
    (c.tags.includes("availability") && !installs(schema, "availability")) ||
    (c.tags.includes("records") && !schema.plugins.includes(conformancePlugin))
  );
}

/**
 * The Block Developer Fields of `schema`'s `blocks()` Plugin; none without it.
 *
 * @returns The Block Developer Fields, empty without `blocks()`.
 */
export function blockFieldsOf(schema: AnySchema): Columns {
  return tablesOf(schema.plugins)["block"]?.columns ?? {};
}

/**
 * The Adapter's record verbs, for a case on Plugin `plugin`'s tables.
 *
 * @returns The record verbs.
 */
export function pluginRecords<S extends AnySchema, Tx>(
  { adapter, schema }: Pick<CaseContext<S, Tx>, "adapter" | "schema">,
  plugin: "blocks" | "availability"
): SchemaAdapter<S, Tx, "records"> {
  if (!installs(schema, plugin)) {
    throw new Error(`a ${plugin} case ran on a schema without ${plugin}()`);
  }

  // SAFETY: the Plugin declares tables, so GroupsOf<S> includes "records".
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the conditional type can't follow the runtime check.
  return adapter as SchemaAdapter<S, Tx, VerbGroup>;
}

/**
 * A locked handle's record verbs. Callers check a Plugin with tables is installed.
 *
 * @returns The record verbs.
 */
export function lockedRecords<S extends AnySchema, Tx>(
  locked: LockedAdapter<S, Tx, GroupsOf<S>> | LockedAdapter<S, Tx>
): LockedAdapter<S, Tx, "records"> {
  // SAFETY: see above; GroupsOf<S> is "records" once a Plugin declares tables.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- the conditional type can't follow the caller's check.
  return locked as unknown as LockedAdapter<S, Tx, VerbGroup>;
}
