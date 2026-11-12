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

/** The issue paths of a failed result (or of an issue list); throws if the result is ok. */
export function issuePaths(
  input: Result<unknown, InvalidParams> | readonly Issue[]
): Issue["path"][] {
  if ("ok" in input) {
    if (input.ok) {
      throw new Error("Expected InvalidParams, got ok");
    }

    return input.error.issues.map((i) => i.path);
  }

  return input.map((i) => i.path);
}
