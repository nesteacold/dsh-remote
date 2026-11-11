// Spec 005 (remote desktop client) — gateway acceptance tests T1, T2, T4, T5, T6, T7, T8.
//
//   T1  every mapped `msg.type` is served with its scope and refused without it (`auth/forbidden-scope`)
//   T2  a type outside the companion vocabulary is refused (fail closed) and never reaches the Host
//   T4  a foreign Origin gets 403 before the upgrade; a missing Origin is allowed
//   T5  revoking a desktop closes its socket (4401) and refuses its token the next time
//   T6  approval replay reaches a device holding `approval:respond`
//   T7  a pairing string round-trips to the QR payload; used, foreign-pin and expired codes fail
//   T8  re-pairing closes the sockets the previous grant opened, widening and narrowing alike
//   T9  a connection that activates after a re-pair or a revoke sends nothing and closes 4401
//
// Devices pair over the plugin's TLS listener, as a real phone or desktop does:
// the offer pins that certificate (contract §2/§3.4) and the listener refuses a
// client that does not report the same fingerprint (T017). The fake Host records
// every call, so "refused before the Host" is a real assertion.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

import WebSocket from 'ws'
import plugin from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { CLOSE_CODES, OP_RESPONSES, SCOPES, SCOPE_BY_TYPE } from '@dsh-ext/mobile-protocol'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const UUID = 'desk0000-0000-4000-8000-000000000001'

/**
 * These tests reach the management listener with `fetch`, but undici refuses whole
 * classes of ports outright ("bad port": 6000, 10080, 5060, …) before it connects —
 * and `listen(0)` returns whatever the OS picks. `listenFetchSafe` binds, proves
 * the port with the same `fetch`, and re-binds on a refusal; see
 * test/support/fetch-safe-listen.mjs. (The TLS listener is reached with `ws`, which
 * has no such blocklist, so it may use any port.)
 */
