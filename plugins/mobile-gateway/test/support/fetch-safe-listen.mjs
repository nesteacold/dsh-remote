// A loopback listen that undici's `fetch` can actually reach.
//
import net from 'node:net'
//
// Node's WHATWG `fetch` is undici, and undici refuses the Fetch standard's
// "bad ports" outright — before it opens a socket (`TypeError: fetch failed`
// with `cause: Error: bad port`). The tests below bind with port 0 and let the
// OS choose, so on a draw of 6666, 10080 or any other blocked port the harness
// died with an error that had nothing to do with the gateway: `npm test` went
// red for an environmental reason (measured here on port 6666 and 10080), and
// the `&&` chain then skipped every later group.
//
// So bind, then prove — with the same `fetch` the tests use — that the port is
// accepted; on a refusal, close and bind another. Bounded, so a machine that
// never yields an accepted port fails loudly instead of flaking. Nothing about
// the product under test is skipped: the port still comes from the OS, and the
// assertion is only "this port is reachable", which every test already assumed.
//
// The TLS listener the gateway itself owns is reached with `ws` (no port policy),
// so it keeps `lanPort: 0` and is not routed through here.
//
// The proof must not depend on the fixture having booted. `test/webrtc/helpers.mjs`
// binds, then calls `plugin.apply()`; its request handler dereferences a `management`
// route that `apply()` sets later, so a probe reaching it threw
// `TypeError: Cannot read properties of undefined (reading 'handler')` and failed
// five tests (measured). `probe: 'fetch'` (default) is for a fixture whose handler is
// already wired and answers an unknown path with 404 — how every other converted
// fixture is written. `probe: 'tcp'` is for the not-yet-wired ones: it proves only
// that the OS accepted the bind, and the bad-port half of the check is the blocklist
// below, which is undici's own policy (measured port by port on this machine).
//
// Measured on Node 24.18.0 (2026-11-10): every port in `FETCH_BAD_PORTS` under
// 1024 plus the listed ones refuses `fetch` with `bad port`; a control port
// (54321) answers normally; port 6000 cannot even be bound here (EACCES — the
// range is reserved on this machine), which is why a bad *draw* is what matters.

/**
 * The Fetch standard's blocked ("bad") port list, as undici implements it: the
 * ports this helper must never hand a test that will `fetch` them.
 *
 * This is a fast path, not the source of truth: `listenFetchSafe` still probes
 * every candidate with a real `fetch`, so a change in undici's policy is caught
 * here instead of resurfacing as flake.
 */
export const FETCH_BAD_PORTS = new Set([
  0, 1, 4, 6, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
  427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
  990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6679, 6697, 10080,
])

/** Path the probe requests; every fixture server answers an unknown path with 404. */
const PROBE_PATH = '/__fetch-safe-probe__'

/**
 * True when `error` is undici refusing the port. The refusal is reported on a
 * `cause` chain, so the whole chain is walked: `TypeError: fetch failed` alone
 * is every failed fetch, and only the `bad port` cause means the port is at fault.
 * @param {unknown} error
 * @returns {boolean}
 */
export function describesBadPort(error) {
  for (let current = error; current; current = current.cause) {
    if (/bad port/i.test(String(current.message ?? ''))) return true
  }
  return false
}

/**
 * Drop the probe's keep-alive socket so it cannot hold `server.close()` open.
 * `node:http` servers have this since Node 18.2; the guard keeps the helper
 * usable on a plain server-like object.
 * @param {{closeIdleConnections?: () => void}} server
 */
export function closeIdleConnections(server) {
  server?.closeIdleConnections?.()
}

/**
 * Bind a server (or create one per attempt) on an OS-chosen loopback port that
 * `fetch` accepts.
 *
 * @param {(() => import('node:http').Server) | import('node:http').Server} target
 *   A factory returning a fresh server, or a server instance to reuse. A factory
 *   is used by fixtures whose request handler is built from closure state; an
 *   instance is reused by fixtures whose handlers are already attached.
 * @param {{attempts?: number, host?: string, probePath?: string, probeTimeoutMs?: number, probe?: 'fetch' | 'tcp'}} [options]
 *   `probe: 'tcp'` for a fixture whose request handler cannot answer yet (bind
 *   before the plugin registers its route); see the note at the top.
 * @returns {Promise<{server: import('node:http').Server, port: number}>}
 */
export async function listenFetchSafe(target, options = {}) {
  const {
    attempts = 20,
    host = '127.0.0.1',
    probePath = PROBE_PATH,
    probeTimeoutMs = 5_000,
    probe = 'fetch',
  } = options
  const createServer = typeof target === 'function'
  let drawn = 0
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const server = createServer ? target() : target
    await listenOnEphemeralPort(server, host)
    const { port } = server.address()
    drawn = port
    // The list short-circuits a known-bad draw without touching the server; the
    // probe then proves the port against the `fetch` this suite actually calls.
    const accepted = !FETCH_BAD_PORTS.has(port) && (probe === 'tcp'
      ? await tcpAccepts(host, port, probeTimeoutMs)
      : await fetchAccepts(host, port, probePath, probeTimeoutMs))
    if (accepted) {
      closeIdleConnections(server)
      return { server, port }
    }
    await closeServer(server)
  }
  throw new Error(
    `no fetch-safe loopback port after ${attempts} attempts (last drawn port: ${drawn}; ` +
    'undici refuses it with "bad port"). Refusing to run a test against a port fetch cannot reach.',
  )
}

/** Bind port 0 and settle once listening; an error rejects instead of hanging. */
async function listenOnEphemeralPort(server, host) {
  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, host)
  })
}

/**
 * One probe against the port: any answer (including this fixture's 404) means
 * undici connected, which is all the port choice has to guarantee. Any failure
 * that is not a bad-port refusal is therefore accepted too — only undici naming
 * the port is the port's fault.
 */
async function fetchAccepts(host, port, probePath, timeoutMs) {
  try {
    // Same interface the fixture bound: probing a different host would test a
    // different listener (a fixture may bind a LAN address rather than loopback).
    const response = await fetch(`http://${host}:${port}${probePath}`, { signal: AbortSignal.timeout(timeoutMs) })
    await response.text() // drain, so the keep-alive socket can be reclaimed
    return true
  } catch (error) {
    return !describesBadPort(error)
  }
}

/**
 * Raw TCP reachability, for a fixture whose `request` handler cannot answer yet.
 * It proves the bind took and the port is connectable; it deliberately says
 * nothing about undici's policy (the blocklist above does that), because reaching
 * into a not-yet-wired fixture is exactly what crashed five webrtc tests.
 */
async function tcpAccepts(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const finish = (accepted) => { socket.destroy(); resolve(accepted) }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Close a rejected candidate, ignoring a server that never bound. */
async function closeServer(server) {
  if (!server.listening) return
  closeIdleConnections(server)
  await new Promise((resolve) => server.close(() => resolve()))
}
