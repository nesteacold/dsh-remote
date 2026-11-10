// Reviewer 36d9 regression suite for the per-device live authorization added on
// top of T022a. Runs the plugin's real `apply()` with a fake Host whose
// `session/list` is fully controllable, and checks WHAT each socket is sent:
//
//  R1  visible-session refresh: bounded (timeout/abort), coalesced (at most one
//      in flight + one pending), cancelled on teardown, a failure keeps the last
//      good snapshot;
//  R2  versioned refresh/tombstone: a stale in-flight response cannot bring back
//      a session the Host just removed; the tombstone goes only with an accepted
//      newer snapshot;
//  R3  metadata broadcasts + initial archive/queue/projection baselines are
//      reduced per recipient (live sessions:read + the device's visible sessions);
//      the loopback admin (`legacyAdmin`) is unchanged; no scope => nothing;
//  R4  approval pushes AND replay (incl. the conversation-triggered fan-out) need
//      a live approval:respond plus the session; a subscription filter is not an
//      authorization; a re-paired/revoked generation gets nothing;
//  R5  questions are the ADMIN channel's alone: the protocol gives them no
//      device scope and `question-answer` is ADMIN_ONLY, so NO device principal
//      receives a question push or a replay (whole-gateway review 2026-11-10;
//      the 008 bridge reaches the same question separately over `$events`, which
//      this suite does not exercise). A withheld card is audited by ids only.
//  R6  the raw `session/event` fan-out (an unsubscribed legacy/conversation
//      socket) takes the same per-recipient decision as every other session-keyed
//      frame: live credential + `sessions:read` + a visible session; and a device
//      may not subscribe its filter to a session the Host never listed to it.
//
// Fake Host only; the real-service proof lives in device-access-real.test.mjs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

import WebSocket from 'ws'
import plugin from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { COMPANION_PRINCIPAL_KIND } from '../lib/companion-access.mjs'
import { devicePrincipal } from '../lib/device-peers.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DEV_A = 'authz0000-0000-4000-8000-00000000000a'
const DEV_B = 'authz0000-0000-4000-8000-00000000000b'
// WHATWG fetch refuses a few "bad ports"; re-listen until the ephemeral port is usable.
const FETCH_BAD_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080])

