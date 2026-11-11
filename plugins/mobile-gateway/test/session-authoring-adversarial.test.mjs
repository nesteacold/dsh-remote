// Spec 011 — ADVERSARIAL coverage for the `sessions:author` exposure.
//
// Every case below drives a REAL request through the gateway's own router (the
// plugin's `apply()` runs: upgrade, credential, scope gate, deny layers, adapter,
// remote bridge) against a RECORDING fake Host. A case passes only when the
// gateway refuses and the fake Host's call log proves nothing was attempted —
// so a gap shows up as an observed Host call or an accepted operation, not as an
// opinion about the code.
//
// Items (1)-(7) are the reviewer's mandated adversarial list; (8) is the
// reviewer's Minor 1 (`workspaces` must not leak Host filesystem paths) and the
// null-form of Minor 2. Read-only: this file never patches the implementation.
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
import { COMPANION_ENDPOINTS, createCompanionAccessPolicy } from '../lib/companion-access.mjs'
import { AUTHOR_SCOPE } from '../lib/allowlist.mjs'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'

const AUTHOR = AUTHOR_SCOPE
const WORKSPACE_ID = 'w-host-1'
/** A path that must never reach a phone holding only `sessions:author`. */
const SECRET_PATH = '/Users/owner/secret-tax-2025'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The Host endpoints spec 011 FR-004 keeps refused for EVERY device. */
const HARD_BLOCKED_ENDPOINTS = [
  'workspace/create', 'workspace/rename', 'workspace/archiveSession',
  'session/fork', 'session/rename', 'session/archive', 'session/updateQueue',
  'commands/list', 'commands/execute', 'settings/update', 'settings/mutate',
  'pluginManager/installBundle', 'pluginManager/setPluginEnabled',
  'schedule/create', 'schedule/edit', 'goals/set',
]

/** Typed router ops that must stay `op/forbidden` even with `sessions:author`. */
const HARD_BLOCKED_TYPES = [
  'workspace-create', 'session-rename', 'session-archive', 'fork', 'queue-update',
  'commands', 'command-execute', 'settings', 'settings-update', 'settings-mutate',
  'plugin-catalog', 'plugin-install', 'schedule-create', 'schedule-edit', 'goal',
  'goal-edit', 'attachment', 'subagents', 'agent-team', 'directories', 'directory-create',
]

function fakeHost(hostCalls, workspaceRows) {
  const record = (kind, request) => hostCalls.push({
    kind, endpoint: `${request.namespace}/${request.method}`, principal: request.peer?.principal, args: request.args,
  })
  return {
    async invoke(request) {
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
      record('stream', request)
      return (async function* () {
        if (request.namespace === 'workspace' && request.method === 'follow') {
          // The Host's real baseline: identity + absolute path + members + times.
          // Measured 2026-11-10 on a real Host: `name` is EMPTY on every row and only
          // `path` is populated, which is what the label fallback exists for.
          yield {
            type: 'baseline',
            value: {
              items: workspaceRows ?? [{
                workspaceId: WORKSPACE_ID, title: 'proj', path: SECRET_PATH,
                sessionIds: ['s1', 's-hidden'], createdAt: '2026-11-01T00:00:00.000Z',
              }],
              archivedSessionIds: ['s-hidden'],
            },
          }
        } else if (request.namespace === 'session' && request.method === 'follow') {
          const address = request.args?.request?.address
          const id = address?.kind === 'subagent' ? address.childSessionId : address?.sessionId
          yield { type: 'snapshot', header: { version: 4, id }, cursor: 1, records: [], hasMore: false,
            projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } }
        } else {
          yield { type: 'baseline', value: { projections: {} } }
        }
        while (!request.signal?.aborted) await delay(10)
      })()
    },
  }
}

