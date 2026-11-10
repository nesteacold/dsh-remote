// Outbound half of the Devices page (spec 008): a pinned WSS client that speaks
// the mobile companion protocol (packages/mobile-protocol, contract rev 3) to a
// remote DSH Host's mobile-gateway as a `desktop` device.
//
// Security invariants (FR2/FR3, constitution "TLS + per-device auth"):
//  - The leaf certificate SHA-256 from the pairing payload is verified BEFORE a
//    single credential byte is sent: the certificate is read from the socket's
//    handshake, and the WebSocket then runs on that same verified socket. The
//    platform CA store is never consulted — the pin is the whole trust decision,
//    so a Host whose TLS implementation refuses a self-signed anchor (Electron's
//    BoringSSL) still pairs.
//  - The pairing code travels only in the `dsh-pair.<code>` subprotocol and the
//    device token only in `Authorization`; neither is ever put in a URL, an
//    error message or a log line.
//  - No `Origin` header is sent (the gateway refuses foreign origins by default).
import crypto from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { createRequire } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'

// `ws` is not a dependency of this folder yet (no network install in this
// workspace); it is resolved from the sibling gateway plugin, which pins it.
// When @dsh-ext/devices is installed on its own, add "ws" to its dependencies
// and this falls back to the normal resolution.
//
// Resolved on first use, never at import (T032): with the two plugins installed
// apart a missing `ws` must still let this module (and the Devices routes) load,
// and every path that needs it must name the dependency instead of dying as a
// bare MODULE_NOT_FOUND, which the page could only show as "unreachable".
const require = createRequire(import.meta.url)
export function getWebSocket() {
  let firstError
  try { return require('ws') } catch (error) { firstError = error }
  try { return require('../../mobile-gateway/node_modules/ws') } catch { /* not installed there either */ }
  // The message reaches the user, so it carries no filesystem path.
  throw Object.assign(new RemoteInputError('ws is not installed for @dsh-ext/devices', 500, 'remote/ws-missing'),
    { cause: firstError })
}

export const PROTOCOL = 'dsh-mobile-v1'
export const CLOSE_REVOKED = 4401
export const CLOSE_GATEWAY_DISABLED = 4004
export const CLOSE_REAUTH = 4003
export const COMPANION_PROTOCOL_VERSION = 1
const PAIRING_PAYLOAD_VERSION = 3
const HEX64 = /^[a-f0-9]{64}$/

/** A pairing string or address the user typed is unusable; the message is safe to show. */
export class RemoteInputError extends Error {
  constructor(message, status = 400, code = 'bad-request') {
    super(message)
    this.name = 'RemoteInputError'
    this.status = status
    this.code = code
  }
}

/** The presented certificate is not the pinned one. Nothing was sent. */
export class PinMismatchError extends RemoteInputError {
  constructor(expected, actual) {
    super(`certificate pin mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…); no credential was sent`, 502, 'pin-mismatch')
    this.name = 'PinMismatchError'
  }
}

export const sha256Hex = (der) => crypto.createHash('sha256').update(der).digest('hex')

/** Decode and validate the unpadded-base64url JSON pairing string (contract §2). */
export function decodePairingString(text, now = Date.now()) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{16,16384}$/.test(text.trim())) {
    throw new RemoteInputError('the pairing string must be unpadded base64url text')
  }
  let payload
  try { payload = JSON.parse(Buffer.from(text.trim(), 'base64url').toString('utf8')) } catch {
    throw new RemoteInputError('the pairing string does not decode to JSON')
  }
  if (!payload || typeof payload !== 'object' || payload.version !== PAIRING_PAYLOAD_VERSION) {
    throw new RemoteInputError(`unsupported pairing payload version (expected ${PAIRING_PAYLOAD_VERSION})`)
  }
  if (typeof payload.pairingCode !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(payload.pairingCode)) {
    throw new RemoteInputError('the pairing payload carries no usable pairing code')
  }
  if (typeof payload.certSha256 !== 'string' || !HEX64.test(payload.certSha256.toLowerCase())) {
    throw new RemoteInputError('the pairing payload carries no certificate pin (certSha256)')
  }
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= now) {
    throw new RemoteInputError('the pairing code has expired; generate a new one on the other device', 401, 'pairing/expired')
  }
  const urls = [payload.publicUrl, ...(Array.isArray(payload.endpoints) ? payload.endpoints : [])]
  if (!urls.every((url) => typeof url === 'string' && url.startsWith('wss://'))) {
    throw new RemoteInputError('every pairing endpoint must be wss://')
  }
  return { ...payload, certSha256: payload.certSha256.toLowerCase() }
}

/** Strip IPv6 brackets / zone and the IPv4-mapped prefix. */
export function normalizeHost(host) {
  let value = String(host ?? '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length)
  return value
}

/** Loopback, RFC1918, link-local, Tailscale CGNAT (100.64/10), ULA/link-local v6, `.local`. */
export function isPrivateAddress(host) {
  const value = normalizeHost(host)
  if (value === 'localhost' || value === '::1' || value.endsWith('.local')) return true
  const octets = value.split('.').map((part) => Number(part))
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254)
  }
  return net.isIPv6(value) && /^(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(value)
}