async function factory(t, config = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-005-gateway-'))
  const listeners = {}
  const sockets = []
  let management
  let upgrade
  let dispose = () => {}
  const hostCalls = []
  const { server, port } = await listenFetchSafe(() => {
    const candidate = http.createServer((req, res) => {
      if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) {
        management.handler(req, res)
        return
      }
      res.writeHead(404).end()
    })
    candidate.on('upgrade', (req, socket, head) => {
      if (upgrade) upgrade.handler(req, socket, head)
      else socket.destroy()
    })
    return candidate
  })
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke(request) {
        hostCalls.push(`${request.namespace}/${request.method}`)
        if (request.namespace === 'session' && request.method === 'list') return { items: [{ sessionId: 's1' }] }
        if (request.namespace === 'session' && request.method === 'search') return { items: [], hasMore: false }
        if (request.namespace === 'session' && request.method === 'prompt') return { accepted: true }
        if (request.namespace === 'session' && request.method === 'cancel') return { accepted: true }
        // Spec 011: the authoring ops are served to a `sessions:author` device, so
        // the fake Host has to answer what their handlers read.
        if (request.namespace === 'session' && request.method === 'modelCatalog') {
          return { default: { provider: 'p', model: 'm' }, routableProviders: ['p'], groups: [], failures: [] }
        }
        if (request.namespace === 'session' && request.method === 'create') return { sessionId: 's-new' }
        if (request.namespace === 'session' && request.method === 'selectModel') return { provider: 'p', model: 'm' }
        return {}
      },
      async stream(request) {
        hostCalls.push(`${request.namespace}/${request.method}#stream`)
        return (async function* () {
          if (request.namespace === 'session' && request.method === 'follow') {
            const address = request.args.request.address
            yield { type: 'snapshot', header: { version: 4, id: address.sessionId }, cursor: 1,
              records: [], hasMore: false, projections: { asOfSeq: 1, values: {} },
              assistantStream: { revision: 0 } }
          } else {
            yield { type: 'baseline', value: request.namespace === 'workspace'
              ? { items: [{ workspaceId: 'w1' }], archivedSessionIds: [] } : { projections: {} } }
          }
          while (!request.signal.aborted) await delay(10)
        })()
      },
    },
    agentDefaultModel: {},
    on(name, handler) { listeners[name] = handler; return () => {} },
    effect(fn) { dispose = fn() },
  }
  await plugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: `spec005-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true,
    requireHostApproval: false, // spec 008 P1b: these tests exercise the direct claim path; pairing-approval.test.mjs covers the default
    lanHost: '127.0.0.1',
    lanPort: 0,
    ...config,
  })
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    dispose()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    port,
    base: `http://127.0.0.1:${port}`,
    // The loopback route the DSH admin UI uses; no certificate, no pin.
    endpoint: `ws://127.0.0.1:${port}/ws/mobile`,
    hostCalls,
    listeners,
    async post(route, body) {
      const response = await fetch(`${instance.base}/mgw/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: instance.base },
        body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    async status() { return (await fetch(`${instance.base}/mgw/status`)).json() },
    async devices() { return (await fetch(`${instance.base}/mgw/devices`)).json() },
    track(socket) { sockets.push(socket); return socket },
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await instance.status()
    if (status.lan?.listening && status.lan.urls.length > 0) {
      instance.lanUrl = status.lan.urls[0]
      instance.lanPin = status.lan.certSha256
      return instance
    }
    if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

/** Every frame a socket has received; a frame can arrive before anyone awaits it. */
const buffers = new WeakMap()
function recordFrames(ws) {
  const seen = []
  buffers.set(ws, seen)
  ws.on('message', (data) => {
    try { seen.push(JSON.parse(data.toString())) } catch { /* not ours */ }
  })
  ws.on('error', () => {})
  return seen
}

/** Wait for a frame (already received or yet to come) that matches `predicate`. */
async function takeFrame(ws, predicate, timeoutMs = 5_000) {
  const seen = buffers.get(ws) ?? recordFrames(ws)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const frame = seen.find(predicate)
    if (frame) return frame
    await delay(5)
  }
  throw new Error(`timed out waiting for a frame (${seen.map((frame) => frame.kind).join(', ')})`)
}

/** The wss:// endpoint a pairing offer carries. */
const lanEndpoint = (instance) => instance.lanUrl

/** Open a socket to the TLS listener, reporting the pin it presents (T017). */
function openLan(instance, protocols, headers = {}) {
  const ws = new WebSocket(lanEndpoint(instance), protocols, {
    headers: { 'X-DSH-Cert-SHA256': instance.lanPin, ...headers },
    origin: undefined,
    rejectUnauthorized: false,
  })
  return instance.track(ws)
}

/** Open a socket on the loopback route (no certificate to pin). */
function openLoopback(instance, protocols) {
  return instance.track(new WebSocket(instance.endpoint, protocols, { origin: undefined }))
}

/** The status of a refused upgrade, `'open'` when it was accepted. */
function upgradeAnswer(instance, protocols, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(lanEndpoint(instance), protocols, {
      headers: { 'X-DSH-Cert-SHA256': instance.lanPin, ...headers },
      origin: undefined,
      rejectUnauthorized: false,
    })
    const timer = setTimeout(() => { ws.terminate(); resolve('timeout') }, 5_000)
    const finish = (value) => { clearTimeout(timer); resolve(value) }
    ws.once('open', () => { ws.terminate(); finish('open') })
    ws.once('unexpected-response', (_request, response) => { response.resume(); finish(response.statusCode) })
    ws.once('error', () => finish('error'))
  })
}

/** `dsh-mobile-v1` plus the one-time code, the way a companion offers a pairing. */
const pairProtocols = (code) => ['dsh-mobile-v1', `dsh-pair.${code}`]

let requestCounter = 0
/**
 * Send one request and wait for its answer: the frame echoing `requestId`, or —
 * for the ops that answer without one (`unsubscribe` → `unsubscribed`) — the
 * response kind the contract assigns to it.
 */
async function request(ws, frame) {
  const requestId = frame.requestId ?? `t-${++requestCounter}`
  const kind = OP_RESPONSES[frame.type]
  ws.send(JSON.stringify({ ...frame, requestId }))
  return takeFrame(ws, (reply) => reply.requestId === requestId || (kind !== undefined && reply.kind === kind))
}

/** Contract §3.6/§5a: operations wait for the acknowledged client-hello. */
async function negotiate(ws) {
  const requestId = `hello-${++requestCounter}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test', platform: 'ios' }))
  return takeFrame(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === requestId)
}

/** Pair a device the way a companion does; returns its token and first `hello`. */
async function pairDevice(instance, name, deviceId, offer = {}) {
  const created = await instance.post('pair', { name, publicUrl: lanEndpoint(instance), ...offer })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ws = openLan(instance, pairProtocols(created.data.payload.pairingCode), { 'X-DSH-Device-ID': deviceId })
  recordFrames(ws)
  await once(ws, 'open')
  const paired = await takeFrame(ws, (frame) => frame.kind === 'paired')
  const hello = await takeFrame(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return { ws, created: created.data, token: paired.token, device: paired.device, hello }
}

async function connectToken(instance, token, deviceId) {
  const ws = openLan(instance, ['dsh-mobile-v1'], { Authorization: `Bearer ${token}`, 'X-DSH-Device-ID': deviceId })
  recordFrames(ws)
  await once(ws, 'open')
  const hello = await takeFrame(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return { ws, hello }
}

test('T1: every mapped type is served with its scope and refused without it', async (t) => {
  const instance = await factory(t)
  // One scope at a time, so a type is refused exactly when its own scope is absent.
  for (const [index, scope] of SCOPES.entries()) {
    const deviceId = `scoped-0000-4000-8000-00000000000${index}`
    const layout = await pairDevice(instance, `scope ${scope}`, deviceId, { kind: 'desktop', scopes: [scope] })
    assert.deepEqual(layout.hello.device.scopes, [scope])
    const { ws } = await connectToken(instance, layout.token, deviceId)
    for (const [type, required] of Object.entries(SCOPE_BY_TYPE)) {
      // Spec 008 remote-bridge frames are scoped too but are not contract §4 ops:
      // they answer with `remote-result`, not OP_RESPONSES. test/remote-bridge.test.mjs
      // covers their scope gate (T4) and their endpoint allowlist.
      if (OP_RESPONSES[type] === undefined) continue
      const before = instance.hostCalls.length
      const requestId = `scope-${index}-${type}`
      const reply = await request(ws, { requestId, type, sessionId: 's1', companionProtocol: 1,
        appVersion: '1.0.0', platform: 'ios', query: 'q', rpcId: 'rpc-x', approvalId: 'approval-x',
        argsHash: 'h', outcome: 'rejected', text: 'hi', clientMsgId: `m-${index}-${type}`,
        // Spec 011: the authoring frames' own arguments.
        workspaceId: 'w1', provider: 'p', model: 'm' })
      // The `client-hello` exchange itself is not scope-gated: it is what makes
      // the connection ready (contract §3.6/§5a), so it is served before any
      // scope decision — otherwise a device whose grant lacks sessions:read
      // could never negotiate at all.
      if (type === 'client-hello') {
        assert.equal(reply.kind, 'client-hello', JSON.stringify(reply))
        continue
      }
      if (required === scope) {
        // Served: the gateway answers with this type's response kind (and, for
        // every op that echoes it, the requestId). A scope refusal is never it.
        assert.equal(reply.kind, OP_RESPONSES[type], `${type} must be served to a ${scope} device: ${JSON.stringify(reply)}`)
        assert.notEqual(reply.code, 'auth/forbidden-scope', type)
        continue
      }
      assert.equal(reply.kind, 'error', `${type} must be refused to a device holding only ${scope}`)
      assert.equal(reply.code, 'auth/forbidden-scope', `${type} needs ${required}: ${JSON.stringify(reply)}`)
      assert.equal(reply.requestType, type)
      assert.equal(reply.scope, required)
      assert.equal(instance.hostCalls.length, before, `${type} was refused but still reached the Host`)
    }
    ws.close()
  }
})

test('T2: a type outside the companion vocabulary is refused for a scoped device and never reaches the Host', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, 'desktop', UUID, { kind: 'desktop' })
  const { ws } = await connectToken(instance, layout.token, UUID)
  for (const type of ['plugin-catalog', 'not-an-op']) {
    const before = instance.hostCalls.length
    const reply = await request(ws, { type, path: '/tmp' })
    assert.equal(reply.kind, 'error', `${type} must be refused`)
    assert.equal(reply.code, 'op/forbidden', `${type} must stay outside the companion allowlist: ${JSON.stringify(reply)}`)
    assert.equal(reply.requestType, type)
    assert.equal(instance.hostCalls.length, before, `${type} must not reach the Host`)
  }
  // Spec 011: `workspaces` is part of the §4 vocabulary now, but only for a device
  // that holds `sessions:author` — this desktop offer did not include it, so the
  // SCOPE gate answers instead of the type allowlist, still before any Host call.
  {
    const before = instance.hostCalls.length
    const reply = await request(ws, { type: 'workspaces' })
    assert.equal(reply.kind, 'error')
    assert.equal(reply.code, 'auth/forbidden-scope', JSON.stringify(reply))
    assert.equal(reply.scope, 'sessions:author')
    assert.equal(instance.hostCalls.length, before, 'workspaces must not reach the Host without the scope')
  }
  // Push has no scope and is refused by its own branch — never by silence.
  for (const type of ['push-register', 'push-remove']) {
    const reply = await request(ws, { type, platform: 'fcm', token: 'x' })
    assert.equal(reply.kind, 'error', `${type} must be refused`)
    assert.equal(reply.requestType, type)
  }
  // A refusal is not a revocation: the credential still works.
  assert.equal((await request(ws, { type: 'device-info' })).device.id, layout.device.id)
})

test('T4: a foreign Origin gets 403 before the upgrade; a missing Origin is allowed', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, 'desktop', UUID, { kind: 'desktop' })
  // Default `allowedOrigins: []`: every Origin is foreign, credential or not.
  assert.equal(await upgradeAnswer(instance, ['dsh-mobile-v1'], { Origin: 'https://attacker.example' }), 403)
  assert.equal(await upgradeAnswer(instance, ['dsh-mobile-v1'],
    { Origin: 'https://attacker.example', Authorization: `Bearer ${layout.token}` }), 403)
  assert.equal(await upgradeAnswer(instance, ['dsh-mobile-v1']), 401, 'no Origin, no credential: the usual 401')
  const allowed = await connectToken(instance, layout.token, UUID)
  assert.equal(allowed.hello.authenticated, true)

  // A configured origin is admitted; another is still refused.
  const configured = await factory(t, { allowedOrigins: ['https://desk.example'] })
  const second = await pairDevice(configured, 'desktop', UUID, { kind: 'desktop' })
  assert.equal(await upgradeAnswer(configured, ['dsh-mobile-v1'], { Origin: 'https://other.example' }), 403)
  const viaAllowedOrigin = configured.track(new WebSocket(lanEndpoint(configured), ['dsh-mobile-v1'], {
    headers: { Authorization: `Bearer ${second.token}`, 'X-DSH-Device-ID': UUID, 'X-DSH-Cert-SHA256': configured.lanPin },
    origin: 'https://desk.example',
    rejectUnauthorized: false,
  }))
  recordFrames(viaAllowedOrigin)
  await once(viaAllowedOrigin, 'open')
  assert.equal((await takeFrame(viaAllowedOrigin, (frame) => frame.kind === 'hello')).authenticated, true)
})