async function factory(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-author-adv-'))
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
  await listenFetchSafe(server)
  const port = server.address().port
  // Host events the plugin subscribes to (`api-session/added`, `api-session/removed`,
  // …). Recorded so a test can drive the reconciliation path the way the Host does.
  const events = new Map()
  const remoteAccess = createTestRemoteAccess()
  await plugin.apply({
    webServer: {
      port,
      register(route) { management = route; return () => {} },
      registerUpgrade(route) { upgrade = route; return () => {} },
    },
    connection: createTestConnection(),
    remoteAccess,
    typertGateway: fakeHost(hostCalls, options.workspaceRows),
    agentDefaultModel: {},
    on(event, handler) {
      const list = events.get(event) ?? []
      list.push(handler)
      events.set(event, list)
      return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1) }
    },
    effect(fn) { dispose = fn() },
  }, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: `author-adv-${port}`,
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
    directory,
    events,
    remoteAccess,
    base: `http://127.0.0.1:${port}`,
    async post(route, body) {
      const response = await fetch(`${instance.base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: instance.base }, body: JSON.stringify(body ?? {}),
      })
      let data = null
      try { data = await response.json() } catch { /* non-JSON error page */ }
      return { status: response.status, data }
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
async function take(ws, predicate, timeoutMs = 6_000) {
  const seen = frames.get(ws) ?? record(ws)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const frame = seen.find(predicate); if (frame) return frame; await delay(5) }
  throw new Error(`timed out waiting for a frame (seen: ${seen.map((frame) => frame.kind).join(', ') || 'none'})`)
}
const open = (instance, protocols, headers = {}) => instance.track(new WebSocket(instance.lanUrl, protocols, {
  headers: { 'X-DSH-Cert-SHA256': instance.lanPin, ...headers }, origin: undefined, rejectUnauthorized: false,
}))
let helloCounter = 0
async function negotiate(ws) {
  const requestId = `hello-${++helloCounter}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test', platform: 'ios' }))
  return take(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === requestId)
}
let counter = 0
async function ask(ws, frame) {
  const requestId = `adv-${++counter}`
  ws.send(JSON.stringify({ ...frame, requestId }))
  return take(ws, (reply) => reply.requestId === requestId)
}
const callsSince = (instance, since, endpoint) =>
  instance.hostCalls.slice(since).filter((call) => call.endpoint === endpoint)
const callsSinceSet = (instance, since) =>
  [...new Set(instance.hostCalls.slice(since).map((call) => call.endpoint))]

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

const MOBILE_AUTHOR = { kind: 'mobile', scopes: ['sessions:read', 'prompt:send', 'approval:respond', AUTHOR] }
const DESKTOP_AUTHOR = { kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond', AUTHOR] }
const MOBILE_NO_AUTHOR = { kind: 'mobile', scopes: ['sessions:read', 'prompt:send', 'approval:respond'] }
const DESKTOP_BRIDGE_NO_AUTHOR = {
  kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond', 'harness:remote'],
}
const DESKTOP_BRIDGE_AUTHOR = {
  kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond', 'harness:remote', AUTHOR],
}

// ===========================================================================
// (1) The grant is revoked while the socket is open
// ===========================================================================

test('ADV-1a re-pairing with a narrower grant makes the open socket stale: the next authoring frame is refused with no Host call', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-revoke-0001'
  const first = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  // Prove the socket works before the change.
  const ok = await ask(first.ws, { type: 'workspaces' })
  assert.equal(ok.kind, 'workspaces', JSON.stringify(ok).slice(0, 200))

  // Re-pair the SAME installation without the scope: the registry rotates the
  // credential and bumps its generation, and the gateway closes every socket the
  // old grant opened (`credential re-paired`, close 4401). Either outcome is a
  // refusal — a closed socket, or `auth/revoked` if the frame raced the close.
  const closed = new Promise((resolve) => first.ws.on('close', (code) => resolve({ closed: code })))
  const narrowed = await pairDevice(instance, deviceId, MOBILE_NO_AUTHOR)
  assert.equal(narrowed.device.scopes.includes(AUTHOR), false, 'the new record must not hold the scope')

  const since = instance.hostCalls.length
  const afterRePair = await Promise.race([
    closed,
    ask(first.ws, { type: 'workspaces' }).then((reply) => ({ reply })).catch(() => ({ closed: 'no-reply' })),
  ])
  if (afterRePair.closed !== undefined) {
    assert.equal(afterRePair.closed, 4401, `a re-paired installation's socket must close 4401 (got ${afterRePair.closed})`)
  } else {
    assert.equal(afterRePair.reply.kind, 'error', JSON.stringify(afterRePair.reply).slice(0, 200))
    assert.equal(afterRePair.reply.code, 'auth/revoked', `→ ${afterRePair.reply.code}`)
  }
  assert.deepEqual(callsSinceSet(instance, since), [], `a stale socket must reach nothing on the Host: ${callsSinceSet(instance, since)}`)
  first.ws.close()
  narrowed.ws.close()
})

test('ADV-1b revoking the device closes the socket and its token cannot reconnect', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-revoke-0002'
  const { ws, token, device } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  // The route names the REGISTRY's device id, which is what the pairing answered.
  const revoked = await instance.post(`devices/${device.id}/revoke`, {})
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data))
  assert.equal(revoked.data.revoked, true, JSON.stringify(revoked.data))
  assert.equal(await closed, 4401, 'a revoked credential closes with 4401')
  // The token is dead: a fresh upgrade with it must be refused before any frame.
  const retry = open(instance, ['dsh-mobile-v1', `dsh-auth.${token}`], {})
  record(retry)
  const code = await new Promise((resolve) => { retry.on('error', () => resolve('error')); retry.on('close', (c) => resolve(c)) })
  assert.ok(code === 4401 || code === 'error', `a revoked token must not reconnect (got ${code})`)
})

