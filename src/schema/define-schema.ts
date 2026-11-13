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
 * @template R - The Resource id column.
 * @template F - The Developer Fields.
 */
export interface DefineSchemaParams<
  R extends ResourceIdColumn,
  F extends Fields,
> {
  /** The Resource id type; defaults to `column.text()`. */
  readonly resource?: { readonly idType: R };
  /** Developer Fields on the Booking; a name that collides with a Booking column is a type error. */
  readonly booking?: {
    readonly fields?: F & { readonly [K in BookingColumn]?: never };
  };
  /** Physical names; each defaults to its logical name. */
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
    /** Stored Status values; each must be distinct. */
    readonly statuses?: Partial<Record<BaseStatus, string>>;
  };
}

/**
 * A resolved schema: every default filled in, so nothing downstream handles a missing option.
 *
 * @template R - The Resource id column.
 * @template F - The Developer Fields.
 * @template St - The Statuses.
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
  readonly statuses: {
    readonly [K in St]: { readonly blocking: boolean; readonly stored: string };
  };
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
  return Object.fromEntries(
    logical.map((name) => [
      name,
      (renamed && Object.hasOwn(renamed, name) ? renamed[name] : undefined) ??
        String(name),
    ])
  ) as Record<K, string>;
}

/**
 * Resolve a schema definition: physical names, the Resource id type, Developer Fields and Statuses.
 *
 * @template R - The Resource id column; defaults to `column.text()`.
 * @template F - The Developer Fields.
 * @param params - The schema definition.
 * @returns The resolved schema.
 * @throws {Error} When two Statuses share a stored value: a definition-time defect.
 */
export function defineSchema<
  R extends ResourceIdColumn = Column<"text", string>,
  F extends Fields = Record<never, never>,
>(params: DefineSchemaParams<R, F>): Schema<R, F> {
  const { names } = params;
  // SAFETY: R falls back to its default, Column<"text", string>, exactly when `resource` is absent.
  const idType = (params.resource?.idType ?? column.text()) as R;
  // SAFETY: F falls back to its default, no fields, exactly when `fields` is absent.
  const fields = (params.booking?.fields ?? {}) as F;
  const stored = physicalNames(["booked", "cancelled"], names?.statuses);

  if (stored.booked === stored.cancelled) {
    throw new Error(
      `defineSchema: Statuses "booked" and "cancelled" share the stored value "${stored.booked}"; each stored value must belong to one Status.`
    );
  }

  return {
    booking: { fields },
    names: {
      columns: {
        availabilityRule: physicalNames(
          AVAILABILITY_RULE_COLUMNS,
          names?.columns?.availabilityRule
        ),
        booking: physicalNames<BookingColumn | keyof F>(
          [...BOOKING_COLUMNS, ...Object.keys(fields)],
          names?.columns?.booking
        ),
      },
      tables: physicalNames(["booking", "availabilityRule"], names?.tables),
    },
    resource: { idType },
    statuses: {
      booked: { blocking: true, stored: stored.booked },
      cancelled: { blocking: false, stored: stored.cancelled },
    },
  };
}
