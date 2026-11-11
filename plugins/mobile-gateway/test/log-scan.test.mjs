// T032 / SC-006 — one end-to-end pair -> prompt -> approve -> revoke run must
// leave no credential and no tool-argument content in the gateway's own log.
//
// The sink under test is the real one (`lib/logging.mjs`): `log()` redacts once
// and then emits the SAME line to stdout (`console.log`, prefixed
// `mobile-gateway:`) and to `<tmp>/mobile-gateway.log`. This test captures both:
//   - `console.log/warn/error` are intercepted for the whole flow, and
//   - TEMP/TMP/TMPDIR are pointed at this test's directory BEFORE the plugin is
//     imported, so `LOG_FILE` (resolved from `os.tmpdir()` at import time) lands
//     there and the whole file belongs to this run.
//
// A clean capture could also mean "nothing was written at all", so the test
// asserts the expected audit markers are present (the flow really happened and
// really logged) and runs a negative control: the scanner must flag every value
// when it is planted in a synthetic line. The mutation check was run by hand
// while developing this file: temporarily leaking the live device token, and
// separately the argument canary, into the harness made the absence assertion
// fail ("the gateway log sink leaked: ..."); the harness was restored after.
//
// Deliberately NOT asserted absent: `argsHash`. The contract publishes it to the
// device (the approval card carries it, the decision echoes it), so it is not a
// secret. `argsPreview` IS shown to the device by design; the assertion here is
// the stronger one — no raw argument content reaches the log sink, and
// `lib/redact.mjs` would mask a keyed `arguments`/`argsPreview` field anyway
// (asserted at the bottom so the claim is measured, not assumed).
//
// Run: `node --test test/log-scan.test.mjs` (node:test; the flow is one run).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import test from 'node:test'
import WebSocket from 'ws'
import { approvalArgsHash } from '../lib/approval-hash.mjs'
import { redactLine } from '../lib/redact.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'

const SESSION = 'logscan-session'
const DEVICE_ID = 'logscan-device-0001'
// A distinctive, NOT token-shaped canary: 43+ contiguous base64url-ish
// characters would be masked by `lib/redact.mjs` regardless of where it appears,
// which would make an absence assertion vacuous. Spaces keep this string outside
// every redaction pattern, so "not in the log" means the raw argument never
// reached the sink at all.
const CANARY = 'argument-canary 4f8c1d2e do-not-log'
const ARGUMENTS_ONE = JSON.stringify({ command: 'bash', script: `echo ${CANARY}` })
const ARGUMENTS_TWO = JSON.stringify({ command: 'bash', script: `printf ${CANARY}` })
const PROMPT_TEXT = 'please run the log scan'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Redirect the platform temp directory BEFORE importing the plugin: logging.mjs
// computes LOG_FILE once, at module load.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-logscan-'))
const LOG_DIR = path.join(ROOT, 'logs')
fs.mkdirSync(LOG_DIR)
process.env.TEMP = process.env.TMP = process.env.TMPDIR = LOG_DIR
const { default: plugin } = await import('../lib/index.mjs')
const { LOG_FILE } = await import('../lib/logging.mjs')

const captured = []
let restoreConsole

function startLogCapture() {
  const originals = { log: console.log, warn: console.warn, error: console.error }
  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...args) => {
      captured.push(args.map((value) => (typeof value === 'string' ? value : String(value))).join(' '))
    }
  }
  restoreConsole = () => {
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
    restoreConsole = undefined
  }
}

function stopLogCapture() {
  restoreConsole?.()
}

/** Both real sinks, concatenated: intercepted stdout/stderr and the log file. */
function capturedSink() {
  const file = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : ''
  return { file, text: `${captured.join('\n')}\n${file}` }
}

async function waitUntil(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(5)
  }
}

function collect(socket) {
  const frames = []
  socket.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())) } catch { /* a non-JSON frame is not part of this contract */ }
  })
  socket.on('error', () => {})
  return frames
}

function open(url, protocols, options = {}) {
  const socket = new WebSocket(url, protocols, { rejectUnauthorized: false, ...options })
  socket.on('error', () => {})
  return socket
}

/** Contract §3.6/§5a: operations wait for the acknowledged client-hello. */
async function negotiate(socket, frames, label) {
  const requestId = `logscan-hello-${label}`
  socket.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: '0.1.0', platform: 'ios' }))
  await waitUntil(() => frames.some((frame) => frame.kind === 'client-hello' && frame.requestId === requestId), `${label} client-hello`)
}