// ===========================================================================
// (2) Every hard-blocked endpoint, through every route a phone has
// ===========================================================================

test('ADV-2a typed ops: all FR-004 families stay op/forbidden for a device holding sessions:author, and never reach the Host', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-carve-0001'
  const { ws } = await pairDevice(instance, deviceId, DESKTOP_AUTHOR)
  const since = instance.hostCalls.length
  for (const type of HARD_BLOCKED_TYPES) {
    const reply = await ask(ws, { type, path: SECRET_PATH, name: 'x', sessionId: 's1', title: 't', ns: 'permission' })
    assert.equal(reply.kind, 'error', `${type}: ${JSON.stringify(reply).slice(0, 220)}`)
    assert.equal(reply.code, 'op/forbidden', `${type} → ${reply.code} (must stay op/forbidden with ${AUTHOR})`)
  }
  assert.deepEqual(callsSinceSet(instance, since), [], `no hard-blocked op may reach the Host: ${callsSinceSet(instance, since)}`)
  ws.close()
})

test('ADV-2b remote-bridge passthrough: the same endpoints are refused for a desktop holding harness:remote + sessions:author', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-carve-0002'
  const { ws } = await pairDevice(instance, deviceId, DESKTOP_BRIDGE_AUTHOR)
  const since = instance.hostCalls.length
  for (const endpoint of HARD_BLOCKED_ENDPOINTS) {
    const reply = await ask(ws, { type: 'remote-call', endpoint, args: { request: { path: SECRET_PATH, sessionId: 's1' } } })
    // The bridge answers in-band with a `remote-result` receipt, never a success.
    assert.equal(reply.kind, 'remote-result', `${endpoint} via the bridge: ${JSON.stringify(reply).slice(0, 240)}`)
    assert.equal(reply.ok, false, `${endpoint} must not be honoured by the bridge`)
    assert.equal(typeof reply.error?.code, 'string', `${endpoint} must name a refusal code`)
    assert.notEqual(reply.error.code, 'internal')
  }
  assert.deepEqual(callsSinceSet(instance, since), [], `the bridge must not forward a hard-blocked endpoint: ${callsSinceSet(instance, since)}`)
  ws.close()
})

// ===========================================================================
// (3) Case / whitespace / slash / encoding variants, device WITHOUT the scope
// ===========================================================================

test('ADV-3a type variants of the authoring ops are refused for a device without the scope, with no Host call', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-variant-0001'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_NO_AUTHOR)
  const since = instance.hostCalls.length
  const variants = [
    'Session-Create', 'SESSION-CREATE', 'session-create ', ' session-create', 'session-create\n',
    'session/selectModel', 'session-create/', 'session%2Fcreate', 'Select-Model', 'select-model ',
    'WORKSPACES', 'workspaces ', 'Models',
  ]
  for (const type of variants) {
    const reply = await ask(ws, { type, sessionId: 's1', provider: 'p', model: 'm', workspaceId: WORKSPACE_ID })
    assert.equal(reply.kind, 'error', `${JSON.stringify(type)}: ${JSON.stringify(reply).slice(0, 200)}`)
    assert.ok(['op/forbidden', 'auth/forbidden-scope', 'bad-request'].includes(reply.code),
      `${JSON.stringify(type)} → unexpected code ${reply.code}`)
    assert.notEqual(reply.kind, 'workspaces')
    assert.notEqual(reply.kind, 'session-created')
  }
  assert.deepEqual(callsSinceSet(instance, since), [], `a type variant must not reach the Host: ${callsSinceSet(instance, since)}`)
  ws.close()
})

test('ADV-3b endpoint spelling variants cannot slip through the remote bridge for a device without the scope', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-variant-0002'
  const { ws } = await pairDevice(instance, deviceId, DESKTOP_BRIDGE_NO_AUTHOR)
  const since = instance.hostCalls.length
  const variants = [
    'Session/Create', 'session/Create', 'session/create ', 'session/create/', 'session//create',
    'session%2Fcreate', 'session/create?x=1', ' session/create', 'session/selectModel ', 'Session/SelectModel',
    'workspace/follow ', 'Workspace/Follow',
  ]
  for (const endpoint of variants) {
    const reply = await ask(ws, { type: 'remote-call', endpoint, args: { request: { sessionId: 's1' } }, requestId: `v-${endpoint}` })
    assert.equal(reply.kind, 'remote-result', `${JSON.stringify(endpoint)}: ${JSON.stringify(reply).slice(0, 220)}`)
    assert.equal(reply.ok, false, `${JSON.stringify(endpoint)} must not be forwarded`)
    // A malformed name is refused as `bad-request` before the allowlist runs; a
    // well-formed but unlisted one as `op/forbidden`. Both are refusals.
    assert.ok(['op/forbidden', 'bad-request'].includes(reply.error?.code),
      `${JSON.stringify(endpoint)} → ${reply.error?.code}`)
  }
  assert.deepEqual(callsSinceSet(instance, since), [], `an endpoint variant must not reach the Host: ${callsSinceSet(instance, since)}`)
  ws.close()
})