async function factory(t, options = {}) {
  const remoteAccess = createTestRemoteAccess()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-36d9-'))
  const listeners = {}
  const sockets = []
  const listCalls = []
  // `sessionList` is what the Host answers; tests swap it. `listGate` lets a test
  // hold a `session/list` open (and observe its AbortSignal).
  const state = { sessionList: ['s1', 's2'], listGate: null, archives: [], projections: {}, queuesInbox: {} }
  let management
  let upgrade
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) { management.handler(req, res); return }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  for (;;) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    if (!FETCH_BAD_PORTS.has(server.address().port)) break
    await new Promise((resolve) => server.close(resolve))
  }
  const port = server.address().port
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => {} },
      registerUpgrade(route) { upgrade = route; return () => {} },
    },
    connection: createTestConnection(),
    remoteAccess,
    typertGateway: {
      async invoke(request) {
        if (request.namespace === 'session' && request.method === 'list') {
          const call = { signal: request.signal, aborted: false }
          listCalls.push(call)
          request.signal?.addEventListener('abort', () => { call.aborted = true }, { once: true })
          if (state.listGate) {
            await new Promise((resolve, reject) => {
              state.listGate.release = resolve
              request.signal?.addEventListener('abort', () => reject(request.signal.reason ?? new Error('aborted')), { once: true })
            })
          }
          if (state.listError) throw new Error(state.listError)
          call.answered = [...state.sessionList]
          return { items: call.answered.map((sessionId) => ({ sessionId })) }
        }
        if (request.namespace === 'session' && request.method === 'search') return { items: [], hasMore: false }
        return {}
      },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'workspace') {
            yield { type: 'baseline', value: { items: [], archivedSessionIds: state.archives } }
          } else if (request.namespace === 'session' && request.method === 'control') {
            yield { type: 'baseline', value: { projections: state.projections } }
          } else {
            yield { type: 'baseline', value: { projections: {} } }
          }
          while (!request.signal.aborted) await delay(10)
        })()
      },
    },
    agentDefaultModel: {},
    on(name, handler) { listeners[name] = handler; return () => {} },
    effect(fn) { dispose = fn() },
  }
  const start = () => plugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: `36d9-${port}`,
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
    state.listGate?.release?.()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    ctx, listeners, start, port, state, listCalls, remoteAccess, connection: ctx.connection,
    base: `http://127.0.0.1:${port}`,
    teardown() { dispose(); dispose = () => {} },
    async post(route, body) {
      const response = await fetch(`${instance.base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: instance.base }, body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    track(socket) { sockets.push(socket); return socket },
  }
  return instance
}

async function ready(instance) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await (await fetch(`${instance.base}/mgw/status`)).json()
    if (status.lan?.listening && status.lan.urls.length > 0) { instance.lanUrl = status.lan.urls[0]; instance.lanPin = status.lan.certSha256; return }
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
  while (Date.now() < deadline) { const frame = seen.find(predicate); if (frame) return frame; await delay(5) }
  throw new Error(`timed out waiting for a frame (${seen.map((frame) => frame.kind).join(', ')})`)
}
let counter = 0
/** Everything the server sent before this round trip has been delivered when it resolves. */
async function flush(ws) {
  const requestId = `flush-${++counter}`
  ws.send(JSON.stringify({ type: 'ping', requestId }))
  await take(ws, (frame) => frame.requestId === requestId)
}
const open = (instance, protocols, headers = {}) => instance.track(new WebSocket(instance.lanUrl, protocols, {
  headers: { 'X-DSH-Cert-SHA256': instance.lanPin, ...headers }, origin: undefined, rejectUnauthorized: false,
}))
/** Contract §3.6/§5a: operations wait for the acknowledged client-hello. */
async function negotiate(ws) {
  const requestId = `hello-${++counter}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test', platform: 'ios' }))
  await take(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === requestId)
}
async function pairDevice(instance, deviceId, offer = {}) {
  const created = await instance.post('pair', { name: deviceId, publicUrl: instance.lanUrl, ...offer })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ws = open(instance, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], { 'X-DSH-Device-ID': deviceId })
  record(ws)
  await once(ws, 'open')
  const paired = await take(ws, (frame) => frame.kind === 'paired')
  await take(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return { ws, token: paired.token, device: paired.device }
}
async function connectToken(instance, token, deviceId, channel = 'control') {
  const ws = open(instance, ['dsh-mobile-v1'], { Authorization: `Bearer ${token}`, 'X-DSH-Device-ID': deviceId, 'X-DSH-Channel': channel })
  record(ws)
  await once(ws, 'open')
  await take(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return ws
}
async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10) }
  assert.fail(message)
}
const visibleIds = (instance, deviceId) => instance.remoteAccess.policies.get(COMPANION_PRINCIPAL_KIND)
  .bindings(devicePrincipal(deviceId)).filter((binding) => binding.resource.kind === 'session').map((binding) => binding.resource.id).sort()
const toolCall = (instance, sessionId, callId) => instance.listeners['session/event']({ id: sessionId }, {
  type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 0, callId, name: 'bash', arguments: '{"command":"ls"}' },
})
const requestApproval = (instance, sessionId, callId, next) => instance.listeners['approval/request']({
  agent: { id: sessionId }, toolName: 'bash', callId, reason: '36d9', signal: new AbortController().signal,
}, next)
const emitEvent = (instance, sessionId, text) => instance.listeners['session/event']({ id: sessionId }, {
  type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
})
const requestQuestion = (instance, sessionId, next) => instance.listeners['user-questions/request']({
  agent: { id: sessionId }, signal: new AbortController().signal,
  questions: [{ id: 'q', question: 'pick', options: [{ label: 'a' }, { label: 'b' }] }],
}, next)

// ---------------------------------------------------------------------------
// R1 / R2: visible-session refresh
// ---------------------------------------------------------------------------

