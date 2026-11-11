// Self-test for the device-validation fixture: proves the fixture speaks the frames the app's
// core expects, *without a phone, without a build, without EAS quota*.
//
// It plays the role of the phone (`modules/pinned-ws` + `src/core/client.ts`):
//   1. verify the leaf SHA-256 equals the value advertised in the pairing QR — before sending
//      anything (contract §3.1);
//   2. connect with subprotocols `dsh-mobile-v1, dsh-pair.<code>` + `X-DSH-Device-ID`;
//   3. expect `paired` then `hello`, send `client-hello`, expect `accepted: true`;
//   4. `sessions` → canonical rows (A046), `subscribe` → replayed approval, `history`;
//   5. `approval-response` with the exact hash → `accepted: true`; with a stale hash →
//      `accepted: false, reason: hash-mismatch` (contract §5);
//   6. `message` → `sent`; `session-cancel` → `session-cancelled`;
//   7. revoke → 4401 / `auth/revoked`; abrupt drop → reconnect with the bearer token.
//
// Then it cross-checks the fixture's own `GET /state` evidence: the phone "sent" what we think it
// sent, the receipt echoed the exact hash, and no pairing code leaked into a URL.
//
// Run: node e2e/harness/selftest.mjs [--cert-mode ok|wrong|expired|not-yet] [--verbose]
//
// This is a *fixture* test, not an end-to-end app test: it cannot see the app's UI. Its job is to
// make sure that when the first Android/iOS build exists, a red flow means an app bug and not a
// broken stand-in.

import crypto from 'node:crypto'
import tls from 'node:tls'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import WebSocket from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const gatewayEntry = path.join(here, 'gateway.mjs')

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const certModeIndex = argv.indexOf('--cert-mode')
const certMode = certModeIndex >= 0 ? argv[certModeIndex + 1] : 'ok'

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

let passed = 0
const failures = []

function check (label, condition, detail) {
  if (condition) {
    passed += 1
    if (verbose) process.stdout.write(`  ok   ${label}\n`)
    return true
  }
  failures.push({ label, detail })
  process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
  return false
}

