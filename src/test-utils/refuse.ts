/** An Adapter verb that must never be called: rejects, so a call fails the test. */
export async function refuse(): Promise<never> {
  return await Promise.reject(new Error("no Adapter call expected"));
}
