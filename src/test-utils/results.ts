import type { InvalidParams, Issue, Result } from "../core/result.js";
import type { AdapterError } from "../framework/errors.js";

/** The value of an ok result; throws (failing the test) otherwise. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`Expected ok, got: ${JSON.stringify(result.error)}`);
  }

  return result.value;
}

/** The issue paths of an `InvalidParams` result; throws (failing the test) on ok or any other error. */
export function issuePaths(
  result: Result<unknown, InvalidParams | AdapterError>
): Issue["path"][] {
  if (result.ok || result.error._tag !== "InvalidParams") {
    throw new Error(`Expected InvalidParams, got: ${JSON.stringify(result)}`);
  }

  return result.error.issues.map((i) => i.path);
}