test('R1a: refresh is bounded: a hung session/list is aborted by the timeout and the last good list survives', async (t) => {
  const instance = await factory(t, { config: { testVisibleRefreshTimeoutMs: 150 } })
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEV_A)
  await waitFor(() => visibleIds(instance, layout.device.id).length === 2, 'initial snapshot')
  const call = { n: instance.listCalls.length }
  instance.state.listGate = {} // every further session/list hangs
  instance.state.sessionList = ['s1', 's2', 's9']
  instance.listeners['api-session/added']({ sessionId: 's9', running: false })
  await waitFor(() => instance.listCalls.length > call.n, 'a refresh was started')
  const hung = instance.listCalls.at(-1)
  await waitFor(() => hung.aborted, 'the hung refresh is aborted by its timeout (bounded)')
  assert.deepEqual(visibleIds(instance, layout.device.id), ['s1', 's2'], 'a timed-out refresh keeps the last good list and adds nothing')
  // and the next refresh is allowed again (the in-flight slot was released)
  instance.state.listGate = null
  instance.listeners['api-session/added']({ sessionId: 's9', running: false })
  await waitFor(() => visibleIds(instance, layout.device.id).includes('s9'), 'a later refresh recovers')
})

test('R1b: refreshes are coalesced: at most one in flight plus one pending, however many events arrive', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEV_A)
  await waitFor(() => visibleIds(instance, layout.device.id).length === 2, 'initial snapshot')
  const before = instance.listCalls.length
  instance.state.listGate = {}
  instance.listeners['api-session/added']({ sessionId: 'x1', running: false })
  await waitFor(() => instance.listCalls.length === before + 1, 'first refresh in flight')
  for (let i = 0; i < 25; i += 1) instance.listeners['api-session/added']({ sessionId: `x${i + 2}`, running: false })
  await delay(100)
  assert.equal(instance.listCalls.length, before + 1, '25 further events do not start further session/list calls while one is in flight')
  const gate = instance.state.listGate
  instance.state.listGate = null
  gate.release()
  await waitFor(() => instance.listCalls.length === before + 2, 'exactly one more refresh ran for the burst')
  await delay(100)
  assert.equal(instance.listCalls.length, before + 2, 'the burst collapsed into ONE pending refresh, not 25')
})

test('R1c: teardown cancels the in-flight refresh and starts no further one', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEV_A)
  await waitFor(() => visibleIds(instance, layout.device.id).length === 2, 'initial snapshot')
  const before = instance.listCalls.length
  instance.state.listGate = {}
  instance.listeners['api-session/added']({ sessionId: 'x1', running: false })
  instance.listeners['api-session/added']({ sessionId: 'x2', running: false }) // pending
  await waitFor(() => instance.listCalls.length === before + 1, 'refresh in flight')
  const hung = instance.listCalls.at(-1)
  instance.teardown()
  await waitFor(() => hung.aborted, 'teardown aborts the in-flight session/list')
  instance.state.listGate = null
  await delay(150)
  assert.equal(instance.listCalls.length, before + 1, 'the pending refresh does not run after teardown')
})

