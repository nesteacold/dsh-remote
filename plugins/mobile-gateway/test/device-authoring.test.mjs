// Spec 011 — a paired device that holds `sessions:author` may list this Host's
// workspaces, list the model catalog, create a session and pick its model.
//
// Runs the plugin's real `apply()` (router, scope gate, device adapters) against
// a RECORDING typertGateway, so the fake Host's call log is the evidence for
// "refused before any Host call": a refused frame must leave no `session/create`,
// `session/selectModel` or `session/modelCatalog` behind.
//
// This file proves the PLUGIN wiring. DSH's own enforcement of a session a device
// may not address (`session/selectModel` is mapped as a `session` resource, so the
// Host applies the identical rule it applies to `session/prompt`) is proven with
// the real RemoteAccessService in test/device-access-real.test.mjs; the policy
// mapping itself — including select-model vs prompt on a foreign session — is
// proven in test/companion-access.test.mjs. Case A-8 drives that same rule over
// the wire, against a fake Host that decides like DSH.
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
import { AUTHOR_SCOPE, OP_FORBIDDEN, SESSIONS_AUTHOR_TYPES } from '../lib/allowlist.mjs'
import { COMPANION_PRINCIPAL_KIND } from '../lib/companion-access.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The one workspace this fake Host has. */
const WORKSPACE_ID = 'w-host-1'

// ---------------------------------------------------------------------------
// A fake Host that decides like DSH
// ---------------------------------------------------------------------------

// DSH resolves the resource a Remote call touches and consults the policy the
// plugin registered BEFORE the endpoint's handler runs (the rules copied from the
// installed 0.2.2-rc.1 in test/companion-access.test.mjs). The plain fake below
// accepts everything; case A-8 turns this gate on so that "refused" and "the Host
// was never called" are one observation instead of two promises.
const sameResource = (a, b) => a.kind === b.kind && a.id === b.id

/** The resource DSH resolves: a `sessionId` at the top level or in the first object argument. */
function resourceOf(args) {
  const sessionIdOf = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const address = value.address
    const id = value.sessionId ?? (address === undefined
      ? undefined
      : address.kind === 'session' ? address.sessionId : address.childSessionId)
    return typeof id === 'string' && id !== '' ? id : undefined
  }
  const top = sessionIdOf(args)
  if (top !== undefined) return { kind: 'session', id: top }
  for (const value of Object.values(args ?? {})) {
    const nested = sessionIdOf(value)
    if (nested !== undefined) return { kind: 'session', id: nested }
  }
  return { kind: 'global' }
}

/**
 * `undefined` when the policy allows the call, the refusal reason otherwise.
 * An owner Peer is never gated: DSH skips owners.
 */
function remoteAccessRefusal(remoteAccess, request) {
  const principal = request.peer?.principal
  if (!principal || principal.kind === 'owner') return undefined
  const action = `${request.namespace}/${request.method}`
  const policy = remoteAccess.policies.get(principal.kind)
  if (!policy) return 'no-allow'
  const resource = resourceOf(request.args)
  let bindings
  try { bindings = policy.bindings(principal) } catch { return 'policy-failed' }
  const allowed = bindings.some((binding) =>
    sameResource(binding.resource, resource) && binding.role.actions.includes(action))
  if (allowed) return undefined
  try {
    return policy.explain?.({ principal, action, resources: [resource], args: request.args }) ?? 'no-allow'
  } catch { return 'policy-failed' }
}

