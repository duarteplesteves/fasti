/** Runs each unit given to it after the one before has settled, so at most one runs at a time. */
export type Serialize = <T>(unit: () => Promise<T>) => Promise<T>;

/** A new line of units: each waits for the previous one to resolve or reject, in call order. */
export function serialize(): Serialize {
  let queue: Promise<unknown> = Promise.resolve();

  return async (unit) => {
    const result = queue.then(unit);

    // The next unit waits for this one to settle, whether it resolves or rejects.
    queue = result.catch(() => null);

    return await result;
  };
}
