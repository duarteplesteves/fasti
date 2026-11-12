import type { InvalidParams, Issue, Result } from "../core/result.js";

/** The value of an ok result; throws (failing the test) otherwise. */
export function unwrap<T>(result: Result<T, InvalidParams>): T {
  if (!result.ok) {
    throw new Error(
      `Expected ok, got issues: ${JSON.stringify(result.error.issues)}`
    );
  }

  return result.value;
}

/** The issue paths of a failed result; throws (failing the test) if the result is ok. */
export function issuePaths(
  result: Result<unknown, InvalidParams>
): Issue["path"][] {
  if (result.ok) {
    throw new Error("Expected InvalidParams, got ok");
  }

  return result.error.issues.map((i) => i.path);
}