test('R2a: a stale in-flight session/list cannot re-add a session removed meanwhile', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEV_A)
  await waitFor(() => visibleIds(instance, layout.device.id).length === 2, 'initial snapshot')
  const before = instance.listCalls.length
  instance.state.listGate = {}
  instance.listeners['api-session/added']({ sessionId: 's3', running: false })
  await waitFor(() => instance.listCalls.length === before + 1, 'refresh in flight (its answer still lists s2)')
  const gate = instance.state.listGate
  instance.listeners['api-session/removed']('s2')
  assert.deepEqual(visibleIds(instance, layout.device.id), ['s1'], 'removal is immediate')
  // The in-flight answer was produced BEFORE the removal and still lists s2
  // (`call.answered` is taken when the gate opens, so set the stale list first).
  instance.state.sessionList = ['s1', 's2', 's3']
  // Freeze the follow-up refresh so the state right after the STALE answer is observable.
  const followUpGate = {}
  const firstGate = gate
  instance.state.listGate = followUpGate
  firstGate.release()
  await waitFor(() => instance.listCalls[before].answered, 'the stale answer was delivered')
  assert.deepEqual(instance.listCalls[before].answered, ['s1', 's2', 's3'])
  await waitFor(() => instance.listCalls.length >= before + 2, 'the follow-up refresh started (and is held)')
  assert.ok(!visibleIds(instance, layout.device.id).includes('s2'),
    'right after the stale answer s2 is still absent: ' + visibleIds(instance, layout.device.id))
  // Then the Host answers the follow-up without s2.
  instance.state.sessionList = ['s1', 's3']
  instance.state.listGate = null
  followUpGate.release()
  await waitFor(() => instance.listCalls.at(-1).answered, 'the follow-up answered')
  await delay(50)
  assert.deepEqual(visibleIds(instance, layout.device.id), ['s1', 's3'])
})

test('R2b: a stale answer is ignored for the removed id even if every later refresh fails; tombstone cleared only by an accepted snapshot', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEV_A)
  await waitFor(() => visibleIds(instance, layout.device.id).length === 2, 'initial snapshot')
  const before = instance.listCalls.length
  instance.state.listGate = {}
  instance.listeners['api-session/added']({ sessionId: 's3', running: false })
  await waitFor(() => instance.listCalls.length === before + 1, 'refresh in flight')
  const gate = instance.state.listGate
  instance.listeners['api-session/removed']('s2')
  instance.state.listGate = null
  instance.state.listError = 'host unavailable' // the follow-up refresh fails
  gate.release() // the stale answer ([s1,s2]) arrives now
  await waitFor(() => instance.listCalls.length >= before + 2, 'follow-up refresh attempted (and failed)')
  await delay(50)
  assert.ok(!visibleIds(instance, layout.device.id).includes('s2'), 'the stale answer alone cannot restore the removed session')
  // A later ACCEPTED snapshot that started after the removal is authoritative again.
  instance.state.listError = null
  instance.state.sessionList = ['s1', 's2']
  instance.listeners['api-session/added']({ sessionId: 's2', running: false })
  await waitFor(() => visibleIds(instance, layout.device.id).includes('s2'), 'an accepted newer snapshot may list s2 again (the Host re-created it)')
})

// ---------------------------------------------------------------------------
// R3: metadata + baselines per recipient
// ---------------------------------------------------------------------------

test('R3a: metadata broadcasts reach only devices with live sessions:read and the session visible; admin is unchanged', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const reader = await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] })
  const blind = await pairDevice(instance, DEV_B, { scopes: ['prompt:send'] }) // no sessions:read
  const readerWs = await connectToken(instance, reader.token, DEV_A)
  const blindWs = await connectToken(instance, blind.token, DEV_B)
  await waitFor(() => visibleIds(instance, reader.device.id).length === 2, 'snapshot')
  instance.listeners['api-session/status']('s1', true)
  instance.listeners['api-session/status']('not-listed', true)
  instance.listeners['schedule/changed']()
  await flush(readerWs); await flush(blindWs)
  const statuses = (ws) => seenOf(ws).filter((frame) => frame.kind === 'session-status').map((frame) => frame.sessionId)
  assert.deepEqual(statuses(readerWs), ['s1'], 'only the visible session reaches the reader')
  assert.deepEqual(statuses(blindWs), [], 'a device without sessions:read gets no session metadata')
  assert.equal(seenOf(readerWs).some((frame) => frame.kind === 'schedule-changed'), false, 'owner-management notifications never reach a device')
})

