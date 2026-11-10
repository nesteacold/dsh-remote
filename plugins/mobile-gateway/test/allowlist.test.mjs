// T021 / US3 — "A leaked phone token cannot take over the Host".
//
// Covers FR-005/FR-006 (SC-002) and the contract's §4 allowlist:
//   1. every request `type` the router implements is enumerated: a device token
//      gets a real answer for the `companion-v1` operations and an error frame
//      `op/forbidden` (echoing `requestId`) for everything else;
//   2. every host-adapter operation (every `namespace/method` the adapter can
//      reach) is refused at the adapter boundary for a device-token caller,
//      whatever the router allows;
//   3. a `type` added to the wire vocabulary but not to the companion list is
//      still refused (the allowlist is a positive list, not "everything but
//      this enum");
//   4. revoking one device closes *its* socket with 4401 and refuses its next
//      upgrade with 401, while a second device keeps working;
//   5. `device-forget` revokes the calling device only;
//   6. authentication is permanent: `/mgw/auth` is gone and a `requireAuth:
//      false` config still refuses every unauthenticated upgrade.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import plugin from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { connect, pair, upgradeStatus } from './client/pair.mjs'
import * as contract from '@dsh-ext/mobile-protocol'
import {
  ADMIN_ONLY_TYPES, CLOSE_REVOKED, COMPANION_CAPABILITIES, COMPANION_DENIED_HOST_ENDPOINTS,
  COMPANION_V1_TYPES, OP_FORBIDDEN, fetchPathAllowedForCompanion, hostEndpointAllowedForCompanion,
  isAdminOnlyType, isCompanionType,
} from '../lib/allowlist.mjs'
import { createDshHostAdapter } from '../lib/dsh-host-adapter.mjs'
import { PLUGIN_REQUEST_TYPES } from '../lib/plugin-management.mjs'
import { SPEECH_REQUEST_TYPES } from '../lib/speech-input.mjs'
import { FILE_UPLOAD_REQUEST_TYPES } from '../lib/file-upload.mjs'
import { SCHEDULE_REQUEST_TYPES } from '../lib/schedule-management.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-allowlist-'))
const out = []
let checks = 0
function passed(label) { checks += 1; out.push(`PASS ${checks}: ${label}`) }

// ---------------------------------------------------------------------------
// The request `type` table the router implements. It is copied from the
// router's `else if` chain in lib/index.mjs and from the request-type sets of
// the helper modules; the test asserts every entry is classified as either a
// `companion-v1` operation or an admin-only one, so a new `type` cannot slip in
// unclassified.
// ---------------------------------------------------------------------------
const ROUTER_TYPES = new Set([
  // connection management
  'ping', 'subscribe', 'unsubscribe',
  // human in the loop
  'question-answer', 'question-cancel', 'approval-response',
  // files
  'file-list', 'file-resolve', 'file-download-open', 'file-download-read', 'file-download-cancel',
  // messaging and session control
  'message', 'session-cancel',
  // reads and settings
  'agent-team', 'subagents', 'workspaces', 'sessions', 'history', 'attachment', 'search', 'host',
  'directories', 'directory-create', 'workspace-create', 'session-create', 'models', 'commands',
  'command-execute', 'command-options', 'command-select', 'select-model', 'permission-options',
  'permission', 'context-usage', 'agent-presets', 'session-agent-preset', 'select-agent-preset',
  'defaults', 'set-default', 'session-stats', 'default-model', 'save-default-model', 'fork',
  'queue-update', 'session-archive', 'session-rename', 'providers', 'tasks', 'goal', 'goal-edit',
  'goal-pause', 'goal-resume', 'goal-clear',
  ...PLUGIN_REQUEST_TYPES,
  ...SCHEDULE_REQUEST_TYPES,
  ...SPEECH_REQUEST_TYPES,
  ...FILE_UPLOAD_REQUEST_TYPES,
])

// Device-token parameters that make each companion operation answer for real
// (the fake Host serves session `s1`).
const COMPANION_PROBES = {
  'client-hello': { companionProtocol: 1, appVersion: '1.0.0', platform: 'ios' },
  ping: {},
  sessions: {},
  search: { query: 'anything' },
  history: { sessionId: 's1' },
  subscribe: { sessionId: 's1' },
  unsubscribe: {},
  message: { sessionId: 's1', text: 'hello', clientMsgId: 'msg-1' },
  'session-cancel': { sessionId: 's1' },
  'approval-response': { rpcId: 'rpc-unknown', sessionId: 's1', approvalId: 'a-unknown', argsHash: 'x', outcome: 'rejected' },
  'device-info': {},
  'device-forget': {},
  'push-register': { platform: 'apns', token: 'sk-token' },
  'push-remove': {},
}