/**
 * Parse the address the user typed (`ip:port`, `[v6]:port`, or `wss://host:port[/path]`)
 * and require it to name the same listener as the pairing payload. Returns the
 * URL to dial (always from the payload, never from free text).
 */
export function resolveDialUrl(address, payload, { allowPublic = false } = {}) {
  const typed = String(address ?? '').trim()
  if (!typed) throw new RemoteInputError('an address (ip:port) is required')
  let host
  let port
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `wss://${typed}`)
    if (url.protocol !== 'wss:') throw new Error('scheme')
    if (url.username || url.password || url.search || url.hash) throw new Error('parts')
    host = normalizeHost(url.hostname)
    port = url.port || '443'
  } catch {
    throw new RemoteInputError('the address must look like 192.168.1.20:3081')
  }
  const candidates = [payload.publicUrl, ...(Array.isArray(payload.endpoints) ? payload.endpoints : [])]
    .map((value) => { try { return new URL(value) } catch { return null } })
    .filter(Boolean)
  const match = candidates.find((url) => normalizeHost(url.hostname) === host && (url.port || '443') === port)
  if (!match) throw new RemoteInputError('the address does not match any endpoint in the pairing string')
  if (!allowPublic && !isPrivateAddress(host)) {
    throw new RemoteInputError('only private-network addresses are allowed (public addresses are disabled by default)', 403, 'forbidden')
  }
  return match.toString()
}

function dialTarget(url) {
  const target = new URL(url)
  return { host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port) || 443 }
}

/** Read the leaf certificate a listener presents, sending no application data. */
export async function probeCertificate(url, { timeoutMs = 8000 } = {}) {
  const { host, port } = dialTarget(url)
  const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false })
  const timer = setTimeout(() => socket.destroy(new Error('TLS probe timed out')), timeoutMs)
  try {
    await once(socket, 'secureConnect')
    const raw = socket.getPeerCertificate(true)?.raw
    if (!raw) throw new Error('the listener presented no certificate')
    return raw
  } finally {
    clearTimeout(timer)
    socket.destroy()
  }
}

/**
 * Dial `url` and hand back the socket only once the leaf it presents hashes to
 * the pin. The handshake is all that happens before this resolves, so a peer
 * with another certificate never sees a credential byte.
 *
 * The pin is compared here rather than through `ca` + `checkServerIdentity`,
 * which is what made pairing fail inside the DSH Host (spec 008): that way the
 * trust decision is chain building, and builders disagree about the gateway's
 * self-signed leaf (basicConstraints CA:FALSE). OpenSSL accepts it as its own
 * trust anchor; BoringSSL — the Electron Host — answers
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE and Node then skips `checkServerIdentity`, so
 * the pin was never compared and every dial ended as "unreachable".
 */
async function openPinnedTlsSocket({ url, expected, timeoutMs }) {
  const { host, port } = dialTarget(url)
  // The hash comparison below is the trust decision: the gateway's certificate
  // is self-signed by design, so the platform's chain verdict is not consulted.
  const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false })
  const timer = setTimeout(() => socket.destroy(new Error('TLS handshake timed out')), timeoutMs)
  try {
    await once(socket, 'secureConnect')
    const raw = socket.getPeerCertificate(true)?.raw
    // An empty buffer would hash to the digest of no input, so reject it here:
    // only a certificate we actually hashed may be compared with the pin.
    if (!Buffer.isBuffer(raw) || raw.length === 0) throw new Error('the listener presented no certificate')
    const actual = sha256Hex(raw)
    if (actual !== expected) throw new PinMismatchError(expected, actual)
    return socket
  } catch (error) {
    // A refused/again-unreachable host keeps its socket code (`ECONNREFUSED`,
    // …): the Devices routes read that as "host offline" and answer from the
    // cached copy instead of failing the request.
    socket.destroy()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Open a WebSocket over that already-verified socket. `ws` writes the upgrade —
 * and with it the pairing code or the device token — only after the pin matched,
 * so the credential cannot precede the check.
 * @returns {Promise<import('ws').WebSocket>} the ws client, not yet open
 */
export async function openPinnedSocket({ url, protocols, headers, certSha256, timeoutMs = 8000, WebSocketImpl = getWebSocket() }) {
  const expected = String(certSha256).toLowerCase()
  if (!HEX64.test(expected)) throw new RemoteInputError('invalid certificate pin')
  const socket = await openPinnedTlsSocket({ url, expected, timeoutMs })
  try {
    return new WebSocketImpl(url, protocols, { createConnection: () => socket, headers, handshakeTimeout: timeoutMs })
  } catch (error) {
    socket.destroy()
    throw error
  }
}

let requestCounter = 0
const nextRequestId = () => `dev-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`
// The bridge refuses an id starting with `res.` (reserved for its own one-shot
// result streams) and accepts 1..64 of [A-Za-z0-9._-].
const nextStreamId = () => `dev-s-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`
const REMOTE_STREAM_CREDIT = 64

/**
 * Stop the bounded open wait of a `remote-stream-open`. It runs from the send
 * until the Host says anything about that stream, so a Host that answers the
 * open with nothing at all cannot keep the consumer waiting forever.
 */
function clearOpenTimer(state) {
  if (!state?.timer) return
  clearTimeout(state.timer)
  state.timer = null
}

/** Frames of one `remote-stream-open` handed to the consumer in order. */
class StreamQueue {
  constructor() {
    this.values = []
    this.waiters = []
    this.closed = false
    this.error = null
  }

  push(value) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) { waiter({ value, done: false }); return }
    this.values.push(value)
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  fail(error) {
    if (this.closed) return
    this.error = error
    this.close()
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.values.length > 0) { yield this.values.shift(); continue }
      if (this.closed) { if (this.error) throw this.error; return }
      const next = await new Promise((resolve) => this.waiters.push(resolve))
      if (next.done) { if (this.error) throw this.error; return }
      yield next.value
    }
  }
}