test('R3b: initial baselines are reduced to the recipient\'s visible sessions; empty scopes get nothing', async (t) => {
  const instance = await factory(t)
  instance.state.archives = ['s1', 's2', 'hidden']
  instance.state.projections = {
    s1: { asOfSeq: 1, values: { goal: { text: 'g1' } } },
    hidden: { asOfSeq: 1, values: { goal: { text: 'secret' } } },
  }
  await instance.start(); await ready(instance)
  const reader = await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] })
  const blind = await pairDevice(instance, DEV_B, { scopes: ['prompt:send'] })
  await waitFor(() => visibleIds(instance, reader.device.id).length === 2, 'snapshot')
  const readerWs = await connectToken(instance, reader.token, DEV_A)
  const blindWs = await connectToken(instance, blind.token, DEV_B)
  await flush(readerWs); await flush(blindWs)
  const archives = seenOf(readerWs).find((frame) => frame.kind === 'session-archives')
  assert.deepEqual(archives?.archivedSessionIds, ['s1', 's2'], 'the hidden session id is not in the archive baseline')
  const projection = seenOf(readerWs).find((frame) => frame.kind === 'projection-baseline')
  assert.deepEqual(Object.keys(projection?.projections ?? {}), ['s1'], 'the hidden session is not in the projection baseline')
  assert.equal(JSON.stringify(seenOf(readerWs)).includes('secret'), false, 'hidden-session data never reaches the reader')
  for (const kind of ['session-archives', 'session-queues', 'projection-baseline']) {
    assert.equal(seenOf(blindWs).some((frame) => frame.kind === kind), false, `a device without sessions:read gets no ${kind}`)
  }
})

test('R3c: the loopback admin keeps the full baselines and metadata', async (t) => {
  const instance = await factory(t, { config: { legacyAdmin: true } })
  instance.state.archives = ['s1', 'hidden']
  instance.state.projections = { hidden: { asOfSeq: 1, values: { goal: { text: 'secret' } } } }
  await instance.start(); await ready(instance)
  const admin = await pairDevice(instance, DEV_A, { scopes: [] })
  const adminWs = await connectToken(instance, admin.token, DEV_A) // legacyAdmin test socket = admin channel
  await flush(adminWs)
  assert.deepEqual(seenOf(adminWs).find((frame) => frame.kind === 'session-archives')?.archivedSessionIds, ['s1', 'hidden'])
  assert.ok(Object.hasOwn(seenOf(adminWs).find((frame) => frame.kind === 'projection-baseline').projections, 'hidden'))
  instance.listeners['schedule/changed']()
  await take(adminWs, (frame) => frame.kind === 'schedule-changed')
})

test('R3d: a live broadcast after a scope-narrowing re-pair reaches nobody who lost sessions:read', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const first = await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] })
  const ws = await connectToken(instance, first.token, DEV_A)
  await waitFor(() => visibleIds(instance, first.device.id).length === 2, 'snapshot')
  const closed = once(ws, 'close')
  await pairDevice(instance, DEV_A, { scopes: [] }) // re-pair with no scopes: generation bumped
  await closed
  instance.listeners['api-session/status']('s1', true)
  await delay(100)
  assert.equal(seenOf(ws).some((frame) => frame.kind === 'session-status'), false, 'the stale generation gets nothing')
})

// ---------------------------------------------------------------------------
// R4: approvals (push + replay)
// ---------------------------------------------------------------------------

test('R4a: an approval push needs live approval:respond AND the session; subscription filters are not authorization', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const responder = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond'] })
  const observer = await pairDevice(instance, DEV_B, { scopes: ['sessions:read'] })
  const responderWs = await connectToken(instance, responder.token, DEV_A)
  const observerWs = await connectToken(instance, observer.token, DEV_B)
  await waitFor(() => visibleIds(instance, responder.device.id).length === 2, 'snapshot')
  toolCall(instance, 's1', 'c1'); toolCall(instance, 'hidden-session', 'c2')
  const answer = Promise.withResolvers()
  const p1 = requestApproval(instance, 's1', 'c1', () => answer.promise)
  const p2 = requestApproval(instance, 'hidden-session', 'c2', () => answer.promise)
  await take(responderWs, (frame) => frame.kind === 'approval-requested' && frame.sessionId === 's1')
  await flush(responderWs); await flush(observerWs)
  assert.equal(seenOf(responderWs).some((frame) => frame.kind === 'approval-requested' && frame.sessionId === 'hidden-session'), false,
    'a session the Host never listed to the device gets no card even with approval:respond')
  assert.equal(seenOf(observerWs).some((frame) => frame.kind === 'approval-requested'), false, 'a device without approval:respond gets no card')
  // A subscription to the hidden session is a routing hint, not an authorization.
  responderWs.send(JSON.stringify({ type: 'subscribe', sessionId: 'hidden-session', requestId: 'sub1' }))
  await take(responderWs, (frame) => frame.requestId === 'sub1')
  await flush(responderWs)
  assert.equal(seenOf(responderWs).some((frame) => frame.kind === 'approval-requested' && frame.sessionId === 'hidden-session'), false,
    'subscribing to a hidden session replays nothing')
  answer.resolve('rejected'); await Promise.all([p1, p2])
})

