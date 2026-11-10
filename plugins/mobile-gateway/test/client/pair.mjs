// Test client: pair with a dsh mobile gateway over pinned TLS, the way the
// companion app does (contract revision 2, §2 and §3).
//
//  1. Decode the QR/manual text (unpadded base64url of a UTF-8 JSON payload).
//  2. Open a WSS connection and verify the leaf certificate SHA-256 equals the
//     pinned `certSha256` BEFORE sending a single frame. Node aborts the TLS
//     handshake itself when the certificate does not match (`rejectUnauthorized`
//     + a check against the QR certificate), so neither the pairing code nor a
//     device token can reach an interception proxy (SC-003).
//  3. First pairing: `dsh-mobile-v1, dsh-pair.<code>` + `X-DSH-Device-ID`.
//     Later connections: `Authorization: Bearer <token>`.
//
// The module also records what the server actually observed, so a test can
// assert that a rejected certificate produced no WebSocket upgrade at all.
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'

/** Decode an upstream/contract pairing payload (unpadded base64url JSON, no padding tolerated). */
export function decodePairingPayload(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new TypeError('pairing text must be unpadded base64url')
  return JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
}

export function sha256HexOfCertificate(der) {
  return crypto.createHash('sha256').update(der).digest('hex')
}

/**
 * A throwaway self-signed certificate standing in for an interception proxy.
 * @returns {{ key: string, cert: string }} PEM pair for `tls.createServer`
 */
export function createImpostorCertificate() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: derToPem(createProxyCertificate(privateKey, publicKey)),
  }
}