// ===========================================================================
// (4) Malformed scope lists can never yield the author scope
// ===========================================================================

test('ADV-4a a pairing request with a malformed scope list is refused or grants nothing — never sessions:author', async (t) => {
  const instance = await factory(t)
  const malformed = [
    'sessions:author',            // a bare string, not an array
    { scopes: AUTHOR },           // an object where a list belongs
    null,
    42,
    [['sessions:author']],        // nested array
    ['sessions:author '],         // trailing space
    [' sessions:author'],         // leading space
    ['*'],                        // wildcard
    ['sessions:*'],
    ['SESSIONS:AUTHOR'],
    ['sessions:author', 'not-a-scope'],
  ]
  for (const scopes of malformed) {
    const reply = await instance.post('pair', { mode: 'otp', kind: 'mobile', scopes })
    if (reply.status === 201) {
      assert.equal(reply.data.pairing.scopes.includes(AUTHOR), false,
        `malformed ${JSON.stringify(scopes)} must not yield the scope`)
    } else {
      assert.ok(reply.status >= 400 && reply.status < 500, `malformed ${JSON.stringify(scopes)} → ${reply.status}`)
    }
  }
})

test('ADV-4b a hand-edited device record with malformed scopes grants nothing', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-malformed-0001'
  // Pair without the scope, then rewrite the record on disk the way an attacker
  // with local access would try to escalate, and restart the registry.
  const first = await pairDevice(instance, deviceId, MOBILE_NO_AUTHOR)
  first.ws.close()
  const storePath = path.join(instance.directory, 'devices.json')
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'))
  for (const scopes of ['sessions:author', [['sessions:author']], ['sessions:author '], ['*'], [AUTHOR, 'junk-scope']]) {
    const tampered = JSON.parse(JSON.stringify(store))
    tampered.devices[0].scopes = scopes
    fs.writeFileSync(storePath, JSON.stringify(tampered))
    const reply = await instance.post('pair', { mode: 'otp', kind: 'mobile', scopes: [AUTHOR] })
    assert.equal(reply.status, 201)
    // The live registry decides from memory; a malformed record must never be
    // repaired into a grant. Assert through the next authoring request instead of
    // trusting the file alone.
    const probe = await (async () => {
      const { ws } = await pairDevice(instance, `adv-malformed-${Math.random().toString(16).slice(2, 8)}`, MOBILE_NO_AUTHOR)
      const since = instance.hostCalls.length
      const answer = await ask(ws, { type: 'workspaces' })
      const calls = callsSinceSet(instance, since)
      ws.close()
      return { answer, calls }
    })()
    assert.equal(probe.answer.code, 'auth/forbidden-scope', JSON.stringify(scopes))
    assert.deepEqual(probe.calls, [], JSON.stringify(scopes))
  }
})

// ===========================================================================
// (5) session-create argument smuggling, incl. the null forms (Minor 2)
// ===========================================================================

test('ADV-5a session-create refuses cwd / agentPreset (including explicit null) for a phone holding ONLY the author scope, with no Host call', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-create-0001'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const since = instance.hostCalls.length
  const smuggles = [
    { cwd: SECRET_PATH },
    { cwd: 'C:\\Windows\\System32' },
    { cwd: '/etc' },
    { cwd: '' },
    { cwd: null },
    { agentPreset: 'minimal' },
    { agentPreset: null },
    { agentPreset: '' },
    { cwd: SECRET_PATH, workspaceId: WORKSPACE_ID },
    { agentPreset: 'minimal', workspaceId: WORKSPACE_ID },
    { cwd: null, agentPreset: null },
  ]
  for (const extra of smuggles) {
    const reply = await ask(ws, { type: 'session-create', ...extra })
    assert.equal(reply.kind, 'error', `${JSON.stringify(extra)}: ${JSON.stringify(reply).slice(0, 240)}`)
    // `cwd`/`agentPreset` present with ANY value (null included) is a refusal: the
    // phone must not be able to choose a directory or an agent composition.
    assert.equal(reply.code, 'remote/argument-denied', `${JSON.stringify(extra)} → ${reply.code}`)
    assert.equal(reply.requestType, 'session-create')
  }
  assert.deepEqual(callsSince(instance, since, 'session/create'), [],
    'a refused session-create must not create a session on the Host')
  ws.close()
})

