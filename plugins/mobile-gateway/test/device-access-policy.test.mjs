// T022a — integration of the non-owner device Peer into the running plugin.
//
// Runs the plugin's real `apply()` (router, scope gate, adapters, lifecycle) with
// a RECORDING typertGateway, and checks WHICH Peer each Host call carried:
//  - a paired device's calls carry its own `dsh-ext-mobile-device` Peer;
//  - the owner-internal background streams (workspace/follow, session/control)
//    and the loopback admin channel keep the shared owner Peer;
//  - a device never gets those streams or any unmapped endpoint;
//  - the policy is registered exactly once through `ctx.remoteAccess`;
//  - the Peer is disposed on disconnect, revoke and plugin teardown;
//  - the plugin refuses to start without `ctx.remoteAccess` (fail closed).
//
// This file proves the PLUGIN wiring with a fake Host. DSH's own enforcement
// (remote-access/denied from the real Gateway) is proven in
// test/device-access-real.test.mjs, which needs DSH_INSTALL_ROOT; this suite does
// NOT claim Host enforcement.
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
import { COMPANION_PRINCIPAL_KIND, COMPANION_ENDPOINTS } from '../lib/companion-access.mjs'
import { createDeviceAccess, devicePrincipal, deviceAccessAvailable } from '../lib/device-peers.mjs'
import { createPositiveDeviceGuard } from '../lib/allowlist.mjs'
import { hostEndpointAllowedForDevice } from '../lib/companion-access.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DEVICE = 'dev00000-0000-4000-8000-000000000001'
const OTHER = 'dev00000-0000-4000-8000-000000000002'