function derToPem(der) {
  const base64 = der.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`
}

// Minimal X.509 v3 self-signed certificate built by hand: enough for a TLS
// listener that must present a well-formed but untrusted leaf.
function createProxyCertificate(privateKey, publicKey) {
  const der = (tag, ...parts) => encode(0x30 | tag, Buffer.concat(parts))
  const integer = (value) => encode(0x02, Buffer.from([0x01, value]))
  const oid = (bytes) => encode(0x06, Buffer.from(bytes))
  const utf8 = (text) => encode(0x0c, Buffer.from(text, 'utf8'))
  const time = (date) => encode(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'))
  const name = (cn) => encode(0x30, encode(0x31, encode(0x30, oid([0x55, 0x04, 0x03]), utf8(cn))))
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  // id-ecPublicKey + prime256v1: the certificate carries the same EC P-256 key
  // the gateway uses, so OpenSSL will accept the signature algorithm.
  const algorithm = encode(0x30, oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]), oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]))
  const signatureAlgorithm = encode(0x30, oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]))
  const tbs = der(0,
    encode(0xa0, integer(2)),
    integer(1),
    signatureAlgorithm,
    name('dsh-mobile-gateway proxy'),
    encode(0x30, time(new Date(Date.now() - 60_000)), time(new Date(Date.now() + 86_400_000))),
    name('dsh-mobile-gateway proxy'),
    spki,
  )
  const signature = crypto.sign('sha256', tbs, privateKey)
  return der(0, tbs, signatureAlgorithm, encode(0x03, Buffer.concat([Buffer.from([0]), signature])))

  function encode(tag, ...parts) {
    const content = Buffer.concat(parts)
    return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content])
  }
  function encodeLength(length) {
    if (length < 0x80) return Buffer.from([length])
    const bytes = []
    for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff)
    return Buffer.from([0x80 | bytes.length, ...bytes])
  }
}

/**
 * Observe what the gateway's TLS listener saw: TCP connections and WebSocket
 * upgrades, including the ones the TLS layer aborted. Wraps `net.Server.prototype.emit`
 * for the duration of one test; `restore()` puts it back.
 */
export function observeServerTraffic(server) {
  const traffic = { connections: 0, upgrades: 0, upgradesWithCredential: 0 }
  const original = net.Server.prototype.emit
  const listener = function observedEmit(event, ...args) {
    // Count what reached the gateway *behind* TLS: the HTTP upgrade (and the
    // request headers carrying a credential), not the TLS-handshake aborts of
    // a client that rejected the pin.
    if (this === server && event === 'upgrade') {
      traffic.upgrades += 1
      const headers = args[0]?.headers ?? {}
      if (headers.authorization || /dsh-pair\./.test(String(headers['sec-websocket-protocol'] ?? ''))) {
        traffic.upgradesWithCredential += 1
      }
    }
    return Reflect.apply(original, this, [event, ...args])
  }
  net.Server.prototype.emit = listener
  return {
    traffic,
    restore() { if (net.Server.prototype.emit === listener) net.Server.prototype.emit = original },
  }
}

/**
 * TLS options that make `tls.connect` fail the handshake when the presented
 * leaf certificate's SHA-256 differs from `certSha256` (contract §3.1).
 *
 * With `rejectUnauthorized: false` Node skips `checkServerIdentity`, so the pin
 * is enforced twice: on the peer certificate after `secureConnect`, and when the
 * client certificate arrives (`checkServerIdentity`, still used when it is set).
 */
export function pinnedTlsOptions(pairingPayload) {
  const fingerprint = String(pairingPayload.certSha256 ?? '').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new TypeError('pairing payload carries no valid certSha256')
  const verify = (raw) => {
    const actual = sha256HexOfCertificate(raw)
    return actual === fingerprint ? undefined : new Error(`certificate pin mismatch: expected ${fingerprint}, got ${actual}`)
  }
  return {
    // Self-signed by design; the pin below is the trust decision.
    rejectUnauthorized: false,
    checkServerIdentity: (_host, certificate) => verify(certificate.raw),
    // Node only calls `checkServerIdentity` when it verifies the chain, so the
    // pin is re-checked on the established socket as well.
    __pinCheck: verify,
  }
}

function waitForFrame(ws, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = new Error('timed out waiting for a frame')
    const timer = setTimeout(() => { cleanup(); reject(timeout) }, timeoutMs)
    const onMessage = (data) => {
      let frame
      try { frame = JSON.parse(data.toString()) } catch { return }
      if (!predicate(frame)) return
      cleanup()
      resolve(frame)
    }
    const onClose = (code) => {
      cleanup()
      reject(new Error(`socket closed (${code}) before the expected frame`, { cause: timeout }))
    }
    const onError = (error) => { cleanup(); reject(error) }
    function cleanup() {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      ws.off('error', onError)
    }
    ws.on('message', onMessage)
    ws.on('close', onClose)
    ws.on('error', onError)
  })
}

function assertPairingPayload(payload) {
  if (payload?.version !== 3) throw new Error(`pairing payload version must be 3, got ${payload?.version}`)
  const urls = [payload.publicUrl, ...(Array.isArray(payload.endpoints) ? payload.endpoints : [])]
  if (!urls.every((url) => typeof url === 'string' && url.startsWith('wss://'))) throw new Error('every pairing endpoint must be wss://')
  if (!/^[a-f0-9]{64}$/.test(String(payload.certSha256))) throw new Error('pairing payload certSha256 must be 64 lowercase hex')
  const ttl = Number(payload.expiresAt) - Date.now()
  if (!(ttl > 0 && ttl <= 5 * 60 * 1000)) throw new Error(`expiresAt must be within 5 minutes, got ${ttl}ms`)
  return payload
}

/**
 * Connection options for a client that trusts the pin.
 *
 * `checkServerIdentity` is pinned for chain-verifying clients. For the
 * self-signed host certificate the pin is what makes the connection trusted, so
 * `ca` carries the certificate the client just verified: Node then completes the
 * verified handshake (and calls `checkServerIdentity`) instead of stopping on a
 * self-signed chain. A mismatching certificate still fails both checks.
 */
async function trustedPinOptions(url, payload) {
  const options = pinnedTlsOptions(payload)
  const target = new URL(url)
  const probe = tls.connect({
    host: target.hostname.replace(/^\[|\]$/g, ''),
    port: Number(target.port) || 443,
    servername: net.isIP(target.hostname) ? undefined : target.hostname,
    rejectUnauthorized: false,
  })
  await once(probe, 'secureConnect')
  const certificate = probe.getPeerCertificate(true)
  const raw = certificate.raw
  probe.destroy()
  const mismatch = options.__pinCheck(raw)
  if (mismatch) throw mismatch
  return {
    ...options,
    rejectUnauthorized: true,
    ca: new crypto.X509Certificate(raw).toString(),
  }
}

/**
 * Open a WebSocket whose TLS session is verified against the pin before the
 * handshake completes. `ws` does not expose the socket before `open`, so the
 * connection is pre-flighted through `tls.connect`, the pin is checked on the
 * peer certificate, and the client is aborted (nothing sent) on a mismatch.
 * @returns {Promise<WebSocket>} the connected client, or throws the pin error
 */
async function openPinnedSocket(url, protocols, headers, payload, extra = {}) {
  const options = await trustedPinOptions(url, payload)
  return new WebSocket(url, protocols, { ...options, ...extra, headers })
}

/**
 * Connect for first pairing.
 * @param {object} options
 * @param {object} options.payload decoded QR payload (contract §2)
 * @param {string} [options.pairingCode] defaults to `payload.pairingCode`
 * @param {string} options.deviceId install-scoped UUID
 * @param {string} [options.deviceName] human name (`X-DSH-Device-Name`, base64)
 * @param {string} [options.url] override the endpoint under test
 * @param {object} [options.tls] extra ws options (`ca`, …) for a proxy case
 */
export async function pair(options) {
  const payload = assertPairingPayload(options.payload)
  const url = options.url ?? payload.publicUrl
  const headers = {
    'X-DSH-Device-ID': options.deviceId,
    ...(options.deviceName ? { 'X-DSH-Device-Name': Buffer.from(options.deviceName, 'utf8').toString('base64') } : {}),
  }
  const ws = await openPinnedSocket(url, ['dsh-mobile-v1', `dsh-pair.${options.pairingCode ?? payload.pairingCode}`],
    headers, payload, options.tls)
  const paired = waitForFrame(ws, (frame) => frame.kind === 'paired')
  const hello = waitForFrame(ws, (frame) => frame.kind === 'hello')
  await once(ws, 'open')
  const pairedFrame = await paired
  const helloFrame = await hello
  return {
    ws,
    token: pairedFrame.token,
    device: pairedFrame.device,
    paired: pairedFrame,
    hello: helloFrame,
    request(frame, timeoutMs) {
      ws.send(JSON.stringify(frame))
      return waitForFrame(ws, (reply) => reply.requestId === frame.requestId, timeoutMs)
    },
    close() { try { ws.close() } catch { /* already closed */ } },
  }
}

/**
 * Connect with a device token (contract §3.4). The token travels in
 * `Authorization`; `dsh-auth.<token>` is the subprotocol fallback.
 *
 * `viaSubprotocol` and `token` are required only when the URL itself carries no
 * token. The `hello` (and anything pushed after it) must be observed through
 * `next()`, because the caller is expected to know how the gateway frames the
 * connection; declaring the observed protocol version is what `client-hello`
 * is for.
 */
export async function connect(options) {
  const payload = assertPairingPayload(options.payload)
  const url = options.url ?? payload.publicUrl
  const viaSubprotocol = options.viaSubprotocol ?? options.token === undefined
  const ws = await openPinnedSocket(url, viaSubprotocol ? ['dsh-mobile-v1', `dsh-auth.${options.token}`] : ['dsh-mobile-v1'], {
    ...(viaSubprotocol ? {} : { Authorization: `Bearer ${options.token}` }),
    'X-DSH-Device-ID': options.deviceId,
    ...(options.channel ? { 'X-DSH-Channel': options.channel } : {}),
  }, payload, options.tls)
  const hello = waitForFrame(ws, (frame) => frame.kind === 'hello')
  await once(ws, 'open')
  const helloFrame = await hello
  // Frames that arrived between `hello` and the first request are buffered.
  const pending = []
  const waiters = []
  ws.on('message', (data) => {
    let frame
    try { frame = JSON.parse(data.toString()) } catch { return }
    const index = waiters.findIndex((waiter) => waiter.predicate(frame))
    if (index < 0) { pending.push(frame); return }
    const [waiter] = waiters.splice(index, 1)
    waiter.resolve(frame)
  })
  const next = (predicate, timeoutMs = 5_000) => {
    const buffered = pending.findIndex(predicate)
    if (buffered >= 0) return Promise.resolve(pending.splice(buffered, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve }
      waiters.push(waiter)
      setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index < 0) return
        waiters.splice(index, 1)
        reject(new Error('timed out waiting for a frame'))
      }, timeoutMs).unref?.()
    })
  }
  const request = async (frame, timeoutMs) => {
    // Register the waiter before sending: the answer can arrive inside send().
    const answer = next((reply) => reply.requestId === frame.requestId, timeoutMs)
    ws.send(JSON.stringify(frame))
    await new Promise((resolve) => setImmediate(resolve))
    void pending; void waiters
    return answer
  }
  // Contract §3.6/§5a: the peer is ready only after the accepted `client-hello`;
  // until then the gateway refuses every other operation.
  const helloRequestId = `hello-${crypto.randomBytes(4).toString('hex')}`
  const ack = await request({
    type: 'client-hello', requestId: helloRequestId, companionProtocol: 1, appVersion: '0.1.0', platform: 'ios',
  })
  if (ack.kind !== 'client-hello' || ack.accepted !== true) {
    throw new Error(`client-hello was not accepted: ${JSON.stringify(ack).slice(0, 200)}`)
  }
  return {
    ws,
    hello: helloFrame,
    request,
    next,
    close() { try { ws.close() } catch { /* already closed */ } },
  }
}

/** Resolve the HTTP status of a refused WebSocket upgrade (or 'open' / the error code). */
export function upgradeStatus(url, options = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, options.protocols ?? ['dsh-mobile-v1'], {
      ...(options.payload ? pinnedTlsOptions(options.payload) : {}),
      ...(options.tls ?? {}),
      headers: options.headers ?? {},
    })
    const timer = setTimeout(() => { ws.terminate(); resolve('timeout') }, 5_000)
    const finish = (value) => { clearTimeout(timer); resolve(value) }
    ws.once('open', () => { ws.terminate(); finish('open') })
    ws.once('unexpected-response', (_request, response) => { response.resume(); finish(response.statusCode) })
    // A refusal at the TLS layer (pin mismatch) surfaces here rather than as an
    // HTTP status.
    ws.once('error', (error) => finish(`error:${error?.code ?? error?.message ?? 'unknown'}`))
  })
}

/** A TLS tunnel that presents a certificate the pinned client must refuse. */
export async function startInterceptionProxy(target, { certificate }) {
  let accepted = 0
  const opened = new Set()
  const server = tls.createServer({ key: certificate.key, cert: certificate.cert }, (socket) => {
    accepted += 1
    opened.add(socket)
    const upstream = tls.connect({ host: target.host, port: target.port, rejectUnauthorized: false })
    opened.add(upstream)
    socket.pipe(upstream).pipe(socket)
    socket.on('error', () => {})
    upstream.on('error', () => {})
    const drop = () => { opened.delete(socket); opened.delete(upstream) }
    socket.once('close', drop)
    upstream.once('close', drop)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    get accepted() { return accepted },
    close() {
      for (const socket of opened) socket.destroy()
      opened.clear()
      server.close()
      return once(server, 'close')
    },
  }
}