/** Fake Host: records every served Remote call, and answers only what authoring needs. */
function fakeHost(hostCalls, options = {}) {
  const { decide, denials } = options
  const record = (kind, request) => hostCalls.push({
    kind,
    endpoint: `${request.namespace}/${request.method}`,
    principal: request.peer?.principal,
    args: request.args,
  })
  // A denied call is never served, so it leaves no entry in `hostCalls`.
  const admit = (request) => {
    if (decide === undefined) return
    const reason = decide(request)
    if (reason === undefined) return
    if (denials !== undefined) denials.push({ endpoint: `${request.namespace}/${request.method}`, reason })
    throw Object.assign(new Error(`remote access denied: ${reason}`), {
      code: 'remote-access/denied', details: { reason },
    })
  }
  return {
    async invoke(request) {
      admit(request)
      record('invoke', request)
      const { namespace, method } = request
      if (namespace === 'session' && method === 'list') return { items: [{ sessionId: 's1' }] }
      if (namespace === 'session' && method === 'modelCatalog') {
        return { default: { provider: 'p', model: 'm' }, routableProviders: ['p'], groups: [], failures: [] }
      }
      if (namespace === 'session' && method === 'create') return { sessionId: 's-new' }
      if (namespace === 'session' && method === 'selectModel') {
        return { provider: request.args?.request?.provider, model: request.args?.request?.model }
      }
      return {}
    },
    async stream(request) {
      admit(request)
      record('stream', request)
      return (async function* () {
        if (request.namespace === 'workspace' && request.method === 'follow') {
          yield { type: 'baseline', value: { items: [{ workspaceId: WORKSPACE_ID, path: '/srv/proj' }], archivedSessionIds: [] } }
        } else if (request.namespace === 'session' && request.method === 'follow') {
          const address = request.args?.request?.address
          const id = address?.kind === 'subagent' ? address.childSessionId : address?.sessionId
          yield { type: 'snapshot', header: { version: 4, id }, cursor: 1, records: [], hasMore: false,
            projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } }
        } else {
          yield { type: 'baseline', value: { projections: {} } }
        }
        while (!request.signal.aborted) await delay(10)
      })()
    },
  }
}

