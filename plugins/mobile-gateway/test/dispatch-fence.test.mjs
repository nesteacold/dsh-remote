// Reviewer regression suite for the two dispatch fences of the companion
// channel (both are contract rules, not new vocabulary):
//
//  B  contract §1: every companion request carries a `requestId` bounded to
//     64 characters from [A-Za-z0-9._-], and one id may not be in flight
//     twice. One pre-dispatch validator; a bad frame answers `bad-request` and
//     changes no state and makes no Host call.
//  C  contract §3.6/§5a: the client is ready only after the `client-hello`
//     exchange is acknowledged. Before that only `client-hello` and the
//     keep-alive `ping` may run; everything else is refused with no Host call.
//     The version-mismatch socket closes ~20 ms later, so without the fence
//     operations could dispatch inside that window.
//
// The suite runs the real `apply()` against a fake Host whose `session/list`
// can be held open (deterministic "in flight") and which records every Host
// call, so "no Host call" is measured rather than assumed.
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DEV_A = 'fence0000-0000-4000-8000-00000000000a'
const DEV_B = 'fence0000-0000-4000-8000-00000000000b'

async function factory(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fence-'))
  const sockets = []
  const hostCalls = []
  let management
  let upgrade
  let dispose = () => {}
  // `gate` holds one `session/list` open so a test can observe a request that is
  // genuinely in flight; `sessionList` is what every list answers.
  const state = { gate: null, sessionList: ['s1', 's2'] }
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) { management.handler(req, res); return }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  // WHATWG fetch refuses a few "bad ports"; the helper re-binds until the
  // ephemeral port is one `fetch` accepts (test/support/fetch-safe-listen.mjs).
  await listenFetchSafe(server)
  const port = server.address().port
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => {} },
      registerUpgrade(route) { upgrade = route; return () => {} },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke(request) {
        hostCalls.push(`${request.namespace}/${request.method}`)
        if (request.namespace === 'session' && request.method === 'list') {
          const gate = state.gate
          if (gate) {
            state.gate = null
            gate.started = true
            await new Promise((resolve) => { gate.release = resolve })
          }
          return { items: state.sessionList.map((sessionId) => ({ sessionId })) }
        }
        if (request.namespace === 'session' && request.method === 'search') return { items: [], hasMore: false }
        if (request.namespace === 'workspace' && request.method === 'list') return { items: [] }
        return {}
      },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'workspace') {
            yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
          } else {
            yield { type: 'baseline', value: { projections: {} } }
          }
          while (!request.signal.aborted) await delay(10)
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(fn) { dispose = fn() },
  }
  await plugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: `fence-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    requireHostApproval: false,
    ...(options.config ?? {}),
  })
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    try { dispose() } catch { /* already disposed */ }
    state.gate?.release?.()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    ctx, state, hostCalls, port,
    base: `http://127.0.0.1:${port}`,
    async post(route, body) {
      const response = await fetch(`${instance.base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: instance.base }, body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    track(socket) { sockets.push(socket); return socket },
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await (await fetch(`${instance.base}/mgw/status`)).json()
    if (status.lan?.listening && status.lan.urls.length > 0) {
      instance.lanUrl = status.lan.urls[0]
      instance.lanPin = status.lan.certSha256
      return instance
    }
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

const frames = new WeakMap()
function record(ws) {
  const seen = []
  frames.set(ws, seen)
  ws.on('message', (data) => { try { seen.push(JSON.parse(data.toString())) } catch { /* not ours */ } })
  ws.on('error', () => {})
  return seen
}
const seenOf = (ws) => frames.get(ws) ?? record(ws)
async function take(ws, predicate, timeoutMs = 5_000) {
  const seen = seenOf(ws)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const frame = seen.find((candidate, index) => predicate(candidate, index))
    if (frame) return frame
    await delay(5)
  }
  throw new Error(`timed out waiting for a frame (${seen.map((frame) => `${frame.kind}${frame.code ? `:${frame.code}` : ''}`).join(', ')})`)
}
async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10) }
  assert.fail(message)
}
const open = (instance, protocols, headers = {}) => instance.track(new WebSocket(instance.lanUrl, protocols, {
  headers: { 'X-DSH-Cert-SHA256': instance.lanPin, ...headers }, origin: undefined, rejectUnauthorized: false,
}))
async function pairDevice(instance, deviceId, offer = {}) {
  const created = await instance.post('pair', { name: deviceId, publicUrl: instance.lanUrl, ...offer })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ws = open(instance, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], { 'X-DSH-Device-ID': deviceId })
  record(ws)
  await once(ws, 'open')
  const paired = await take(ws, (frame) => frame.kind === 'paired')
  await take(ws, (frame) => frame.kind === 'hello')
  instance.track(ws)
  return { ws, token: paired.token, device: paired.device }
}
async function connectToken(instance, token, deviceId, channel = 'control') {
  const ws = open(instance, ['dsh-mobile-v1'], { Authorization: `Bearer ${token}`, 'X-DSH-Device-ID': deviceId, 'X-DSH-Channel': channel })
  record(ws)
  await once(ws, 'open')
  await take(ws, (frame) => frame.kind === 'hello')
  return ws
}
/** The contract exchange; only after its ack may operations run. */
async function negotiate(ws, overrides = {}) {
  const requestId = `hello-${Math.random().toString(36).slice(2, 10)}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: '1.0.0', platform: 'ios', ...overrides }))
  return take(ws, (frame) => (frame.kind === 'client-hello' || frame.kind === 'error') && frame.requestId === requestId)
}
// Every request id used below stays inside the contract charset, and the
// fixtures use unique ids so the in-flight set never interferes across cases.
let seq = 0
const nextId = (label) => `${label}-${++seq}`