test('R4b: replay on connect and on subscribe applies the same per-recipient authorization', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const responder = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond'] })
  const observer = await pairDevice(instance, DEV_B, { scopes: ['sessions:read'] })
  await waitFor(() => visibleIds(instance, responder.device.id).length === 2, 'snapshot')
  toolCall(instance, 's1', 'c1'); toolCall(instance, 'hidden-session', 'c2')
  const answer = Promise.withResolvers()
  const p1 = requestApproval(instance, 's1', 'c1', () => answer.promise)
  const p2 = requestApproval(instance, 'hidden-session', 'c2', () => answer.promise)
  await delay(50)
  const responderWs = await connectToken(instance, responder.token, DEV_A)
  const observerWs = await connectToken(instance, observer.token, DEV_B)
  await take(responderWs, (frame) => frame.kind === 'approval-requested' && frame.sessionId === 's1' && frame.replay === true)
  await flush(responderWs); await flush(observerWs)
  assert.equal(seenOf(responderWs).some((frame) => frame.sessionId === 'hidden-session' && frame.kind === 'approval-requested'), false)
  assert.equal(seenOf(observerWs).some((frame) => frame.kind === 'approval-requested'), false, 'no approval:respond => no replay')
  answer.resolve('rejected'); await Promise.all([p1, p2])
})

test('R4c: a conversation-socket subscribe fans the replay out only to authorized control sockets', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const responder = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond'] })
  const observer = await pairDevice(instance, DEV_B, { scopes: ['sessions:read'] })
  await waitFor(() => visibleIds(instance, responder.device.id).length === 2, 'snapshot')
  const responderCtl = await connectToken(instance, responder.token, DEV_A, 'control')
  const observerCtl = await connectToken(instance, observer.token, DEV_B, 'control')
  // The conversation socket belongs to the OBSERVER; the fan-out target list is
  // every control socket, including the responder's.
  const observerConv = await connectToken(instance, observer.token, DEV_B, 'conversation')
  toolCall(instance, 's1', 'c1')
  const answer = Promise.withResolvers()
  const pending = requestApproval(instance, 's1', 'c1', () => answer.promise)
  await take(responderCtl, (frame) => frame.kind === 'approval-requested' && frame.replay !== true)
  const seenBefore = seenOf(responderCtl).filter((frame) => frame.kind === 'approval-requested').length
  observerConv.send(JSON.stringify({ type: 'subscribe', sessionId: 's1', requestId: 'sub-conv' }))
  await take(observerConv, (frame) => frame.requestId === 'sub-conv')
  await waitFor(() => seenOf(responderCtl).filter((frame) => frame.kind === 'approval-requested').length > seenBefore,
    'the authorized responder control socket is re-sent the card')
  await flush(observerCtl)
  assert.equal(seenOf(observerCtl).some((frame) => frame.kind === 'approval-requested'), false,
    'the unauthorized observer control socket gets nothing from the fan-out')
  answer.resolve('rejected'); await pending
})

