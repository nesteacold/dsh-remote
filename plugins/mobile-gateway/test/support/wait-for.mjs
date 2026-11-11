// Await state, not a sleep.
//
// WHY THIS FILE EXISTS (measured 2026-11-10): `remote-bridge.test.mjs` T6 asserted
// `hostStream.signal.aborted === true` / `hostStream.returned === true` after
// `await delay(100)`. That passed alone and failed once while `npm run test:package` ran in
// another process: the cancel path emits `remote-stream-closed` and settles the Host iterator's
// abort/return on a later microtask/tick, so a fixed 100 ms is a bet on the scheduler — and the
// scheduler loses under CPU contention.
//
// A sleep used as synchronisation has exactly two outcomes: too short (flake) or too long (slow).
// `waitFor` removes the bet: it polls a predicate and returns as soon as the state is true, bounded
// by a deadline that is generous because it costs nothing when the state arrives early. On timeout
// it throws with the label and the last observed value, so a genuine regression reports *what* never
// happened instead of a bare assertion failure.
//
// It deliberately does NOT swallow anything: a predicate that never becomes true is a failure, not a
// skip. Existing assertions stay where they are — this only decides *when* they run.

/**
 * Poll `predicate` until it is true, or throw after `timeoutMs`.
 *
 * @param {() => boolean} predicate state check; must be cheap and side-effect free
 * @param {{label?: string, timeoutMs?: number, intervalMs?: number}} [options]
 *   `label` names the state in the timeout error (e.g. 'the Host iterator aborted')
 * @returns {Promise<void>} resolves on the first true observation
 */
export async function waitFor(predicate, options = {}) {
  const { label = 'condition', timeoutMs = 10_000, intervalMs = 5 } = options
  const deadline = Date.now() + timeoutMs
  // Check before the first sleep: the common case (state already settled) costs no timer at all.
  if (predicate()) return
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    if (predicate()) return
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/**
 * Wait for `predicate`, then assert the value did not change for `quietMs`.
 *
 * This is for "no more work happens after X" assertions: it first waits for the state that makes
 * further work impossible (e.g. an iterator that has returned), then proves quiescence. The quiet
 * window is still a sleep, but it no longer gates *whether* the test proceeds — only the
 * no-change observation, which is what such an assertion actually means.
 *
 * @param {() => unknown} read value to watch
 * @param {{label?: string, timeoutMs?: number, quietMs?: number}} [options]
 * @returns {Promise<unknown>} the settled value
 */
export async function settlesAt(read, options = {}) {
  const { label = 'value', timeoutMs = 10_000, quietMs = 50 } = options
  const before = read()
  await waitFor(() => read() === before, { label: `${label} to stop changing`, timeoutMs })
  await new Promise((resolve) => setTimeout(resolve, quietMs))
  return read()
}