async function factory(t, options = {}) {
  const config = options.config ?? {}
  // `remoteAccess: null` means a Host WITHOUT the service (U2); omitted means the recording fake.
  const remoteAccess = options.remoteAccess === null ? undefined : (options.remoteAccess ?? createTestRemoteAccess())
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-t022a-'))
  const listeners = {}
  const sockets = []
  const hostCalls = []
  let management
  let upgrade
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) { management.handler(req, res); return }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const connection = createTestConnection()
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => {} },
      registerUpgrade(route) { upgrade = route; return () => {} },
    },
    connection,
    remoteAccess,
    typertGateway: {
      async invoke(request) {
        hostCalls.push({ kind: 'invoke', endpoint: `${request.namespace}/${request.method}`, principal: request.peer?.principal })
        if (request.namespace === 'session' && request.method === 'list') return { items: [{ sessionId: 's1' }, { sessionId: 's2' }] }
        if (request.namespace === 'session' && request.method === 'search') return { items: [], hasMore: false }
        if (request.namespace === 'session' && request.method === 'prompt') return { accepted: true }
        if (request.namespace === 'session' && request.method === 'cancel') return { accepted: true }
        return {}
      },
      async stream(request) {
        hostCalls.push({ kind: 'stream', endpoint: `${request.namespace}/${request.method}`, principal: request.peer?.principal,
          sessionId: request.args?.request?.address?.sessionId })
        return (async function* () {
          if (request.namespace === 'session' && request.method === 'follow') {
            yield { type: 'snapshot', header: { version: 4, id: request.args.request.address.sessionId }, cursor: 1, records: [], hasMore: false,
              projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } }
          } else {
            yield { type: 'baseline', value: request.namespace === 'workspace' ? { items: [], archivedSessionIds: [] } : { projections: {} } }
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
    gatewayName: `t022a-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    requireHostApproval: false,
    ...config,
  })
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    try { dispose() } catch { /* already disposed */ }
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    ctx, connection, hostCalls, listeners, start, port,
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
async function take(ws, predicate, timeoutMs = 5_000) {
  const seen = frames.get(ws) ?? record(ws)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const frame = seen.find(predicate); if (frame) return frame; await delay(5) }
  throw new Error(`timed out waiting for a frame (${seen.map((frame) => frame.kind).join(', ')})`)
}
const open = (instance, protocols, headers = {}) => instance.track(new WebSocket(instance.lanUrl, protocols, {
  headers: { 'X-DSH-Cert-SHA256': instance.lanPin, ...headers }, origin: undefined, rejectUnauthorized: false,
}))
/** Contract §3.6/§5a: operations wait for the acknowledged client-hello. */
let helloCounter = 0
async function negotiate(ws) {
  const requestId = `hello-${++helloCounter}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test', platform: 'ios' }))
  return take(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === requestId)
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
async function connectToken(instance, token, deviceId) {
  const ws = open(instance, ['dsh-mobile-v1'], { Authorization: `Bearer ${token}`, 'X-DSH-Device-ID': deviceId })
  record(ws)
  await once(ws, 'open')
  await take(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return ws
}
let counter = 0
async function ask(ws, frame) {
  const requestId = `q-${++counter}`
  ws.send(JSON.stringify({ ...frame, requestId }))
  return take(ws, (reply) => reply.requestId === requestId)
}
const principalKinds = (calls) => [...new Set(calls.map((call) => call.principal?.kind))]

test('U1: the plugin registers the device policy exactly once through ctx.remoteAccess, and a restart does not collide', async (t) => {
  const remoteAccess = createTestRemoteAccess()
  const instance = await factory(t, { remoteAccess })
  await instance.start()
  assert.equal(remoteAccess.policies.size, 1)
  assert.ok(remoteAccess.policies.has(COMPANION_PRINCIPAL_KIND))
  const policy = remoteAccess.policies.get(COMPANION_PRINCIPAL_KIND)
  assert.equal(typeof policy.bindings, 'function')
  assert.deepEqual(policy.bindings({ kind: 'owner' }), [], 'the policy gives an owner-shaped principal nothing')
  assert.deepEqual(policy.bindings({ kind: COMPANION_PRINCIPAL_KIND, deviceId: 'nobody' }), [], 'an unknown device has no grants')
  instance.teardown()
  assert.equal(remoteAccess.policies.size, 0, 'teardown removes the policy')
  await instance.start() // the same kind registers again without "already has a policy"
  assert.equal(remoteAccess.policies.size, 1)
})

test('U2: the plugin refuses to start without ctx.remoteAccess (fail closed, no owner-Peer fallback)', async (t) => {
  const instance = await factory(t, { remoteAccess: null })
  await assert.rejects(instance.start(), /requires DSH remoteAccess/)
  assert.deepEqual(instance.hostCalls, [], 'nothing reached the Host')
  assert.equal(deviceAccessAvailable({ connection: { createPeer() {} }, remoteAccess: {} }), false)
  assert.equal(deviceAccessAvailable({ connection: {}, remoteAccess: { registerPolicy() {}, invalidate() {} } }), false)
  assert.equal(deviceAccessAvailable({ connection: { createPeer() {} }, remoteAccess: { registerPolicy() {}, invalidate() {} } }), true)
  assert.throws(() => createDeviceAccess({ ctx: { connection: { createPeer() {} } }, getDevice() {}, getVisibleSessionIds() { return [] } }),
    /requires DSH remoteAccess/)
})

test('U3: a device connection speaks through its own non-owner Peer; owner-internal streams stay on the owner Peer', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEVICE)
  const ws = await connectToken(instance, layout.token, DEVICE)
  const before = instance.hostCalls.length
  const sessions = await ask(ws, { type: 'sessions' })
  assert.equal(sessions.kind, 'sessions')
  await ask(ws, { type: 'search', query: 'q' })
  await ask(ws, { type: 'message', sessionId: 's1', clientMsgId: 'm1', text: 'hi' })
  await ask(ws, { type: 'session-cancel', sessionId: 's1' })
  const deviceCalls = instance.hostCalls.slice(before)
  assert.ok(deviceCalls.length >= 4, JSON.stringify(deviceCalls))
  for (const call of deviceCalls) {
    assert.deepEqual(call.principal, devicePrincipal(layout.device.id), `${call.endpoint} must carry the device principal`)
    assert.ok(Object.hasOwn(COMPANION_ENDPOINTS, call.endpoint), `${call.endpoint} must be in the positive table`)
  }
  // The background streams were opened by the plugin itself, as owner, before any device.
  const internal = instance.hostCalls.slice(0, before).filter((call) => call.kind === 'stream')
  assert.ok(internal.some((call) => call.endpoint === 'workspace/follow'))
  assert.ok(internal.some((call) => call.endpoint === 'session/control'))
  for (const call of internal) assert.equal(call.principal?.kind, 'owner', `${call.endpoint} is owner-internal`)
  assert.equal(instance.connection.peers.filter((peer) => peer.principal.kind === COMPANION_PRINCIPAL_KIND).length, 2, 'pairing socket + token socket each own one Peer')
})

test('U4: a device never reaches an unmapped endpoint through any router op (guard before the Host)', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEVICE)
  const ws = await connectToken(instance, layout.token, DEVICE)
  const before = instance.hostCalls.length
  // Ops outside the companion vocabulary never reach the Host (router layer)...
  for (const type of ['session-create', 'workspaces', 'plugin-catalog', 'settings', 'commands', 'fork', 'queue-update', 'directories', 'host']) {
    const reply = await ask(ws, { type })
    assert.equal(reply.code, 'op/forbidden', type)
  }
  // ...and the adapter guard of the device Peer refuses even a mapped router op
  // whose Host endpoint is NOT in the positive table (`history` page → session/page is mapped,
  // `subscribe` follow is mapped; nothing else is reachable).
  assert.deepEqual(instance.hostCalls.slice(before), [])
  const mapped = new Set(Object.keys(COMPANION_ENDPOINTS))
  for (const call of instance.hostCalls.slice(before)) assert.ok(mapped.has(call.endpoint))
})

test('U5: the positive guard composes the denied list AND the positive table, and refuses every Fetch path', () => {
  const guard = createPositiveDeviceGuard(hostEndpointAllowedForDevice)
  for (const key of Object.keys(COMPANION_ENDPOINTS)) {
    const [namespace, method] = key.split('/')
    assert.equal(guard.hostEndpoint(namespace, method), true, key)
  }
  for (const [namespace, method] of [['session', 'create'], ['session', 'control'], ['workspace', 'follow'], ['settings', 'mutate'],
    ['pluginManager', 'installBundle'], ['speech', 'catalog'], ['unknown', 'thing'], ['session', 'modelCatalog'], ['subagents', 'prompt']]) {
    assert.equal(guard.hostEndpoint(namespace, method), false, `${namespace}/${method}`)
  }
  assert.equal(guard.fetchPath('/api/session/uploadFileBinary'), false)
  assert.equal(guard.fetchPath('/api/anything'), false)
  assert.throws(() => createPositiveDeviceGuard(), TypeError)
  // The positive table cannot widen the denied list: a table that said yes to a denied endpoint is still no.
  const widen = createPositiveDeviceGuard(() => true)
  assert.equal(widen.hostEndpoint('settings', 'update'), false)
  assert.equal(widen.hostEndpoint('session', 'create'), false)
})

test('U6: the Peer is disposed on disconnect and the other device keeps its own Peer', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const a = await pairDevice(instance, DEVICE)
  const b = await pairDevice(instance, OTHER)
  const wsA = await connectToken(instance, a.token, DEVICE)
  const wsB = await connectToken(instance, b.token, OTHER)
  const devicePeers = () => instance.connection.peers.filter((peer) => peer.principal.kind === COMPANION_PRINCIPAL_KIND)
  const peerOf = (id) => devicePeers().filter((peer) => peer.principal.deviceId === id)
  const idA = a.device.id; const idB = b.device.id
  assert.ok(peerOf(idA).length >= 1 && peerOf(idB).length >= 1)
  // The pairing socket is itself a device connection with its own Peer, so a
  // phone that disconnects drops both: end both sockets here.
  const closed = [once(wsA, 'close'), once(a.ws, 'close')]
  wsA.terminate(); a.ws.terminate()
  await Promise.all(closed)
  for (let i = 0; i < 100 && !peerOf(idA).every((peer) => peer.signal.aborted); i += 1) await delay(10)
  assert.ok(peerOf(idA).every((peer) => peer.signal.aborted), 'the disconnected device Peer is disposed: ' + JSON.stringify(devicePeers().map((peer) => [peer.principal.deviceId.slice(0, 4), peer.signal.aborted])))
  assert.ok(peerOf(idB).every((peer) => !peer.signal.aborted), 'the other device Peer is untouched')
  assert.equal((await ask(wsB, { type: 'sessions' })).kind, 'sessions')
})