// ---------------------------------------------------------------------------
// B: requestId fence (contract §1)
// ---------------------------------------------------------------------------

test('B1: a companion request without requestId is refused with bad-request and never reaches the Host', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DEV_A)
  const ws = await connectToken(instance, layout.token, DEV_A)
  await negotiate(ws)
  await waitFor(() => instance.hostCalls.length >= 0, 'settled')
  await delay(50)
  const baseline = instance.hostCalls.length
  ws.send(JSON.stringify({ type: 'sessions' }))
  const refused = await take(ws, (frame) => frame.kind === 'error' && frame.requestType === 'sessions')
  assert.equal(refused.code, 'bad-request')
  assert.match(refused.message, /requestId is required/)
  assert.equal('requestId' in refused, false, 'an absent id is not echoed')
  await delay(100)
  assert.equal(instance.hostCalls.length, baseline, `a fenced frame must not reach the Host: ${instance.hostCalls.slice(baseline)}`)
})

test('B2: a non-string requestId is refused with bad-request', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DEV_A)
  const ws = await connectToken(instance, layout.token, DEV_A)
  await negotiate(ws)
  const baseline = instance.hostCalls.length
  ws.send(JSON.stringify({ type: 'sessions', requestId: 7 }))
  const refused = await take(ws, (frame) => frame.kind === 'error' && frame.requestType === 'sessions')
  assert.equal(refused.code, 'bad-request')
  assert.equal('requestId' in refused, false)
  assert.equal(instance.hostCalls.length, baseline)
})

test('B3: a requestId longer than 64 characters is refused and is not echoed', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DEV_A)
  const ws = await connectToken(instance, layout.token, DEV_A)
  await negotiate(ws)
  const baseline = instance.hostCalls.length
  ws.send(JSON.stringify({ type: 'sessions', requestId: 'a'.repeat(65) }))
  const refused = await take(ws, (frame) => frame.kind === 'error' && frame.requestType === 'sessions')
  assert.equal(refused.code, 'bad-request')
  assert.equal('requestId' in refused, false, 'an out-of-bounds id is never echoed back')
  assert.equal(instance.hostCalls.length, baseline)
})

