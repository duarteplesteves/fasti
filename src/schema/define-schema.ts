import { column } from "./column.js";
import type { AnyColumn, Column, ResourceIdColumn } from "./column.js";

/** A Developer Field: an extra Booking column the developer declares. */
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

/** fasti's own Booking columns, by logical name. */
export type BookingColumn = (typeof BOOKING_COLUMNS)[number];

/** fasti's own AvailabilityRule columns, by logical name. */
export type AvailabilityRuleColumn = (typeof AVAILABILITY_RULE_COLUMNS)[number];

/** The Statuses every schema has. */
export type BaseStatus = "booked" | "cancelled";

/**
 * Input to {@link defineSchema}. Every option has a default.
 *
 * @typeParam R - The Resource id column.
 * @typeParam F - The Developer Fields.
 */
export interface DefineSchemaParams<
  R extends ResourceIdColumn,
  F extends Fields,
> {
  /** The Resource id type; defaults to `column.text()`. */
  readonly resource?: { readonly idType: R };
  /** Developer Fields on the Booking; a name that collides with a Booking column is a type error. */
  readonly booking?: {
    readonly fields?: F & Partial<Readonly<Record<BookingColumn, never>>>;
  };
  /** Physical names; each defaults to its logical name, and names of one kind must be distinct. */
  readonly names?: {
    readonly tables?: {
      readonly booking?: string;
      readonly availabilityRule?: string;
    };
    readonly columns?: {
      readonly booking?: Partial<
        Record<BookingColumn | NoInfer<keyof F>, string>
      >;
      readonly availabilityRule?: Partial<
        Record<AvailabilityRuleColumn, string>
      >;
    };
    /** Stored Status values. */
    readonly statuses?: Partial<Record<BaseStatus, string>>;
  };
}

/**
 * A resolved schema: every default filled in, so nothing downstream handles a missing option.
 *
 * @typeParam R - The Resource id column.
 * @typeParam F - The Developer Fields.
 * @typeParam St - The Statuses.
 */
export interface Schema<
  R extends ResourceIdColumn = ResourceIdColumn,
  F extends Fields = Fields,
  St extends string = BaseStatus,
> {
  /** The Resource id type. */
  readonly resource: { readonly idType: R };
  /** The Developer Fields. */
  readonly booking: { readonly fields: F };
  /** Each Status: whether it blocks the slot, and its stored value. */
  readonly statuses: Readonly<
    Record<St, { readonly blocking: boolean; readonly stored: string }>
  >;
  /** Physical names, keyed by logical name. */
  readonly names: {
    readonly tables: {
      readonly booking: string;
      readonly availabilityRule: string;
    };
    readonly columns: {
      readonly booking: Readonly<Record<BookingColumn | keyof F, string>>;
      readonly availabilityRule: Readonly<
        Record<AvailabilityRuleColumn, string>
      >;
    };
  };
}

/** A schema of any shape, for use as a constraint (`S extends AnySchema`). */
export type AnySchema = Schema<ResourceIdColumn, Fields, string>;

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
 * @throws When two Statuses share a stored value (I6), or two columns of one table, or the two tables, share a physical name.
 */
export function defineSchema<
  R extends ResourceIdColumn = Column<"text", string>,
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- "no Developer Fields" is exactly `{}`.
  F extends Fields = Record<never, never>,
>(params: DefineSchemaParams<R, F>): Schema<R, F> {
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

  const tables = physicalNames(["booking", "availabilityRule"], names?.tables);

  assertDistinct("stored value", stored);
  assertDistinct("column name", bookingColumns);
  assertDistinct("column name", ruleColumns);
  assertDistinct("table name", tables);

  return {
    booking: { fields },
    names: {
      columns: { availabilityRule: ruleColumns, booking: bookingColumns },
      tables,
    },
    resource: { idType },
    statuses: {
      booked: { blocking: true, stored: stored.booked },
      cancelled: { blocking: false, stored: stored.cancelled },
    },
  };
}