/** Resolve the upgrade outcome: an HTTP status code, 'open', or the error code. */
function upgradeOutcome(url, protocols, options = {}) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, protocols, { rejectUnauthorized: false, ...options })
    const timer = setTimeout(() => { socket.terminate(); resolve('timeout') }, 5_000)
    socket.once('open', () => { socket.terminate(); clearTimeout(timer); resolve('open') })
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      clearTimeout(timer)
      resolve(response.statusCode)
    })
    socket.once('error', (error) => { clearTimeout(timer); resolve(`error:${error?.code ?? error?.message}`) })
  })
}

function approvalCards(frames, sessionId = SESSION) {
  return frames.filter((frame) => frame.kind === 'approval-requested' && frame.sessionId === sessionId)
}

async function startGateway() {
  const directory = fs.mkdtempSync(path.join(ROOT, 'gateway-'))
  const listeners = {}
  const sockets = []
  let management
  let upgrade
  let dispose = () => {}
  let seq = 0
  const server = http.createServer((req, res) => {
    if (management && req.url.startsWith('/mgw')) management.handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  server.on('upgrade', (req, socket, head) => (upgrade ? upgrade.handler(req, socket, head) : socket.destroy()))
  // WHATWG fetch refuses a handful of "bad ports"; an ephemeral listener that
  // lands on one would fail the harness, not the gateway. The shared helper
  // re-binds until `fetch` accepts the port (test/support/fetch-safe-listen.mjs).
  await listenFetchSafe(server)
  const ctx = {
    webServer: {
      port: server.address().port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      // A device only sees/cards sessions the Host lists to it (reviewer 36d9),
      // so the fake must answer `session/list` like the real Host.
      async invoke(request) {
        if (request.namespace === 'session' && request.method === 'list') return { items: [{ sessionId: SESSION }] }
        if (request.namespace === 'session' && request.method === 'prompt') return { accepted: true, messageId: `logscan-msg-${++seq}` }
        throw new Error(`unexpected Host call ${request.namespace}/${request.method}`)
      },
      async stream(request) {
        return (async function* () {
          yield { type: 'baseline', value: request.namespace === 'workspace'
            ? { items: [], archivedSessionIds: [] } : { projections: {} } }
          while (!request.signal.aborted) await delay(5)
        })()
      },
    },
    agentDefaultModel: {},
    on(name, handler) { listeners[name] = handler; return () => { delete listeners[name] } },
    effect(factory) { dispose = factory() },
  }
  await plugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: 'logscan',
    deviceFile: path.join(directory, 'devices.json'),
    tlsCertificateDir: path.join(directory, 'tls'),
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    // The QR/direct claim path (spec 001 T019/T020). Host-approval (OTP) pairing
    // is spec 008 and has its own suite; it hands out the same token/credential
    // surfaces this scan looks for.
    requireHostApproval: false,
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const instance = {
    base,
    loopbackWsUrl: `ws://127.0.0.1:${server.address().port}/ws/mobile`,
    listeners,
    track(socket) { sockets.push(socket); return socket },
    async status() { return (await (await fetch(`${base}/mgw/status`)).json()) },
    async post(route, body) {
      const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, body: await response.json() }
    },
    /** Emit a `tool/call` exactly as the Host session stream does. */
    toolCall(callId, rawArguments, name = 'bash') {
      listeners['session/event']({ id: SESSION }, {
        type: 'tool/call', seq: ++seq, time: Date.now(),
        data: { turn: 1, step: 0, callId, name, arguments: rawArguments },
      })
    },
    /** The `approval/request` waterfall; `next` is the desktop chain. */
    requestApproval({ callId, toolName = 'bash', next } = {}) {
      return listeners['approval/request']({
        agent: { id: SESSION }, toolName,
        ...(callId === undefined ? {} : { callId }),
        reason: 'log scan', signal: new AbortController().signal,
      }, next ?? (() => new Promise(() => {})))
    },
    async close() {
      for (const socket of sockets) socket.terminate()
      dispose()
      await new Promise((resolve) => server.close(resolve))
      // Let the disposal log lines reach both sinks before the file is read.
      await delay(50)
    },
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await instance.status()
    if (status.lan?.listening && status.lan.urls.length > 0) {
      instance.lanUrl = status.lan.urls[0]
      return instance
    }
    if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

/** Redeem a QR offer on the plugin TLS listener and return the paired device. */
async function pairDevice(instance) {
  const created = await instance.post('/mgw/pair', { name: 'Log scan phone', publicUrl: instance.lanUrl })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const { payload, qrPayload } = created.body
  assert.equal(payload.version, 3)
  assert.equal(typeof payload.pairingCode, 'string')
  // The copy-safe pairing string is the base64url JSON payload (contract §2).
  assert.deepEqual(JSON.parse(Buffer.from(qrPayload, 'base64url').toString('utf8')), payload)
  const socket = instance.track(open(instance.lanUrl, ['dsh-mobile-v1', `dsh-pair.${payload.pairingCode}`], {
    headers: { 'X-DSH-Device-ID': DEVICE_ID },
  }))
  const frames = collect(socket)
  await once(socket, 'open')
  await waitUntil(() => frames.some((frame) => frame.kind === 'paired'), 'paired frame')
  const paired = frames.find((frame) => frame.kind === 'paired')
  assert.equal(typeof paired.token, 'string')
  assert.match(paired.token, /^[A-Za-z0-9_-]{43}$/, 'a 32-byte base64url device token')
  assert.equal(typeof paired.device.id, 'string')
  socket.close()
  return { ...paired, pairingCode: payload.pairingCode, qrPayload }
}

let receiptCounter = 0
/** Send an `approval-response` and return its receipt. */
async function respond(socket, frames, card, overrides = {}) {
  const requestId = `logscan-receipt-${++receiptCounter}`
  socket.send(JSON.stringify({
    type: 'approval-response', requestId,
    rpcId: card.rpcId, sessionId: card.sessionId, approvalId: card.approvalId,
    argsHash: card.argsHash, outcome: 'allowed-once', ...overrides,
  }))
  await waitUntil(() => frames.some((reply) => reply.kind === 'approval-response' && reply.requestId === requestId),
    `${requestId} receipt`)
  return frames.find((reply) => reply.kind === 'approval-response' && reply.requestId === requestId)
}

test('pair -> prompt -> approve -> revoke leaves no token, pairing code, credential or tool argument in the gateway log', async () => {
  startLogCapture()
  let host
  let sink
  try {
    try {
      host = await startGateway()

      // ---------------------------------------------------------------- pair
      const paired = await pairDevice(host)
      const token = paired.token
      const deviceId = paired.device.id

      // Failure paths around pairing: the code is single-use, a foreign Origin
      // is refused before anything is learned, and a credential never travels
      // in the URL query (FR-004/FR-007).
      assert.equal(await upgradeOutcome(host.lanUrl, ['dsh-mobile-v1', `dsh-pair.${paired.pairingCode}`],
        { headers: { 'X-DSH-Device-ID': DEVICE_ID } }), 401, 'a used pairing code must be refused')
      assert.equal(await upgradeOutcome(host.loopbackWsUrl, ['dsh-mobile-v1'],
        { origin: 'https://foreign.example' }), 403, 'a foreign Origin must be refused')
      assert.equal(await upgradeOutcome(host.loopbackWsUrl, ['dsh-mobile-v1'], {}), 401,
        'a socket without a credential must be refused')
      assert.equal(await upgradeOutcome(`${host.loopbackWsUrl}?token=${encodeURIComponent(token)}`,
        ['dsh-mobile-v1'], {}), 401, 'a credential in the query must be refused')

      // --------------------------------------------------------------- login
      // Device credentials are accepted only on the plugin-owned TLS listener.
      const control = host.track(open(host.lanUrl, ['dsh-mobile-v1'], {
        headers: { Authorization: `Bearer ${token}`, 'X-DSH-Channel': 'control', 'X-DSH-Device-ID': DEVICE_ID },
      }))
      const controlFrames = collect(control)
      await once(control, 'open')
      await waitUntil(() => controlFrames.some((frame) => frame.kind === 'hello'), 'control hello')
      await waitUntil(() => controlFrames.some((frame) => frame.kind === 'projection-baseline'), 'control baseline')
      // Contract §3.6/§5a: operations wait for the acknowledged client-hello.
      await negotiate(control, controlFrames, 'control')

      // The browser-style credential form: `dsh-auth.<token>` as a subprotocol,
      // no Authorization header. Its hello must authenticate.
      const browser = host.track(open(host.lanUrl,
        ['dsh-mobile-v1', `dsh-auth.${token}`, `dsh-device.${deviceId}`], {}))
      const browserFrames = collect(browser)
      await once(browser, 'open')
      await waitUntil(() => browserFrames.some((frame) => frame.kind === 'hello'), 'browser hello')
      assert.equal(browserFrames.find((frame) => frame.kind === 'hello').authenticated, true)
      browser.close()

      // -------------------------------------------------------------- prompt
      const conversation = host.track(open(host.lanUrl, ['dsh-mobile-v1'], {
        headers: { Authorization: `Bearer ${token}`, 'X-DSH-Channel': 'conversation', 'X-DSH-Device-ID': DEVICE_ID },
      }))
      const conversationFrames = collect(conversation)
      await once(conversation, 'open')
      await waitUntil(() => conversationFrames.some((frame) => frame.kind === 'hello'), 'conversation hello')
      await negotiate(conversation, conversationFrames, 'conversation')
      conversation.send(JSON.stringify({
        type: 'message', requestId: 'logscan-prompt', sessionId: SESSION, text: PROMPT_TEXT, clientMsgId: 'logscan-msg-1',
      }))
      await waitUntil(() => conversationFrames.some((frame) => frame.kind === 'sent' && frame.requestId === 'logscan-prompt'),
        'sent receipt')

      // -------------------------------------------------------------- approve
      // The Host publishes `tool/call` (raw argument JSON) and asks for an
      // approval. The card carries `argsHash` (public to the device by
      // contract) and a bounded `argsPreview` — the device DOES see the preview;
      // the log must not.
      host.toolCall('logscan-call-1', ARGUMENTS_ONE)
      const allowed = host.requestApproval({ callId: 'logscan-call-1' })
      await waitUntil(() => approvalCards(controlFrames).length === 1, 'first approval card')
      const card = approvalCards(controlFrames)[0]
      assert.equal(card.argsHash, approvalArgsHash({ toolName: 'bash', callId: 'logscan-call-1', rawArguments: ARGUMENTS_ONE }))
      assert.equal(card.argsPreview, ARGUMENTS_ONE, 'the device is shown the bounded preview by design')

      // Deliberate denial path 1: a decision that does not bind the card is a
      // normal receipt, the request stays pending, nothing is applied.
      const mismatch = await respond(control, controlFrames, card, { argsHash: 'f'.repeat(64) })
      assert.equal(mismatch.accepted, false)
      assert.equal(mismatch.reason, 'hash-mismatch')
      // The matching decision is accepted once and resolves the Host request.
      const accepted = await respond(control, controlFrames, card, { argsHash: card.argsHash })
      assert.equal(accepted.accepted, true)
      assert.equal(await allowed, 'allowed-once')

      // Deliberate denial path 2: the owner rejects the second request.
      host.toolCall('logscan-call-2', ARGUMENTS_TWO)
      const denied = host.requestApproval({ callId: 'logscan-call-2' })
      await waitUntil(() => approvalCards(controlFrames).length === 2, 'second approval card')
      const deniedReceipt = await respond(control, controlFrames, approvalCards(controlFrames)[1], { outcome: 'rejected' })
      assert.equal(deniedReceipt.accepted, true)
      assert.equal(await denied, 'rejected')

      // Deliberate denial path 3: a companion op outside the device scopes is
      // refused (and logged by type only).
      control.send(JSON.stringify({ type: 'plugin-catalog', requestId: 'logscan-admin-op' }))
      await waitUntil(() => controlFrames.some((frame) => frame.kind === 'error' && frame.requestId === 'logscan-admin-op'),
        'scope refusal')
      const refusal = controlFrames.find((frame) => frame.kind === 'error' && frame.requestId === 'logscan-admin-op')
      assert.ok(['op/forbidden', 'auth/forbidden-scope'].includes(refusal.code), refusal.code)

      // --------------------------------------------------------------- revoke
      const controlClosed = once(control, 'close')
      const conversationClosed = once(conversation, 'close')
      const revoked = await host.post(`/mgw/devices/${encodeURIComponent(deviceId)}/revoke`, {})
      assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
      assert.equal(revoked.body.revoked, true)
      assert.equal((await controlClosed)[0], 4401, 'revocation closes the live socket with 4401')
      assert.equal((await conversationClosed)[0], 4401)
      // The dead token opens nothing, in either credential form (on the TLS
      // listener, so the refusal is the revocation and not the listener rule).
      assert.equal(await upgradeOutcome(host.lanUrl, ['dsh-mobile-v1'],
        { headers: { Authorization: `Bearer ${token}`, 'X-DSH-Device-ID': DEVICE_ID } }), 401,
        'a revoked token must be refused')
      assert.equal(await upgradeOutcome(host.lanUrl, ['dsh-mobile-v1', `dsh-auth.${token}`], {}), 401,
        'a revoked token in the `dsh-auth.` subprotocol must be refused')

      sink = { token, deviceId, pairingCode: paired.pairingCode, qrPayload: paired.qrPayload }
    } finally {
      if (host) await host.close()
      stopLogCapture()
    }
    const output = capturedSink()
    sink.output = output

    // --------------------------------------------------------------------- scan
    // Everything below is what the gateway actually emitted, in both sinks.
    const secrets = [
      ['device token', sink.token],
      ['one-time pairing code', sink.pairingCode],
      ['QR payload (base64url pairing string)', sink.qrPayload],
      ['dsh-pair. subprotocol credential', `dsh-pair.${sink.pairingCode}`],
      ['dsh-auth. subprotocol credential', `dsh-auth.${sink.token}`],
      ['Authorization header value', `Bearer ${sink.token}`],
      ['raw tool arguments (canary)', CANARY],
      ['raw tool arguments (JSON)', ARGUMENTS_ONE],
    ]
    const findLeaks = (text) => secrets.filter(([, value]) => typeof value === 'string' && value !== '' && text.includes(value))
      .map(([label]) => label)

    // The harness must have captured real output, or every absence assertion
    // below would pass for the wrong reason. `LOG_FILE` is ours because TEMP/TMP
    // were redirected before the plugin was imported.
    assert.equal(fs.realpathSync(path.dirname(LOG_FILE)), fs.realpathSync(LOG_DIR),
      'the scanned log file must be the one this run wrote')
    assert.ok(output.file.length > 0, 'the file sink captured no gateway log at all')
    assert.ok(output.text.length > 0, 'the harness captured no gateway log output at all')

    // The durable file sink carried the flow itself (not only stdout).
    for (const marker of ['pairing created:', 'mobile message accepted:', 'approval requested:', 'device revoked:']) {
      assert.ok(output.file.includes(marker), `the log file should contain ${JSON.stringify(marker)}`)
    }

    // The flow really ran: each audit marker is a line the gateway itself wrote.
    for (const marker of [
      'applying: version=',
      'pairing created:',
      'pairing rejected:',
      'client connected',
      'mobile message accepted:',
      'approval requested:',
      'approval response refused:',
      'hash-mismatch',
      'outcome=allowed-once',
      'outcome=rejected',
      'device revoked:',
      'plugin stopped',
    ]) {
      assert.ok(output.text.includes(marker), `the gateway should have logged ${JSON.stringify(marker)} during the flow`)
    }
    assert.ok(/op forbidden for device token|scope refused/.test(output.text),
      'a device-scope refusal should be logged during the flow')
    assert.ok(output.text.includes('auth rejected:'), 'an unauthenticated/refused upgrade should be logged during the flow')

    // No credential, no pairing code, no QR string, no raw argument content.
    assert.deepEqual(findLeaks(output.text), [],
      `the gateway log sink leaked: ${findLeaks(output.text).join(', ')}`)

    // Negative control: the same scanner flags a planted value, so an empty
    // result above is evidence and not a broken matcher.
    for (const [label, value] of secrets) {
      assert.ok(findLeaks(`mobile-gateway: planted ${value}`).includes(label),
        `the scanner must detect a planted ${label}`)
    }

    // `lib/redact.mjs` is the designed backstop for a keyed arguments/argsPreview
    // field: measured here so the design claim is not assumed.
    const redactedFields = redactLine(JSON.stringify({ arguments: ARGUMENTS_ONE, argsPreview: ARGUMENTS_ONE }))
    assert.equal(redactedFields.includes(CANARY), false, 'a keyed arguments/argsPreview field is masked by the redactor')
  } finally {
    stopLogCapture()
    fs.rmSync(ROOT, { recursive: true, force: true })
  }
})