test('B4: a requestId outside the safe charset (control characters, space, slash) is refused', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DEV_A)
  const ws = await connectToken(instance, layout.token, DEV_A)
  await negotiate(ws)
  const baseline = instance.hostCalls.length
  const seen = seenOf(ws)
  for (const id of ['ctrl\u0001id', 'has space', 'slash/id', 'quote"id', 'unicode-é']) {
    // Consume only frames that arrive AFTER this send: `take()` searches the whole
    // accumulated buffer, so without a cursor every iteration could re-assert the
    // first refusal and the remaining ids would never be proven independently.
    const from = seen.length
    ws.send(JSON.stringify({ type: 'sessions', requestId: id }))
    const refused = await take(ws, (frame, index) => index >= from && frame.kind === 'error' && frame.requestType === 'sessions' && frame.message?.includes('requestId'))
    assert.equal(refused.code, 'bad-request', JSON.stringify(id))
    // Contract §1: only a VALID id is echoed. A malformed one must not be reflected:
    // it cannot be attributed by the client and reflecting control characters or
    // Unicode is itself a framing defect.
    assert.equal('requestId' in refused, false, `a malformed id is never echoed back: ${JSON.stringify(id)}`)
  }
  assert.equal(instance.hostCalls.length, baseline)
})

test('B5: a duplicate in-flight requestId is refused deterministically and the first request still settles once', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DEV_A)
  const ws = await connectToken(instance, layout.token, DEV_A)
  await negotiate(ws)
  const id = nextId('dup')
  const gate = { started: false, release: null }
  instance.state.gate = gate
  ws.send(JSON.stringify({ type: 'sessions', requestId: id }))
  await waitFor(() => gate.started, 'the first request must be in flight at the Host')
  ws.send(JSON.stringify({ type: 'sessions', requestId: id }))
  const refused = await take(ws, (frame) => frame.kind === 'error' && frame.requestId === id)
  assert.equal(refused.code, 'bad-request')
  assert.match(refused.message, /already in flight/)
  gate.release()
  const reply = await take(ws, (frame) => frame.kind === 'sessions' && frame.requestId === id)
  assert.ok(Array.isArray(reply.items), 'the original request is answered exactly once')
  // The id is released when the request settles: a later frame may reuse it.
  ws.send(JSON.stringify({ type: 'sessions', requestId: id }))
  assert.ok(await take(ws, (frame) => frame.kind === 'sessions' && frame.requestId === id && frame !== reply))
})

test('B6: a valid requestId still works and is echoed by the reply', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DEV_A)
  const ws = await connectToken(instance, layout.token, DEV_A)
  await negotiate(ws)
  const id = 'ok-1_2.3'
  ws.send(JSON.stringify({ type: 'sessions', requestId: id }))
  const reply = await take(ws, (frame) => frame.kind === 'sessions')
  assert.equal(reply.requestId, id)
})

test('B7: server pushes carry no requestId, so the fence never applies to them', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DEV_A)
  const ws = await connectToken(instance, layout.token, DEV_A)
  await negotiate(ws)
  const hello = seenOf(ws).find((frame) => frame.kind === 'hello')
  assert.ok(hello, 'the hello push was delivered')
  assert.equal('requestId' in hello, false, 'a push frame carries no requestId')
  const baseline = seenOf(ws).length
  ws.send(JSON.stringify({ type: 'ping', requestId: nextId('keepalive') }))
  await take(ws, (frame) => frame.kind === 'pong')
  assert.ok(seenOf(ws).length >= baseline + 1)
})

// ---------------------------------------------------------------------------
// C: pre-negotiation gate (contract §3.6/§5a)
// ---------------------------------------------------------------------------