test('U7: revoke disposes the device Peers and invalidates its DSH snapshot; the socket closes 4401', async (t) => {
  const remoteAccess = createTestRemoteAccess()
  const instance = await factory(t, { remoteAccess })
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEVICE)
  const ws = await connectToken(instance, layout.token, DEVICE)
  const peers = instance.connection.peers.filter((peer) => peer.principal.deviceId === layout.device.id)
  assert.ok(peers.length >= 1)
  const closed = once(ws, 'close')
  const revoked = await instance.post(`devices/${layout.device.id}/revoke`)
  assert.equal(revoked.status, 200)
  const [code] = await closed
  assert.equal(code, 4401)
  for (let i = 0; i < 100 && !peers.every((peer) => peer.signal.aborted); i += 1) await delay(10)
  assert.ok(peers.every((peer) => peer.signal.aborted), 'revoked device Peers are disposed')
  assert.ok(remoteAccess.invalidations.some((principal) => principal?.deviceId === layout.device.id), 'its DSH snapshot was invalidated')
  // the revoked token can no longer open a connection, so no new Peer appears for it
  const peersBefore = instance.connection.peers.length
  const retry = open(instance, ['dsh-mobile-v1'], { Authorization: `Bearer ${layout.token}`, 'X-DSH-Device-ID': DEVICE })
  retry.on('error', () => {})
  await Promise.race([once(retry, 'unexpected-response'), once(retry, 'close'), delay(1_000)])
  assert.equal(instance.connection.peers.length, peersBefore, 'no Peer for a revoked credential')
})