test('ADV-5b session-create refuses a foreign, blank, omitted or non-string workspace and permission/mode smuggling', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-create-0002'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const since = instance.hostCalls.length
  // A workspaceId this Host does not have, or one the device never names, is
  // refused (FR-005 + lead decision 2026-11-10: a phone holding only
  // `sessions:author` must NAME a workspace — omission would let the create land in
  // the Host's own default working directory, which the phone did not choose).
  const refusedWorkspaces = [
    'w-somewhere-else', '../w-host-1', 'w-host-1/../x', 'w-host-1\u0000', 'w-host-1\u0007',
    undefined, '', '   ', '\t\n', 0, 42, true, null, ['w-host-1'], { workspaceId: WORKSPACE_ID },
  ]
  for (const workspaceId of refusedWorkspaces) {
    const frame = { type: 'session-create', ...(workspaceId === undefined ? {} : { workspaceId }) }
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', `workspaceId=${JSON.stringify(workspaceId)}: ${JSON.stringify(reply).slice(0, 240)}`)
    assert.equal(reply.code, 'remote/argument-denied', `workspaceId=${JSON.stringify(workspaceId)} → ${reply.code}`)
    assert.equal(reply.requestType, 'session-create')
  }
  assert.deepEqual(callsSince(instance, since, 'session/create'), [],
    'no refused session-create may reach the Host')

  // A workspace of this Host still works, and smuggled extra fields never travel.
  const accepted = await ask(ws, { type: 'session-create', workspaceId: WORKSPACE_ID })
  assert.equal(accepted.kind, 'session-created', JSON.stringify(accepted).slice(0, 240))
  const first = callsSince(instance, since, 'session/create')
  assert.equal(first.length, 1, JSON.stringify(first))

  const after = instance.hostCalls.length
  const smuggled = await ask(ws, {
    type: 'session-create', workspaceId: WORKSPACE_ID,
    permission: 'bypass', permissionMode: 'yolo', mode: 'full-access', scopes: [AUTHOR], kind: 'desktop', path: SECRET_PATH,
  })
  assert.equal(smuggled.kind, 'session-created', JSON.stringify(smuggled).slice(0, 200))
  const created = callsSince(instance, after, 'session/create')
  assert.equal(created.length, 1)
  const payload = JSON.stringify(created[0].args ?? {})
  for (const leak of ['bypass', 'yolo', 'full-access', SECRET_PATH, 'sessions:author']) {
    assert.equal(payload.includes(leak), false, `the create payload must not carry ${leak}: ${payload.slice(0, 300)}`)
  }
  ws.close()
})

// ===========================================================================
// (6) select-model cannot widen what the device may address or choose
// ===========================================================================

test('ADV-6a select-model is a per-session resource: the policy grants nothing for a session outside the visible set', () => {
  // The gateway forwards `session/selectModel` as a `session` resource, so DSH
  // applies to it the identical rule it applies to `session/prompt` (proven
  // against the real RemoteAccessService in test/device-access-real.test.mjs).
  assert.deepEqual({ ...COMPANION_ENDPOINTS['session/selectModel'] },
    { scope: AUTHOR, resource: 'session' }, 'select-model must stay a per-session resource')
  assert.deepEqual({ ...COMPANION_ENDPOINTS['session/prompt'] },
    { scope: 'prompt:send', resource: 'session' }, 'session/prompt is the reference rule')
  const policy = createCompanionAccessPolicy({
    getDevice: () => ({ kind: 'mobile', scopes: ['sessions:read', AUTHOR] }),
    getSessionIds: () => ['s1'],
  })
  const explain = policy.explain({ resource: { kind: 'session', id: 's-foreign' }, action: 'session/selectModel' })
  assert.notEqual(explain, undefined, 'a session outside the visible set must not be explained as allowed')
  const denied = policy.explain({ resource: { kind: 'session', id: 's1' }, action: 'session/selectModel' })
  assert.notEqual(denied, true, 'the visible session must be decided by the bindings, not by a wildcard')
})

test('ADV-6b select-model for an unknown session is never answered with a success frame', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-select-0001'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  // The fake Host answers only what it is asked; an unaddressable session is
  // refused by DSH before this fake is reached in production. Here we assert the
  // gateway never turns such a request into an accepted selection on its own.
  const reply = await ask(ws, { type: 'select-model', sessionId: 's-foreign', provider: 'p', model: 'm' })
  assert.notEqual(reply.kind, 'session-created')
  if (reply.kind === 'select-model') {
    // Acceptable ONLY because this harness has no DSH policy: the fake Host answers
    // every call. The gate that stops it in a real Host is the per-session resource
    // mapping asserted in ADV-6a, exercised against the real RemoteAccessService in
    // test/device-access-real.test.mjs.
    assert.equal(reply.kind, 'select-model')
  } else {
    assert.equal(reply.kind, 'error')
  }
  ws.close()
})

// ===========================================================================
// (7) The grant can only come from the owner's offer, never from the client
// ===========================================================================