/**
 * One live, authenticated connection to one remote gateway. Emits:
 *  - `state`    (state, detail)   'connecting' | 'online' | 'offline' | 'revoked' | 'error'
 *  - `approval` (frame)           an `approval-requested` frame
 *  - `resolved` (frame)           an `approval-resolved` frame
 *  - `question` (frame)           a `question-requested` frame
 *  - `questionResolved` (frame)   a `question-resolved` frame
 *  - `revoked`  ()                the remote closed with 4401: the caller wipes the token
 */
export class RemoteConnection extends EventEmitter {
  // The `ws` implementation is not defaulted here on purpose: constructing a
  // connection must never resolve (and fail on) it — `openPinnedSocket` does at
  // dial time, so the missing dependency is reported by name, not at apply time.
  constructor({ remote, readToken, log = () => {}, requestTimeoutMs = 10_000, WebSocketImpl }) {
    super()
    this.remote = remote
    this.readToken = readToken
    this.log = log
    this.requestTimeoutMs = requestTimeoutMs
    this.WebSocketImpl = WebSocketImpl
    this.state = 'offline'
    this.ws = null
    this.waiters = new Map()
    // streamId -> collector of a `remote-call` result delivered as a stream.
    this.streams = new Map()
    // streamId -> state of a `remote-stream-open` this client asked for.
    this.wireStreams = new Map()
    // Frames that arrive before `call` registered the collector (the reply and
    // the first frames can land in the same tick), keyed by streamId.
    this.earlyStreamFrames = new Map()
    this.closedByUs = false
    this.hello = null
  }

  setState(state, detail) {
    this.state = state
    this.emit('state', state, detail)
  }

  /** Connect with the stored token; resolves once the gateway's `hello` arrived. */
  async connect() {
    // A connect already in flight (e.g. the fire-and-forget one after pairing)
    // is awaited, never raced: its socket exists before the gateway's `hello`.
    if (this.connecting) return this.connecting
    if (this.ws && this.state === 'online') return this.hello
    const token = this.readToken()
    if (!token) throw new RemoteInputError('no stored credential for this device; pair it again', 401, 'auth/required')
    this.closedByUs = false
    this.setState('connecting')
    this.connecting = this.#open(token).finally(() => { this.connecting = null })
    return this.connecting
  }