test('U8: a re-pair disposes the previous grant\'s Peers before the new connection has one', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const first = await pairDevice(instance, DEVICE, { scopes: ['sessions:read', 'prompt:send'] })
  const ws = await connectToken(instance, first.token, DEVICE)
  const old = instance.connection.peers.filter((peer) => peer.principal.deviceId === first.device.id)
  assert.ok(old.length >= 1)
  const closed = once(ws, 'close')
  await pairDevice(instance, DEVICE, { scopes: ['sessions:read'] })
  const [code] = await closed
  assert.equal(code, 4401)
  for (let i = 0; i < 100 && !old.every((peer) => peer.signal.aborted); i += 1) await delay(10)
  assert.ok(old.every((peer) => peer.signal.aborted), 'the previous grant\'s Peers are disposed')
})

test('U9: plugin teardown disposes every device Peer and the owner Peer', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEVICE)
  await connectToken(instance, layout.token, DEVICE)
  instance.teardown()
  for (let i = 0; i < 100 && !instance.connection.peers.every((peer) => peer.signal.aborted); i += 1) await delay(10)
  assert.ok(instance.connection.peers.length >= 2)
  assert.ok(instance.connection.peers.every((peer) => peer.signal.aborted), 'no Peer outlives the plugin')
})

test('U10: session visibility follows the Host: refreshed on start, a removed id drops at once, a failed refresh keeps the last list', async (t) => {
  const remoteAccess = createTestRemoteAccess()
  const instance = await factory(t, { remoteAccess })
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEVICE)
  const policy = remoteAccess.policies.get(COMPANION_PRINCIPAL_KIND)
  const principal = devicePrincipal(layout.device.id)
  const sessionIds = () => policy.bindings(principal).filter((binding) => binding.resource.kind === 'session').map((binding) => binding.resource.id).sort()
  for (let i = 0; i < 100 && sessionIds().length === 0; i += 1) await delay(10)
  assert.deepEqual(sessionIds(), ['s1', 's2'], 'exact ids from session/list, no wildcard')
  const invalidationsBefore = remoteAccess.invalidations.length
  instance.listeners['api-session/removed']('s2')
  assert.deepEqual(sessionIds(), ['s1'], 'a removed session is not grantable even before the refresh returns')
  assert.ok(remoteAccess.invalidations.length > invalidationsBefore)
  // The Host lists s2 again on the next refresh, and an added event re-reads it.
  for (let i = 0; i < 100 && sessionIds().length < 2; i += 1) await delay(10)
  assert.deepEqual(sessionIds(), ['s1', 's2'])
  // A failing list keeps the previous snapshot and never adds anything.
  const original = instance.ctx.typertGateway.invoke
  instance.ctx.typertGateway.invoke = async () => { throw new Error('host unavailable') }
  instance.listeners['api-session/added']({ sessionId: 's9', running: false })
  await delay(100)
  assert.deepEqual(sessionIds(), ['s1', 's2'], 'a failed refresh keeps the last good list')
  instance.ctx.typertGateway.invoke = original
})