test('T5: revoking a desktop closes its socket (4401) and kills its token', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, 'desktop', UUID, { kind: 'desktop' })
  const { ws } = await connectToken(instance, layout.token, UUID)
  assert.equal((await instance.devices()).devices[0].kind, 'desktop')
  const closed = once(ws, 'close')
  assert.equal((await instance.post(`devices/${layout.device.id}/revoke`)).status, 200)
  assert.equal((await closed)[0], CLOSE_CODES.revoked)
  assert.equal(await upgradeAnswer(instance, ['dsh-mobile-v1'],
    { Authorization: `Bearer ${layout.token}`, 'X-DSH-Device-ID': UUID }), 401)
  assert.deepEqual((await instance.devices()).devices, [])
})

test('T6: a device holding approval:respond answers a replayed approval; one without it cannot', async (t) => {
  const instance = await factory(t)
  const observerId = 'desk-alt-0000-4000-8000-000000000002'
  const responder = await pairDevice(instance, 'desktop', UUID, { kind: 'desktop' })
  const observer = await pairDevice(instance, 'observer', observerId, { kind: 'desktop', scopes: ['sessions:read'] })
  const { ws: responderWs } = await connectToken(instance, responder.token, UUID)
  const { ws: observerWs } = await connectToken(instance, observer.token, observerId)
  await takeFrame(responderWs, (frame) => frame.kind === 'projection-baseline')
  await takeFrame(observerWs, (frame) => frame.kind === 'projection-baseline')

  const desktopAnswer = Promise.withResolvers()
  // T024/T026: a remotely decidable approval must bind the `tool/call` content;
  // seed it the way the Host emits it before the approval pipeline.
  instance.listeners['session/event']({ id: 's1' }, {
    type: 'tool/call', seq: 1, time: 1,
    data: { turn: 1, step: 0, callId: 'scope-approval-1', name: 'bash', arguments: '{"command":"ls"}' },
  })
  const pending = instance.listeners['approval/request']({
    agent: { id: 's1' }, toolName: 'bash', callId: 'scope-approval-1',
    reason: 'spec 005 T6', signal: new AbortController().signal,
  }, () => desktopAnswer.promise)
  const live = await takeFrame(responderWs, (frame) => frame.kind === 'approval-requested' && frame.replay !== true)
  // Reviewer 36d9 #5: a device without a live `approval:respond` is not sent the
  // card at all (it could not act on it), and it still cannot answer one either.
  await request(observerWs, { type: 'ping' }) // everything sent before this reply has been delivered
  assert.equal((buffers.get(observerWs) ?? []).some((frame) => frame.kind === 'approval-requested'), false,
    'an observer without approval:respond must not receive the approval card')
  const refused = await request(observerWs, { type: 'approval-response', rpcId: live.rpcId, sessionId: 's1',
    approvalId: live.approvalId, argsHash: live.argsHash ?? 'x', outcome: 'rejected' })
  assert.equal(refused.code, 'auth/forbidden-scope')

  // Reconnect: the still-pending approval is replayed to the new connection (contract §5).
  responderWs.close()
  await once(responderWs, 'close')
  const { ws: replayed } = await connectToken(instance, responder.token, UUID)
  const replay = await takeFrame(replayed, (frame) => frame.kind === 'approval-requested')
  assert.equal(replay.rpcId, live.rpcId)
  assert.equal(replay.replay, true)
  const receipt = await request(replayed, { type: 'approval-response', rpcId: replay.rpcId, sessionId: 's1',
    approvalId: replay.approvalId, argsHash: replay.argsHash ?? 'x', outcome: 'allowed-once' })
  assert.equal(receipt.kind, 'approval-response')
  assert.equal(receipt.accepted, true, JSON.stringify(receipt))
  assert.equal(await pending, 'allowed-once')
  desktopAnswer.resolve('rejected')
})