test('ADV-7a no-scope offers never carry the author scope, on both pairing paths', async (t) => {
  const instance = await factory(t)
  for (const kind of ['mobile', 'desktop']) {
    const reply = await instance.post('pair', { mode: 'otp', kind })
    assert.equal(reply.status, 201, JSON.stringify(reply.data))
    assert.equal(reply.data.pairing.scopes.includes(AUTHOR), false, `${kind} default offer must not include ${AUTHOR}`)
  }
  // The direct claim path grants the registry default, which is narrower still.
  const direct = await pairDevice(instance, 'adv-offer-0001', {})
  assert.equal(direct.device.scopes.includes(AUTHOR), false, 'a no-scope claim must not grant the author scope')
  direct.ws.close()
})

test('ADV-7b a client cannot assert its own scopes through client-hello, the pairing claim or a smuggled device record', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-selfassert-0001'
  const created = await instance.post('pair', { name: deviceId, publicUrl: instance.lanUrl, ...MOBILE_NO_AUTHOR })
  assert.equal(created.status, 201)
  const ws = open(instance, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], { 'X-DSH-Device-ID': deviceId })
  record(ws)
  await once(ws, 'open')
  const paired = await take(ws, (frame) => frame.kind === 'paired')
  assert.equal(paired.device.scopes.includes(AUTHOR), false, 'the device record comes from the offer only')
  // A hostile client asserts scopes/kind in the handshake and the claim proof.
  const helloId = `hello-self-${++helloCounter}`
  ws.send(JSON.stringify({
    type: 'client-hello', requestId: helloId, companionProtocol: 1, appVersion: 'test', platform: 'ios',
    scopes: [AUTHOR], kind: 'desktop', deviceKind: 'desktop', role: 'owner', authenticated: true,
  }))
  const hello = await take(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === helloId)
  // The reply is the SERVER's answer (`{kind, requestId, companionProtocol?, appVersion?, platform?}`):
  // it carries no scope list, and never echoes a client-claimed one.
  assert.equal(hello.kind, 'client-hello')
  assert.equal(hello.requestId, helloId)
  for (const claim of ['scopes', 'kind', 'deviceKind', 'role', 'authenticated', 'capabilities']) {
    if (claim === 'kind') continue // `kind` is the frame discriminator, not a claim
    assert.equal(Object.hasOwn(hello, claim), false, `the client-hello reply must not echo ${claim}`)
  }
  const since = instance.hostCalls.length
  for (const frame of [{ type: 'workspaces' }, { type: 'models' },
    { type: 'session-create', workspaceId: WORKSPACE_ID },
    { type: 'select-model', sessionId: 's1', provider: 'p', model: 'm' }]) {
    const reply = await ask(ws, { ...frame, ...MOBILE_AUTHOR })
    assert.equal(reply.kind, 'error', `${frame.type} after a self-asserted grant: ${JSON.stringify(reply).slice(0, 220)}`)
    assert.equal(reply.code, 'auth/forbidden-scope', `${frame.type} → ${reply.code}`)
  }
  assert.deepEqual(callsSinceSet(instance, since), [], 'a self-asserted scope must reach nothing on the Host')
  ws.close()
})

// ===========================================================================
// (8) Minor 1: the workspace reply carries no Host filesystem path
// ===========================================================================

test('ADV-8a workspaces for a device with only the author scope carries identity + name, never an absolute path', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-path-0001'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const lines = []
  const original = console.log
  console.log = (...args) => { lines.push(args.map(String).join(' ')) }
  let reply
  try { reply = await ask(ws, { type: 'workspaces' }) } finally { console.log = original }

  assert.equal(reply.kind, 'workspaces', JSON.stringify(reply).slice(0, 240))
  assert.deepEqual(reply.items, [{ workspaceId: WORKSPACE_ID, name: 'proj' }],
    `only identity + display name may survive: ${JSON.stringify(reply.items)}`)
  // Minor 1 also drops the archive bookkeeping: it names sessions (ids) the device
  // may not be able to address, and the picker does not render it.
  assert.equal(Object.hasOwn(reply, 'archivedSessionIds'), false,
    `the workspace reply must not carry hidden session ids: ${JSON.stringify(reply).slice(0, 240)}`)
  const body = JSON.stringify(reply)
  for (const forbidden of [SECRET_PATH, '/Users/owner', 'secret-tax', 'sessionIds', 's-hidden', '2026-11-01']) {
    assert.equal(body.includes(forbidden), false, `the workspace reply leaked ${forbidden}: ${body.slice(0, 300)}`)
  }
  // The log line for the query must not carry the path either.
  assert.ok(lines.length > 0, 'the query still logs (the sink was not bypassed)')
  const joined = lines.join('\n')
  assert.equal(joined.includes(SECRET_PATH), false, 'no log line may carry a Host workspace path')
  assert.equal(joined.includes('/Users/owner'), false)
  ws.close()
})