async function factory(t, { enforcePolicy = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-authoring-'))
  const sockets = []
  const hostCalls = []
  const denials = []
  let management
  let upgrade
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) { management.handler(req, res); return }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  // fetch-safe: undici refuses whole classes of ports ("bad port"), and `listen(0)`
  // returns whatever the OS picks; the helper re-binds until `fetch` accepts it.
  await listenFetchSafe(server)
  const port = server.address().port
  const remoteAccess = createTestRemoteAccess()
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => {} },
      registerUpgrade(route) { upgrade = route; return () => {} },
    },
    connection: createTestConnection(),
    remoteAccess,
    typertGateway: fakeHost(hostCalls, enforcePolicy
      ? { decide: (request) => remoteAccessRefusal(remoteAccess, request), denials }
      : {}),
    agentDefaultModel: {},
    on() { return () => {} },
    effect(fn) { dispose = fn() },
  }
  await plugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: `authoring-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    requireHostApproval: false,
  })
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    try { dispose() } catch { /* already disposed */ }
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    hostCalls,
    denials,
    remoteAccess,
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
async function take(ws, predicate, timeoutMs = 5_000) {
  const seen = frames.get(ws) ?? record(ws)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const frame = seen.find(predicate); if (frame) return frame; await delay(5) }
  throw new Error(`timed out waiting for a frame (${seen.map((frame) => frame.kind).join(', ')})`)
}
const open = (instance, protocols, headers = {}) => instance.track(new WebSocket(instance.lanUrl, protocols, {
  headers: { 'X-DSH-Cert-SHA256': instance.lanPin, ...headers }, origin: undefined, rejectUnauthorized: false,
}))
let helloCounter = 0
/** Contract §3.6/§5a: operations wait for the acknowledged client-hello. */
async function negotiate(ws) {
  const requestId = `hello-${++helloCounter}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test', platform: 'ios' }))
  return take(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === requestId)
}
/** Pair a device with an EXPLICIT grant, and return its live connection. */
async function pairDevice(instance, deviceId, offer) {
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
let counter = 0
async function ask(ws, frame) {
  const requestId = `q-${++counter}`
  ws.send(JSON.stringify({ ...frame, requestId }))
  return take(ws, (reply) => reply.requestId === requestId)
}

/** Calls the fake Host received for one endpoint, after `since`. */
const callsSince = (instance, since, endpoint) =>
  instance.hostCalls.slice(since).filter((call) => call.endpoint === endpoint)

const AUTHOR = {
  mobile: { kind: 'mobile', scopes: ['sessions:read', 'prompt:send', 'approval:respond', AUTHOR_SCOPE] },
  desktop: { kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond', AUTHOR_SCOPE] },
}

/** The four authoring operations, as a paired client sends them. */
const AUTHORING_FRAMES = [
  { type: 'workspaces' },
  { type: 'models' },
  { type: 'session-create', workspaceId: WORKSPACE_ID },
  { type: 'select-model', sessionId: 's1', provider: 'p', model: 'm' },
]

// ---------------------------------------------------------------------------
// Positive matrix — mobile and desktop with the scope
// ---------------------------------------------------------------------------

for (const [label, offer] of [['mobile', AUTHOR.mobile], ['desktop', AUTHOR.desktop]]) {
  test(`A-1 positive: a ${label} device holding ${AUTHOR_SCOPE} reaches all four authoring handlers`, async (t) => {
    const instance = await factory(t)
    const { ws } = await pairDevice(instance, `auth-${label}-0001`, offer)

    const since = instance.hostCalls.length

    // `workspaces` → workspace/list through the adapter's `workspace/follow` baseline.
    const workspaces = await ask(ws, { type: 'workspaces' })
    assert.equal(workspaces.kind, 'workspaces', JSON.stringify(workspaces).slice(0, 300))
    // The device projection keeps identity + a display label only; with no Host
    // `name`/`title` the label is the last path segment (spec 011 Minor 1).
    assert.deepEqual(workspaces.items, [{ workspaceId: WORKSPACE_ID, name: 'proj' }])
    assert.equal(callsSince(instance, since, 'workspace/follow').length > 0, true, 'workspace/follow reached the Host')

    // `models` (no session) → the Host-wide catalog.
    const models = await ask(ws, { type: 'models' })
    assert.equal(models.kind, 'models', JSON.stringify(models).slice(0, 300))
    assert.deepEqual(models.groups, [])
    assert.equal(callsSince(instance, since, 'session/modelCatalog').length > 0, true, 'session/modelCatalog reached the Host')

    // `models` (with a session) → the per-session catalog.
    const perSession = await ask(ws, { type: 'models', sessionId: 's1' })
    assert.equal(perSession.kind, 'models', JSON.stringify(perSession).slice(0, 300))
    assert.equal(perSession.current.provider, 'p')

    // `session-create` in a workspace of this Host → the upstream create handler.
    const created = await ask(ws, { type: 'session-create', workspaceId: WORKSPACE_ID })
    assert.equal(created.kind, 'session-created', JSON.stringify(created).slice(0, 300))
    assert.equal(created.sessionId, 's-new')
    const createCalls = callsSince(instance, since, 'session/create')
    assert.equal(createCalls.length, 1, JSON.stringify(createCalls))
    assert.deepEqual(createCalls[0].args, { request: { workspaceId: WORKSPACE_ID } })

    // `select-model` → the upstream select handler, on the session the device named.
    const selected = await ask(ws, { type: 'select-model', sessionId: 's1', provider: 'p', model: 'm' })
    assert.equal(selected.kind, 'select-model', JSON.stringify(selected).slice(0, 300))
    const selectCalls = callsSince(instance, since, 'session/selectModel')
    assert.equal(selectCalls.length, 1, JSON.stringify(selectCalls))
    assert.deepEqual(selectCalls[0].args, { request: { sessionId: 's1', provider: 'p', model: 'm' } })

    // Every authoring call went through THIS device's non-owner adapter: the
    // Host-side policy and the positive guard see all of them (never the owner).
    const authoring = instance.hostCalls.slice(since).filter((call) =>
      ['session/create', 'session/selectModel', 'session/modelCatalog', 'workspace/follow'].includes(call.endpoint))
    assert.ok(authoring.length > 0)
    for (const call of authoring) {
      assert.equal(call.principal?.kind, 'dsh-ext-mobile-device', `${call.endpoint} must run as the device`)
      assert.equal(typeof call.principal?.deviceId, 'string')
    }
    ws.close()
  })
}

// ---------------------------------------------------------------------------
// Negative matrix — no scope, or harness:remote alone
// ---------------------------------------------------------------------------

const NEGATIVE_CASES = [
  ['a mobile device without the scope', { kind: 'mobile', scopes: ['sessions:read', 'prompt:send', 'approval:respond'] }],
  ['a desktop device without the scope', { kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond'] }],
  ['a desktop device with harness:remote alone', { kind: 'desktop', scopes: ['harness:remote'] }],
]

for (const [label, offer] of NEGATIVE_CASES) {
  test(`A-2 negative: ${label} is refused all four and no Host call is attempted`, async (t) => {
    const instance = await factory(t)
    const { ws } = await pairDevice(instance, `noauth-${label.length}-0001`, offer)
    const since = instance.hostCalls.length
    for (const frame of AUTHORING_FRAMES) {
      const reply = await ask(ws, frame)
      assert.equal(reply.kind, 'error', `${label} ${frame.type}: ${JSON.stringify(reply).slice(0, 200)}`)
      assert.equal(reply.code, 'auth/forbidden-scope', `${label} ${frame.type} → ${reply.code}`)
      assert.equal(reply.requestType, frame.type)
      assert.equal(reply.scope, AUTHOR_SCOPE, `${label} ${frame.type} must name the missing scope`)
    }
    // The fake's call log is the evidence: not one authoring endpoint was touched.
    for (const endpoint of ['session/create', 'session/selectModel', 'session/modelCatalog']) {
      assert.equal(callsSince(instance, since, endpoint).length, 0, `${label} reached ${endpoint}`)
    }
    assert.equal(callsSince(instance, since, 'workspace/follow').length, 0, `${label} reached workspace/follow as a device`)
    ws.close()
  })
}

// ---------------------------------------------------------------------------
// FR-004: the carve-outs stay refused even WITH the scope
// ---------------------------------------------------------------------------

test('A-3 carve-outs: a device holding sessions:author still cannot mutate a workspace or a session', async (t) => {
  const instance = await factory(t)
  const { ws } = await pairDevice(instance, 'auth-carve-0001', AUTHOR.mobile)
  const since = instance.hostCalls.length
  // Each of these is a router type outside the authoring family; with the scope
  // held they must still be refused, and never reach the Host.
  for (const type of [
    'workspace-create', 'session-rename', 'fork', 'queue-update', 'attachment', 'session-archive',
    'commands', 'command-execute', 'settings', 'settings-update', 'plugin-catalog', 'schedule-create',
  ]) {
    const reply = await ask(ws, { type, path: '/tmp/x', sessionId: 's1', title: 't', name: 'x' })
    assert.equal(reply.kind, 'error', `${type}: ${JSON.stringify(reply).slice(0, 200)}`)
    assert.equal(reply.code, OP_FORBIDDEN, `${type} must stay ${OP_FORBIDDEN}, got ${reply.code}`)
  }
  for (const endpoint of ['workspace/create', 'workspace/rename', 'workspace/archiveSession', 'session/fork',
    'session/rename', 'session/updateQueue', 'session/attachment', 'session/canOpenWorkspacePath',
    'commands/execute', 'settings/mutate', 'pluginManager/installBundle', 'schedule/create']) {
    assert.equal(callsSince(instance, since, endpoint).length, 0, `${endpoint} must not reach the Host`)
  }
  ws.close()
})

// ---------------------------------------------------------------------------
// FR-005: the argument rules the desktop bridge already enforces
// ---------------------------------------------------------------------------

test('A-4 argument rule: session-create naming a foreign workspaceId is refused, and session/create is never called', async (t) => {
  const instance = await factory(t)
  const { ws } = await pairDevice(instance, 'auth-arg-0001', AUTHOR.mobile)
  const since = instance.hostCalls.length
  const reply = await ask(ws, { type: 'session-create', workspaceId: 'w-somewhere-else' })
  assert.equal(reply.kind, 'error', JSON.stringify(reply).slice(0, 300))
  assert.equal(reply.code, 'remote/argument-denied')
  assert.equal(reply.requestType, 'session-create')
  assert.equal(callsSince(instance, since, 'session/create').length, 0, 'a foreign workspaceId must not create a session')
  // The rule reads the Host list through the same adapter the call would use.
  assert.equal(callsSince(instance, since, 'workspace/follow').length > 0, true)

  // A workspace of this Host still works on the same connection.
  const accepted = await ask(ws, { type: 'session-create', workspaceId: WORKSPACE_ID })
  assert.equal(accepted.kind, 'session-created', JSON.stringify(accepted).slice(0, 300))
  assert.equal(callsSince(instance, since, 'session/create').length, 1)
  ws.close()
})

test('A-5 argument rule: cwd and agentPreset need workspace:manage (the desktop bridge rule)', async (t) => {
  const instance = await factory(t)
  const { ws } = await pairDevice(instance, 'auth-arg-0002', AUTHOR.mobile)
  const since = instance.hostCalls.length
  for (const extra of [{ cwd: 'C:\\somewhere' }, { cwd: 'C:\\somewhere', workspaceId: WORKSPACE_ID }, { agentPreset: 'preset-1' }]) {
    const reply = await ask(ws, { type: 'session-create', ...extra })
    assert.equal(reply.kind, 'error', JSON.stringify(reply).slice(0, 300))
    assert.equal(reply.code, 'remote/argument-denied', JSON.stringify(extra))
  }
  assert.equal(callsSince(instance, since, 'session/create').length, 0, 'a refused cwd/agentPreset must not create a session')

  // The same device with `workspace:manage` (desktop only) may pass a cwd.
  const desktop = await pairDevice(instance, 'auth-arg-0003', {
    kind: 'desktop', scopes: ['sessions:read', AUTHOR_SCOPE, 'workspace:manage'],
  })
  const desktopSince = instance.hostCalls.length
  const accepted = await ask(desktop.ws, { type: 'session-create', cwd: 'C:\\somewhere' })
  assert.equal(accepted.kind, 'session-created', JSON.stringify(accepted).slice(0, 300))
  assert.equal(callsSince(instance, desktopSince, 'session/create').length, 1)
  ws.close()
  desktop.ws.close()
})

// ---------------------------------------------------------------------------
// The session rule on the wire: a session this device may not address
// ---------------------------------------------------------------------------

test('A-8 session addressing: select-model on a session the device may not address is refused like session/prompt, and session/selectModel is never called', async (t) => {
  // This instance's fake Host decides like DSH (`remoteAccessRefusal` above), so a
  // call the policy denies never reaches the endpoint: the refusal and the empty
  // call log are the same observation.
  const instance = await factory(t, { enforcePolicy: true })
  const { ws, device } = await pairDevice(instance, 'auth-session-0001', AUTHOR.mobile)
  const deviceId = device.id

  // The grant list is a snapshot refreshed asynchronously; wait for the one
  // session this fake Host lists instead of sleeping a fixed time.
  const policy = instance.remoteAccess.policies.get(COMPANION_PRINCIPAL_KIND)
  assert.ok(policy, 'the plugin must register its policy with DSH')
  const addressable = () => (policy.bindings({ kind: COMPANION_PRINCIPAL_KIND, deviceId }) ?? [])
    .some((binding) => binding.resource.kind === 'session' && binding.resource.id === 's1')
  for (let attempt = 0; attempt < 200 && !addressable(); attempt += 1) await delay(10)
  assert.equal(addressable(), true, 'sessions:read must make the Host session s1 addressable')

  // Control: the same endpoint on the session the device MAY address is served.
  const since = instance.hostCalls.length
  const own = await ask(ws, { type: 'select-model', sessionId: 's1', provider: 'p', model: 'm' })
  assert.equal(own.kind, 'select-model', JSON.stringify(own).slice(0, 300))
  assert.equal(callsSince(instance, since, 'session/selectModel').length, 1)

  // The reference refusal: `session/prompt` for a session outside the grant.
  const foreignSince = instance.hostCalls.length
  const prompt = await ask(ws, { type: 'message', sessionId: 's-foreign', clientMsgId: 'c-1', text: 'hi' })
  assert.equal(prompt.kind, 'error', JSON.stringify(prompt).slice(0, 300))
  assert.deepEqual(callsSince(instance, foreignSince, 'session/prompt'), [],
    'the reference refusal must not reach session/prompt')

  // `select-model` touches the same `session` resource, so it is refused the same
  // way — the plugin added no rule of its own, and the Host was never asked.
  const selected = await ask(ws, { type: 'select-model', sessionId: 's-foreign', provider: 'p', model: 'm' })
  assert.equal(selected.kind, 'error', JSON.stringify(selected).slice(0, 300))
  assert.equal(selected.code, prompt.code, 'select-model must reuse the session/prompt rule, not add a second one')
  assert.equal(selected.message, prompt.message, 'both refusals must come from the same policy decision')
  assert.equal(selected.requestType, 'select-model')
  assert.deepEqual(callsSince(instance, foreignSince, 'session/selectModel'), [],
    'a refused select-model must never reach session/selectModel')
  // Both attempts were stopped by the same policy decision (the fake Host's
  // gateway half), which is why no endpoint ran for either of them.
  const reasonsFor = (endpoint) => [...new Set(instance.denials
    .filter((denial) => denial.endpoint === endpoint).map((denial) => denial.reason))]
  assert.deepEqual(reasonsFor('session/prompt'), ['resource-not-allowed'], JSON.stringify(instance.denials))
  assert.deepEqual(reasonsFor('session/selectModel'), ['resource-not-allowed'], JSON.stringify(instance.denials))
  ws.close()
})

// ---------------------------------------------------------------------------
// No credential in any log line emitted by the authoring path
// ---------------------------------------------------------------------------

test('A-6 no-leak: no device token, Authorization header or pairing code logs during the four ops', async (t) => {
  const instance = await factory(t)
  const { ws, token } = await pairDevice(instance, 'auth-log-0001', AUTHOR.mobile)
  const lines = []
  const original = console.log
  console.log = (...args) => { lines.push(args.map(String).join(' ')) }
  try {
    for (const frame of AUTHORING_FRAMES) await ask(ws, frame)
  } finally {
    console.log = original
  }
  assert.ok(lines.length > 0, 'the authoring path must still log (the sink was not bypassed)')
  const joined = lines.join('\n')
  assert.equal(/Bearer\s/i.test(joined), false, 'no Authorization header may be logged')
  assert.equal(joined.includes(token), false, 'the device token may never appear in a log line')
  assert.equal(/\bdsh-pair\./.test(joined), false, 'no pairing subprotocol may be logged')
  assert.equal(/X-DSH-(Cert|Device)/i.test(joined), false, 'no handshake header value may be logged')
  ws.close()
})

// ---------------------------------------------------------------------------
// The four types are the whole surface
// ---------------------------------------------------------------------------

test('A-7 the authoring type list is exactly the four contract types', () => {
  assert.deepEqual([...SESSIONS_AUTHOR_TYPES].sort(), ['models', 'select-model', 'session-create', 'workspaces'])
  for (const type of SESSIONS_AUTHOR_TYPES) assert.equal(type.includes('*'), false)
})