test('U11: a desktop device (008 harness:remote) is served by the same narrow policy and gets its own Peer; mobile cannot hold harness:remote', async (t) => {
  const remoteAccess = createTestRemoteAccess()
  const instance = await factory(t, { remoteAccess })
  await instance.start(); await ready(instance)
  const desktop = await pairDevice(instance, OTHER, { kind: 'desktop', scopes: ['sessions:read', 'harness:remote'] })
  const policy = remoteAccess.policies.get(COMPANION_PRINCIPAL_KIND)
  const bindings = policy.bindings(devicePrincipal(desktop.device.id))
  const actions = new Set(bindings.flatMap((binding) => binding.role.actions))
  assert.ok(actions.has('session/list'))
  assert.ok(![...actions].some((action) => action.startsWith('harness') || action.startsWith('remote') || action === 'session/prompt' || action === 'session/control'),
    [...actions].join(','))
  const mobile = await pairDevice(instance, DEVICE, { kind: 'mobile', scopes: ['sessions:read', 'harness:remote'] })
  assert.ok(!mobile.device.scopes.includes('harness:remote'), 'a mobile record never holds harness:remote')
})

test('U12: subscribe with assistantStream follows the session through the device Peer, never the owner Peer', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEVICE)
  const ws = await connectToken(instance, layout.token, DEVICE)
  const before = instance.hostCalls.length
  const subscribed = await ask(ws, { type: 'subscribe', sessionId: 's1', assistantStream: true })
  assert.equal(subscribed.kind, 'subscribed')
  await take(ws, (frame) => frame.kind === 'session-snapshot')
  const follows = instance.hostCalls.slice(before).filter((call) => call.endpoint === 'session/follow')
  assert.ok(follows.length >= 1, 'the follower opened session/follow')
  for (const call of follows) {
    assert.deepEqual(call.principal, devicePrincipal(layout.device.id))
    assert.equal(call.sessionId, 's1')
  }
  assert.ok(instance.hostCalls.slice(before).every((call) => call.principal?.kind === COMPANION_PRINCIPAL_KIND),
    'every Host call of the device connection carries the device principal')
})