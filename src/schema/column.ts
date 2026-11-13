declare const columnType: unique symbol;

/** The storage kinds a schema column can have. */
export type ColumnKind = "text" | "uuid" | "integer" | "boolean" | "instant";

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

/** Any valid column: each kind fixes its TypeScript type, so a hand-built `Column<"boolean", string>` is rejected. */
export type AnyColumn =
  | Column<"text" | "uuid", string>
  | Column<"integer", number>
  | Column<"boolean", boolean>
  | Column<"instant", Temporal.Instant>;

/** The column kinds a Resource id can have. */
export type ResourceIdColumn =
  | Column<"text" | "uuid", string>
  | Column<"integer", number>;

/** The TypeScript type a column holds. */
export type TypeOf<C> = C extends Column<ColumnKind, infer T> ? T : never;

/**
 * Column helpers for `idType` and Developer Field types. One object, because
 * Drizzle also exports `text`/`integer`/`boolean` and schema files import both.
 * Pass a type argument to adopt a brand: `column.integer<StaffId>()`.
 */
export const column = {
  /** A boolean column. */
  boolean: (): Column<"boolean", boolean> => ({ kind: "boolean" }),
  /** A Temporal.Instant column. */
  instant: (): Column<"instant", Temporal.Instant> => ({ kind: "instant" }),
  /** An integer column; `T` may be a branded number. */
  integer: <T extends number = number>(): Column<"integer", T> => ({
    kind: "integer",
  }),
  /** A text column; `T` may be a branded string. */
  text: <T extends string = string>(): Column<"text", T> => ({ kind: "text" }),
  /** A UUID column; `T` may be a branded string. */
  uuid: <T extends string = string>(): Column<"uuid", T> => ({ kind: "uuid" }),
};