test('R4d: a revoked or re-paired generation is sent no approval push and no replay', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const first = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond'] })
  const ws = await connectToken(instance, first.token, DEV_A)
  await waitFor(() => visibleIds(instance, first.device.id).length === 2, 'snapshot')
  const closed = once(ws, 'close')
  const revoked = await instance.post(`devices/${first.device.id}/revoke`)
  assert.equal(revoked.status, 200)
  await closed
  toolCall(instance, 's1', 'c1')
  const answer = Promise.withResolvers()
  const pending = requestApproval(instance, 's1', 'c1', () => answer.promise)
  await delay(150)
  assert.equal(seenOf(ws).some((frame) => frame.kind === 'approval-requested'), false, 'a revoked device is sent no card')
  answer.resolve('rejected'); await pending
})

// ---------------------------------------------------------------------------
// R5: questions
// ---------------------------------------------------------------------------

test('R5: the admin socket is always sent a question', async (t) => {
  const instance = await factory(t, { config: { legacyAdmin: true } })
  await instance.start(); await ready(instance)
  // `legacyAdmin` makes a device-token socket the admin channel for the test, so
  // use a SECOND instance without it for the real device behaviour.
  const device = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  const adminWs = await connectToken(instance, device.token, DEV_A)
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  await take(adminWs, (frame) => frame.kind === 'question-requested')
  answer.resolve({ answers: [{ id: 'q', selected: ['a'] }] }); await pending
})

test('R5b: a real device gets no question card and no question replay, whatever scopes it holds (audited)', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  // No device scope grants questions: `question-answer` is ADMIN_ONLY, so a
  // device is never sent a card it could not answer on this channel.
  const device = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'prompt:send'] })
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  await delay(50)
  const ws = await connectToken(instance, device.token, DEV_A) // replay on connect
  await flush(ws)
  assert.equal(seenOf(ws).some((frame) => frame.kind === 'question-requested'), false, 'no live card and no replay')
  answer.resolve({ answers: [{ id: 'q', selected: ['a'] }] }); await pending
})

test('R5c: a FULLY-scoped device receives no question push and no replay, while the admin channel still does', async (t) => {
  // `legacyAdmin` turns a device-token socket into the admin channel, so the
  // device half needs its own instance without it.
  const adminInstance = await factory(t, { config: { legacyAdmin: true } })
  await adminInstance.start(); await ready(adminInstance)
  const admin = await pairDevice(adminInstance, DEV_A, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  const adminWs = await connectToken(adminInstance, admin.token, DEV_A)
  await flush(adminWs) // the connect baseline is delivered
  const adminAnswer = Promise.withResolvers()
  const adminPending = requestQuestion(adminInstance, 's1', () => adminAnswer.promise)
  try {
    const card = await take(adminWs, (frame) => frame.kind === 'question-requested' && frame.sessionId === 's1')
    assert.equal(card.questions[0].id, 'q', 'the admin channel is still served the card')
    const adminSecond = await connectToken(adminInstance, admin.token, DEV_A)
    await take(adminSecond, (frame) => frame.kind === 'question-requested' && frame.replay === true)
  } finally {
    adminAnswer.resolve({ answers: [{ id: 'q', selected: ['a'] }] }); await adminPending
  }

  const instance = await factory(t)
  await instance.start(); await ready(instance)
  // Every scope that could plausibly be read as "may answer": the device is
  // fully scoped for approvals and prompts, and still gets nothing.
  const device = await pairDevice(instance, DEV_B, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  const ws = await connectToken(instance, device.token, DEV_B)
  await flush(ws)
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  try {
    // Replay-on-connect is a separate path from the live push: both are withheld.
    const second = await connectToken(instance, device.token, DEV_B)
    await flush(ws); await flush(second)
    assert.equal(seenOf(ws).some((frame) => frame.kind === 'question-requested'), false,
      'a device principal is never sent a question push')
    assert.equal(seenOf(second).some((frame) => frame.kind === 'question-requested'), false,
      'and a connecting device is sent no question replay')
  } finally {
    answer.resolve({ answers: [{ id: 'q', selected: ['a'] }] }); await pending
  }
})


// ---------------------------------------------------------------------------
// R6: the raw session/event fan-out (reviewer 537f M1)
// ---------------------------------------------------------------------------

test('R6a: an unsubscribed LEGACY socket without sessions:read gets no live session event at all', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const blind = await pairDevice(instance, DEV_B, { scopes: ['prompt:send'] })
  // The pairing socket stays in `clients` on the legacy channel and never subscribes.
  emitEvent(instance, 's1', 'not for the blind device')
  await flush(blind.ws)
  assert.equal(seenOf(blind.ws).some((frame) => frame.kind === 'event'), false,
    'the raw fan-out is session READ data, so it needs sessions:read')
})

test('R6b: an unsubscribed legacy socket with sessions:read gets only its visible sessions\' live events', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const reader = await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] })
  const ws = reader.ws // legacy channel, never subscribes
  await waitFor(() => visibleIds(instance, reader.device.id).length === 2, 'snapshot')
  emitEvent(instance, 's1', 'visible text')
  await take(ws, (frame) => frame.kind === 'event' && frame.sessionId === 's1')
  emitEvent(instance, 'hidden-session', 'SECRET hidden text')
  await flush(ws)
  assert.equal(seenOf(ws).some((frame) => frame.kind === 'event' && frame.sessionId === 'hidden-session'), false,
    'a session the Host never listed to the device leaks no live event')
  assert.equal(JSON.stringify(seenOf(ws)).includes('SECRET hidden text'), false, 'and none of its content')
})