test('C1: operations are refused before client-hello is acknowledged, then work after it', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DEV_A)
  const ws = await connectToken(instance, layout.token, DEV_A)
  const baseline = instance.hostCalls.length
  const id = nextId('early')
  ws.send(JSON.stringify({ type: 'sessions', requestId: id }))
  const refused = await take(ws, (frame) => frame.kind === 'error' && frame.requestId === id)
  assert.equal(refused.code, 'bad-request')
  assert.match(refused.message, /client-hello must be accepted/)
  await delay(100)
  assert.equal(instance.hostCalls.length, baseline, 'a pre-negotiation op must not reach the Host')
  const ack = await negotiate(ws)
  assert.equal(ack.kind, 'client-hello')
  assert.equal(ack.accepted, true)
  ws.send(JSON.stringify({ type: 'sessions', requestId: nextId('after') }))
  const reply = await take(ws, (frame) => frame.kind === 'sessions')
  assert.ok(Array.isArray(reply.items))
})

test('C2: ping is keep-alive and is served before negotiation', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DEV_A)
  const ws = await connectToken(instance, layout.token, DEV_A)
  const id = nextId('ping')
  ws.send(JSON.stringify({ type: 'ping', requestId: id }))
  const pong = await take(ws, (frame) => frame.kind === 'pong')
  assert.equal(pong.requestId, id)
})

test('C3: a failed negotiation leaves the ~20 ms close window without a dispatch path', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DEV_A)
  const ws = await connectToken(instance, layout.token, DEV_A)
  const closed = once(ws, 'close')
  const baseline = instance.hostCalls.length
  // Mismatch refuses and closes 20 ms later; an operation sent in that window
  // must be refused, not dispatched.
  ws.send(JSON.stringify({ type: 'client-hello', requestId: nextId('mismatch'), companionProtocol: 0 }))
  const id = nextId('window')
  ws.send(JSON.stringify({ type: 'sessions', requestId: id }))
  const refused = await take(ws, (frame) => frame.kind === 'error' && frame.requestId === id)
  assert.equal(refused.code, 'bad-request')
  assert.match(refused.message, /client-hello must be accepted/)
  const protocolError = await take(ws, (frame) => frame.kind === 'error' && frame.code === 'protocol/unsupported')
  assert.equal(protocolError.requestType, 'client-hello')
  assert.equal((await closed)[0], 4003)
  await delay(50)
  assert.equal(instance.hostCalls.length, baseline, 'nothing was dispatched in the closing window')
})

test('C4: framing wins before negotiation, and the rev-3 scope refusal still answers afterwards', async (t) => {
  const instance = await factory(t)
  const layout = await pairDevice(instance, DEV_B, { scopes: ['prompt:send'] })
  const ws = await connectToken(instance, layout.token, DEV_B)
  const baseline = instance.hostCalls.length
  // (1) Not negotiated AND missing sessions:read: contract §3.7 says the framing
  // refusal is unconditional, so the mismatched frame must NOT be answered with a
  // scope-dependent code (and must not echo the id it never validated).
  const unnegotiatedId = nextId('pre')
  ws.send(JSON.stringify({ type: 'sessions', requestId: unnegotiatedId }))
  const early = await take(ws, (frame) => frame.kind === 'error' && frame.requestType === 'sessions')
  assert.equal(early.code, 'bad-request', 'framing precedes scope before negotiation')
  assert.equal(instance.hostCalls.length, baseline)
  // (2) After a successful negotiation the scope gate is unchanged: a well-formed
  // `sessions` request from a device without sessions:read is still refused by scope.
  await negotiate(ws)
  const id = nextId('scope')
  ws.send(JSON.stringify({ type: 'sessions', requestId: id }))
  const refused = await take(ws, (frame) => frame.kind === 'error' && frame.requestId === id)
  assert.equal(refused.code, 'auth/forbidden-scope')
  assert.equal(instance.hostCalls.length, baseline)
})