test('T7: a pairing string round-trips to the QR payload, and a used code fails', async (t) => {
  const instance = await factory(t)
  const created = await instance.post('pair', { name: 'Desktop', kind: 'desktop', publicUrl: lanEndpoint(instance) })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const body = created.data

  // FR3: the copy-paste pairing string is the QR payload (unpadded base64url JSON).
  assert.equal(body.pairingString, body.qrPayload)
  assert.match(body.pairingString, /^[A-Za-z0-9_-]+$/, 'base64url never emits + / or =')
  const decoded = JSON.parse(Buffer.from(body.pairingString, 'base64url').toString('utf8'))
  assert.deepEqual(decoded, body.payload)
  assert.equal(body.pairing.kind, 'desktop')
  assert.deepEqual(body.pairing.scopes, ['sessions:read', 'prompt:send', 'approval:respond'])
  assert.match(decoded.certSha256, /^[a-f0-9]{64}$/, 'the pin travels with the code')
  const ttl = decoded.expiresAt - Date.now()
  assert.ok(ttl > 0 && ttl <= 5 * 60 * 1000, `expiresAt must sit inside the 5-minute TTL, got ${ttl}`)

  // The decoded string alone is enough to pair, with the offered kind and scopes.
  const first = openLan(instance, pairProtocols(decoded.pairingCode), { 'X-DSH-Device-ID': UUID })
  recordFrames(first)
  await once(first, 'open')
  const paired = await takeFrame(first, (frame) => frame.kind === 'paired' || frame.kind === 'error')
  assert.equal(paired.kind, 'paired', JSON.stringify(paired))
  assert.equal(paired.device.kind, 'desktop')
  assert.deepEqual(paired.device.scopes, body.pairing.scopes)
  const pairedHello = await takeFrame(first, (frame) => frame.kind === 'hello')
  assert.equal(pairedHello.device.kind, 'desktop')
  assert.deepEqual(pairedHello.device.scopes, body.pairing.scopes)

  // Used: the same code is single-use, on any installation id.
  assert.equal(await upgradeAnswer(instance, pairProtocols(decoded.pairingCode), { 'X-DSH-Device-ID': UUID }), 401)
  assert.equal(await upgradeAnswer(instance, pairProtocols(decoded.pairingCode),
    { 'X-DSH-Device-ID': 'desk-alt-0000-4000-8000-000000000003' }), 401)

  // An invalid kind or scope is a 400, never a silently widened grant.
  assert.equal((await instance.post('pair', { kind: 'tablet', publicUrl: lanEndpoint(instance) })).status, 400)
  assert.equal((await instance.post('pair', { kind: 'desktop', scopes: ['root'], publicUrl: lanEndpoint(instance) })).status, 400)

  // FR4: the device list carries kind + scopes.
  const row = (await instance.devices()).devices.find((device) => device.id === body.pairing.id)
  assert.equal(row.kind, 'desktop')
  assert.deepEqual(row.scopes, body.pairing.scopes)
})