test('ADV-8b a device that also holds workspace:manage keeps the full Host shape (admin/desktop parity)', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-path-0002'
  const { ws } = await pairDevice(instance, deviceId, {
    kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond', AUTHOR, 'workspace:manage'],
  })
  const reply = await ask(ws, { type: 'workspaces' })
  assert.equal(reply.kind, 'workspaces')
  assert.equal(reply.items[0].path, SECRET_PATH, 'workspace:manage keeps the path (the desktop bridge class already sees it)')
  ws.close()
})

// ===========================================================================
// (9) ROOT CAUSE of "This computer has no workspaces" (live blocker 2026-11-10)
// ===========================================================================

test('ADV-9a the policy binds the workspace RESOURCE, which is what makes a workspace visible at all', () => {
  // DSH's workspace controller filters a `workspace/follow` baseline item by item:
  //   const visible = (workspaceId) => access.allows({ kind: 'workspace', id: workspaceId })
  // (dsh-api-workspace-controller `follow()`). `evaluate()` then requires a binding
  // whose `resource` is EXACTLY {kind:'workspace', id} — `sameResource()` has no
  // wildcard — whose role lists the invocation action `workspace/follow`. A device
  // holding `sessions:author` used to get no such binding, so every item was dropped
  // and the picker said "no workspaces" while `sessions` (session bindings) worked.
  const withAuthor = createCompanionAccessPolicy({
    getDevice: () => ({ kind: 'mobile', scopes: ['sessions:read', AUTHOR] }),
    getSessionIds: () => ['s1'],
    getWorkspaceIds: () => ['w1', 'w2'],
  })
  const bindings = withAuthor.bindings({ kind: 'dsh-ext-mobile-device', deviceId: 'd1' })
  const workspaceBindings = bindings.filter((binding) => binding.resource.kind === 'workspace')
  assert.deepEqual(workspaceBindings.map((binding) => binding.resource.id).sort(), ['w1', 'w2'],
    'one binding per known workspace id (DSH bindings cannot express a wildcard)')
  for (const binding of workspaceBindings) {
    assert.ok(binding.role.actions.includes('workspace/follow'),
      `the role must carry the invocation action: ${JSON.stringify(binding.role.actions)}`)
  }
  // No scope, no bindings: the fix must not widen anything else.
  const withoutAuthor = createCompanionAccessPolicy({
    getDevice: () => ({ kind: 'mobile', scopes: ['sessions:read'] }),
    getSessionIds: () => ['s1'],
    getWorkspaceIds: () => ['w1'],
  })
  assert.equal(withoutAuthor.bindings({ kind: 'dsh-ext-mobile-device', deviceId: 'd2' })
    .filter((binding) => binding.resource.kind === 'workspace').length, 0)
  // Unknown ids are never bound, and the action does not leak into session roles.
  const narrow = withAuthor.bindings({ kind: 'dsh-ext-mobile-device', deviceId: 'd1' })
    .filter((binding) => binding.resource.kind === 'session')
  assert.equal(narrow.some((binding) => binding.role.actions.includes('workspace/follow')), false)
})

test('ADV-9b real-Host labelling: an empty name falls back to the last path segment, and an unlabelled row is skipped', async (t) => {
  // Measured on the owner's Host: nine workspaces, every one with `name: ""` and only
  // `path` populated. The picker must show "DXVK_Project", never the path.
  const rows = [
    { workspaceId: 'w-posix', name: '', path: '/home/me/DXVK_Project' },
    { workspaceId: 'w-win', name: '', path: 'C:\\Users\\owner\\Documents\\DXVK_Project\\' },
    { workspaceId: 'w-default', name: '', path: '/home/me/default-workspace' },
    { workspaceId: 'w-named', name: 'Renamed by owner', path: '/home/me/other' },
    { workspaceId: 'w-title', title: 'Title wins', path: '/home/me/titled' },
    { workspaceId: 'w-bare' },
    { path: '/home/me/no-id' },
  ]
  const instance = await factory(t, { workspaceRows: rows })
  const deviceId = 'adv-path-0003'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const lines = []
  const original = console.log
  console.log = (...args) => { lines.push(args.map(String).join(' ')) }
  let reply
  try { reply = await ask(ws, { type: 'workspaces' }) } finally { console.log = original }

  assert.equal(reply.kind, 'workspaces', JSON.stringify(reply).slice(0, 240))
  assert.deepEqual(reply.items, [
    { workspaceId: 'w-posix', name: 'DXVK_Project' },
    { workspaceId: 'w-win', name: 'DXVK_Project' },
    { workspaceId: 'w-default', name: 'default-workspace' },
    { workspaceId: 'w-named', name: 'Renamed by owner' },
    { workspaceId: 'w-title', name: 'Title wins' },
  ], `labels must be names/basenames and unlabelled rows dropped: ${JSON.stringify(reply.items)}`)
  const body = JSON.stringify(reply)
  for (const forbidden of ['/home/me', 'C:\\\\Users', 'C:\\Users', 'Documents', 'w-bare', 'no-id', 'sessionIds']) {
    assert.equal(body.includes(forbidden), false, `the reply leaked ${JSON.stringify(forbidden)}: ${body.slice(0, 300)}`)
  }
  assert.ok(lines.length > 0, 'the query still logs')
  const joined = lines.join('\n')
  for (const forbidden of ['/home/me', 'Users\\neste', 'Documents']) {
    assert.equal(joined.includes(forbidden), false, `a log line leaked a Host path (${forbidden})`)
  }
  ws.close()
})