test('R6c: a device that subscribes to a hidden session is refused and gets none of its live events', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const device = await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] })
  const ws = await connectToken(instance, device.token, DEV_A, 'conversation')
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'hidden-session', requestId: 'sub-hidden' }))
  const refused = await take(ws, (frame) => frame.requestId === 'sub-hidden')
  assert.equal(refused.kind, 'error', 'a subscription is a routing hint, not a grant')
  assert.equal(refused.code, 'session-not-found')
  emitEvent(instance, 'hidden-session', 'SECRET via subscription')
  await flush(ws)
  assert.equal(seenOf(ws).some((frame) => frame.kind === 'event' && frame.sessionId === 'hidden-session'), false,
    'an unfiltered hidden subscription never widens the raw stream')
  assert.equal(JSON.stringify(seenOf(ws)).includes('SECRET via subscription'), false)
  // The same socket may still subscribe to a VISIBLE session and then receives it.
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: 's1', requestId: 'sub-visible' }))
  assert.equal((await take(ws, (frame) => frame.requestId === 'sub-visible')).kind, 'subscribed')
  emitEvent(instance, 's1', 'visible via subscription')
  await take(ws, (frame) => frame.kind === 'event' && frame.sessionId === 's1')
})

test('R6d: the loopback admin (legacyAdmin) socket still receives the full live stream', async (t) => {
  const instance = await factory(t, { config: { legacyAdmin: true } })
  await instance.start(); await ready(instance)
  const admin = await pairDevice(instance, DEV_A, { scopes: [] })
  const ws = admin.ws // legacy channel, admin test socket
  emitEvent(instance, 's1', 'admin sees this')
  emitEvent(instance, 'hidden-session', 'admin sees that too')
  await take(ws, (frame) => frame.kind === 'event' && frame.sessionId === 'hidden-session')
})

test('R6e: a re-paired or revoked generation gets no live session event', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const repaired = await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] })
  const revoked = await pairDevice(instance, DEV_B, { scopes: ['sessions:read'] })
  const oldSockets = [repaired.ws, revoked.ws] // legacy channel: the raw fan-out's target
  await waitFor(() => visibleIds(instance, repaired.device.id).length === 2, 'snapshot')
  const closed = Promise.all(oldSockets.map((ws) => once(ws, 'close')))
  await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] }) // generation bumped
  assert.equal((await instance.post(`devices/${revoked.device.id}/revoke`)).status, 200)
  await closed
  emitEvent(instance, 's1', 'after the credential changed')
  await delay(150)
  for (const ws of oldSockets) {
    assert.equal(seenOf(ws).some((frame) => frame.kind === 'event'), false, 'a stale generation is sent no live event')
  }
})