  async #open(token) {
    let ws
    try {
      ws = await openPinnedSocket({
        url: this.remote.publicUrl,
        protocols: [PROTOCOL],
        headers: { Authorization: `Bearer ${token}`, 'X-DSH-Device-ID': this.remote.clientDeviceId },
        certSha256: this.remote.certSha256,
      })
    } catch (error) {
      this.setState('error', error.message)
      throw error
    }
    this.ws = ws
    ws.on('message', (data) => this.#onMessage(data))
    ws.on('error', () => { /* surfaced through close/handshake below; never log the error object (headers) */ })
    ws.on('close', (code) => this.#onClose(code))
    const hello = await new Promise((resolve, reject) => {
      const fail = (reason) => { cleanup(); reject(reason) }
      const onHello = (frame) => { cleanup(); resolve(frame) }
      const timer = setTimeout(() => fail(new Error('timed out waiting for the gateway hello')), this.requestTimeoutMs)
      const onClose = (code) => fail(Object.assign(new Error(`gateway closed the connection (${code})`), { closeCode: code }))
      const onError = () => fail(new Error('could not connect to the remote gateway'))
      const cleanup = () => { clearTimeout(timer); ws.off('close', onClose); ws.off('error', onError); this.off('hello', onHello) }
      ws.once('close', onClose)
      ws.once('error', onError)
      this.once('hello', onHello)
    }).catch((error) => {
      try { ws.terminate() } catch { /* already gone */ }
      if (this.state === 'connecting') this.setState('error', error.message)
      throw error
    })
    this.hello = hello
    // Contract §4: declare the protocol revision we speak; a mismatch closes us with 4003.
    ws.send(JSON.stringify({ type: 'client-hello', requestId: nextRequestId(), companionProtocol: COMPANION_PROTOCOL_VERSION,
      appVersion: 'dsh-ext-devices/0.1.0', platform: 'desktop' }))
    this.setState('online')
    return hello
  }

  #onMessage(data) {
    let frame
    try { frame = JSON.parse(data.toString()) } catch { return }
    if (!frame || typeof frame !== 'object') return
    if (frame.kind === 'hello') { this.emit('hello', frame); return }
    if (frame.kind === 'approval-requested') { this.emit('approval', frame); return }
    if (frame.kind === 'approval-resolved') { this.emit('resolved', frame); return }
    // Question cards are the other interaction a Host can push to a device; the
    // multi-host router turns both into native `$events` cards (spec 008 P2c).
    if (frame.kind === 'question-requested') { this.emit('question', frame); return }
    if (frame.kind === 'question-resolved') { this.emit('questionResolved', frame); return }
    if (frame.kind === 'remote-frame' || frame.kind === 'remote-stream-closed') {
      if (this.#onWireStreamFrame(frame)) return
      this.#onStreamFrame(frame)
      return
    }
    if (typeof frame.requestId === 'string' && this.waiters.has(frame.requestId)) {
      const waiter = this.waiters.get(frame.requestId)
      this.waiters.delete(frame.requestId)
      clearTimeout(waiter.timer)
      waiter.resolve(frame)
    }
  }

  #onClose(code) {
    this.ws = null
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(Object.assign(new Error('the connection closed before the remote answered'), { closeCode: code }))
      this.waiters.delete(id)
    }
    for (const [id, collector] of this.streams) {
      clearTimeout(collector.timer)
      collector.reject(Object.assign(new Error('the connection closed before the streamed result arrived'), { closeCode: code }))
      this.streams.delete(id)
    }
    // An open `remote-stream-open` cannot survive its transport: end it so the
    // consumer (e.g. a merged workspace stream) can report the host as offline.
    for (const [id, state] of this.wireStreams) {
      clearOpenTimer(state)
      state.reader.fail(Object.assign(new Error('the connection closed while the stream was open'), { closeCode: code }))
      this.wireStreams.delete(id)
    }
    if (code === CLOSE_REVOKED) {
      this.setState('revoked')
      this.emit('revoked')
    } else if (this.closedByUs) {
      this.setState('offline')
    } else {
      this.setState('offline', `closed (${code})`)
    }
  }

  /** Send one request and await the frame echoing its `requestId`. */
  async request(frame, { signal } = {}) {
    await this.connect()
    const ws = this.ws
    if (!ws || ws.readyState !== 1) throw new Error('the connection to the remote is not open')
    const requestId = nextRequestId()
    return new Promise((resolve, reject) => {
      const settle = (fn, value) => {
        clearTimeout(timer)
        this.waiters.delete(requestId)
        signal?.removeEventListener?.('abort', onAbort)
        fn(value)
      }
      const timer = setTimeout(() => settle(reject, new Error('the remote did not answer in time')), this.requestTimeoutMs)
      // A call the UI cancelled must stop waiting; the remote answer is ignored
      // when it lands (the waiter is gone).
      const onAbort = () => settle(reject, Object.assign(new Error('the request was cancelled'), { code: 'cancelled' }))
      if (signal?.aborted) { onAbort(); return }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      this.waiters.set(requestId, {
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error),
        timer,
      })
      ws.send(JSON.stringify({ ...frame, requestId }), (error) => {
        if (error) settle(reject, error)
      })
    })
  }

  /**
   * One remote-bridge call (`remote-call`, spec 008 P1). Resolves with the Host's
   * value. A reply `{ ok:true, streamed:true, streamId }` means the result did not
   * fit one WS frame: it follows as `remote-frame`s (`{ $json }` slices of the
   * JSON text, or `{ $binary }` chunks) closed by `remote-stream-closed`. The
   * value is reassembled here (JSON parsed once, binary joined into a Buffer), so
   * callers never see the difference. Rejects on `{ ok:false }` and on a stream
   * that ends with an error or short.
   */
  async call(endpoint, args = {}, { timeoutMs = this.requestTimeoutMs, signal } = {}) {
    const reply = await this.request({ type: 'remote-call', endpoint, args }, { signal })
    if (reply.ok !== true) {
      throw Object.assign(new Error(reply.error?.message || 'the remote refused the call'),
        { code: reply.error?.code, scope: reply.error?.scope })
    }
    if (reply.streamed !== true) return reply.value
    if (typeof reply.streamId !== 'string') throw new Error('the remote announced a stream without an id')
    return this.#collectStream(reply.streamId, timeoutMs)
  }

  /**
   * Open a stream on the remote Host (`remote-stream-open`, spec 008 P1). The
   * Host answers with `remote-frame`s then `remote-stream-closed`; the values are
   * yielded in `seq` order exactly as the Host produced them (ids are NOT renamed
   * here — that is the caller's job). Credit is granted back every
   * REMOTE_STREAM_CREDIT frames so a long stream cannot stall on the Host's
   * default window. Cancelling (`signal`) or abandoning the iterator tells the
   * Host to stop (`remote-stream-cancel`).
   * @param {string} endpoint e.g. `session/follow`, `workspace/follow`
   * @param {object} args the exact `args` the Host's dispatchRpc receives
   * @returns {Promise<AsyncIterable<unknown>>}
   */
  async openStream(endpoint, args = {}, { signal } = {}) {
    await this.connect()
    const ws = this.ws
    if (!ws || ws.readyState !== 1) throw new Error('the connection to the remote is not open')
    const streamId = nextStreamId()
    const state = { reader: new StreamQueue(), next: 0, credit: REMOTE_STREAM_CREDIT, timer: null }
    this.wireStreams.set(streamId, state)
    // Releases the Host side exactly once: cancel frame, then the consumer ends.
    const cancel = (error) => {
      if (!this.wireStreams.delete(streamId)) return
      clearOpenTimer(state)
      try { this.ws?.send(JSON.stringify({ type: 'remote-stream-cancel', streamId })) } catch { /* closed */ }
      if (error) state.reader.fail(error)
      else state.reader.close()
    }
    const onAbort = () => cancel(Object.assign(new Error('the remote stream was cancelled'), { code: 'cancelled' }))
    if (signal?.aborted) {
      onAbort()
      return state.reader
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    ws.send(JSON.stringify({ type: 'remote-stream-open', streamId, endpoint, args }), (error) => {
      // A send failure means the socket is gone: the Host never saw the open.
      if (error) cancel(Object.assign(new Error('the remote stream could not be opened'), { code: 'remote/unreachable' }))
    })
    // An open the Host never answers (no frame, no close) would hang the consumer
    // for good: bound it like a request, tell the Host to stop, and fail the
    // iterator with a code the UI can show instead of an empty stream.
    state.timer = setTimeout(() => cancel(Object.assign(
      new Error(`the remote Host did not open the stream within ${this.requestTimeoutMs} ms`),
      { code: 'remote/stream-open-timeout' })), this.requestTimeoutMs)
    const connection = this
    return (async function* values() {
      try {
        yield* state.reader
      } finally {
        signal?.removeEventListener('abort', onAbort)
        cancel()
        connection.wireStreams.delete(streamId)
      }
    })()
  }

  /**
   * Frames of a `remote-stream-open`. Returns false when the id belongs to a
   * one-shot result stream (`res.N`), which `call` collects.
   */
  #onWireStreamFrame(frame) {
    const state = this.wireStreams.get(frame.streamId)
    if (!state) return false
    // The Host answered the open (a frame or the close): the bounded wait is over.
    clearOpenTimer(state)
    if (frame.kind === 'remote-stream-closed') {
      this.wireStreams.delete(frame.streamId)
      if (frame.error) state.reader.fail(Object.assign(new Error(frame.error.message || 'the remote stream failed'), { code: frame.error.code }))
      else state.reader.close()
      return true
    }
    if (frame.seq !== state.next) {
      this.wireStreams.delete(frame.streamId)
      state.reader.fail(new Error('the remote stream arrived out of order'))
      return true
    }
    state.next += 1
    state.credit -= 1
    if (state.credit <= 0) {
      state.credit += REMOTE_STREAM_CREDIT
      try { this.ws?.send(JSON.stringify({ type: 'remote-stream-credit', streamId: frame.streamId, n: REMOTE_STREAM_CREDIT })) } catch { /* closed */ }
    }
    state.reader.push(frame.value)
    return true
  }

  #collectStream(streamId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const collector = {
        parts: [], next: 0, kind: null, resolve, reject,
        timer: setTimeout(() => {
          this.streams.delete(streamId)
          // Tell the Host to stop sending; the result is unusable anyway.
          try { this.ws?.send(JSON.stringify({ type: 'remote-stream-cancel', streamId })) } catch { /* closed */ }
          reject(new Error('the streamed result did not complete in time'))
        }, timeoutMs),
      }
      this.streams.set(streamId, collector)
      const early = this.earlyStreamFrames.get(streamId)
      this.earlyStreamFrames.delete(streamId)
      for (const frame of early ?? []) this.#onStreamFrame(frame)
    })
  }

  #onStreamFrame(frame) {
    const streamId = frame.streamId
    if (typeof streamId !== 'string') return
    const collector = this.streams.get(streamId)
    if (!collector) {
      // Not collected (yet): keep a bounded buffer for a collector about to
      // register; frames of streams nobody asked for are dropped by the cap.
      const early = this.earlyStreamFrames.get(streamId) ?? []
      if (this.earlyStreamFrames.size < 64 && early.length < 4096) {
        early.push(frame)
        this.earlyStreamFrames.set(streamId, early)
      }
      return
    }
    const finish = (error, value) => {
      clearTimeout(collector.timer)
      this.streams.delete(streamId)
      if (error) collector.reject(error)
      else collector.resolve(value)
    }
    if (frame.kind === 'remote-stream-closed') {
      if (frame.error) { finish(Object.assign(new Error(frame.error.message || 'the streamed result failed'), { code: frame.error.code })); return }
      try { finish(null, this.#assemble(collector)) } catch (error) { finish(error) }
      return
    }
    if (frame.seq !== collector.next) { finish(new Error('the streamed result arrived out of order')); return }
    collector.next += 1
    const value = frame.value
    const kind = value?.$json ? 'json' : value?.$binary || value?.data?.$binary ? 'binary' : 'plain'
    if (collector.kind && collector.kind !== kind) { finish(new Error('the streamed result mixed frame kinds')); return }
    collector.kind = kind
    collector.parts.push(value)
    // Grant the Host the next window before it stalls (default credit is 64).
    if (collector.next % 32 === 0) {
      try { this.ws?.send(JSON.stringify({ type: 'remote-stream-credit', streamId, n: 32 })) } catch { /* closed */ }
    }
  }

  /** Join the collected frames back into the value the Host produced. */
  #assemble(collector) {
    const { parts, kind } = collector
    if (parts.length === 0) throw new Error('the streamed result was empty')
    if (kind === 'json') {
      let offset = 0
      let text = ''
      for (const { $json } of parts) {
        if (typeof $json?.text !== 'string' || $json.offset !== offset) throw new Error('the streamed result is not contiguous')
        text += $json.text
        offset += $json.text.length
      }
      const last = parts.at(-1).$json
      if (last.last !== true || last.total !== text.length) throw new Error('the streamed result is incomplete')
      return JSON.parse(text)
    }
    if (kind === 'binary') {
      // A bare Uint8Array travels as `{ $binary }`, a record with `data` as
      // `{ ...rest, data: { $binary } }`; the rest repeats on every chunk.
      const marker = (part) => (part.$binary ? part.$binary : part.data.$binary)
      const chunks = []
      let offset = 0
      for (const part of parts) {
        const { base64, offset: at } = marker(part)
        if (at !== offset) throw new Error('the streamed binary result is not contiguous')
        const bytes = Buffer.from(base64, 'base64')
        chunks.push(bytes)
        offset += bytes.length
      }
      const last = marker(parts.at(-1))
      if (last.last !== true || last.total !== offset) throw new Error('the streamed binary result is incomplete')
      const data = Buffer.concat(chunks)
      if (parts[0].$binary) return data
      const { data: _marker, ...rest } = parts[0]
      return { ...rest, data }
    }
    return parts.length === 1 ? parts[0] : parts
  }

  close() {
    this.closedByUs = true
    try { this.ws?.close(1000, 'removed') } catch { /* already closed */ }
    try { this.ws?.terminate() } catch { /* already closed */ }
    this.ws = null
  }
}