test('T8: a re-pair closes the sockets the previous grant opened (widening and narrowing)', async (t) => {
  const instance = await factory(t)
  const deviceId = 'repair-0000-4000-8000-000000000001'

  // Start narrow: read sessions, nothing else.
  const narrow = await pairDevice(instance, 'desktop', deviceId, { kind: 'desktop', scopes: ['sessions:read'] })
  const { ws: narrowSocket } = await connectToken(instance, narrow.token, deviceId)
  const refused = await request(narrowSocket, { type: 'message', sessionId: 's1', text: 'hi', clientMsgId: 'repair-1' })
  assert.equal(refused.code, 'auth/forbidden-scope', JSON.stringify(refused))

  // Widen. The socket opened under the old grant is closed with the revoke code
  // (4401) before the new one exists, and the replaced token cannot come back.
  const narrowClosed = once(narrowSocket, 'close')
  const widened = await pairDevice(instance, 'desktop', deviceId,
    { kind: 'desktop', scopes: ['sessions:read', 'prompt:send'] })
  assert.equal(widened.device.id, narrow.device.id, 'the same device row is reused')
  assert.deepEqual(widened.hello.device.scopes, ['sessions:read', 'prompt:send'])
  assert.equal((await narrowClosed)[0], CLOSE_CODES.revoked)
  assert.equal(await upgradeAnswer(instance, ['dsh-mobile-v1'],
    { Authorization: `Bearer ${narrow.token}`, 'X-DSH-Device-ID': deviceId }), 401, 'the replaced token is dead')
  const { ws: widenedSocket } = await connectToken(instance, widened.token, deviceId)
  const sent = await request(widenedSocket, { type: 'message', sessionId: 's1', text: 'hi', clientMsgId: 'repair-2' })
  assert.equal(sent.kind, OP_RESPONSES.message, JSON.stringify(sent))

  // Narrow again: a live socket must not keep the wider grant it was opened with.
  const widenedClosed = once(widenedSocket, 'close')
  const narrowed = await pairDevice(instance, 'desktop', deviceId, { kind: 'desktop', scopes: ['sessions:read'] })
  assert.deepEqual(narrowed.hello.device.scopes, ['sessions:read'])
  assert.equal((await widenedClosed)[0], CLOSE_CODES.revoked)
  assert.equal(await upgradeAnswer(instance, ['dsh-mobile-v1'],
    { Authorization: `Bearer ${widened.token}`, 'X-DSH-Device-ID': deviceId }), 401)
  const { ws: narrowedSocket } = await connectToken(instance, narrowed.token, deviceId)
  const refusedAgain = await request(narrowedSocket, { type: 'message', sessionId: 's1', text: 'hi', clientMsgId: 'repair-3' })
  assert.equal(refusedAgain.code, 'auth/forbidden-scope', JSON.stringify(refusedAgain))
})

