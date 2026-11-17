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

/** Declared Statuses beyond the base, each saying whether it blocks its slot. */
export type StatusDecls = Readonly<
  Record<string, { readonly blocking: boolean }>
>;

/** Every Status of a schema declaring `D`: the base ones plus the declared ones. */
export type StatusesOf<D extends StatusDecls> = BaseStatus | (keyof D & string);

/** A Transition table: each Status → the Statuses it may move to. */
export type TransitionTable<St extends string> = Readonly<
  Partial<Record<St, readonly St[]>>
>;

/** A resolved Transition table: every Status has an entry; one with none leaving it is terminal. */
export type Transitions<St extends string> = Readonly<
  Record<St, readonly St[]>
>;

/** The resolved table of `defineSchema`: `booked → cancelled` always added, `[]` for an undeclared Status. */
export type ResolveTransitions<T, St extends string> = {
  readonly [K in St]: K extends "booked"
    ? readonly (Extract<TargetsOf<T, K>, St> | "cancelled")[]
    : readonly Extract<TargetsOf<T, K>, St>[];
};

type TargetsOf<T, K extends PropertyKey> =
  T extends Readonly<Record<K, readonly (infer X)[]>> ? X : never;

/** The stored value of Status `K`: its rename in `N`, else its logical name. */
type StoredOf<N, K extends string> = K extends keyof N
  ? N[K] extends string
    ? N[K]
    : K
  : K;

/** Refuses a rename whose stored value another Status already has (I6). A non-literal value can't be checked here. */
type DistinctStored<N, St extends string> = {
  readonly [K in St]?: string extends StoredOf<N, K>
    ? string
    : StoredOf<N, K> extends StoredOf<N, Exclude<St, K>>
      ? never
      : string;
};

/**
 * Input to {@link defineSchema}. Every option has a default.
 *
 * @typeParam R - The Resource id column.
 * @typeParam F - The Developer Fields.
 * @typeParam B - The Block's Developer Fields, or `null` for a schema without Blocks.
 * @typeParam D - The declared Statuses beyond the base.
 * @typeParam T - The declared Transitions.
 * @typeParam I - The Statuses `book` may create a Booking in.
 * @typeParam N - The stored Status values, by logical name.
 */
export interface DefineSchemaParams<
  R extends ResourceIdColumn,
  F extends Fields,
  B extends Fields | null = null,
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- "no declared Statuses" is exactly `{}`.
  D extends StatusDecls = Record<never, never>,
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- "no declared Transitions" is exactly `{}`.
  T = Record<never, never>,
  I extends readonly string[] = readonly ["booked"],
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- "no renamed Statuses" is exactly `{}`.
  N = Record<never, never>,
> {
  /** The Resource id type; defaults to `column.text()`. */
  readonly resource?: { readonly idType: R };
  readonly booking?: {
    /** Developer Fields on the Booking; a name that collides with a Booking column, or `also` (reserved), is a type error. */
    readonly fields?: F &
      Partial<Readonly<Record<BookingColumn | "also", never>>>;
    /** Statuses beyond `booked` and `cancelled`, each with `blocking`; redeclaring a base Status is a type error. */
    readonly statuses?: D & Partial<Readonly<Record<BaseStatus, never>>>;
    /** The Transitions each Status may make (ADR 009); `booked → cancelled` is always added. */
    readonly transitions?: T &
      NoInfer<
        TransitionTable<StatusesOf<D>> &
          Readonly<Record<Exclude<keyof T, BaseStatus | keyof D>, never>>
      >;
    /** The Statuses `book` may create a Booking in; defaults to `["booked"]`. With more than one, `book` takes a `status`. */
    readonly initial?: I &
      NoInfer<readonly [StatusesOf<D>, ...StatusesOf<D>[]]>;
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
    /** Stored Status values; two Statuses sharing one is a type error. */
    readonly statuses?: N &
      Partial<Record<BaseStatus | NoInfer<keyof D & string>, string>> &
      NoInfer<DistinctStored<N, StatusesOf<D>>>;
  };
}