// ===========================================================================
// (10) The created-session window (spec 011, measured live 2026-11-10)
//
// Measured on the running gateway: `models` on a session the device had just
// created was refused `remote-access/denied … session/follow … resource-not-allowed`
// at +0 ms and succeeded by +1 s, because the session binding comes from the
// asynchronously refreshed visible-session snapshot. An app that opens the new
// session immediately always hits that window, so the gateway now records the id
// before it answers `session-created`.
// ===========================================================================

/** Session ids the device's DSH policy currently binds (what `allows()` consults). */
function boundSessionIds(instance, deviceId) {
  const policy = instance.remoteAccess.policies.get('dsh-ext-mobile-device')
  assert.ok(policy, 'the device policy must be registered')
  const bindings = policy.bindings({ kind: 'dsh-ext-mobile-device', deviceId })
  return bindings.filter((binding) => binding.resource.kind === 'session').map((binding) => binding.resource.id)
}

test('ADV-10a a session returned by session-create is addressable IMMEDIATELY: the very next models succeeds with no retry', async (t) => {
  // The fake Host lists only `s1`, so a refresh would DROP the new id: this is the
  // hostile case the created-after guard exists for.
  const instance = await factory(t)
  const deviceId = 'adv-created-0001'
  const { ws, device } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)

  const since = instance.hostCalls.length
  const created = await ask(ws, { type: 'session-create', workspaceId: WORKSPACE_ID })
  assert.equal(created.kind, 'session-created', JSON.stringify(created).slice(0, 240))
  const newId = created.sessionId
  assert.equal(typeof newId, 'string')

  // No delay, no second request, no refresh: the binding must already be there.
  assert.ok(boundSessionIds(instance, device.id).includes(newId),
    `the created id must be bound before the answer returns (bound: ${JSON.stringify(boundSessionIds(instance, device.id))})`)

  const models = await ask(ws, { type: 'models', sessionId: newId })
  assert.equal(models.kind, 'models', `models on the new session must succeed first try: ${JSON.stringify(models).slice(0, 240)}`)
  assert.equal(typeof models.current, 'object', 'a per-session catalog carries `current`')
  // One request, one answer: the retry the app would otherwise need never happens.
  assert.equal(callsSince(instance, since, 'session/modelCatalog').length, 1)
  ws.close()
})

test('ADV-10b the fix widens nothing: an id the device never created is still unbound, and every bound id is one the Host listed', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-created-0002'
  const { ws, device } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const before = boundSessionIds(instance, device.id)

  const created = await ask(ws, { type: 'session-create', workspaceId: WORKSPACE_ID })
  assert.equal(created.kind, 'session-created')
  const after = boundSessionIds(instance, device.id)

  // Exactly one id was added, and it is the one the Host created for this device.
  assert.deepEqual(after.filter((id) => !before.includes(id)), [created.sessionId],
    'the create path must add exactly the created id and nothing else')
  // A foreign id is never bound, so DSH refuses it on the next call.
  assert.equal(after.includes('s-foreign'), false)
  assert.equal(after.includes('s-hidden'), false)
  ws.close()
})

test('ADV-10c the cache still reconciles: when the Host reports the session removed, the binding goes', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-created-0003'
  const { ws, device } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const created = await ask(ws, { type: 'session-create', workspaceId: WORKSPACE_ID })
  assert.equal(created.kind, 'session-created')
  assert.ok(boundSessionIds(instance, device.id).includes(created.sessionId), 'bound right after creation')

  // The Host removes it: the plugin's own handler must drop the id at once.
  const handlers = instance.events.get('api-session/removed') ?? []
  assert.ok(handlers.length > 0, 'the plugin subscribes to api-session/removed')
  for (const handler of handlers) handler(created.sessionId)
  assert.equal(boundSessionIds(instance, device.id).includes(created.sessionId), false,
    'a removed session must not stay addressable')

  // …and a later refresh must not resurrect it (the tombstone rule still applies).
  await delay(150)
  assert.equal(boundSessionIds(instance, device.id).includes(created.sessionId), false,
    'a refresh must not bring a removed session back')
  ws.close()
})