test('T9: activation after a re-pair or a revoke sends nothing and closes 4401', async (t) => {
  // The window between authentication and activation is normally too narrow to
  // hit from a test, so the gateway's test-only `testActivationHold` hook holds
  // it open: activation waits for the gate, the test re-pairs or revokes, then
  // releases it. Nothing about the check itself is test-only.
  const holds = []
  const hold = ({ paired }) => {
    if (paired) return undefined                   // pairing sockets activate at once
    const gate = Promise.withResolvers()
    holds.push(gate)
    return gate.promise
  }
  const instance = await factory(t, { testActivationHold: hold })
  const waitForHold = async (index) => {
    for (let attempt = 0; attempt < 400 && holds.length <= index; attempt += 1) await delay(5)
    assert.ok(holds.length > index, 'the connection must reach activation')
  }
  const framesOn = (ws) => buffers.get(ws) ?? []
  // A guard that regressed would leave the socket open instead of closing it, so
  // the wait is bounded: the test fails with the reason instead of hanging.
  const closingCode = (ws, timeoutMs = 5_000) => new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve('closed'); return }
    const timer = setTimeout(() => {
      ws.off('close', onClose)
      reject(new Error(`the socket was never closed (readyState=${ws.readyState}, frames=${JSON.stringify(framesOn(ws).map((frame) => frame.kind))})`))
    }, timeoutMs)
    const onClose = (code) => { clearTimeout(timer); resolve(code) }
    ws.once('close', onClose)
  })
  // `connectToken` would wait for the hello that must never arrive.
  const openWithToken = (token, deviceId) => {
    const ws = openLan(instance, ['dsh-mobile-v1'], { Authorization: `Bearer ${token}`, 'X-DSH-Device-ID': deviceId })
    recordFrames(ws)
    return ws
  }

  // (a) re-pair while the channel is authenticating
  const deviceId = 'delayed0-0000-4000-8000-000000000001'
  const first = await pairDevice(instance, 'desktop', deviceId, { kind: 'desktop', scopes: ['sessions:read'] })
  const stale = openWithToken(first.token, deviceId)
  await once(stale, 'open')
  await waitForHold(0)
  const staleClosing = closingCode(stale)
  // The same installation pairs again: the token and the grant are replaced. The
  // re-pair sweep closes registered sockets only, so this one is left to
  // activation — where it must be refused rather than served the old grant.
  const repaired = await pairDevice(instance, 'desktop', deviceId,
    { kind: 'desktop', scopes: ['sessions:read', 'prompt:send'] })
  assert.equal(repaired.device.id, first.device.id, 'the same device row is reused')
  holds[0].resolve()
  assert.equal(await staleClosing, CLOSE_CODES.revoked)
  assert.deepEqual(framesOn(stale), [], 'a channel re-paired under it receives nothing, not even the hello')
  assert.equal(await upgradeAnswer(instance, ['dsh-mobile-v1'],
    { Authorization: `Bearer ${first.token}`, 'X-DSH-Device-ID': deviceId }), 401, 'the replaced token is dead')

  // (b) revocation while the channel is authenticating
  const revokedId = 'delayed0-0000-4000-8000-000000000002'
  const second = await pairDevice(instance, 'desktop', revokedId, { kind: 'desktop' })
  const doomed = openWithToken(second.token, revokedId)
  await once(doomed, 'open')
  await waitForHold(1)
  const doomedClosing = closingCode(doomed)
  assert.equal((await instance.post(`devices/${second.device.id}/revoke`)).status, 200)
  holds[1].resolve()
  assert.equal(await doomedClosing, CLOSE_CODES.revoked)
  assert.deepEqual(framesOn(doomed), [], 'a channel revoked under it receives nothing, not even the hello')
})
