import { column } from "./column.js";
import type { AnyColumn, Column, ResourceIdColumn } from "./column.js";

/** A Developer Field: an extra Booking or Block column the developer declares. */
export interface FieldDef {
  /** The column type. */
  readonly type: AnyColumn;
  /** Whether a value is required; an optional field reads as `null` when unset. */
  readonly required: boolean;
}

/** Developer Fields by logical name. */
export type Fields = Readonly<Record<string, FieldDef>>;

const BOOKING_COLUMNS = ["id", "resourceId", "start", "end", "status"] as const;

const AVAILABILITY_RULE_COLUMNS = [
  "id",
  "resourceId",
  "recurrence",
  "windowStart",
  "windowEnd",
  "timezone",
  "effectiveFrom",
  "effectiveTo",
  "exceptions",
] as const;

const BLOCK_COLUMNS = ["id", "resourceId", "start", "end"] as const;

/** fasti's own Booking columns, by logical name. */
export type BookingColumn = (typeof BOOKING_COLUMNS)[number];

/** fasti's own Block columns, by logical name. */
export type BlockColumn = (typeof BLOCK_COLUMNS)[number];

/** fasti's own AvailabilityRule columns, by logical name. */
export type AvailabilityRuleColumn = (typeof AVAILABILITY_RULE_COLUMNS)[number];

/** The Statuses every schema has. */
export type BaseStatus = "booked" | "cancelled";

/**
 * Input to {@link defineSchema}. Every option has a default.
 *
 * @typeParam R - The Resource id column.
 * @typeParam F - The Developer Fields.
 * @typeParam B - The Block's Developer Fields, or `null` for a schema without Blocks.
 */
export interface DefineSchemaParams<
  R extends ResourceIdColumn,
  F extends Fields,
  B extends Fields | null = null,
> {
  /** The Resource id type; defaults to `column.text()`. */
  readonly resource?: { readonly idType: R };
  /** Developer Fields on the Booking; a name that collides with a Booking column is a type error. */
  readonly booking?: {
    readonly fields?: F & Partial<Readonly<Record<BookingColumn, never>>>;
  };
  /** Declare Blocks, with their Developer Fields (`{}` for none); absent, the schema has no Blocks. A name that collides with a Block column is a type error. */
  readonly block?: { readonly fields: B };
  /** Physical names; each defaults to its logical name, and names of one kind must be distinct. */
  readonly names?: {
    readonly tables?: {
      readonly booking?: string;
      readonly availabilityRule?: string;
      readonly block?: string;
    };
    readonly columns?: {
      readonly booking?: Partial<
        Record<BookingColumn | NoInfer<keyof F>, string>
      >;
      readonly availabilityRule?: Partial<
        Record<AvailabilityRuleColumn, string>
      >;
      readonly block?: Partial<Record<BlockColumn | NoInfer<keyof B>, string>>;
    };
    /** Stored Status values. */
    readonly statuses?: Partial<Record<BaseStatus, string>>;
  };
}

/** Refuses a Block Developer Field named after a Block column. Apart from `block`, so `fields: {}` still infers B (an intersection there drops the inference). */
interface BlockFieldGuard {
  readonly block?: {
    readonly fields: Partial<Readonly<Record<BlockColumn, never>>>;
  };
}

/**
 * A resolved schema: every default filled in, so nothing downstream handles a missing option.
 *
 * @typeParam R - The Resource id column.
 * @typeParam F - The Developer Fields.
 * @typeParam St - The Statuses.
 * @typeParam B - The Block's Developer Fields, or `null` for a schema without Blocks.
 */
export interface Schema<
  R extends ResourceIdColumn = ResourceIdColumn,
  F extends Fields = Fields,
  St extends string = BaseStatus,
  B extends Fields | null = null,
> {
  /** The Resource id type. */
  readonly resource: { readonly idType: R };
  /** The Developer Fields. */
  readonly booking: { readonly fields: F };
  /** The Block's Developer Fields; `null`: this schema has no Blocks. */
  readonly block: B extends Fields ? { readonly fields: B } : null;
  /** Each Status: whether it blocks the slot, and its stored value. */
  readonly statuses: Readonly<
    Record<St, { readonly blocking: boolean; readonly stored: string }>
  >;
  /** Physical names, keyed by logical name. */
  readonly names: {
    readonly tables: {
      readonly booking: string;
      readonly availabilityRule: string;
      /** Resolved even without Blocks, and then unused. */
      readonly block: string;
    };
    readonly columns: {
      readonly booking: Readonly<Record<BookingColumn | keyof F, string>>;
      readonly availabilityRule: Readonly<
        Record<AvailabilityRuleColumn, string>
      >;
      readonly block: Readonly<
        Record<BlockColumn | (B extends Fields ? keyof B : never), string>
      >;
    };
  };
}

