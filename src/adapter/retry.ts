/** Attempts at a unit of work that fails with a transient error, the first included. */
const MAX_ATTEMPTS = 3;

/** Whether `matches` holds for `error` or any link of its `cause` chain. */
export function someCause(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejection reason is whatever was thrown.
  error: unknown,
  // oxlint-disable-next-line anti-slop/no-object-parameters -- a link is any thrown object; `matches` reads its fields with `in`.
  matches: (link: object) => boolean
): boolean {
  // At most 10 links, so a `cause` that loops back (a developer's thrown value can) ends the walk.
  for (
    let depth = 0, e = error;
    e instanceof Object && depth < 10;
    e = "cause" in e ? e.cause : null, depth += 1
  ) {
    if (matches(e)) {
      return true;
    }
  }

  return false;
}

/** Run `unit`, rerunning the whole of it on a transient error (ADR 008), up to {@link MAX_ATTEMPTS} times. */
export async function retryTransient<T>(
  unit: () => Promise<T>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejection reason is whatever was thrown.
  isTransient: (error: unknown) => boolean
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- attempts run one after another.
      return await unit();
    } catch (error) {
      if (!isTransient(error) || attempt === MAX_ATTEMPTS) {
        throw error;
      }
    }
  }
}