/** The 8-digit pairing code the user typed (spaces/dashes tolerated). */
export function normalizeOtp(value) {
  const digits = String(value ?? '').replace(/[\s-]/g, '')
  if (!/^\d{8}$/.test(digits)) throw new RemoteInputError('the pairing code is 8 digits')
  return digits
}

/** "123456" -> "123 456", the grouping both screens show. */
export const formatVerificationCode = (code) => String(code).replace(/^(\d{3})(\d{3})$/, '$1 $2')

/** Address typed by the user (`ip:port`) -> the gateway's wss URL. Private ranges only by default. */
export function otpDialUrl(address, { allowPublic = false, path = '/ws/mobile' } = {}) {
  const typed = String(address ?? '').trim()
  if (!typed) throw new RemoteInputError('an address (ip:port) is required')
  let url
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `wss://${typed}`)
    if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) throw new Error('parts')
  } catch { throw new RemoteInputError('the address must look like 192.168.1.20:3081') }
  if (!allowPublic && !isPrivateAddress(url.hostname)) {
    throw new RemoteInputError('only private-network addresses are allowed (public addresses are disabled by default)', 403, 'forbidden')
  }
  if (url.pathname === '/' || url.pathname === '') url.pathname = path
  return url.toString()
}

/** TLS pin the listener presents now (trust on first use): read before any secret is sent. */
export async function readCertificatePin(url, { timeoutMs } = {}) {
  return sha256Hex(await probeCertificate(url, { timeoutMs }))
}