/** Refuses a Block Developer Field named after a Block column, or `also` (reserved). Apart from `block`, so `fields: {}` still infers B (an intersection there drops the inference). */
interface BlockFieldGuard {
  readonly block?: {
    readonly fields: Partial<Readonly<Record<BlockColumn | "also", never>>>;
  };
}

/**
 * A resolved schema: every default filled in, so nothing downstream handles a missing option.
 *
 * @typeParam R - The Resource id column.
 * @typeParam F - The Developer Fields.
 * @typeParam St - The Statuses.
 * @typeParam B - The Block's Developer Fields, or `null` for a schema without Blocks.
 * @typeParam Tr - The resolved Transition table.
 * @typeParam In - The Statuses `book` may create a Booking in.
 */
export interface Schema<
  R extends ResourceIdColumn = ResourceIdColumn,
  F extends Fields = Fields,
  St extends string = BaseStatus,
  B extends Fields | null = null,
  Tr extends Transitions<St> = Transitions<St>,
  In extends St = Extract<St, "booked">,
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
  /** Each Status → the Statuses it may move to; always includes `booked → cancelled`. */
  readonly transitions: Tr;
  /** The Statuses `book` may create a Booking in. */
  readonly initial: readonly [In, ...In[]];
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
export type AnySchema = Schema<
  ResourceIdColumn,
  Fields,
  string,
  Fields | null,
  Transitions<string>,
  string
>;

/** The Statuses `book` may create a Booking of `S` in. */
export type InitialOf<S extends AnySchema> = S["initial"][number];

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

/** Throw when `status` isn't a Status of the schema: a definition-time defect. */
function assertStatus(
  where: string,
  statuses: readonly string[],
  status: string
): void {
  if (!statuses.includes(status)) {
    throw new Error(
      `defineSchema: \`${where}\` names "${status}", which isn't a Status.`
    );
  }
}

/** Throw on a Developer Field named `also`, which write Actions reserve. */
function assertNotAlso(kind: string, fields: Fields): void {
  if (Object.hasOwn(fields, "also")) {
    throw new Error(
      `defineSchema: a ${kind} Developer Field can't be named "also"; it is reserved.`
    );
  }
}

/** The lifecycle as declared in `booking`, untyped; `defineSchema` checks it here and types it. */
interface Lifecycle {
  readonly statuses: Readonly<
    Record<string, { readonly blocking: boolean; readonly stored: string }>
  >;
  readonly transitions: Readonly<Record<string, readonly string[]>>;
  readonly initial: readonly string[];
}

/** Resolve and check Statuses, Transitions and initial Statuses (ADR 009). */
function resolveLifecycle(
  booking:
    | {
        readonly statuses?: StatusDecls;
        readonly transitions?: unknown;
        readonly initial?: readonly string[];
      }
    | undefined,
  renamed: Partial<Record<string, string>> | undefined
): Lifecycle {
  const blocking = new Map([
    ["booked", true],
    ["cancelled", false],
  ]);

  for (const [status, decl] of Object.entries(booking?.statuses ?? {})) {
    if (blocking.has(status)) {
      throw new Error(
        `defineSchema: "${status}" is a base Status; it can't be redeclared.`
      );
    }

    // Plain-JS callers can leave it out; a silent non-blocking Status would let overlaps through.
    if (![true, false].includes(decl.blocking)) {
      throw new TypeError(
        `defineSchema: Status "${status}" needs \`blocking: true\` or \`blocking: false\`.`
      );
    }

    blocking.set(status, decl.blocking);
  }

  const names = [...blocking.keys()];
  const stored = physicalNames(names, renamed);

  assertDistinct("stored value", stored);

  // SAFETY: TransitionTable is a record of Status arrays; its names are checked next.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the declared table is generic; read it as plain data.
  const table = (booking?.transitions ?? {}) as Readonly<
    Record<string, readonly string[]>
  >;

  for (const [from, to] of Object.entries(table)) {
    for (const status of [from, ...to]) {
      assertStatus("transitions", names, status);
    }
  }

  const initial = booking?.initial ?? ["booked"];

  if (initial.length === 0) {
    throw new Error("defineSchema: `initial` needs at least one Status.");
  }

  for (const status of initial) {
    assertStatus("initial", names, status);
  }

  return {
    initial: [...initial],
    statuses: Object.fromEntries(
      names.map((status) => [
        status,
        {
          blocking: blocking.get(status) ?? false,
          stored: stored[status] ?? status,
        },
      ])
    ),
    transitions: Object.fromEntries(
      names.map((from) => {
        const to = Object.hasOwn(table, from) ? (table[from] ?? []) : [];

        return [
          from,
          from === "booked" && !to.includes("cancelled")
            ? [...to, "cancelled"]
            : [...to],
        ];
      })
    ),
  };
}