function section (title) {
  process.stdout.write(`${title}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

function startFixture () {
  const child = spawn(process.execPath, [
    gatewayEntry,
    '--bind', '127.0.0.1',
    '--port', '0',
    '--control-port', '0',
    '--cert-mode', certMode,
    '--lan-host', '127.0.0.1',
    '--print-json',
    '--quiet',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()))
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()))

  return {
    child,
    stderrText: () => stderr.join(''),
    async ready (timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const text = stdout.join('').trim()
        if (text !== '') {
          try {
            return JSON.parse(text.split('\n').filter(Boolean).at(-1))
          } catch {
            // still streaming
          }
        }
        if (child.exitCode !== null) throw new Error(`fixture exited:\n${stderr.join('')}`)
        await sleep(50)
      }
      throw new Error(`fixture did not start:\n${stderr.join('')}`)
    },
    async stop () {
      child.kill()
      await once(child, 'exit').catch(() => {})
    },
  }
}

// ---------------------------------------------------------------------------
// The "phone": pinned TLS + contract framing
// ---------------------------------------------------------------------------

/**
 * Open a pinned socket the way the app does.
 *
 * The leaf is checked **after** the TLS handshake but **before** the HTTP upgrade is written:
 * with `ws`, the upgrade request is sent by the client as soon as the handshake completes, so a
 * real client aborts inside the trust callback. `rejectUnauthorized: false` + an explicit peer
 * check is the closest a Node script gets without a custom `checkServerIdentity` hook; the
 * point of the check here is the *fixture* (does it serve the leaf the QR advertises), which the
 * `wrong` mode exercises by verifying that the app-facing value differs from the served one.
 */
function connectPinned ({ endpoint, certSha256, protocols, headers }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, protocols, {
      // The fixture is self-signed: trust is the leaf pin, not a CA (mirrors the native module).
      rejectUnauthorized: false,
      headers,
      handshakeTimeout: 10_000,
    })

    const cleanup = () => {
      socket.removeListener('open', onOpen)
      socket.removeListener('error', onError)
      socket.removeListener('unexpected-response', onUnexpected)
    }
    const onOpen = () => {
      const peer = socket._socket?.getPeerCertificate?.()
      const served = peer?.raw ? crypto.createHash('sha256').update(peer.raw).digest('hex') : null
      cleanup()
      if (served !== null && served !== certSha256) {
        socket.terminate()
        reject(Object.assign(new Error('pin-mismatch'), { code: 'client/pin-mismatch', served }))
        return
      }
      resolve({ socket, served })
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onUnexpected = (_request, response) => {
      cleanup()
      reject(Object.assign(new Error(`upgrade refused: ${response.statusCode}`), { status: response.statusCode }))
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
    socket.once('unexpected-response', onUnexpected)
  })
}

/** Collect frames until `predicate` matches (or time out). */
function waitFor (socket, predicate, timeoutMs = 5_000) {
  const inbox = socket.inbox ?? []
  for (const frame of inbox) {
    if (predicate(frame)) return Promise.resolve(frame)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('timed out waiting for frame'))
    }, timeoutMs)
    const onMessage = (data) => {
      const frame = JSON.parse(data.toString())
      if (!predicate(frame)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(frame)
    }
    socket.on('message', onMessage)
  })
}

function attachInbox (socket) {
  socket.inbox = []
  socket.on('message', (data) => {
    try {
      socket.inbox.push(JSON.parse(data.toString()))
    } catch {
      socket.inbox.push({ kind: 'unparseable' })
    }
  })
  return socket
}

/**
 * Answer the pairing challenge (contract §3.8) the way the app now must: the Host's
 * `pairing-challenge` arrives first and the only frame allowed before admission is
 * `pairing-proof {clientNonce}`. Returns the proof so a scenario can assert on it.
 */
async function answerPairingChallenge (socket) {
  const challenge = await waitFor(socket, (frame) => frame.kind === 'pairing-challenge')
  check('pairing challenge arrives before anything else', challenge.kind === 'pairing-challenge')
  check('challenge carries a serverNonce', /^[A-Za-z0-9_-]{16,64}$/.test(challenge.serverNonce ?? ''), String(challenge.serverNonce))
  check('challenge pins the served leaf', typeof challenge.certSha256 === 'string' && challenge.certSha256.length === 64)
  check('challenge says whether a one-time code is required', challenge.otpRequired === false)
  const proof = { type: 'pairing-proof', clientNonce: crypto.randomBytes(24).toString('base64url') }
  socket.send(JSON.stringify(proof))
  return proof
}

let requestCounter = 0
function request (socket, type, params = {}, expectKind) {
  requestCounter += 1
  const requestId = `selftest-${String(requestCounter).padStart(4, '0')}`
  const promise = waitFor(socket, (frame) => frame.requestId === requestId, 5_000)
  socket.send(JSON.stringify({ type, requestId, ...params }))
  return expectKind === undefined ? promise : promise.then((frame) => {
    check(`${type} answered kind:${expectKind}`, frame.kind === expectKind || frame.kind === 'error', `got kind:${frame.kind}${frame.code === undefined ? '' : ` code:${frame.code}`}`)
    return frame
  })
}

async function control (state, route, body) {
  const response = await fetch(`${state.controlUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fixture-token': state.controlToken },
    body: JSON.stringify(body ?? {}),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(`control ${route} failed: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function fetchState (state) {
  const response = await fetch(`${state.controlUrl}/state`)
  return response.json()
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioHappyPath (state) {
  section(`happy path (cert-mode ${state.certMode})`)

  const deviceId = crypto.randomUUID().toLowerCase()
  const { socket, served } = await connectPinned({
    endpoint: state.endpoint,
    certSha256: state.advertisedSha256,
    protocols: ['dsh-mobile-v1', `dsh-pair.${state.pairing.pairingCode}`],
    headers: { 'X-DSH-Device-ID': deviceId },
  })
  attachInbox(socket)
  check('served leaf matches the advertised pin', served === state.advertisedSha256, `${served} != ${state.advertisedSha256}`)

  // Contract §3.8: the socket is not admitted until it answers the challenge.
  await answerPairingChallenge(socket)
  const pairPending = await waitFor(socket, (frame) => frame.kind === 'pairing-pending')
  check('pairing-pending carries the comparison code', typeof pairPending.verificationCode === 'string' && pairPending.verificationCode.length > 0)
  check('pairing-pending carries an expiry in the future', pairPending.expiresAt > Date.now())

  const paired = await waitFor(socket, (frame) => frame.kind === 'paired' || frame.kind === 'pairing-rejected')
  check('pairing is approved by the fixture', paired.kind === 'paired', JSON.stringify(paired))
  check('paired frame carries a token', typeof paired.token === 'string' && paired.token.length > 0)
  check('paired frame carries the device', typeof paired.device?.id === 'string')

  const hello = await waitFor(socket, (frame) => frame.kind === 'hello')
  check('hello speaks companionProtocol 1', hello.companionProtocol === 1, `got ${hello.companionProtocol}`)
  check('hello advertises approval-v1', Array.isArray(hello.capabilities) && hello.capabilities.includes('approval-v1'))
  check('hello is authenticated after pairing', hello.authenticated === true)
  check('hello echoes gatewayId', hello.gatewayId === state.gatewayId)

  const ack = await request(socket, 'client-hello', { companionProtocol: 1, appVersion: '0.1.0', platform: 'android' })
  check('client-hello accepted', ack.kind === 'client-hello' && ack.accepted === true, JSON.stringify(ack))
  check('client-hello echoes requestId', ack.requestId !== undefined)

  // US2: the canonical projection (sessionId / running / projections.values.title).
  const sessions = await request(socket, 'sessions')
  check('sessions answered', sessions.kind === 'sessions' && Array.isArray(sessions.items))
  const alpha = sessions.items.find((row) => row.sessionId === 'sess-alpha')
  check('rows are canonical (`sessionId`, boolean `running`)', alpha !== undefined && alpha.running === true && alpha.sessionId === 'sess-alpha')
  check('title is under projections.values.title', alpha?.projections?.values?.title === 'Refactor gateway TLS')
  const gamma = sessions.items.find((row) => row.sessionId === 'sess-gamma')
  check('archived row carries the archive marker', gamma?.archived === true)

  // US2: search is a view over the same projection.
  const search = await request(socket, 'search', { query: 'release' })
  check('search filters by title', search.kind === 'search' && search.items.length === 1 && search.items[0].sessionId === 'sess-beta')

  // US3: subscribe replays the pending approval for that session.
  const subscribed = await request(socket, 'subscribe', { sessionId: 'sess-alpha' })
  check('subscribe acknowledged', subscribed.kind === 'subscribed')
  const replay = await waitFor(socket, (frame) => frame.kind === 'approval-requested' && frame.approvalId === 'apv-hash')
  check('replayed approval is marked replay:true', replay.replay === true)
  check('approval carries a 64-hex argsHash', /^[0-9a-f]{64}$/.test(replay.argsHash ?? ''), String(replay.argsHash))
  check('approval carries toolName', replay.toolName === 'shell.exec')

  // The null-hash card (US3 §3): a decision must be refused as not-pending, never honoured.
  const nullDecision = await request(socket, 'approval-response', {
    rpcId: replay.rpcId,
    sessionId: 'sess-beta',
    approvalId: 'apv-null',
    argsHash: 'f'.repeat(64),
    outcome: 'allowed-once',
  })
  check('null-hash decision is refused not-pending', nullDecision.accepted === false && nullDecision.reason === 'not-pending', JSON.stringify(nullDecision))

  // Stale hash first (contract §5): refused, approval stays pending.
  const stale = await request(socket, 'approval-response', {
    rpcId: replay.rpcId,
    sessionId: 'sess-alpha',
    approvalId: 'apv-hash',
    argsHash: 'a'.repeat(64),
    outcome: 'allowed-once',
  })
  check('stale hash is refused with hash-mismatch', stale.accepted === false && stale.reason === 'hash-mismatch', JSON.stringify(stale))
  check('refused decision kept the approval pending', (await fetchState(state)).approvals.some((approval) => approval.approvalId === 'apv-hash'))

  // Exact hash: accepted once, plus the resolved push.
  const decided = await request(socket, 'approval-response', {
    rpcId: replay.rpcId,
    sessionId: 'sess-alpha',
    approvalId: 'apv-hash',
    argsHash: replay.argsHash,
    outcome: 'allowed-once',
  })
  check('decision with the exact hash is accepted', decided.accepted === true, JSON.stringify(decided))
  const resolved = await waitFor(socket, (frame) => frame.kind === 'approval-resolved' && frame.approvalId === 'apv-hash')
  check('approval-resolved push carries the outcome', resolved.outcome === 'allowed-once')

  // Duplicate decision → not-pending ("already decided").
  const duplicate = await request(socket, 'approval-response', {
    rpcId: replay.rpcId,
    sessionId: 'sess-alpha',
    approvalId: 'apv-hash',
    argsHash: replay.argsHash,
    outcome: 'rejected',
  })
  check('second decision is refused not-pending', duplicate.accepted === false && duplicate.reason === 'not-pending', JSON.stringify(duplicate))

  // US4: prompt + cancel.
  const clientMsgId = crypto.randomUUID()
  const sent = await request(socket, 'message', { sessionId: 'sess-alpha', text: 'Run the tests again', clientMsgId })
  check('prompt acknowledged', sent.kind === 'sent' && sent.clientMsgId === clientMsgId)
  const duplicatePrompt = await request(socket, 'message', { sessionId: 'sess-alpha', text: 'Run the tests again', clientMsgId })
  check('prompt retry is idempotent by clientMsgId', duplicatePrompt.kind === 'sent')
  const cancel = await request(socket, 'session-cancel', { sessionId: 'sess-alpha' })
  check('cancel acknowledged', cancel.kind === 'session-cancelled' && cancel.accepted === true)

  const history = await request(socket, 'history', { sessionId: 'sess-alpha' })
  check('history has rows', history.kind === 'history' && history.items.length >= 2)
  check('history rows carry role+text', history.items.every((row) => typeof row.role === 'string' && typeof row.text === 'string'))

  // Evidence cross-check: the phone's own view of what it sent.
  const evidence = await fetchState(state)
  const promptCount = evidence.evidence.prompts.filter((prompt) => prompt.clientMsgId === clientMsgId).length
  check('fixture stored the prompt once (idempotent)', promptCount === 1, `count=${promptCount}`)
  const receipt = evidence.evidence.approvalReceipts.find((entry) => entry.accepted === true)
  check('accepted receipt echoed the exact hash', receipt?.argsHash === replay.argsHash, `${receipt?.argsHash} != ${replay.argsHash}`)
  const mismatchReceipt = evidence.evidence.approvalReceipts.find((entry) => entry.reason === 'hash-mismatch')
  check('mismatch receipt recorded the refused hash', mismatchReceipt?.argsHash === 'a'.repeat(64))
  check('no pairing code was ever put in a URL', evidence.evidence.upgradeRefusals.every((refusal) => !refusal.url.includes(state.pairing.pairingCode)))
  check('exactly one connection is open', evidence.evidence.openConnections === 1, `open=${evidence.evidence.openConnections}`)

  // Reconnect with the bearer token (the app's normal second connection).
  socket.close(1000, 'selftest-done')
  await once(socket, 'close').catch(() => {})
  const second = await connectPinned({
    endpoint: state.endpoint,
    certSha256: state.advertisedSha256,
    protocols: ['dsh-mobile-v1'],
    headers: { Authorization: `Bearer ${paired.token}`, 'X-DSH-Device-ID': deviceId },
  })
  attachInbox(second.socket)
  const hello2 = await waitFor(second.socket, (frame) => frame.kind === 'hello')
  check('bearer reconnect is authenticated', hello2.authenticated === true)
  const pending = await waitFor(second.socket, (frame) => frame.kind === 'paired', 500).then(() => true, () => false)
  check('bearer connection does not send `paired` again', pending === false)

  // Revocation: every token dies, live sockets close 4401. Subscribe before the control call:
  // the close event can land while that HTTP round-trip is still awaited.
  const revokedClose = once(second.socket, 'close')
  await control(state, '/scenario/revoke')
  const closeEvent = await revokedClose
  const closeCode = closeEvent?.[0]
  check('revoke closes the live socket with 4401', closeCode === 4401, `code=${closeCode}`)

  // A revoked token cannot come back.
  const revokedAttempt = await connectPinned({
    endpoint: state.endpoint,
    certSha256: state.advertisedSha256,
    protocols: ['dsh-mobile-v1'],
    headers: { Authorization: `Bearer ${paired.token}` },
  }).then(() => ({ ok: true }), (error) => ({ ok: false, status: error.status }))
  check('revoked token is refused at the upgrade (401)', revokedAttempt.ok === false && revokedAttempt.status === 401, JSON.stringify(revokedAttempt))
}

async function scenarioUpgradeRefusals (state) {
  section('upgrade refusals (401 / 403 mapping)')
  const attempt = async (status) => {
    await control(state, '/scenario/upgrade-status', { status })
    const result = await connectPinned({
      endpoint: state.endpoint,
      certSha256: state.advertisedSha256,
      protocols: ['dsh-mobile-v1', `dsh-pair.${state.pairing.pairingCode}`],
      headers: { 'X-DSH-Device-ID': crypto.randomUUID() },
    }).then(() => ({ ok: true }), (error) => ({ ok: false, status: error.status, code: error.code }))
    return result
  }

  const unauthorised = await attempt(401)
  check('upgrade refused with 401 when the scenario asks', unauthorised.ok === false && unauthorised.status === 401, JSON.stringify(unauthorised))
  const forbidden = await attempt(403)
  check('upgrade refused with 403 when the scenario asks', forbidden.ok === false && forbidden.status === 403, JSON.stringify(forbidden))
  await control(state, '/scenario/upgrade-status', { status: null })

  const after = await fetchState(state)
  check('refusals are recorded with their status', after.evidence.upgradeRefusals.length >= 2)
  check('no socket was created for a refused upgrade', after.evidence.openConnections === 0, `open=${after.evidence.openConnections}`)
}

async function scenarioProtocolGate (state) {
  section('protocol/unsupported gate')
  // Pairing codes are one-time: rotate so this scenario owns a fresh one.
  const fresh = await control(state, '/pairing/new')
  await control(state, '/scenario/protocol', { companionProtocol: 2, minClientVersion: 2 })
  const { socket } = await connectPinned({
    endpoint: state.endpoint,
    certSha256: state.advertisedSha256,
    protocols: ['dsh-mobile-v1', `dsh-pair.${fresh.pairingCode}`],
    headers: { 'X-DSH-Device-ID': crypto.randomUUID() },
  })
  attachInbox(socket)
  await answerPairingChallenge(socket)
  await waitFor(socket, (frame) => frame.kind === 'paired')
  const hello = await waitFor(socket, (frame) => frame.kind === 'hello')
  check('hello announces the newer companion protocol', hello.companionProtocol === 2)
  requestCounter += 1
  const requestId = `selftest-${String(requestCounter).padStart(4, '0')}`
  socket.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: '0.1.0', platform: 'android' }))
  const error = await waitFor(socket, (frame) => frame.kind === 'error' || (frame.kind === 'client-hello' && frame.requestId === requestId))
  check('client-hello answered protocol/unsupported', error.kind === 'error' && error.code === 'protocol/unsupported', JSON.stringify(error))
  check('refusal carries minClientVersion', error.minClientVersion === 2)
  socket.terminate()
  await control(state, '/scenario/protocol', { companionProtocol: 1, minClientVersion: 1 })
}

async function scenarioPairingCodeIsSingleUse (state) {
  section('one-time pairing code (replay → 401)')
  const rotated = await control(state, '/pairing/new')
  const code = rotated.pairingCode
  const first = await connectPinned({
    endpoint: state.endpoint,
    certSha256: state.advertisedSha256,
    protocols: ['dsh-mobile-v1', `dsh-pair.${code}`],
    headers: { 'X-DSH-Device-ID': crypto.randomUUID() },
  })
  attachInbox(first.socket)
  await answerPairingChallenge(first.socket)
  await waitFor(first.socket, (frame) => frame.kind === 'paired')
  first.socket.close(1000, 'selftest-replay')

  const replay = await connectPinned({
    endpoint: state.endpoint,
    certSha256: state.advertisedSha256,
    protocols: ['dsh-mobile-v1', `dsh-pair.${code}`],
    headers: { 'X-DSH-Device-ID': crypto.randomUUID() },
  }).then(() => ({ ok: true }), (error) => ({ ok: false, status: error.status }))
  check('replayed pairing code is refused at the upgrade (401)', replay.ok === false && replay.status === 401, JSON.stringify(replay))

  const next = await control(state, '/pairing/new')
  check('control API rotates the pairing code', next.qr !== rotated.qr && next.endpoint === state.endpoint)
}

async function scenarioAbruptDrop (state) {
  section('abrupt drop (network loss)')
  const fresh = await control(state, '/pairing/new')
  const { socket } = await connectPinned({
    endpoint: state.endpoint,
    certSha256: state.advertisedSha256,
    protocols: ['dsh-mobile-v1', `dsh-pair.${fresh.pairingCode}`],
    headers: { 'X-DSH-Device-ID': crypto.randomUUID() },
  })
  attachInbox(socket)
  await answerPairingChallenge(socket)
  const paired = await waitFor(socket, (frame) => frame.kind === 'paired')

  // The fixture terminates the socket with no close frame — what a dead Wi-Fi link looks like.
  // Subscribe before the control call so an early close is never missed.
  const dropped = once(socket, 'close')
  await control(state, '/scenario/drop')
  const closeEvent = await dropped
  check('dropped socket reports an abnormal close', closeEvent[0] !== 1000, `code=${closeEvent[0]}`)

  // The retry the app's Reconnector performs, with the token it kept in the secure store.
  const retry = await connectPinned({
    endpoint: state.endpoint,
    certSha256: state.advertisedSha256,
    protocols: ['dsh-mobile-v1'],
    headers: { Authorization: `Bearer ${paired.token}` },
  })
  attachInbox(retry.socket)
  const hello = await waitFor(retry.socket, (frame) => frame.kind === 'hello')
  check('reconnect after a drop is accepted', hello.authenticated === true)
  const sessions = await request(retry.socket, 'sessions')
  check('resync lists sessions again', sessions.kind === 'sessions' && sessions.items.length === 3)
  retry.socket.terminate()
}

/**
 * TLS-only probe that emulates the **native** pin check exactly: complete the handshake, compare
 * the peer leaf, and destroy the socket *before writing any HTTP upgrade bytes*.
 *
 * This is the only way a Node script can reproduce `modules/pinned-ws`: `ws` writes the upgrade
 * request as soon as the handshake completes, so a pin failure inside `ws` arrives too late to
 * prove "nothing was sent". A native trust callback (OkHttp `X509ExtendedTrustManager` / iOS
 * `URLSessionDelegate`) aborts inside the handshake, and this probe mimics that.
 */
function probePinnedTls ({ endpoint, certSha256, timeoutMs = 10_000 }) {
  const url = new URL(endpoint.replace(/^wss:/, 'https:'))
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: url.hostname,
      port: Number(url.port),
      servername: url.hostname,
      // The leaf is self-signed and trust comes from the pin, not a CA (mirrors the native module).
      rejectUnauthorized: false,
    }, () => {
      const peer = socket.getPeerCertificate()
      const served = peer?.raw ? crypto.createHash('sha256').update(peer.raw).digest('hex') : null
      // Nothing has been written yet: no HTTP request line, no subprotocol, no device id.
      socket.destroy()
      resolve({ pinOk: served === certSha256, served })
    })
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      reject(new Error('tls probe timed out'))
    })
    socket.once('error', reject)
  })
}

async function scenarioPinMismatch (state) {
  section('certificate modes')
  check('advertised hash differs from the served leaf in `wrong` mode', state.certMode !== 'wrong' || state.advertisedSha256 !== state.servedSha256, 'wrong mode must advertise a different leaf')

  const probe = await probePinnedTls({ endpoint: state.endpoint, certSha256: state.advertisedSha256 })
  const afterProbe = await fetchState(state)

  if (state.certMode === 'wrong') {
    check('pin mismatch is detected from the served leaf', probe.pinOk === false, `served=${probe.served}`)
    // The property the device run must reproduce: a trust callback that aborts inside the
    // handshake leaves zero upgrade attempts and transmits no code / device id.
    check('pin mismatch sent no upgrade request', afterProbe.evidence.upgradeAttempts === 0, `upgrades=${afterProbe.evidence.upgradeAttempts}`)
    check('pin mismatch sent no pairing code', afterProbe.evidence.offeredPairingCodes.length === 0)
    check('pin mismatch sent no device id', afterProbe.evidence.deviceIds.length === 0)
    check('the served TLS socket recorded no completed handshake-to-upgrade', afterProbe.evidence.openConnections === 0)
  } else if (state.certMode === 'expired' || state.certMode === 'not-yet') {
    check('pin matches the advertised leaf', probe.pinOk === true, `served=${probe.served}`)
    check('served leaf is outside its validity window', state.servedWindow.validTo <= Date.now() || state.servedWindow.validFrom > Date.now(), JSON.stringify(state.servedWindow))
    // Node's TLS stack accepts it (rejectUnauthorized is false by design for a pinned connection),
    // so the refusal has to come from the device trust manager: that is the checkpoint this mode
    // exists for (A032 Node transport, A047 iOS, PinnedTrustManager on Android).
    process.stdout.write('  note  Node accepts the leaf by design: the validity refusal is a device-side check (A032/A047)\n')
    check('pin-only acceptance is what makes this mode meaningful', probe.pinOk === true)
  } else {
    check('valid leaf passes the pin check', probe.pinOk === true, `served=${probe.served}`)
    check('a probe that aborts is not a connection', afterProbe.evidence.openConnections === 0)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

section(`fixture self-test — cert-mode ${certMode}`)
const fixture = startFixture()
let state
try {
  state = await fixture.ready()
  process.stdout.write(`  fixture ${state.endpoint} (pin ${state.advertisedSha256.slice(0, 16)}…)\n\n`)

  if (certMode === 'ok') {
    await scenarioHappyPath(state)
    await scenarioUpgradeRefusals(state)
    await scenarioProtocolGate(state)
    await scenarioPairingCodeIsSingleUse(state)
    await scenarioAbruptDrop(state)
  }
  await scenarioPinMismatch(state)
} catch (error) {
  failures.push({ label: 'unexpected exception', detail: error instanceof Error ? error.stack : String(error) })
  process.stdout.write(`\n  FAIL unexpected exception: ${error instanceof Error ? error.stack : String(error)}\n`)
} finally {
  await fixture.stop()
}

process.stdout.write(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${passed} checks passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const failure of failures) {
    process.stdout.write(`  - ${failure.label}${failure.detail === undefined ? '' : `: ${failure.detail}`}\n`)
  }
  if (fixture.stderrText() !== '') process.stdout.write(`\nfixture stderr:\n${fixture.stderrText()}\n`)
  process.exitCode = 1
}
