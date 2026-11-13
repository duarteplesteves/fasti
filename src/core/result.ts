/** An `ok` value, or an expected failure as `error`; Core functions return this instead of throwing. */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Structurally the Standard Schema `Issue`; copied so the Core has no dependency. */
export interface Issue {
  readonly message: string;
  readonly path?:
    | readonly (PropertyKey | { readonly key: PropertyKey })[]
    | undefined;
}

/** The params broke one or more meaning checks; `issues` lists every one. */
export interface InvalidParams {
  readonly _tag: "InvalidParams";
  readonly issues: readonly [Issue, ...Issue[]];
}

/** Runs `compute` only when there are no issues. Internal; not exported from the Core. */
export function checked<T>(
  issues: readonly Issue[],
  compute: () => T
): Result<T, InvalidParams> {
  const [first, ...rest] = issues;

  return first === undefined
    ? { ok: true, value: compute() }
    : { error: { _tag: "InvalidParams", issues: [first, ...rest] }, ok: false };
}