/** A schema of any shape, for use as a constraint (`S extends AnySchema`). */
export type AnySchema = Schema<ResourceIdColumn, Fields, string, Fields | null>;

/** A schema that declares Blocks, for use as a constraint. */
export type BlockSchema = AnySchema & {
  readonly block: { readonly fields: Fields };
};

/** Whether a schema declares Blocks. */
export type HasBlocks<S extends AnySchema> = [S["block"]] extends [null]
  ? false
  : true;

function physicalNames<K extends PropertyKey>(
  logical: readonly K[],
  renamed: Partial<Record<K, string>> | undefined
): Record<K, string> {
  // SAFETY: the entries cover every key in `logical`, which is all of K.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fromEntries can't keep the key type.
  return Object.fromEntries(
    logical.map((name) => [
      name,
      (renamed && Object.hasOwn(renamed, name) ? renamed[name] : undefined) ??
        String(name),
    ])
  ) as Record<K, string>;
}

/** Throw when two logical names share one physical name: a definition-time defect. */
function assertDistinct(
  kind: string,
  names: Readonly<Record<string, string>>
): void {
  const seen = new Map<string, string>();

  for (const [logical, physical] of Object.entries(names)) {
    const other = seen.get(physical);

    if (other !== undefined) {
      throw new Error(
        `defineSchema: "${other}" and "${logical}" share the ${kind} "${physical}"; each must have its own.`
      );
    }

    seen.set(physical, logical);
  }
}

/**
 * Resolve a schema definition: physical names, the Resource id type, Developer Fields and Statuses.
 *
 * @typeParam R - The Resource id column; defaults to `column.text()`.
 * @typeParam F - The Developer Fields.
 * @typeParam B - The Block's Developer Fields; `null` (no Blocks) when `block` is absent.
 * @throws When two Statuses share a stored value (I6), or two columns of one table, or two tables, share a physical name.
 */
export function defineSchema<
  R extends ResourceIdColumn = Column<"text", string>,
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- "no Developer Fields" is exactly `{}`.
  F extends Fields = Record<never, never>,
  B extends Fields | null = null,
>(
  params: DefineSchemaParams<R, F, B> & BlockFieldGuard
): Schema<R, F, BaseStatus, B> {
  const { names } = params;
  // SAFETY: R falls back to its default, Column<"text", string>, exactly when `resource` is absent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the default can't be tied to absence in the signature.
  const idType = (params.resource?.idType ?? column.text()) as R;
  // SAFETY: F falls back to its default, no fields, exactly when `fields` is absent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above, for F.
  const fields = (params.booking?.fields ?? {}) as F;
  const stored = physicalNames(["booked", "cancelled"], names?.statuses);

  const bookingColumns = physicalNames<BookingColumn | keyof F>(
    [...BOOKING_COLUMNS, ...Object.keys(fields)],
    names?.columns?.booking
  );

  const ruleColumns = physicalNames(
    AVAILABILITY_RULE_COLUMNS,
    names?.columns?.availabilityRule
  );

  const blockFields = params.block?.fields ?? {};

  // SAFETY: the keys are the Block columns plus B's field names, exactly the declared key type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- B's keys are only known at runtime.
  const blockColumns = physicalNames<string>(
    [...BLOCK_COLUMNS, ...Object.keys(blockFields)],
    names?.columns?.block
  ) as Schema<R, F, BaseStatus, B>["names"]["columns"]["block"];

  const tables = physicalNames(
    ["booking", "availabilityRule", "block"],
    names?.tables
  );

  assertDistinct("stored value", stored);
  assertDistinct("column name", bookingColumns);
  assertDistinct("column name", ruleColumns);

  // Unused Block names can't collide with anything.
  if (params.block) {
    assertDistinct("column name", blockColumns);
  }

  assertDistinct(
    "table name",
    params.block
      ? tables
      : { availabilityRule: tables.availabilityRule, booking: tables.booking }
  );

  // SAFETY: B is inferred from `block.fields` when present, and defaults to null exactly when it is absent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the conditional type can't follow the runtime check.
  const block = (params.block ? { fields: blockFields } : null) as Schema<
    R,
    F,
    BaseStatus,
    B
  >["block"];

  return {
    block,
    booking: { fields },
    names: {
      columns: {
        availabilityRule: ruleColumns,
        block: blockColumns,
        booking: bookingColumns,
      },
      tables,
    },
    resource: { idType },
    statuses: {
      booked: { blocking: true, stored: stored.booked },
      cancelled: { blocking: false, stored: stored.cancelled },
    },
  };
}