test('C5: the owner/admin channel is not negotiated and keeps working (loopback/admin path)', async (t) => {
  const instance = await factory(t, { config: { legacyAdmin: true } })
  const layout = await pairDevice(instance, DEV_A)
  const ws = await connectToken(instance, layout.token, DEV_A)
  // The test-only admin marker on a device-token socket is the owner/admin
  // surface; it is not a companion peer and keeps the upstream semantics
  // (no client-hello, upstream ops served by the owner Peer).
  ws.send(JSON.stringify({ type: 'workspaces', legacyAdmin: true }))
  const reply = await take(ws, (frame) => frame.kind === 'workspaces' || (frame.kind === 'error' && frame.requestType === 'workspaces'))
  assert.equal(reply.kind, 'workspaces', JSON.stringify(reply).slice(0, 300))
})

// ---------------------------------------------------------------------------
// D: refusal echoes (contract §1) — no refusal reflects a malformed requestId
// ---------------------------------------------------------------------------

test('D1: the op/forbidden refusal never echoes a malformed requestId and still echoes a valid one', async (t) => {
  const instance = await factory(t)
  // `plugin-catalog` is not a companion-v1 op, so the dispatcher's op/forbidden
  // branch answers it — BEFORE the framing fence, which is exactly why that
  // branch has to validate the id it would reflect. (Spec 011: `workspaces` used
  // to play this part, but it is a SCOPED op now, so the fence answers it first.)
  const layout = await pairDevice(instance, DEV_A, { scopes: [] })
  const ws = await connectToken(instance, layout.token, DEV_A)
  await negotiate(ws)
  const seen = seenOf(ws)
  for (const id of ['ctrl\u0001id', 'a'.repeat(65), 'has space', 'unicode-é']) {
    // Only frames that arrive AFTER this send (the buffer is shared).
    const from = seen.length
    ws.send(JSON.stringify({ type: 'plugin-catalog', requestId: id }))
    const refused = await take(ws, (frame, index) => index >= from && frame.kind === 'error' && frame.code === 'op/forbidden')
    assert.equal(refused.requestType, 'plugin-catalog')
    assert.equal('requestId' in refused, false, `a malformed id must not be reflected: ${JSON.stringify(id)}`)
  }
  // The branch itself is unchanged for a well-formed id (no over-narrowing).
  ws.send(JSON.stringify({ type: 'plugin-catalog', requestId: 'ok-1_2.3' }))
  const echoed = await take(ws, (frame) => frame.kind === 'error' && frame.code === 'op/forbidden' && frame.requestId === 'ok-1_2.3')
  assert.equal(echoed.requestType, 'plugin-catalog')
})

// The remaining pre-fence refusals (remote-control disabled, the auth/required
// backstops, a stale device generation, the bridge's auth/revoked) now take their
// echo from the same `requestIdEcho` predicate. They cannot be driven from a
// well-behaved client: switching the owner switch off or re-pairing/revoking
// closes the socket (4004/4401) before another frame can be sent, so a wire test
// of those branches would be a race, not a proof.

// ---------------------------------------------------------------------------
// P: pairing offer TTL (contract §2)
// ---------------------------------------------------------------------------

test('P1: a config above the contract window cannot mint a longer pairing offer', async (t) => {
  const instance = await factory(t, { config: { pairingTtlMs: 900_000 } })
  const created = await instance.post('pair', { name: 'ttl', publicUrl: instance.lanUrl })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ttl = created.data.payload.expiresAt - Date.now()
  assert.ok(ttl > 0 && ttl <= 300_000, `a 900000 TTL must still offer at most 300000ms, got ${ttl}`)
  const status = await (await fetch(`${instance.base}/mgw/status`)).json()
  assert.equal(status.pairingTtlMs, 300_000, 'status reports the TTL actually in force')
})

test('P2: the normal five-minute TTL is offered unchanged', async (t) => {
  const instance = await factory(t, { config: { pairingTtlMs: 300_000 } })
  const created = await instance.post('pair', { name: 'ttl', publicUrl: instance.lanUrl })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ttl = created.data.payload.expiresAt - Date.now()
  assert.ok(ttl > 290_000 && ttl <= 300_000, `300000 must be offered unchanged, got ${ttl}`)
})