/**
 * Resolve a schema definition: physical names, the Resource id type, Developer Fields and Statuses.
 *
 * @typeParam R - The Resource id column; defaults to `column.text()`.
 * @typeParam F - The Developer Fields.
 * @typeParam B - The Block's Developer Fields; `null` (no Blocks) when `block` is absent.
 * @typeParam D - The declared Statuses beyond the base.
 * @typeParam T - The declared Transitions.
 * @typeParam I - The initial Statuses; `["booked"]` when `initial` is absent.
 * @typeParam N - The stored Status values.
 * @throws When a base Status is redeclared, `transitions` or `initial` names an unknown Status, `initial` is empty,
 * a Developer Field is named `also`, two Statuses share a stored value (I6), or two columns of one table, or two tables, share a physical name.
 */
export function defineSchema<
  R extends ResourceIdColumn = Column<"text", string>,
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- "no Developer Fields" is exactly `{}`.
  F extends Fields = Record<never, never>,
  B extends Fields | null = null,
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- "no declared Statuses" is exactly `{}`.
  const D extends StatusDecls = Record<never, never>,
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- "no declared Transitions" is exactly `{}`.
  const T = Record<never, never>,
  const I extends readonly string[] = readonly ["booked"],
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- "no renamed Statuses" is exactly `{}`.
  const N = Record<never, never>,
>(
  params: DefineSchemaParams<R, F, B, D, T, I, N> & BlockFieldGuard
): Schema<
  R,
  F,
  StatusesOf<D>,
  B,
  ResolveTransitions<T, StatusesOf<D>>,
  I[number] & StatusesOf<D>
> {
  type St = StatusesOf<D>;

  const { names } = params;
  // SAFETY: R falls back to its default, Column<"text", string>, exactly when `resource` is absent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the default can't be tied to absence in the signature.
  const idType = (params.resource?.idType ?? column.text()) as R;
  // SAFETY: F falls back to its default, no fields, exactly when `fields` is absent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above, for F.
  const fields = (params.booking?.fields ?? {}) as F;
  const blockFields = params.block?.fields ?? {};

  assertNotAlso("Booking", fields);
  assertNotAlso("Block", blockFields);

  // SAFETY: resolveLifecycle has an entry for every St, adds booked → cancelled, and checks that transitions and initial name only St.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the Status names are only known at runtime.
  const lifecycle = resolveLifecycle(params.booking, names?.statuses) as Pick<
    Schema<R, F, St, B, ResolveTransitions<T, St>, I[number] & St>,
    "initial" | "statuses" | "transitions"
  >;

  const bookingColumns = physicalNames<BookingColumn | keyof F>(
    [...BOOKING_COLUMNS, ...Object.keys(fields)],
    names?.columns?.booking
  );

  const ruleColumns = physicalNames(
    AVAILABILITY_RULE_COLUMNS,
    names?.columns?.availabilityRule
  );

  // SAFETY: the keys are the Block columns plus B's field names, exactly the declared key type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- B's keys are only known at runtime.
  const blockColumns = physicalNames<string>(
    [...BLOCK_COLUMNS, ...Object.keys(blockFields)],
    names?.columns?.block
  ) as Schema<R, F, St, B>["names"]["columns"]["block"];

  const tables = physicalNames(
    ["booking", "availabilityRule", "block"],
    names?.tables
  );

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
    St,
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
    ...lifecycle,
  };
}