// ---------------------------------------------------------------------------
// Fake Host: records every Remote call, so a forbidden request that still
// reached the Host would be visible.
// ---------------------------------------------------------------------------
function fakeHost(records) {
  return {
    invoke(request) {
      records.push({ kind: 'invoke', namespace: request.namespace, method: request.method })
      if (request.namespace === 'session' && request.method === 'list') return Promise.resolve({ items: [{ sessionId: 's1' }] })
      if (request.namespace === 'session' && request.method === 'search') return Promise.resolve({ items: [], hasMore: false })
      if (request.namespace === 'session' && request.method === 'prompt') return Promise.resolve({ accepted: true })
      if (request.namespace === 'session' && request.method === 'cancel') return Promise.resolve({ accepted: true })
      if (request.namespace === 'session' && request.method === 'follow') {
        const address = request.args.request.address
        const id = address.kind === 'subagent' ? address.childSessionId : address.sessionId
        return Promise.resolve((async function* () {
          yield { type: 'snapshot', header: { version: 4, id }, cursor: 1,
            records: [], hasMore: false, projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } }
        })())
      }
      if (request.namespace === 'session' && request.method === 'page') return Promise.resolve({ records: [], hasMore: false })
      return Promise.resolve({ ok: true })
    },
    stream(request) {
      records.push({ kind: 'stream', namespace: request.namespace, method: request.method })
      return Promise.resolve((async function* () {
        yield { type: 'baseline', value: request.namespace === 'workspace'
          ? { items: [], archivedSessionIds: [] } : { projections: {} } }
        while (!request.signal.aborted) await delay(5)
      })())
    },
  }
}

// ---------------------------------------------------------------------------
// Fake Host: records every Remote call, so a forbidden request that still
// reached the Host would be visible. Session streams stay open until their
// signal aborts, like the real Gateway streams.
// ---------------------------------------------------------------------------
function sessionFakeHost(records) {
  return {
    invoke(request) {
      records.push({ kind: 'invoke', namespace: request.namespace, method: request.method })
      if (request.namespace === 'session' && request.method === 'list') return { items: [{ sessionId: 's1' }] }
      if (request.namespace === 'session' && request.method === 'search') return { items: [], hasMore: false }
      if (request.namespace === 'session' && request.method === 'prompt') return { accepted: true }
      if (request.namespace === 'session' && request.method === 'cancel') return { accepted: true }
      return { ok: true }
    },
    stream(request) {
      records.push({ kind: 'stream', namespace: request.namespace, method: request.method })
      const frames = []
      return Promise.resolve((async function* () {
        if (request.namespace === 'session' && request.method === 'follow') {
          const address = request.args.request.address
          const id = address.kind === 'subagent' ? address.childSessionId : address.sessionId
          yield { type: 'snapshot', header: { version: 4, id }, cursor: 1,
            records: [], hasMore: false, projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } }
        } else {
          yield { type: 'baseline', value: { projections: {}, items: [], archivedSessionIds: [] } }
        }
        while (!request.signal.aborted) {
          if (frames.length > 0) { yield frames.shift(); continue }
          await new Promise((done) => {
            const timer = setTimeout(done, 10)
            timer.unref?.()
            request.signal.addEventListener('abort', () => { clearTimeout(timer); done() }, { once: true })
          })
        }
      })())
    },
  }
}

