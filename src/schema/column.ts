declare const columnType: unique symbol;

/** The storage kinds a schema column can have. `date`, `time`, `json` and `dates` are for Plugin tables only. */
export type ColumnKind =
  | "text"
  | "uuid"
  | "integer"
  | "boolean"
  | "instant"
  | "date"
  | "time"
  | "json"
  | "dates";

/** A JSON value. */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

/**
 * A column of kind `K` whose TypeScript type is `T`.
 *
 * @typeParam K - The storage kind.
 * @typeParam T - The TypeScript type of the column's values; may be a developer brand.
 */
export interface Column<K extends ColumnKind, T> {
  /** The storage kind. */
  readonly kind: K;
  /** Phantom carrier for `T`; never set at runtime. */
  readonly [columnType]?: T;
}

/** Any valid Developer Field column: each kind fixes its TypeScript type, so a hand-built `Column<"boolean", string>` is rejected. */
export type AnyColumn =
  | Column<"text" | "uuid", string>
  | Column<"integer", number>
  | Column<"boolean", boolean>
  | Column<"instant", Temporal.Instant>;

/** Any valid Plugin table column: the Developer Field kinds, plus `date`, `time`, `json` and `dates`. */
export type RecordColumn =
  | AnyColumn
  | Column<"date", Temporal.PlainDate>
  | Column<"time", Temporal.PlainTime>
  // A top-level JSON `null` would read back as an unset column, so it isn't a value here.
  | Column<"json", Exclude<Json, null>>
  | Column<"dates", readonly Temporal.PlainDate[]>;

/** The column kinds a Resource id can have. */
export type ResourceIdColumn =
  | Column<"text" | "uuid", string>
  | Column<"integer", number>;

/** The TypeScript type a column holds. */
export type TypeOf<C> = C extends Column<ColumnKind, infer T> ? T : never;

/**
 * Column helpers for `idType`, Developer Field types and Plugin table columns. One object, because
 * Drizzle also exports `text`/`integer`/`boolean` and schema files import both.
 * Pass a type argument to adopt a brand: `column.integer<StaffId>()`.
 */
export const column = {
  /**
   * A boolean column.
   *
   * @returns A column definition of kind `"boolean"`.
   */
  boolean: (): Column<"boolean", boolean> => ({ kind: "boolean" }),
  /**
   * A Temporal.PlainDate column; Plugin tables only.
   *
   * @returns A column definition of kind `"date"`.
   */
  date: (): Column<"date", Temporal.PlainDate> => ({ kind: "date" }),
  /**
   * A list of Temporal.PlainDate, in order; Plugin tables only.
   *
   * @returns A column definition of kind `"dates"`.
   */
  dates: (): Column<"dates", readonly Temporal.PlainDate[]> => ({
    kind: "dates",
  }),
  /**
   * A Temporal.Instant column.
   *
   * @returns A column definition of kind `"instant"`.
   */
  instant: (): Column<"instant", Temporal.Instant> => ({ kind: "instant" }),
  /**
   * An integer column; `T` may be a branded number.
   *
   * @returns A column definition of kind `"integer"`.
   */
  integer: <T extends number = number>(): Column<"integer", T> => ({
    kind: "integer",
  }),
  /**
   * A JSON column holding a `T`; Plugin tables only. Object key order isn't kept.
   *
   * @returns A column definition of kind `"json"`.
   */
  json: <T extends Exclude<Json, null>>(): Column<"json", T> => ({
    kind: "json",
  }),
  /**
   * A text column; `T` may be a branded string.
   *
   * @returns A column definition of kind `"text"`.
   */
  text: <T extends string = string>(): Column<"text", T> => ({ kind: "text" }),
  /**
   * A Temporal.PlainTime column; Plugin tables only.
   *
   * @returns A column definition of kind `"time"`.
   */
  time: (): Column<"time", Temporal.PlainTime> => ({ kind: "time" }),
  /**
   * A UUID column; `T` may be a branded string.
   *
   * @returns A column definition of kind `"uuid"`.
   */
  uuid: <T extends string = string>(): Column<"uuid", T> => ({ kind: "uuid" }),
};