/** 6-digit code both screens show; same derivation as the gateway (pairing-requests.mjs). */
export function verificationCode(certSha256, clientNonce, serverNonce) {
  const digest = crypto.createHash('sha256')
    .update(String(certSha256)).update(String(clientNonce)).update(String(serverNonce)).update('dsh-verify').digest()
  return String(BigInt(`0x${digest.toString('hex')}`) % 1_000_000n).padStart(6, '0')
}

/**
 * OTP pairing (spec 008 P1b), client side:
 *  1. TOFU: read the listener's certificate and record its SHA-256 (`certSha256`).
 *  2. Pin the real connection to exactly that certificate.
 *  3. After the server nonce arrives, prove the OTP with
 *     HMAC-SHA256(key = otp, certSha256 || clientNonce || serverNonce). The OTP
 *     itself is never sent.
 *  4. The Host answers `pairing-pending` with a 6-digit code (also derived here
 *     and compared: a mismatch aborts) -> `onPending(code)` so the UI can show it.
 *  5. Wait (cancelable via `signal`) for `paired` + `hello`, or a rejection.
 * Resolves `{ token, device, hello, certSha256, gatewayId, gatewayName }`.
 */
export async function claimWithOtp({ url, otp, clientDeviceId, deviceName, onPending, signal, timeoutMs = 10_000,
  waitMs = 5 * 60_000 + 15_000, WebSocketImpl = getWebSocket() }) {
  const code = normalizeOtp(otp)
  const certSha256 = await readCertificatePin(url, { timeoutMs })
  if (signal?.aborted) throw new RemoteInputError('pairing cancelled', 499, 'cancelled')
  const ws = await openPinnedSocket({
    url,
    protocols: [PROTOCOL, 'dsh-pair-otp.v1'],
    headers: {
      'X-DSH-Device-ID': clientDeviceId,
      ...(deviceName ? { 'X-DSH-Device-Name': Buffer.from(deviceName, 'utf8').toString('base64') } : {}),
    },
    certSha256, timeoutMs, WebSocketImpl,
  })
  return new Promise((resolve, reject) => {
    let paired = null
    let clientNonce = null
    let serverNonce = null
    let settled = false
    const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value) }
    const kill = () => { try { ws.terminate() } catch { /* gone */ } }
    // Before the Host answers `pairing-pending` the usual short timeout applies;
    // afterwards the user has up to the Host's 5-minute window to approve.
    let timer = setTimeout(() => { kill(); finish(reject, new RemoteInputError('timed out waiting for the remote', 504, 'timeout')) }, timeoutMs)
    const onAbort = () => { kill(); finish(reject, new RemoteInputError('pairing cancelled', 499, 'cancelled')) }
    signal?.addEventListener('abort', onAbort)
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      ws.off('message', onMessage); ws.off('close', onClose); ws.off('error', onError)
    }
    const onMessage = (data) => {
      let frame
      try { frame = JSON.parse(data.toString()) } catch { return }
      if (frame?.kind === 'pairing-challenge' && typeof frame.serverNonce === 'string' && clientNonce === null) {
        // The Host reports the pin it presents; it must be the one we pinned.
        if (frame.certSha256 && String(frame.certSha256).toLowerCase() !== certSha256) {
          kill(); finish(reject, new PinMismatchError(certSha256, String(frame.certSha256))); return
        }
        serverNonce = frame.serverNonce
        clientNonce = crypto.randomBytes(18).toString('base64url')
        const otpProof = crypto.createHmac('sha256', code).update(certSha256).update(clientNonce).update(serverNonce).digest('hex')
        ws.send(JSON.stringify({ type: 'pairing-proof', clientNonce, otpProof }))
      } else if (frame?.kind === 'pairing-pending') {
        const expected = verificationCode(certSha256, clientNonce, serverNonce)
        if (frame.verificationCode !== expected) {
          // The Host and this client do not see the same TLS session: do not wait for approval.
          kill(); finish(reject, new RemoteInputError('the verification codes do not match; the connection may be intercepted', 502, 'verification-mismatch')); return
        }
        clearTimeout(timer)
        timer = setTimeout(() => { kill(); finish(reject, new RemoteInputError('the host did not answer in time', 504, 'timeout')) }, waitMs)
        try { onPending?.(expected) } catch { /* UI callback must not break pairing */ }
      } else if (frame?.kind === 'paired' && typeof frame.token === 'string') {
        paired = frame
      } else if (frame?.kind === 'hello' && paired) {
        try { ws.close(1000, 'paired') } catch { /* gone */ }
        finish(resolve, { token: paired.token, device: paired.device, hello: frame, certSha256,
          gatewayId: paired.gatewayId, gatewayName: paired.gatewayName })
      } else if (frame?.kind === 'pairing-rejected') {
        kill()
        const reason = String(frame.reason ?? 'rejected')
        finish(reject, reason === 'pairing/rejected'
          ? new RemoteInputError('the host rejected this device', 403, 'pairing/rejected')
          : new RemoteInputError(reason === 'pairing/expired' ? 'wrong or expired pairing code' : `the host refused pairing (${reason})`, 401, reason))
      }
    }
    const onClose = (closeCode) => {
      if (paired) return // the hello frame follows; the close handler must not win the race
      finish(reject, closeCode === 4403 ? new RemoteInputError('the host rejected this device', 403, 'pairing/rejected')
        : new RemoteInputError(`the remote closed the connection during pairing (${closeCode}); the code may be wrong or expired`, 401, 'pairing/refused'))
    }
    const onError = () => finish(reject, new RemoteInputError('could not connect to the remote gateway', 502, 'unreachable'))
    ws.on('message', onMessage); ws.on('close', onClose); ws.on('error', onError)
  })
}