async function startGateway() {
  let management
  let upgrade
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management) management.handler(req, res)
    else res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (upgrade) upgrade.handler(req, socket, head)
    else socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const config = {
    deviceFile: path.join(temp, `devices-${port}.json`),
    gatewayName: `allowlist-${port}`,
    gatewayWaitTimeoutMs: 60_000,
    adminLoopbackOnly: true,
    pairingTtlMs: 60_000,
    lanEnabled: true,
    requireHostApproval: false, // spec 008 P1b: these tests exercise the direct claim path; pairing-approval.test.mjs covers the default
    lanHost: '127.0.0.1',
    lanPort: 0,
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
  }
  const hostRecords = []
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: sessionFakeHost(hostRecords),
    agentDefaultModel: {},
    on() { return () => {} },
    effect(factory) { dispose = factory() },
  }
  await plugin.apply(ctx, config)
  const base = `http://127.0.0.1:${port}`
  const instance = {
    port,
    base,
    wsUrl: `ws://127.0.0.1:${port}/ws/mobile`,
    config,
    hostRecords,
    async status() { return (await (await fetch(`${base}/mgw/status`)).json()) },
    async post(route, body) {
      const response = await fetch(`${base}/mgw/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    async waitForLan() {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const status = await instance.status()
        if (status.lan?.listening && status.lan.urls.length > 0) return status
        if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
        await delay(20)
      }
      throw new Error('TLS listener did not become ready')
    },
    async close() {
      dispose()
      server.close()
      await once(server, 'close')
    },
  }
  return instance
}

// Per-connection frame buffer written by a `next()` predicate that never
// matches: every frame pushed after `hello` lands in it.
const connectorBuffers = new WeakMap()

/** Wait for the next frame that is not a push the gateway sends on connect. */
async function request(connection, frame) {
  const requestId = frame.requestId ?? `req-${crypto.randomUUID().slice(0, 8)}`
  const sent = { ...frame, requestId }
  connection.ws.send(JSON.stringify(sent))
  const pending = connectorBuffers.get(connection)
  if (!pending) return connection.request(sent)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const index = pending.findIndex((candidate) => candidate.requestId === requestId)
    if (index >= 0) return pending.splice(index, 1)[0]
    await delay(5)
  }
  throw new Error(`timed out waiting for the answer to ${frame.type}`)
}

/** Remember every frame a connection pushes after `hello`. */
function track(connection) {
  const buffer = connectorBuffers.get(connection)
  if (buffer) return connection
  const created = []
  connectorBuffers.set(connection, created)
  // A waiter that never matches keeps its place; each incoming frame is offered
  // to it first and then buffered here.
  connection.next((frame) => { created.push(frame); return false })
  return connection
}

const instance = await startGateway()
try {
  const lanStatus = await instance.waitForLan()
  const endpoint = lanStatus.lan.urls[0]

  const pairDevice = async (name, deviceId) => {
    const created = await instance.post('pair', { name, publicUrl: endpoint })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    return pair({ payload: created.data.payload, deviceId, deviceName: name })
  }

  const phone = await pairDevice('Phone A', 'aaaa0000-0000-4000-8000-000000000001')
  const otherPhone = await pairDevice('Phone B', 'bbbb0000-0000-4000-8000-000000000002')

  // -------------------------------------------------------------------------
  // 0. The lists themselves.
  // -------------------------------------------------------------------------
  assert.deepEqual([...COMPANION_V1_TYPES].sort(), [...contract.OPS].sort(), 'the allowlist is the contract §4 op list')
  assert.deepEqual([...COMPANION_CAPABILITIES], [...contract.CAPABILITIES], 'hello advertises exactly the package capabilities')
  const unclassified = [...ROUTER_TYPES].filter((type) => !isCompanionType(type) && !isAdminOnlyType(type))
  assert.deepEqual(unclassified, [], `every router request type must be classified: ${unclassified.join(', ')}`)
  for (const type of ROUTER_TYPES) {
    if (isCompanionType(type)) continue
    assert.equal(isAdminOnlyType(type), true, `${type} must be admin-only`)
  }
  passed(`router request types enumerated (${ROUTER_TYPES.size}); companion-v1 = contract §4 (${COMPANION_V1_TYPES.size})`)

  // -------------------------------------------------------------------------
  // 1. The companion allowlist on the wire.
  // -------------------------------------------------------------------------
  const connectionPayload = (await instance.post('pair', { name: 'Connect only', publicUrl: endpoint })).data.payload
  const phoneConnection = track(await connect({ payload: connectionPayload, token: phone.token, deviceId: 'aaaa0000-0000-4000-8000-000000000001' }))
  assert.equal(phoneConnection.hello.authenticated, true)

  const accepted = new Map()
  const explain = (type, reply) => `${type} answered ${JSON.stringify(reply).slice(0, 300)}`
  for (const type of COMPANION_V1_TYPES) {
    if (type === 'device-forget') {
      accepted.set(type, 'device-forgotten') // revokes the caller; scenario 4
      continue
    }
    const reply = await request(phoneConnection, { type, ...(COMPANION_PROBES[type] ?? {}) })
    const expected = contract.OP_RESPONSES[type]
    if (type === 'push-register' || type === 'push-remove') {
      assert.equal(reply.kind, 'error', `${type} must answer an error while push-v1 is unadvertised`)
      assert.equal(reply.code, OP_FORBIDDEN, `${type} → ${OP_FORBIDDEN}`)
    } else {
      assert.equal(reply.kind, expected, explain(type, reply))
    }
    accepted.set(type, reply.kind)
  }
  passed('every companion-v1 operation is served to a device token (with requestId echoed)')

  // Every other router type: `op/forbidden`, the caller's requestId, nothing on the Host.
  // The client sends each type as an unknown op (its frame has no operation params).
  const forbidden = [...ROUTER_TYPES].filter((type) => !isCompanionType(type))
  const hostCallsBefore = instance.hostRecords.length
  for (const type of forbidden) {
    const requestId = `forbid-${type}`
    const reply = await request(phoneConnection, { type, requestId, sessionId: 's1', path: '/tmp', name: 'x' })
    assert.equal(reply.kind, 'error', `${type} must be refused, got ${JSON.stringify(reply).slice(0, 160)}`)
    assert.equal(reply.code, OP_FORBIDDEN, `${type} must be ${OP_FORBIDDEN}, got ${reply.code}`)
    assert.equal(reply.requestId, requestId, `${type} must echo the requestId`)
    assert.equal(reply.requestType, type)
  }
  const hostCallsAfter = instance.hostRecords.filter((record) => record.kind !== 'stream' || !record)
  assert.equal(instance.hostRecords.length, hostCallsBefore,
    `a refused type must not reach the Host: ${JSON.stringify(instance.hostRecords.slice(hostCallsBefore)).slice(0, 400)}`)
  passed(`${forbidden.length} non-companion request types → ${OP_FORBIDDEN} with requestId, and never reach the Host`)

  // An unknown type ('plugin-manager', a future op) is refused the same way.
  for (const type of ['plugin-manager', 'sessions.list', 'not-an-operation', '']) {
    const reply = await request(phoneConnection, { type, requestId: `unknown-${type || 'empty'}` })
    assert.equal(reply.code, OP_FORBIDDEN, `${type || '(empty)'} → ${OP_FORBIDDEN}`)
  }
  passed('unknown and future request types are refused (positive allowlist)')

  // -------------------------------------------------------------------------
  // 2. Adapter-level denial: the second, independent layer.
  // -------------------------------------------------------------------------
  const adapterRecords = []
  const adapter = createDshHostAdapter(fakeHost(adapterRecords), { signal: new AbortController().signal, dispose: async () => {} },
    { createSharedFetchHandler: () => null }, {
      guard: { hostEndpoint: hostEndpointAllowedForCompanion, fetchPath: fetchPathAllowedForCompanion },
    })
  // Enumerate every operation the adapter exposes, one level deep.
  const endpointOf = (name) => {
    const calls = {
      'files.upload': () => adapter.files.upload({ sessionId: 's1', name: 'x', data: Buffer.from('x') }),
      'sessions.prompt': () => adapter.sessions.prompt({ sessionId: 's1', content: [] }),
      'sessions.create': () => adapter.sessions.create({}),
      'sessions.cancel': () => adapter.sessions.cancel({ sessionId: 's1' }),
      'sessions.list': () => adapter.sessions.list({}),
      'sessions.search': () => adapter.sessions.search({ query: 'q' }),
      'workspace.create': () => adapter.workspace.create({ path: '/tmp' }),
      'workspace.archiveSession': () => adapter.workspace.archiveSession({ sessionId: 's1' }),
      'settings.describe': () => adapter.settings.describe(),
      'settings.update': () => adapter.settings.update({ ns: 'permission', patch: {} }),
      'plugins.listPlugins': () => adapter.plugins.listPlugins(),
      'plugins.installBundle': () => adapter.plugins.installBundle('x@1'),
      'permissionPresets.catalog': () => adapter.permissionPresets.catalog(),
      'schedule.list': () => adapter.schedule.list({}),
      'schedule.create': () => adapter.schedule.create({}),
      'goals.pause': () => adapter.goals.pause({ sessionId: 's1', ref: { id: 'g', revision: 1 } }),
      'commands.execute': () => adapter.commands.execute('s1', '/compact', []),
      'speech.catalog': () => adapter.speech.catalog(),
      'agentPresets.select': () => adapter.agentPresets.select({ sessionId: 's1', agentPreset: 'x' }),
      'sessions.attachment': () => adapter.sessions.attachment({ sessionId: 's1', attachmentId: 'a' }),
      'host.describe': () => adapter.host.describe(),
    }
    if (!calls[name]) throw new Error(`no probe for adapter operation ${name}`)
    return calls[name]
  }
  const adapterOperations = ['files.upload', 'sessions.prompt', 'sessions.create', 'sessions.cancel', 'sessions.list',
    'sessions.search', 'workspace.create', 'workspace.archiveSession', 'settings.describe', 'settings.update',
    'plugins.listPlugins', 'plugins.installBundle', 'permissionPresets.catalog', 'schedule.list', 'schedule.create',
    'goals.pause', 'commands.execute', 'speech.catalog', 'agentPresets.select', 'sessions.attachment', 'host.describe']
  // Companion-served reads through the adapter: not blocked at the adapter
  // (the router decides), so the probe only has to come back with something.
  const adapterAllowed = new Set(['sessions.prompt', 'sessions.cancel', 'sessions.list', 'sessions.search'])
  for (const name of adapterOperations) {
    if (name === 'files.upload') {
      // Shared Fetch channel (/api/session/uploadFileBinary): file upload is denied.
      await assert.rejects(adapter.files.upload({ sessionId: 's1', name: 'x', data: Buffer.from('x') }),
        (error) => error.code === OP_FORBIDDEN, 'files.upload must fail with op/forbidden for a device token')
      continue
    }
    const [namespace, method] = name.split('.')
    // `agentPresets.select` and `sessions.attachment` check state through an
    // allowed read before they reach their write/read endpoint; the endpoints
    // themselves are covered by COMPANION_DENIED_HOST_ENDPOINTS below.
    const allowed = adapterAllowed.has(name) || name.startsWith('agentPresets.') || name === 'sessions.attachment'
    let error = null
    try { await endpointOf(name)() } catch (caught) { error = caught }
    if (allowed) {
      // A probe may reach the Host and fail there (the fake Host is minimal);
      // what matters is that the guard let it through.
      assert.notEqual(error?.code, OP_FORBIDDEN, `${name} must be allowed for a device token: ${error?.message}`)
    } else {
      assert.ok(error, `${name} must be refused for a device token`)
      assert.equal(error.code, OP_FORBIDDEN, `${name} must fail with ${OP_FORBIDDEN}, got ${error.code}`)
    }
  }
  for (const pattern of COMPANION_DENIED_HOST_ENDPOINTS) {
    const [namespace, method] = pattern.split('/')
    assert.equal(hostEndpointAllowedForCompanion(namespace === '*' ? 'session' : namespace, method === '*' ? 'list' : method), false,
      `${pattern} must be denied for a device token`)
  }
  assert.equal(hostEndpointAllowedForCompanion('session', 'list'), true, 'sessions is allowed for a device token')
  assert.equal(adapter.files.available(), false, 'file upload is unavailable to a device token')
  await assert.rejects(adapter.files.upload({ sessionId: 's1', name: 'x', data: Buffer.from('x') }),
    (error) => error.code === OP_FORBIDDEN, 'file upload must fail with op/forbidden for a device token')
  assert.equal(fetchPathAllowedForCompanion('/api/session/uploadFileBinary'), false, 'file upload is denied for a device token')
  passed(`adapter refuses ${COMPANION_DENIED_HOST_ENDPOINTS.length} mutating endpoint patterns (file upload included)`)

  // -------------------------------------------------------------------------
  // 3. Revocation isolates one device.
  // -------------------------------------------------------------------------
  const otherPayload = (await instance.post('pair', { name: 'Connect B', publicUrl: endpoint })).data.payload
  const other = track(await connect({ payload: otherPayload, token: otherPhone.token, deviceId: 'bbbb0000-0000-4000-8000-000000000002' }))
  const phoneClosed = once(phoneConnection.ws, 'close')
  const otherInfo = await request(other, { type: 'device-info' })
  assert.equal(otherInfo.kind, 'device-info')
  const devices = await (await fetch(`${instance.base}/mgw/devices`)).json()
  const phoneRow = devices.devices.find((device) => device.name === 'Phone A')
  assert.ok(phoneRow, JSON.stringify(devices))
  const revoke = await instance.post(`devices/${phoneRow.id}/revoke`)
  assert.equal(revoke.status, 200)
  const [closeCode] = await Promise.race([phoneClosed, delay(3_000).then(() => ['timeout'])])
  assert.equal(closeCode, CLOSE_REVOKED, `the revoked device's socket must close with 4401, got ${closeCode}`)
  const payload = (await instance.post('pair', { name: 'Unused', publicUrl: endpoint })).data.payload
  assert.equal(await upgradeStatus(endpoint, {
    payload, protocols: ['dsh-mobile-v1'], headers: { Authorization: `Bearer ${phone.token}`, 'X-DSH-Device-ID': 'aaaa0000-0000-4000-8000-000000000001' },
  }), 401, 'a revoked token must be refused on the next upgrade')
  const stillServed = await request(other, { type: 'device-info' })
  assert.equal(stillServed.kind, 'device-info', 'the other device keeps working')
  assert.equal((await request(other, { type: 'sessions' })).kind, 'sessions')
  passed('revoking one device closes its socket with 4401, refuses its next upgrade, leaves the other device working')

  // -------------------------------------------------------------------------
  // 4. device-forget revokes the caller only.
  // -------------------------------------------------------------------------
  const third = await pairDevice('Phone C', 'cccc0000-0000-4000-8000-000000000003')
  const thirdConnection = track(await connect({ payload: (await instance.post('pair', { name: 'Connect C', publicUrl: endpoint })).data.payload,
    token: third.token, deviceId: 'cccc0000-0000-4000-8000-000000000003' }))
  const thirdClosed = once(thirdConnection.ws, 'close')
  // The receipt is written, then the socket closes with 4401 by contract; the
  // frame and the close can race, so both are accepted as evidence of the reply.
  const forgotten = await Promise.race([
    request(thirdConnection, { type: 'device-forget' }),
    thirdClosed.then(() => ({ kind: 'device-forgotten', revoked: true, closedFirst: true })),
  ])
  assert.equal(forgotten.kind, 'device-forgotten', JSON.stringify(forgotten))
  assert.equal(forgotten.revoked, true)
  const [thirdCode] = await Promise.race([thirdClosed, delay(3_000).then(() => ['timeout'])])
  assert.equal(thirdCode, CLOSE_REVOKED)
  const otherAfterForget = await request(other, { type: 'device-info' })
  assert.equal(otherAfterForget.kind, 'device-info', 'forgetting one device must not touch another')
  passed('device-forget revokes the calling device (4401) and nothing else')

  // -------------------------------------------------------------------------
  // 5. Authentication is permanent.
  // -------------------------------------------------------------------------
  // Another device's connection is still live; it is tracked so no request
  // waiter is left hanging when the instance closes.
  const authRoute = await fetch(`${instance.base}/mgw/auth`, { method: 'POST', headers: { Origin: instance.base }, body: '{"enabled":false}' })
  assert.equal(authRoute.status, 404, `POST /mgw/auth must be gone, got ${authRoute.status}`)
  await authRoute.arrayBuffer()
  assert.equal(await upgradeStatus(endpoint, { payload }), 401, 'no credential → 401')
  assert.equal(await upgradeStatus(`${endpoint}?token=${encodeURIComponent(other.token)}`, { payload }), 401, 'query token → 401')
  const status = await instance.status()
  assert.equal(status.requireAuth, true, 'status always reports authentication on')
  assert.equal(status.queryTokenAllowed, false, 'no query-token option is advertised')
  // The schema still accepts a stale `requireAuth: false` (so an old config
  // file loads) but the value has no effect anywhere; the live checks below
  // prove there is no unauthenticated path.
  assert.equal(plugin.Config({ requireAuth: false }).requireAuth, false)
  const debugConfig = await startGateway({ requireAuth: false, remoteControl: { enabled: true }, gatewayMode: 'persistent' })
  try {
    const debugStatus = await debugConfig.waitForLan()
    assert.equal(debugStatus.lan.requireAuth, true)
    const debugEndpoint = debugStatus.lan.urls[0]
    const debugPayload = (await debugConfig.post('pair', { name: 'x', publicUrl: debugEndpoint })).data.payload
    assert.equal(await upgradeStatus(debugEndpoint, { payload: debugPayload }), 401,
      'requireAuth:false must not open an unauthenticated socket')
    assert.equal(plugin.remoteControlEnabled({ requireAuth: false, remoteControl: { enabled: true } }), true)
  } finally {
    await debugConfig.close()
  }
  passed('/mgw/auth is removed, requireAuth:false is inert, every listener still requires a device')

  other.close()
} finally {
  await instance.close()
}

fs.rmSync(temp, { recursive: true, force: true })
// Deliver the report now: the process had nothing else to do, so the exit is
// explicit (a timed-out waiter must never outlive the run).
for (const line of out) process.stdout.write(`${line}\n`)
process.stdout.write(`ALLOWLIST TESTS PASSED (${checks})\n`)
process.exit(0)
