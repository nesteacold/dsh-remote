/** Poll until `predicate` is true or the timeout elapses. Test-only helper. */

export async function waitFor(predicate: () => boolean, options: { timeoutMs?: number; label?: string } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms${options.label ? ` (${options.label})` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A promise plus its resolver for event-driven tests. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