/**
 * First pairing: dial the pinned listener, redeem the one-time code and return
 * `{ token, device, hello }`. The code is sent only after the pin matched.
 */
export async function claimPairing({ url, payload, clientDeviceId, deviceName, onPending, signal, timeoutMs = 10_000,
  waitMs = 5 * 60_000 + 15_000, WebSocketImpl = getWebSocket() }) {
  const ws = await openPinnedSocket({
    url,
    protocols: [PROTOCOL, `dsh-pair.${payload.pairingCode}`],
    headers: {
      'X-DSH-Device-ID': clientDeviceId,
      ...(deviceName ? { 'X-DSH-Device-Name': Buffer.from(deviceName, 'utf8').toString('base64') } : {}),
    },
    certSha256: payload.certSha256,
    timeoutMs,
    WebSocketImpl,
  })
  return new Promise((resolve, reject) => {
    let paired = null
    let settled = false
    let clientNonce = null
    let serverNonce = null
    const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value) }
    const kill = () => { try { ws.terminate() } catch { /* gone */ } }
    let timer = setTimeout(() => { kill(); finish(reject, new RemoteInputError('timed out waiting for the remote to confirm pairing', 504, 'timeout')) }, timeoutMs)
    const onAbort = () => { kill(); finish(reject, new RemoteInputError('pairing cancelled', 499, 'cancelled')) }
    signal?.addEventListener('abort', onAbort)
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      ws.off('message', onMessage); ws.off('close', onClose); ws.off('error', onError)
    }
    const onMessage = (data) => {
      let frame
      try { frame = JSON.parse(data.toString()) } catch { return }
      if (frame?.kind === 'pairing-challenge' && typeof frame.serverNonce === 'string' && clientNonce === null) {
        // Host-approval flow (spec 008 P1b): the long string is itself the secret,
        // so the proof frame only carries a fresh nonce; the Host then raises a
        // pending request and the user must approve it.
        serverNonce = frame.serverNonce
        clientNonce = crypto.randomBytes(18).toString('base64url')
        ws.send(JSON.stringify({ type: 'pairing-proof', clientNonce }))
      } else if (frame?.kind === 'pairing-pending') {
        const expected = verificationCode(payload.certSha256, clientNonce, serverNonce)
        if (frame.verificationCode !== expected) {
          kill(); finish(reject, new RemoteInputError('the verification codes do not match; the connection may be intercepted', 502, 'verification-mismatch')); return
        }
        clearTimeout(timer)
        timer = setTimeout(() => { kill(); finish(reject, new RemoteInputError('the host did not answer in time', 504, 'timeout')) }, waitMs)
        try { onPending?.(expected) } catch { /* UI callback must not break pairing */ }
      } else if (frame?.kind === 'pairing-rejected') {
        kill()
        const reason = String(frame.reason ?? 'rejected')
        finish(reject, reason === 'pairing/rejected'
          ? new RemoteInputError('the host rejected this device', 403, 'pairing/rejected')
          : new RemoteInputError(`the host refused pairing (${reason})`, 401, reason))
      } else if (frame?.kind === 'paired' && typeof frame.token === 'string') {
        paired = frame
      } else if (frame?.kind === 'hello' && paired) {
        try { ws.close(1000, 'paired') } catch { /* gone */ }
        finish(resolve, { token: paired.token, device: paired.device, hello: frame, gatewayId: paired.gatewayId, gatewayName: paired.gatewayName })
      } else if (frame?.kind === 'error' && !paired) {
        // While waiting for approval the gateway refuses stray frames; we send none.
        kill()
        finish(reject, new RemoteInputError(`the remote refused pairing: ${String(frame.code ?? 'error')}`, 401, 'pairing/refused'))
      }
    }
    const onClose = (code) => {
      if (paired) return // the hello frame follows
      finish(reject, code === 4403 ? new RemoteInputError('the host rejected this device', 403, 'pairing/rejected')
        : new RemoteInputError(`the remote closed the connection during pairing (${code}); the code may be expired or already used`, 401, 'pairing/refused'))
    }
    const onError = () => finish(reject, new RemoteInputError('could not connect to the remote gateway', 502, 'unreachable'))
    ws.on('message', onMessage)
    ws.on('close', onClose)
    ws.on('error', onError)
  })
}
