// Spec 008 P1 — the remote-bridge channel (lib/remote-bridge.mjs + the router hook).
//
//   T1  allowlist: deny by default; every deny-listed endpoint refused, never reaching the Host
//   T2  scope mapping: each allowed endpoint needs its own scope on top of harness:remote
//   T3  harness:remote is desktop-only and never a default
//   T4  a missing harness:remote is refused (the frame types are not companion-v1 ops)
//   T5  `$events/result`: wrong / missing argsHash refused and still pending; correct accepted once
//   T5c/T5d  `$events` needs approval:respond; the Peer declares interactions:answer only then
//   T5e  NO device principal receives a question card on the companion channel (admin-only), audited
//   T6  streams: credit and bufferedAmount backpressure, cancel
//   T7  revoke / socket close abort Host-side streams (4401)
//   T8  no carrier on the Host: a clear refusal, not a crash
//
// A real plugin over the pinned TLS listener, as scope-kind.test.mjs does; the
// Host is a fake typertGateway that records every `dispatchRpc` / `openWireStream`.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import { settlesAt, waitFor } from './support/wait-for.mjs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

import WebSocket from 'ws'
import plugin from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import {
  ENDPOINT_SCOPE, DENY_PATTERNS, authorizeEndpoint, denyReason, createRemoteBridge, splitBinary, iterateBinary,
  scopeForEndpoint, checkArguments, checkArgumentsWithHost, isRelativeWorkspacePath, MAX_GOAL_ROUNDS,
} from '../lib/remote-bridge.mjs'
import { scopeDenial } from '../lib/allowlist.mjs'
import {
  CLOSE_CODES, SCOPES, SCOPE_BY_TYPE, DESKTOP_DEFAULT_SCOPES, DESKTOP_ONLY_SCOPES, SCOPE_PRESETS, REMOTE_BINARY_CHUNK_BYTES,
} from '@dsh-ext/mobile-protocol'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DESK = 'deskbrg0-0000-4000-8000-000000000001'
const ALL_REMOTE = ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote']

// -- fake Host gateway ------------------------------------------------------

function fakeGateway() {
  const calls = []
  const opened = []
  const gateway = {
    calls, opened,
    // 36d9: a device only receives cards for sessions the Host lists to it.
    async invoke(request) { return request?.namespace === 'session' && request?.method === 'list' ? { items: [{ sessionId: 's1' }] } : {} },
    async stream(request) {
      return (async function* () {
        yield { type: 'baseline', value: request.namespace === 'workspace'
          ? { items: [], archivedSessionIds: [] } : { projections: {} } }
        while (!request.signal.aborted) await delay(10)
      })()
    },
    // The private carrier the bridge uses. Peer is the 4th argument.
    async dispatchRpc(endpoint, payload, signal, peer) {
      calls.push({ endpoint, payload, peer })
      if (endpoint === 'session/attachment') {
        return { ok: true, value: { name: 'a.bin', data: new Uint8Array(REMOTE_BINARY_CHUNK_BYTES + 10).fill(7) } }
      }
      if (endpoint === 'session/list') return { ok: true, value: { items: [{ sessionId: 's1' }] } }
      if (endpoint === 'session/modelCatalog') {
        return { ok: true, value: { default: { provider: 'deepseek', model: 'deepseek-chat' },
          groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }], failures: [] } }
      }
      if (endpoint === 'credentials/set') return { ok: true, value: undefined }
      if (endpoint === 'credentials/unset') return { ok: false, error: { code: 'credential-failed', message: 'could not unset sk-SECRET-VALUE-123' } }
      if (endpoint === 'session/cancel') return { ok: false, error: { code: 'session-not-found', message: 'gone', details: {} } }
      return { ok: true, value: { endpoint } }
    },
    openWireStream(endpoint, payload, uplink, peer, signal) {
      // rc.1 only streams forwarded Remote events to a Peer that declared
      // `interactions: 'answer'` (dsh-api-gateway/lib/index.js:1484-1486, called
      // from openWireStream:1012-1016). Mirrored here so the Peer contract the
      // bridge creates is measured, not assumed.
      if (endpoint === '$events' && peer?.interactions !== 'answer') {
        throw Object.assign(new Error('forwarded Remote events require interactions=answer'),
          { code: 'gateway/interactions-forbidden' })
      }
      const stream = { endpoint, payload, peer, signal, produced: 0, returned: false }
      opened.push(stream)
      const make = () => ({
        [Symbol.asyncIterator]() {
          let n = 0
          return {
            async next() {
              while (!signal.aborted && stream.paused) await delay(5)
              if (signal.aborted) return { done: true, value: undefined }
              n += 1
              stream.produced = n
              await delay(1)
              // The $events card stream: one waterfall frame, then it holds.
              if (endpoint === '$events') {
                return n === 1
                  ? { done: false, value: { type: 'waterfall', event: 'approval/request', eventId: 'evt-1', agentId: 's1',
                    request: { toolName: 'bash', callId: 'call-1', argsPreview: '{"command":"ls"}',
                      argsHash: 'a'.repeat(64) } } }
                  : { done: true, value: undefined }
              }
              // The workspace list the Host would send as the opening baseline.
              if (endpoint === 'workspace/follow') {
                return n === 1
                  ? { done: false, value: { type: 'baseline', value: { items: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }], archivedSessionIds: [] } } }
                  : { done: true, value: undefined }
              }
              if (endpoint === 'session/attachment') {
                return n === 1
                  ? { done: false, value: { name: 'a.bin', data: new Uint8Array(REMOTE_BINARY_CHUNK_BYTES + 10).fill(7) } }
                  : { done: true, value: undefined }
              }
              return { done: false, value: { n } }
            },
            async return() { stream.returned = true; return { done: true, value: undefined } },
          }
        },
      })
      return Promise.resolve(make())
    },
  }
  return gateway
}

async function factory(t, { gateway = fakeGateway(), config = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-008-bridge-'))
  const listeners = {}
  const sockets = []
  let management
  let upgrade
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) {
      management.handler(req, res)
      return
    }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (upgrade) upgrade.handler(req, socket, head)
    else socket.destroy()
  })
  // fetch-safe: see test/support/fetch-safe-listen.mjs — the OS may hand out a
  // port undici refuses, which used to fail this suite for no product reason.
  await listenFetchSafe(server)
  const port = server.address().port
  // The gateway writes its log lines with console.log (lib/logging.mjs); keep a
  // copy so the audit-line assertions can read them.
  const logs = []
  const originalLog = console.log
  console.log = (...parts) => { logs.push(parts.join(' ')); originalLog(...parts) }
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: gateway,
    agentDefaultModel: {},
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m), error: (m) => logs.push(m) },
    on(name, handler) { listeners[name] = handler; return () => {} },
    effect(fn) { dispose = fn() },
  }
  await plugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: `spec008-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    // These tests pair directly with the long string; the Host-approval step
    // (spec 008 P1b, default on) is covered by pairing-approval.test.mjs.
    requireHostApproval: false,
    ...config,
  })
  t.after(async () => {
    console.log = originalLog
    for (const socket of sockets) socket.terminate()
    dispose()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    port, gateway, listeners, logs,
    base: `http://127.0.0.1:${port}`,
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

const buffers = new WeakMap()
function recordFrames(ws) {
  const seen = []
  buffers.set(ws, seen)
  ws.on('message', (data) => { try { seen.push(JSON.parse(data.toString())) } catch { /* not ours */ } })
  ws.on('error', () => {})
  return seen
}
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
const framesOf = (ws, predicate) => (buffers.get(ws) ?? []).filter(predicate)

function openLan(instance, protocols, headers = {}) {
  return instance.track(new WebSocket(instance.lanUrl, protocols, {
    headers: { 'X-DSH-Cert-SHA256': instance.lanPin, ...headers }, origin: undefined, rejectUnauthorized: false,
  }))
}

/** Contract §3.6/§5a: operations wait for the acknowledged client-hello. */
let helloCounter = 0
async function negotiate(ws) {
  const requestId = `hello-${++helloCounter}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test', platform: 'ios' }))
  return takeFrame(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === requestId)
}

async function pairDevice(instance, deviceId, offer) {
  const created = await instance.post('pair', { name: deviceId, publicUrl: instance.lanUrl, ...offer })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ws = openLan(instance, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], { 'X-DSH-Device-ID': deviceId })
  recordFrames(ws)
  await once(ws, 'open')
  const paired = await takeFrame(ws, (frame) => frame.kind === 'paired')
  await takeFrame(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return { ws, token: paired.token, device: paired.device }
}

async function connectToken(instance, token, deviceId) {
  const ws = openLan(instance, ['dsh-mobile-v1'], { Authorization: `Bearer ${token}`, 'X-DSH-Device-ID': deviceId })
  recordFrames(ws)
  await once(ws, 'open')
  await takeFrame(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return ws
}

let counter = 0
async function call(ws, endpoint, args = {}) {
  const requestId = `rb-${++counter}`
  ws.send(JSON.stringify({ type: 'remote-call', requestId, endpoint, args }))
  return takeFrame(ws, (frame) => frame.requestId === requestId)
}

/** A paired desktop holding every remote scope, connected. */
async function desktop(instance, scopes = ALL_REMOTE, deviceId = DESK) {
  const layout = await pairDevice(instance, deviceId, { kind: 'desktop', scopes })
  const ws = await connectToken(instance, layout.token, deviceId)
  return { ...layout, ws }
}

// -- T1/T2: allowlist -------------------------------------------------------

// Spec 008 "full control": nothing is blocked by design, but only the endpoints a scope names are
// forwarded. These stay refused for EVERY device, whatever its scopes (and so does anything unknown).
const NEVER = [
  'credentials/describe', 'credentials/resolve', 'credentials/get', 'credentials/read', 'credentials/list',
  'credentials/export', 'credentials/anything',
  'pluginInventory/list',
  'remoteAccess/follow', 'claudeCodeMods/pressBand', 'claudeCodeMods/watchBand',
  'workspace/insertBefore', 'workspace/insertSessionBefore', 'workspace/unarchiveSession',
  'workspace/initializeDefault', 'workspace/pinSession', 'workspace/unpinSession',
  'workspaceFiles/readAll', 'workspaceFiles/readRelated', 'workspaceFiles/anything',
  'session/doesNotExist', 'brandNew/method', 'workspace/archive',
]

// Every scope -> the endpoints it (alone, on top of harness:remote) unlocks. The complete table.
const SCOPE_TABLE = {
  'sessions:read': ['session/list', 'session/follow', 'session/events', 'session/page', 'session/search',
    'session/projections', 'session/attachment', 'session/workspacePathApplications',
    'session/canOpenWorkspacePath', 'session/control', 'workspace/follow', 'subagents/list', 'job/list',
    'job/follow', 'skills/list', 'agentPresets/list', 'agentPresets/read', 'commands/list', 'llm/listProviders',
    'llm/listConfigurableProviders', 'llm/discoverModels', 'permissionPresets/catalog', 'messageFeedback/list',
    'schedule/list', 'schedule/catalog', 'schedule/history', 'schedule/deliveryLimits', 'toolResults/watch'],
  'prompt:send': ['session/prompt', 'session/create', 'session/fork', 'session/cancel', 'session/rename',
    'session/updateQueue', 'session/modelCatalog',
    'subagents/interruptByParent', 'subagents/prompt', 'messageFeedback/put', 'messageFeedback/delete', 'job/kill',
    'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/clear', 'goals/complete',
    'workspace/rename', 'workspace/archiveSession'],
  'approval:respond': ['userQuestions/answer', 'userQuestions/attachWait', '$events', '$events/result'],
  'files:read': ['workspaceFiles/list', 'workspaceFiles/stat', 'workspaceFiles/read', 'workspaceFiles/readBytes',
    'workspaceFiles/changes', 'officeToPdf/render', 'officeToPdf/generation', 'fileReferences/list',
    'sessionReferenceResolver/candidates'],
  'commands:execute': ['commands/execute'],
  'workspace:manage': ['workspace/create', 'workspace/delete', 'directoryPicker/list', 'directoryPicker/pick',
    'directoryPicker/browse'],
  // settings/* is the whole namespace (including methods a later DSH adds).
  'settings:write': ['settings/describe', 'settings/mutate', 'settings/replace', 'settings/update',
    'settings/someFutureMethod', 'agentPresets/select', 'session/selectModel', 'session/initializeDefaultModel'],
  'credentials:write': ['credentials/set', 'credentials/unset'],
  'plugins:manage': ['pluginManager/listBundles', 'pluginManager/listPlugins', 'pluginManager/setPluginEnabled',
    'pluginManager/updateBundle', 'pluginManager/installBundle', 'pluginManager/someFutureMethod'],
  'schedule:write': ['schedule/create', 'schedule/update', 'schedule/delete', 'schedule/deleteInactive',
    'schedule/run', 'schedule/edit'],
  terminal: ['terminal/attach', 'terminal/follow', 'terminal/write', 'terminal/resize', 'terminal/environment',
    'terminal/retain'],
}
const FULL_DESKTOP = { kind: 'desktop', scopes: [...SCOPES] }
const holding = (...scopes) => ({ kind: 'desktop', scopes: ['harness:remote', ...scopes] })

test('T1: deny by default — endpoints no scope names, and unknown ones, are refused before the Host for every device', async (t) => {
  const instance = await factory(t)
  // A device with EVERY scope: still nothing outside the table gets through.
  const { ws } = await desktop(instance, [...SCOPES])
  const before = instance.gateway.calls.length
  for (const endpoint of NEVER) {
    const reply = await call(ws, endpoint)
    assert.equal(reply.kind, 'remote-result')
    assert.equal(reply.ok, false, `${endpoint} must be refused`)
    assert.equal(reply.error.code, 'op/forbidden', `${endpoint}: ${JSON.stringify(reply)}`)
  }
  // Malformed endpoint names are a bad request, still never forwarded.
  for (const endpoint of ['', 'a', 'a/b/c', '../etc/passwd', 42, null]) {
    const reply = await call(ws, endpoint)
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'bad-request', String(endpoint))
  }
  // `$events/other` is a well-formed name that is simply not on the allowlist.
  assert.equal((await call(ws, '$events/other')).error.code, 'op/forbidden')
  assert.equal(instance.gateway.calls.length, before, 'a refused endpoint must never reach the Host')
  assert.equal(instance.gateway.opened.length, 0)
})

test('T1b: NEVER endpoints are unreachable for any scope list; the table has no overlap with them', () => {
  for (const endpoint of NEVER) {
    assert.equal(authorizeEndpoint(FULL_DESKTOP, endpoint).ok, false, endpoint)
    assert.equal(scopeForEndpoint(endpoint), undefined, `${endpoint} must not map to a scope`)
  }
  const tabled = Object.values(SCOPE_TABLE).flat()
  assert.equal(new Set(tabled).size, tabled.length, 'an endpoint is listed under exactly one scope')
  for (const endpoint of tabled) assert.equal(denyReason(endpoint), undefined, `${endpoint} is both allowed and denied`)
  assert.ok(DENY_PATTERNS.length > 0)
  // credentials: only set/unset are forwardable. Nothing that could return a secret.
  for (const endpoint of ['credentials/describe', 'credentials/resolve', 'credentials/get', 'credentials/anything']) {
    assert.equal(authorizeEndpoint(FULL_DESKTOP, endpoint).ok, false, endpoint)
  }
  // Prototype keys are not endpoints.
  for (const endpoint of ['__proto__/x', 'constructor/x', 'toString/x']) {
    assert.equal(authorizeEndpoint(FULL_DESKTOP, endpoint).ok, false, endpoint)
  }
})

test('T2: scope mapping — each scope allows exactly its endpoints and refuses without it', () => {
  const allEndpoints = Object.values(SCOPE_TABLE).flat()
  for (const [scope, endpoints] of Object.entries(SCOPE_TABLE)) {
    for (const endpoint of endpoints) {
      assert.equal(scopeForEndpoint(endpoint), scope, `${endpoint} needs ${scope}`)
      // harness:remote alone is not enough: the endpoint's own scope is required too.
      const bare = authorizeEndpoint(holding(), endpoint)
      assert.equal(bare.code, 'auth/forbidden-scope', endpoint)
      assert.equal(bare.scope, scope, endpoint)
      // The endpoint's scope alone is not enough either.
      const noRemote = authorizeEndpoint({ kind: 'desktop', scopes: [scope] }, endpoint)
      assert.equal(noRemote.code, 'auth/forbidden-scope', endpoint)
      assert.equal(noRemote.scope, 'harness:remote', endpoint)
      assert.deepEqual(authorizeEndpoint(holding(scope), endpoint), { ok: true, scope }, endpoint)
      // A mobile record that lists the scopes gets nothing.
      assert.equal(authorizeEndpoint({ kind: 'mobile', scopes: ['harness:remote', scope] }, endpoint).ok, false, endpoint)
      // Every OTHER scope together does not unlock it.
      const others = SCOPES.filter((name) => name !== scope)
      assert.equal(authorizeEndpoint({ kind: 'desktop', scopes: others }, endpoint).ok, false,
        `${endpoint} must stay closed without ${scope}`)
    }
  }
  // The static map agrees with the table for every non-family endpoint.
  for (const [endpoint, scope] of Object.entries(ENDPOINT_SCOPE)) {
    assert.ok(SCOPE_TABLE[scope].includes(endpoint), `${endpoint} -> ${scope} is not in the test table`)
  }
  assert.ok(allEndpoints.length > 80)
  // No device, no scopes, malformed scopes: refused.
  for (const device of [undefined, {}, { kind: 'desktop' }, { kind: 'desktop', scopes: 'harness:remote' }]) {
    assert.equal(authorizeEndpoint(device, 'session/list').ok, false)
  }
})

test('T2a: the model catalog is prompt:send; selectModel/initializeDefaultModel write the Host global default, so settings:write', () => {
  assert.deepEqual(authorizeEndpoint(holding('prompt:send'), 'session/modelCatalog'), { ok: true, scope: 'prompt:send' })
  assert.equal(authorizeEndpoint(holding('sessions:read'), 'session/modelCatalog').ok, false)
  for (const endpoint of ['session/selectModel', 'session/initializeDefaultModel']) {
    // prompt:send (and every scope but settings:write) is not enough.
    const others = SCOPES.filter((name) => name !== 'settings:write')
    const refused = authorizeEndpoint({ kind: 'desktop', scopes: others }, endpoint)
    assert.equal(refused.code, 'auth/forbidden-scope', endpoint)
    assert.equal(refused.scope, 'settings:write', endpoint)
    assert.deepEqual(authorizeEndpoint(holding('settings:write'), endpoint), { ok: true, scope: 'settings:write' }, endpoint)
  }
  for (const endpoint of ['llm/listProviders', 'llm/listConfigurableProviders', 'llm/discoverModels']) {
    assert.equal(authorizeEndpoint(holding('sessions:read'), endpoint).ok, true, endpoint)
  }
})
test('T2b: over the wire, an endpoint is served only with its own scope', async (t) => {
  const instance = await factory(t)
  const { ws } = await desktop(instance, ['sessions:read', 'harness:remote'])
  const served = await call(ws, 'session/list')
  assert.equal(served.ok, true, JSON.stringify(served))
  assert.deepEqual(served.value, { items: [{ sessionId: 's1' }] })
  const before = instance.gateway.calls.length
  for (const endpoint of ['session/prompt', 'session/cancel', 'userQuestions/answer']) {
    const refused = await call(ws, endpoint)
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'auth/forbidden-scope', endpoint)
    assert.equal(refused.error.scope, ENDPOINT_SCOPE[endpoint])
  }
  assert.equal(instance.gateway.calls.length, before, 'a scope refusal must not reach the Host')
  // The Host call ran on an owner Peer the plugin created for this connection.
  const hostCall = instance.gateway.calls.find((c) => c.endpoint === 'session/list')
  assert.deepEqual(hostCall.payload, { args: {} })
  assert.equal(hostCall.peer?.principal?.kind, 'owner')
  // A Host failure is carried as a normal remote-result error.
  const { ws: ws2 } = await desktop(instance, ALL_REMOTE, 'deskbrg2-0000-4000-8000-000000000002')
  const failed = await call(ws2, 'session/cancel')
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'session-not-found')
})

test('T2c: splitBinary / iterateBinary chunk at most 256 KiB, lazily', () => {
  const bytes = new Uint8Array(REMOTE_BINARY_CHUNK_BYTES + 10).fill(7)
  const chunks = splitBinary(bytes)
  assert.equal(chunks.length, 2)
  let total = 0
  for (const chunk of chunks) {
    const decoded = Buffer.from(chunk.$binary.base64, 'base64')
    assert.ok(decoded.length <= REMOTE_BINARY_CHUNK_BYTES, 'a chunk is at most 256 KiB')
    total += decoded.length
    assert.equal(chunk.$binary.total, REMOTE_BINARY_CHUNK_BYTES + 10)
  }
  assert.equal(total, REMOTE_BINARY_CHUNK_BYTES + 10)
  assert.equal(chunks.at(-1).$binary.last, true)
  assert.equal(splitBinary(new Uint8Array(0)).length, 1)
  // The lazy form yields one chunk per next(): nothing is precomputed.
  const lazy = iterateBinary(bytes)
  assert.equal(lazy.next().value.$binary.offset, 0)
  assert.equal(lazy.next().value.$binary.last, true)
  assert.equal(lazy.next().done, true)
})

test('T2d: a binary result on remote-call is upgraded to a stream (never inline, never refused); a direct stream pays credit per chunk', async (t) => {
  const instance = await factory(t)
  const { ws } = await desktop(instance)
  // remote-call never materializes the file inline: the reply names a stream and
  // the bytes arrive as credit-controlled `$binary` chunks (owner decision 2026-11-09).
  const upgraded = await call(ws, 'session/attachment', { id: 'a.bin' })
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded).slice(0, 200))
  assert.equal(upgraded.streamed, true)
  assert.match(upgraded.streamId, /^res\.\d+$/)
  assert.equal(upgraded.value, undefined, 'nothing is duplicated into the one-shot reply')
  assert.equal(upgraded.chunks, undefined)
  await takeFrame(ws, (f) => f.kind === 'remote-stream-closed' && f.streamId === upgraded.streamId)
  const chunks = framesOf(ws, (f) => f.kind === 'remote-frame' && f.streamId === upgraded.streamId)
  assert.equal(chunks.length, 2, 'REMOTE_BINARY_CHUNK_BYTES + 10 bytes = two chunks')
  const bytes = Buffer.concat(chunks.map((f) => Buffer.from(f.value.data.$binary.base64, 'base64')))
  assert.deepEqual(bytes, Buffer.alloc(REMOTE_BINARY_CHUNK_BYTES + 10, 7), 'reassembles byte-exact')
  // The stream path: three binary chunks, one frame each, paying credit per chunk.
  ws.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'bin', endpoint: 'session/attachment', args: { id: 'a.bin' } }))
  await takeFrame(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'bin' && f.seq === 1)
  const frames = framesOf(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'bin')
  assert.ok(frames.length >= 2)
  assert.equal(frames[0].value.data.$binary.offset, 0)
  assert.equal(frames[0].value.name, 'a.bin', 'non-binary fields travel with each chunk')
  assert.ok(Buffer.from(frames[0].value.data.$binary.base64, 'base64').length <= REMOTE_BINARY_CHUNK_BYTES)
})

test('T2e: with maxResultBytes configured, a serialized one-shot result above it is refused, a small one is served (unit)', async () => {
  const gateway = fakeGateway()
  const sent = []
  const ws = { readyState: 1, bufferedAmount: 0, send: (text) => sent.push(JSON.parse(text)) }
  const bridge = createRemoteBridge({
    getGateway: () => gateway,
    createPeer: () => ({ principal: { kind: 'owner' } }),
    getDevice: () => ({ kind: 'desktop', scopes: ALL_REMOTE }),
    decideApproval: async () => ({ kind: 'error', code: 'bad-request', message: 'n/a' }),
    limits: { maxResultBytes: 2000 },
    log: () => {},
  })
  const channel = bridge.attach(ws, 'dev-big')
  gateway.dispatchRpc = async (endpoint) => ({ ok: true, value: { blob: 'x'.repeat(endpoint === 'session/list' ? 5000 : 100) } })
  await channel.call({ requestId: 'big', endpoint: 'session/list' })
  assert.equal(sent.at(-1).ok, false)
  assert.equal(sent.at(-1).error.code, 'remote/result-too-large')
  await channel.call({ requestId: 'small', endpoint: 'session/page' })
  assert.equal(sent.at(-1).ok, true)
  assert.equal(sent.at(-1).streamed, undefined)
  // A cyclic value cannot be serialized: refused, not a crash.
  gateway.dispatchRpc = async () => { const o = {}; o.self = o; return { ok: true, value: o } }
  await channel.call({ requestId: 'cyc', endpoint: 'session/list' })
  assert.equal(sent.at(-1).error.code, 'remote/result-too-large')
  channel.close()
})

test('T2f: with maxResultBytes configured, an oversized non-binary stream frame ends the stream with result-too-large', async () => {
  const sent = []
  const ws = { readyState: 1, bufferedAmount: 0, send: (text) => sent.push(JSON.parse(text)) }
  const gateway = fakeGateway()
  gateway.openWireStream = () => Promise.resolve({
    [Symbol.asyncIterator]() {
      let n = 0
      return { async next() { n += 1; return n === 1 ? { done: false, value: { ok: 1 } } : { done: false, value: { blob: 'x'.repeat(5000) } } },
        async return() { return { done: true } } }
    },
  })
  const bridge = createRemoteBridge({
    getGateway: () => gateway,
    createPeer: () => ({ principal: { kind: 'owner' } }),
    getDevice: () => ({ kind: 'desktop', scopes: ALL_REMOTE }),
    decideApproval: async () => ({ kind: 'error', code: 'bad-request', message: 'n/a' }),
    limits: { maxResultBytes: 2000 },
    log: () => {},
  })
  const channel = bridge.attach(ws, 'dev-sbig')
  await channel.openStream({ streamId: 'big', endpoint: 'session/follow', args: {} })
  await delay(100)
  assert.equal(sent.filter((f) => f.kind === 'remote-frame').length, 1, 'the small frame went out, the big one did not')
  assert.equal(sent.find((f) => f.kind === 'remote-stream-closed').error.code, 'remote/result-too-large')
  channel.close()
})

// -- T3/T4: harness:remote --------------------------------------------------

test('T3: harness:remote is desktop-only and never a default', async (t) => {
  assert.equal(DESKTOP_DEFAULT_SCOPES.includes('harness:remote'), false)
  const instance = await factory(t)
  // Default desktop offer: no harness:remote.
  const plain = await instance.post('pair', { kind: 'desktop', publicUrl: instance.lanUrl })
  assert.equal(plain.status, 201)
  assert.equal(plain.data.pairing.scopes.includes('harness:remote'), false)
  // Explicit desktop offer: granted.
  const chosen = await instance.post('pair', { kind: 'desktop', scopes: ['harness:remote'], publicUrl: instance.lanUrl })
  assert.deepEqual(chosen.data.pairing.scopes, ['harness:remote'])
  // A mobile offer loses it, even when it lists it, and "all scopes" excludes it.
  const mobileExplicit = await instance.post('pair', { kind: 'mobile', scopes: ['sessions:read', 'harness:remote'], publicUrl: instance.lanUrl })
  assert.deepEqual(mobileExplicit.data.pairing.scopes, ['sessions:read'])
  const mobileDefault = await instance.post('pair', { publicUrl: instance.lanUrl })
  assert.equal(mobileDefault.data.pairing.kind, 'mobile')
  assert.equal(mobileDefault.data.pairing.scopes.includes('harness:remote'), false)
  assert.ok(mobileDefault.data.pairing.scopes.length > 0)
})

test('T4: without harness:remote every bridge frame is refused (and a mobile cannot send them)', async (t) => {
  const instance = await factory(t)
  const noRemote = await pairDevice(instance, DESK, { kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond', 'files:read'] })
  const ws = await connectToken(instance, noRemote.token, DESK)
  const before = instance.gateway.calls.length
  const refused = await call(ws, 'session/list')
  assert.equal(refused.kind, 'error')
  assert.equal(refused.code, 'auth/forbidden-scope')
  assert.equal(refused.scope, 'harness:remote')
  assert.equal(refused.requestType, 'remote-call')
  ws.send(JSON.stringify({ type: 'remote-stream-open', requestId: 'o1', streamId: 'st1', endpoint: 'session/follow', args: {} }))
  assert.equal((await takeFrame(ws, (f) => f.requestId === 'o1')).code, 'auth/forbidden-scope')
  assert.equal(instance.gateway.calls.length, before)
  assert.equal(instance.gateway.opened.length, 0)

  const mobile = await pairDevice(instance, 'mobilebr-0000-4000-8000-000000000009', { kind: 'mobile' })
  const mobileWs = await connectToken(instance, mobile.token, 'mobilebr-0000-4000-8000-000000000009')
  const mobileRefused = await call(mobileWs, 'session/list')
  assert.equal(mobileRefused.code, 'auth/forbidden-scope')
  assert.equal(instance.gateway.calls.length, before)

  // scopeDenial maps every bridge type to harness:remote.
  for (const type of ['remote-call', 'remote-stream-open', 'remote-stream-cancel', 'remote-stream-credit']) {
    assert.equal(SCOPE_BY_TYPE[type], 'harness:remote')
    assert.equal(scopeDenial({ scopes: ['sessions:read'] }, type).scope, 'harness:remote')
    assert.equal(scopeDenial({ scopes: ['harness:remote'] }, type), undefined)
  }
  // The audit line carries endpoint + device, never arguments.
  const { ws: ok, device: auditDevice } = await desktop(instance, ALL_REMOTE, 'deskaudt-0000-4000-8000-000000000003')
  await call(ok, 'session/list', { secretArgument: 'do-not-log-me' })
  const audit = instance.logs.filter((line) => String(line).includes('remote-bridge call: endpoint=session/list'))
  assert.ok(audit.length >= 1, 'an audit line per call')
  assert.ok(audit[0].includes(`device=${auditDevice.id}`), 'the audit line names the device')
  assert.ok(audit[0].includes('allowed=true'))
  assert.equal(instance.logs.some((line) => String(line).includes('do-not-log-me')), false, 'arguments are never logged')
})

// -- T5: $events/result -----------------------------------------------------

/** Emit tool/call + approval/request the way the Host does; returns the pending decision + the card. */
async function pendingApproval(instance, observer, callId = 'brg-approval-1') {
  const downstream = Promise.withResolvers()
  instance.listeners['session/event']({ id: 's1' }, {
    type: 'tool/call', seq: 1, time: 1,
    data: { turn: 1, step: 0, callId, name: 'bash', arguments: '{"command":"ls"}' },
  })
  const decision = instance.listeners['approval/request']({
    agent: { id: 's1' }, toolName: 'bash', callId, reason: 'spec 008', signal: new AbortController().signal,
  }, () => downstream.promise)
  const card = await takeFrame(observer, (frame) => frame.kind === 'approval-requested' && frame.replay !== true)
  return { decision, card, downstream }
}

test('T5: $events/result — wrong or missing argsHash is refused and still pending; the right one applies once', async (t) => {
  const instance = await factory(t)
  const { ws } = await desktop(instance)
  const { decision, card, downstream } = await pendingApproval(instance, ws)
  assert.match(card.argsHash, /^[a-f0-9]{64}$/)
  const base = { rpcId: card.rpcId, sessionId: 's1', approvalId: card.approvalId, outcome: { kind: 'result', value: 'allowed-once' } }
  const before = instance.gateway.calls.length

  // Missing hash → normal refusal, still pending.
  const missing = await call(ws, '$events/result', base)
  assert.equal(missing.kind, 'remote-result')
  assert.equal(missing.ok, true)
  assert.equal(missing.value.accepted, false)
  assert.equal(missing.value.reason, 'hash-mismatch')
  // Wrong hash → the same.
  const wrong = await call(ws, '$events/result', { ...base, argsHash: 'f'.repeat(64) })
  assert.equal(wrong.value.accepted, false)
  assert.equal(wrong.value.reason, 'hash-mismatch')
  // A hash of OTHER content (a different callId's hash) is just as wrong.
  const other = await call(ws, '$events/result', { ...base, argsHash: 'a'.repeat(64) })
  assert.equal(other.value.reason, 'hash-mismatch')
  // Rejecting is bound to the hash too.
  const wrongReject = await call(ws, '$events/result', { ...base, outcome: { kind: 'result', value: 'rejected' } })
  assert.equal(wrongReject.value.reason, 'hash-mismatch')

  // Still pending: nothing resolved, and a replay shows the card again.
  const resolvedSoFar = framesOf(ws, (f) => f.kind === 'approval-resolved')
  assert.equal(resolvedSoFar.length, 0, 'a refusal must leave the request pending')
  let settled = false
  decision.then(() => { settled = true })
  await delay(50)
  assert.equal(settled, false, 'the Host decision is still waiting')

  // The right hash is accepted ...
  const accepted = await call(ws, '$events/result', { ...base, argsHash: card.argsHash })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.value.accepted, true, JSON.stringify(accepted))
  assert.equal(accepted.value.outcome, 'allowed-once')
  assert.equal(await decision, 'allowed-once')
  // ... exactly once: the same decision again is `not-pending`.
  const again = await call(ws, '$events/result', { ...base, argsHash: card.argsHash })
  assert.equal(again.value.accepted, false)
  assert.equal(again.value.reason, 'not-pending')
  const flipped = await call(ws, '$events/result', { ...base, argsHash: card.argsHash, outcome: { kind: 'result', value: 'rejected' } })
  assert.equal(flipped.value.reason, 'not-pending')
  downstream.resolve('rejected')

  // The endpoint is never forwarded raw to the Host, whatever the outcome.
  assert.equal(instance.gateway.calls.some((c) => c.endpoint === '$events/result'), false)
  assert.equal(instance.gateway.calls.length, before)
})

test('T5b: $events/result needs approval:respond, validates its shape, and is not a stream', async (t) => {
  const instance = await factory(t)
  const { ws } = await desktop(instance, ['sessions:read', 'harness:remote'], 'deskapr0-0000-4000-8000-000000000004')
  const refused = await call(ws, '$events/result', { rpcId: 'x', sessionId: 's1', approvalId: 'x', argsHash: 'h', outcome: 'rejected' })
  assert.equal(refused.error.code, 'auth/forbidden-scope')
  assert.equal(refused.error.scope, 'approval:respond')

  const { ws: full } = await desktop(instance, ALL_REMOTE, 'deskapr1-0000-4000-8000-000000000005')
  // Not pending / malformed → normal receipt or bad-request, never a Host call.
  const unknown = await call(full, '$events/result', { rpcId: 'nope', sessionId: 's1', approvalId: 'nope', argsHash: 'h', outcome: 'rejected' })
  assert.equal(unknown.ok, true)
  assert.equal(unknown.value.accepted, false)
  assert.equal(unknown.value.reason, 'not-pending')
  const malformed = await call(full, '$events/result', { outcome: 'rejected' })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.error.code, 'bad-request')
  const badOutcome = await call(full, '$events/result', { rpcId: 'a', sessionId: 's1', approvalId: 'a', outcome: 'cancelled' })
  assert.equal(badOutcome.ok, false, 'cancelled is a host-only state')
  full.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'evres', endpoint: '$events/result', args: {} }))
  const closed = await takeFrame(full, (f) => f.kind === 'remote-stream-closed' && f.streamId === 'evres')
  assert.equal(closed.error.code, 'bad-request')
  const callEvents = await call(full, '$events')
  assert.equal(callEvents.error.code, 'bad-request', '$events is a stream')
  assert.equal(instance.gateway.calls.some((c) => c.endpoint === '$events/result'), false)
})

// -- T5c/T5d/T5e: `$events`, the Peer's interactions and question cards -------

test('T5c: $events opens for a device holding approval:respond — the Peer declares interactions:answer and the card arrives', async (t) => {
  const instance = await factory(t)
  const { ws } = await desktop(instance, ALL_REMOTE, 'deskevt0-0000-4000-8000-0000000000c1')
  ws.send(JSON.stringify({ type: 'remote-stream-open', requestId: 'ev-open', streamId: 'evs', endpoint: '$events', args: {} }))
  const frame = await takeFrame(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'evs')
  // The Host's own waterfall frame is forwarded verbatim: this is the card the
  // native UI renders (and the only frame carrying rpcId/argsHash on rc.1).
  assert.equal(frame.value.type, 'waterfall')
  assert.equal(frame.value.event, 'approval/request')
  assert.equal(frame.value.request.argsHash, 'a'.repeat(64))
  const hostStream = instance.gateway.opened.find((stream) => stream.endpoint === '$events')
  assert.ok(hostStream, '$events must reach the Host carrier')
  assert.equal(hostStream.peer?.principal?.kind, 'owner')
  assert.equal(hostStream.peer?.interactions, 'answer', "rc.1 refuses $events for interactions != 'answer'")
  assert.equal(instance.gateway.calls.some((c) => c.endpoint === '$events'), false, '$events is a stream, never a call')

  // The answer path is unchanged: `$events/result` still binds the argsHash the
  // Host computed for the pending request this gateway holds.
  const { decision, card, downstream } = await pendingApproval(instance, ws, 'brg-approval-events')
  const answer = { rpcId: card.rpcId, sessionId: 's1', approvalId: card.approvalId, outcome: { kind: 'result', value: 'allowed-once' } }
  const wrong = await call(ws, '$events/result', { ...answer, argsHash: 'f'.repeat(64) })
  assert.equal(wrong.value.accepted, false)
  assert.equal(wrong.value.reason, 'hash-mismatch')
  let settled = false
  decision.then(() => { settled = true })
  await delay(50)
  assert.equal(settled, false, 'a wrong hash leaves the approval pending')
  const accepted = await call(ws, '$events/result', { ...answer, argsHash: card.argsHash })
  assert.equal(accepted.value.accepted, true, JSON.stringify(accepted))
  assert.equal(await decision, 'allowed-once')
  downstream.resolve('allowed-once')
})

test('T5d: a device without approval:respond cannot open $events, and its bridge Peer stays interactions:none', async (t) => {
  const instance = await factory(t)
  const { ws } = await desktop(instance, ['sessions:read', 'prompt:send', 'files:read', 'harness:remote'],
    'deskevt1-0000-4000-8000-0000000000c2')
  ws.send(JSON.stringify({ type: 'remote-stream-open', requestId: 'ev-denied', streamId: 'evd', endpoint: '$events', args: {} }))
  const refused = await takeFrame(ws, (f) => f.kind === 'remote-stream-closed' && f.streamId === 'evd')
  assert.equal(refused.error.code, 'auth/forbidden-scope')
  assert.equal(refused.error.scope, 'approval:respond')
  assert.equal(instance.gateway.opened.some((stream) => stream.endpoint === '$events'), false,
    'the Host carrier must not be opened for a device that may not answer')
  // A call the device MAY make still works, and its Peer is not upgraded.
  const reply = await call(ws, 'session/list')
  assert.equal(reply.ok, true, JSON.stringify(reply))
  const record = instance.gateway.calls.find((c) => c.endpoint === 'session/list')
  assert.equal(record.peer?.interactions, 'none', 'no approval:respond → no interactions:answer')
  assert.equal(record.peer?.principal?.kind, 'owner')
})

test('T5e: no device principal receives a question card on the companion channel (audited)', async (t) => {
  const instance = await factory(t)
  const answerer = await desktop(instance, ALL_REMOTE, 'deskqst0-0000-4000-8000-0000000000d1')
  const other = await desktop(instance, ['sessions:read', 'prompt:send', 'harness:remote'], 'deskqst1-0000-4000-8000-0000000000d2')
  const controller = new AbortController()
  const questions = [{ id: 'choice', question: 'which one?', options: [{ label: 'Desktop' }, { label: 'Mobile' }] }]
  const pending = instance.listeners['user-questions/request']({
    agent: { id: 's1' }, questions, signal: controller.signal,
  }, () => undefined)
  try {
    // Whole-gateway review 2026-11-10: questions are ADMIN_ONLY on the companion
    // channel, so even a device holding `approval:respond` (ALL_REMOTE) is sent no
    // card. Spec 008 reaches the same question over the separate `$events` stream
    // (T5c/T5d), which this assertion deliberately does not exercise.
    await delay(150)
    assert.equal(framesOf(answerer.ws, (f) => f.kind === 'question-requested').length, 0,
      'a device with approval:respond is still never sent a question on this channel')
    assert.equal(framesOf(other.ws, (f) => f.kind === 'question-requested').length, 0,
      'nor a device without it')
    const withheld = instance.logs.filter((line) => String(line).includes('question card withheld:'))
    assert.ok(withheld.some((line) => String(line).includes(`device=${answerer.device.id}`)), 'the refusal is audited')
    assert.ok(withheld.some((line) => String(line).includes(`device=${other.device.id}`)), 'the refusal is audited')
    assert.equal(instance.logs.some((line) => String(line).includes('which one?')), false, 'question text is never logged')
  } finally {
    controller.abort()
    await pending.catch(() => {})
  }
})

// -- T6: streams ------------------------------------------------------------

test('T6: stream credit — the Host sends no more than it was granted, then resumes on credit', async (t) => {
  const instance = await factory(t)
  const { ws } = await desktop(instance)
  ws.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'sA', endpoint: 'session/follow', args: { request: { address: { sessionId: 's1' } } } }))
  // Default credit is 64: exactly 64 frames arrive, then the Host holds.
  await takeFrame(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'sA' && f.seq === 63)
  // Same class as the cancel assertion below: the 64th granted frame can land a tick after the
  // 63rd, so wait for the count the credit allows rather than betting on a sleep.
  await waitFor(
    () => framesOf(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'sA').length === 64,
    { label: 'all 64 credit frames to arrive' },
  )
  const first = framesOf(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'sA')
  assert.equal(first.length, 64, 'default credit is 64 frames')
  assert.deepEqual(first.map((f) => f.seq), [...Array(64).keys()])
  assert.deepEqual(first[0].value, { n: 1 })
  const hostStream = instance.gateway.opened[0]
  assert.equal(hostStream.endpoint, 'session/follow')
  assert.ok(hostStream.produced <= 66, `the Host iterator must not run ahead of the credit (produced ${hostStream.produced})`)
  assert.equal(hostStream.peer?.principal?.kind, 'owner')

  // 5 more credits → exactly 5 more frames.
  ws.send(JSON.stringify({ type: 'remote-stream-credit', streamId: 'sA', n: 5 }))
  await takeFrame(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'sA' && f.seq === 68)
  await waitFor(
    () => framesOf(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'sA').length === 69,
    { label: 'the five credited frames to arrive' },
  )
  assert.equal(framesOf(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'sA').length, 69)
  // Invalid credit grants nothing.
  for (const n of [0, -3, 1.5, 'many', null]) ws.send(JSON.stringify({ type: 'remote-stream-credit', streamId: 'sA', n }))
  await delay(100)
  assert.equal(framesOf(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'sA').length, 69)

  // Cancel closes the Host iterator and reports closure once.
  ws.send(JSON.stringify({ type: 'remote-stream-cancel', streamId: 'sA' }))
  await takeFrame(ws, (f) => f.kind === 'remote-stream-closed' && f.streamId === 'sA')
  // The `remote-stream-closed` frame and the Host iterator's abort/return settle on different
  // ticks, so a fixed sleep here was a bet on the scheduler: measured — T6 passed alone and failed
  // once while `test:package` ran concurrently, because 100 ms was not enough under load. Wait for
  // the STATE the assertions below are about; the assertions themselves are unchanged.
  await waitFor(() => hostStream.signal.aborted && hostStream.returned, {
    label: 'the Host iterator to abort and return after cancel',
  })
  assert.equal(hostStream.signal.aborted, true)
  assert.equal(hostStream.returned, true)
  const produced = hostStream.produced
  await settlesAt(() => hostStream.produced, { label: 'the Host iterator output' })
  assert.equal(hostStream.produced, produced, 'no frames after cancel')
  assert.equal(framesOf(ws, (f) => f.kind === 'remote-stream-closed' && f.streamId === 'sA').length, 1)
})

test('T6b: stream errors — duplicate id, bad id, host failure, missing scope', async (t) => {
  const instance = await factory(t)
  const { ws } = await desktop(instance)
  ws.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'dup', endpoint: 'session/follow', args: {} }))
  await takeFrame(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'dup')
  ws.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'dup', endpoint: 'session/follow', args: {} }))
  assert.equal((await takeFrame(ws, (f) => f.kind === 'remote-stream-closed' && f.streamId === 'dup')).error.code, 'bad-request')
  ws.send(JSON.stringify({ type: 'remote-stream-open', requestId: 'badid', streamId: '../x', endpoint: 'session/follow', args: {} }))
  assert.equal((await takeFrame(ws, (f) => f.requestId === 'badid')).error.code, 'bad-request')
  ws.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'denied', endpoint: 'terminal/attach', args: {} }))
  // ALL_REMOTE has no `terminal` scope: refused by scope, never forwarded.
  const noTerminal = await takeFrame(ws, (f) => f.kind === 'remote-stream-closed' && f.streamId === 'denied')
  assert.equal(noTerminal.error.code, 'auth/forbidden-scope')
  assert.equal(noTerminal.error.scope, 'terminal')
  assert.equal(instance.gateway.opened.length, 1, 'only the allowed stream reached the Host')

  // Unknown ids and stray credit/cancel are ignored, not errors.
  ws.send(JSON.stringify({ type: 'remote-stream-credit', streamId: 'ghost', n: 5 }))
  ws.send(JSON.stringify({ type: 'remote-stream-cancel', streamId: 'ghost' }))
  assert.equal((await call(ws, 'session/list')).ok, true, 'the connection is still healthy')
})

test('T6c: bufferedAmount above maxPayloadBytes/4 pauses the stream (unit, fake socket)', async () => {
  const gateway = fakeGateway()
  const sent = []
  const ws = { readyState: 1, bufferedAmount: 0, send: (text) => sent.push(JSON.parse(text)) }
  const bridge = createRemoteBridge({
    getGateway: () => gateway,
    createPeer: () => ({ principal: { kind: 'owner' } }),
    getDevice: () => ({ kind: 'desktop', scopes: ALL_REMOTE }),
    decideApproval: async () => ({ kind: 'error', code: 'bad-request', message: 'n/a' }),
    maxPayloadBytes: 1000,
    log: () => {},
  })
  const channel = bridge.attach(ws, 'dev-1')
  ws.bufferedAmount = 251 // > 1000 / 4
  await channel.openStream({ streamId: 'bp', endpoint: 'session/follow', args: {} })
  await delay(150)
  assert.equal(sent.filter((f) => f.kind === 'remote-frame').length, 0, 'a congested socket gets no frames')
  ws.bufferedAmount = 0
  await waitFor(() => sent.filter((f) => f.kind === 'remote-frame').length > 0, {
    label: 'frames to resume once the socket drains',
  })
  const flowing = sent.filter((f) => f.kind === 'remote-frame').length
  assert.ok(flowing > 0, 'frames resume once the socket drains')
  ws.bufferedAmount = 250 // exactly the limit: still allowed
  await delay(60)
  channel.close()
  assert.equal(gateway.opened[0].signal.aborted, true)
})

// The carrier's own signal must already be aborted when `remote-stream-closed`
// leaves the gateway: a cancel that reports closure before aborting would leave a
// Host iterator running. Both paths are asserted synchronously, so the check cannot
// pass on a timing accident (spec 008 review).
test('T6d: cancel and socket close abort the carrier signal BEFORE `remote-stream-closed` is emitted', async () => {
  const gateway = fakeGateway()
  const carriers = []
  const original = gateway.openWireStream
  // Same arity as the rc.1 carrier, so the bridge's arity probe keeps the 6-arg path.
  gateway.openWireStream = function (endpoint, payload, uplink, peer, signal) {
    carriers.push({ endpoint, signal })
    return original.call(this, endpoint, payload, uplink, peer, signal)
  }
  const frames = []
  const closedAtAbort = []
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(text) {
      const frame = JSON.parse(text)
      if (frame.kind === 'remote-stream-closed') closedAtAbort.push(carriers.at(-1)?.signal?.aborted)
      frames.push(frame)
    },
  }
  const bridge = createRemoteBridge({
    getGateway: () => gateway,
    createPeer: () => ({ principal: { kind: 'owner' } }),
    getDevice: () => ({ kind: 'desktop', scopes: ALL_REMOTE }),
    decideApproval: async () => ({ kind: 'error', code: 'bad-request', message: 'n/a' }),
    log: () => {},
  })
  const channel = bridge.attach(ws, 'dev-abort')

  await channel.openStream({ streamId: 'c1', endpoint: 'session/follow', args: {} })
  // The carrier exists only after the deferred open resolves: wait for it, do not guess a delay.
  await waitFor(() => carriers.length === 1, { label: 'the first carrier to be opened' })
  assert.equal(carriers.length, 1)
  assert.equal(carriers[0].signal.aborted, false, 'the stream is live before the cancel')
  // Synchronous assertion: the abort must be visible the moment cancel returns.
  channel.cancel({ streamId: 'c1' })
  assert.equal(carriers[0].signal.aborted, true, 'the cancel aborts the signal the carrier was given')
  assert.deepEqual(closedAtAbort, [true], 'the close frame is emitted only after that abort')

  await channel.openStream({ streamId: 'c2', endpoint: 'session/follow', args: {} })
  await waitFor(() => carriers.length === 2, { label: 'the second carrier to be opened' })
  assert.equal(carriers.length, 2)
  assert.equal(carriers[1].signal.aborted, false)
  // A closed socket is not a client cancel: it aborts the Host side too, and reports
  // nothing (the peer is gone).
  channel.close()
  assert.equal(carriers[1].signal.aborted, true, 'closing the socket aborts the carrier signal synchronously')
  assert.equal(frames.filter((f) => f.kind === 'remote-stream-closed' && f.streamId === 'c2').length, 0)
})

// -- T7: revoke / close -----------------------------------------------------
test('T7: revoking the device closes its streams (4401); a closed socket aborts the Host iterator', async (t) => {
  const instance = await factory(t)
  const layout = await desktop(instance)
  layout.ws.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'rv', endpoint: 'session/follow', args: {} }))
  await takeFrame(layout.ws, (f) => f.kind === 'remote-frame' && f.streamId === 'rv')
  const hostStream = instance.gateway.opened[0]
  assert.equal(hostStream.signal.aborted, false)
  const closed = once(layout.ws, 'close')
  assert.equal((await instance.post(`devices/${layout.device.id}/revoke`)).status, 200)
  assert.equal((await closed)[0], CLOSE_CODES.revoked)
  // Same class as T6: wait for the state, never for a guessed interval.
  await waitFor(() => hostStream.signal.aborted && hostStream.returned, {
    label: 'the Host iterator to abort and return after revoke',
  })
  assert.equal(hostStream.signal.aborted, true, 'the Host iterator is aborted on revoke')
  assert.equal(hostStream.returned, true)
  const produced = hostStream.produced
  await settlesAt(() => hostStream.produced, { label: 'the Host iterator output' })
  assert.equal(hostStream.produced, produced, 'the Host stops producing')
  // The old token no longer authenticates, so the bridge is unreachable.
  const revokedWs = openLan(instance, ['dsh-mobile-v1'], { Authorization: `Bearer ${layout.token}`, 'X-DSH-Device-ID': DESK })
  const status = await new Promise((resolve) => {
    revokedWs.once('open', () => resolve('open'))
    revokedWs.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode) })
    revokedWs.once('error', () => resolve('error'))
  })
  assert.equal(status, 401)

  // A plain socket close aborts the stream too, and drops the owner peer.
  const second = await desktop(instance, ALL_REMOTE, 'deskclos-0000-4000-8000-000000000006')
  second.ws.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'cl', endpoint: 'session/follow', args: {} }))
  await takeFrame(second.ws, (f) => f.kind === 'remote-frame' && f.streamId === 'cl')
  const secondStream = instance.gateway.opened[1]
  second.ws.close()
  await once(second.ws, 'close')
  await waitFor(() => secondStream.signal.aborted && secondStream.returned, {
    label: 'the second stream to abort and return after the socket closed',
  })
  assert.equal(secondStream.signal.aborted, true, 'closing the socket aborts the stream')
  assert.equal(secondStream.returned, true)
})

test('T7b: a re-pair that narrows the grant closes the bridge streams (4401)', async (t) => {
  const instance = await factory(t)
  const layout = await desktop(instance)
  layout.ws.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'rp', endpoint: 'session/follow', args: {} }))
  await takeFrame(layout.ws, (f) => f.kind === 'remote-frame' && f.streamId === 'rp')
  const closed = once(layout.ws, 'close')
  // Re-pair the same installation WITHOUT harness:remote.
  const created = await instance.post('pair', { kind: 'desktop', scopes: ['sessions:read'], publicUrl: instance.lanUrl })
  const next = openLan(instance, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], { 'X-DSH-Device-ID': DESK })
  recordFrames(next)
  await once(next, 'open')
  assert.equal((await closed)[0], CLOSE_CODES.revoked)
  await waitFor(() => instance.gateway.opened[0].signal.aborted, {
    label: 'the narrowed bridge stream to abort on re-pair',
  })
  assert.equal(instance.gateway.opened[0].signal.aborted, true)
  // The new, narrower socket cannot use the bridge any more. It must negotiate
  // first: contract §3.7 refuses any operation before the accepted client-hello,
  // so the scope narrowing is only observable on a negotiated socket.
  await negotiate(next)
  const reply = await call(next, 'session/list')
  assert.equal(reply.code, 'auth/forbidden-scope')
})

// -- T8: no carrier ---------------------------------------------------------

test('T8: a Host without the Gateway carrier refuses clearly instead of guessing', async (t) => {
  const gateway = fakeGateway()
  delete gateway.dispatchRpc
  delete gateway.openWireStream
  const instance = await factory(t, { gateway })
  const { ws } = await desktop(instance)
  const reply = await call(ws, 'session/list')
  assert.equal(reply.ok, false)
  assert.equal(reply.error.code, 'remote/unavailable')
  assert.match(reply.error.message, /carrier/)
  ws.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'nc', endpoint: 'session/follow', args: {} }))
  const closed = await takeFrame(ws, (f) => f.kind === 'remote-stream-closed' && f.streamId === 'nc')
  assert.equal(closed.error.code, 'remote/unavailable')
  // The connection survives the refusal.
  assert.equal((await call(ws, 'session/list')).error.code, 'remote/unavailable')
})

// -- T9: interim hardening (review 2026-11-09) ------------------------------

/** A bridge over a fake socket, for the limit/guard unit tests. */
function unitBridge({ gateway = fakeGateway(), limits, logs = [] } = {}) {
  let peers = 0
  const bridge = createRemoteBridge({
    getGateway: () => gateway,
    createPeer: () => { peers += 1; return { principal: { kind: 'owner' } } },
    getDevice: () => ({ kind: 'desktop', scopes: ALL_REMOTE }),
    decideApproval: async () => ({ kind: 'error', code: 'bad-request', message: 'n/a' }),
    limits,
    log: (line) => logs.push(line),
  })
  const socket = () => {
    const sent = []
    return { sent, ws: { readyState: 1, bufferedAmount: 0, send: (text) => sent.push(JSON.parse(text)) } }
  }
  return { bridge, gateway, logs, socket, get peers() { return peers } }
}

test('T9a: session/prompt starting with "/" is refused before the Host (remote/slash-command-denied)', async (t) => {
  const instance = await factory(t)
  const { ws } = await desktop(instance)
  const before = instance.gateway.calls.length
  for (const args of [
    { text: '/compact' }, { text: '   \n /shell ls' }, { prompt: '/x' },
    { request: { input: { text: '\t/model' } } },
    { parts: [{ type: 'text', text: '/help' }] },
  ]) {
    const reply = await call(ws, 'session/prompt', args)
    assert.equal(reply.ok, false, JSON.stringify(args))
    assert.equal(reply.error.code, 'remote/slash-command-denied', JSON.stringify(args))
  }
  assert.equal(instance.gateway.calls.length, before, 'a refused slash prompt must not reach the Host')
  // A normal prompt (slash inside the text, or in a non-prompt field) still goes through.
  for (const args of [{ text: 'explain a/b' }, { text: 'use /tmp later' }, { sessionId: '/odd-id', text: 'hello' }]) {
    const ok = await call(ws, 'session/prompt', args)
    assert.equal(ok.ok, true, JSON.stringify(args))
  }
  // The guard is specific to session/prompt (workspaceId is checked against the Host list).
  assert.equal((await call(ws, 'session/create', { request: { workspaceId: 'w1', text: '/ok' } })).ok, true)
  // Defence in depth only: a device that holds commands:execute can run slash commands anyway.
  const { ws: commander } = await desktop(instance, [...ALL_REMOTE, 'commands:execute'], 'deskcmd0-0000-4000-8000-000000000010')
  assert.equal((await call(commander, 'session/prompt', { text: '/compact' })).ok, true)
})

test('T9b: per-device budget — extra connections do not multiply it, and busy is refused before a Peer exists', async () => {
  const h = unitBridge({ limits: { maxConnectionsPerDevice: 2, maxInflightPerDevice: 3, callsPerSecond: 1000, maxStreamsPerDevice: 4 } })
  const a = h.socket(); const b = h.socket(); const c = h.socket()
  const chA = h.bridge.attach(a.ws, 'dev-x')
  const chB = h.bridge.attach(b.ws, 'dev-x')
  const chC = h.bridge.attach(c.ws, 'dev-x') // third connection of the same device
  // The third is inert: remote/busy, no Peer, no Host call.
  await chC.call({ requestId: 'c1', endpoint: 'session/list' })
  assert.equal(c.sent[0].error.code, 'remote/busy')
  await chC.openStream({ streamId: 'c-s', endpoint: 'session/follow', args: {} })
  assert.equal(c.sent[1].error.code, 'remote/busy')
  assert.equal(h.peers, 0, 'busy is decided before any Peer is created')
  assert.equal(h.gateway.calls.length, 0)
  assert.equal(h.gateway.opened.length, 0)
  // Another device is unaffected by this device's cap.
  const other = h.socket()
  const chOther = h.bridge.attach(other.ws, 'dev-y')
  await chOther.call({ requestId: 'o1', endpoint: 'session/list' })
  assert.equal(other.sent[0].ok, true)
  // Releasing a connection frees a slot.
  chA.close()
  const d = h.socket()
  const chD = h.bridge.attach(d.ws, 'dev-x')
  await chD.call({ requestId: 'd1', endpoint: 'session/list' })
  assert.equal(d.sent[0].ok, true)
  for (const channel of [chB, chC, chD, chOther]) channel.close()
})

test('T9c: streams are capped per DEVICE across its connections, and released on close', async () => {
  const h = unitBridge({ limits: { maxStreamsPerDevice: 3, callsPerSecond: 1000 } })
  const a = h.socket(); const b = h.socket()
  const chA = h.bridge.attach(a.ws, 'dev-s')
  const chB = h.bridge.attach(b.ws, 'dev-s')
  await chA.openStream({ streamId: 'a1', endpoint: 'session/follow', args: {} })
  await chA.openStream({ streamId: 'a2', endpoint: 'session/follow', args: {} })
  await chB.openStream({ streamId: 'b1', endpoint: 'session/follow', args: {} })
  assert.equal(h.gateway.opened.length, 3)
  await chB.openStream({ streamId: 'b2', endpoint: 'session/follow', args: {} })
  const refused = b.sent.find((f) => f.kind === 'remote-stream-closed' && f.streamId === 'b2')
  assert.equal(refused.error.code, 'remote/busy')
  assert.equal(h.gateway.opened.length, 3, 'the refused stream never reached the Host')
  chA.cancel({ streamId: 'a1' })
  await delay(60)
  await chB.openStream({ streamId: 'b3', endpoint: 'session/follow', args: {} })
  assert.equal(h.gateway.opened.length, 4, 'a freed slot is reusable')
  chA.close(); chB.close()
  await delay(60)
  const c = h.socket()
  const chC = h.bridge.attach(c.ws, 'dev-s')
  for (const id of ['c1', 'c2', 'c3']) await chC.openStream({ streamId: id, endpoint: 'session/follow', args: {} })
  assert.equal(h.gateway.opened.length, 7, 'closing the connections released every stream slot')
  chC.close()
})

test('T9d: in-flight RPCs are capped per device (remote/busy), and released when they settle', async () => {
  const gateway = fakeGateway()
  const release = []
  gateway.dispatchRpc = (endpoint, payload, signal, peer) => new Promise((resolve) => {
    gateway.calls.push({ endpoint, payload, peer }); release.push(() => resolve({ ok: true, value: { endpoint } }))
  })
  const h = unitBridge({ gateway, limits: { maxInflightPerDevice: 2, callsPerSecond: 1000 } })
  const a = h.socket(); const b = h.socket()
  const chA = h.bridge.attach(a.ws, 'dev-i')
  const chB = h.bridge.attach(b.ws, 'dev-i')
  void chA.call({ requestId: 'r1', endpoint: 'session/list' })
  void chB.call({ requestId: 'r2', endpoint: 'session/list' })
  await delay(20)
  await chA.call({ requestId: 'r3', endpoint: 'session/list' })
  assert.equal(a.sent.at(-1).error.code, 'remote/busy')
  assert.equal(gateway.calls.length, 2, 'the third call never reached the Host')
  release.splice(0).forEach((fn) => fn())
  await delay(20)
  const fourth = chA.call({ requestId: 'r4', endpoint: 'session/list' })
  await delay(20)
  release.splice(0).forEach((fn) => fn())
  await fourth
  assert.equal(a.sent.at(-1).ok, true, 'a settled call frees its slot')
  chA.close(); chB.close()
})

test('T9e: token bucket — 20 calls/s per device across connections; refills over time', async () => {
  const h = unitBridge({ limits: { callsPerSecond: 20, maxInflightPerDevice: 1000 } })
  const a = h.socket(); const b = h.socket()
  const chA = h.bridge.attach(a.ws, 'dev-t')
  const chB = h.bridge.attach(b.ws, 'dev-t')
  for (let i = 0; i < 10; i += 1) await chA.call({ requestId: `a${i}`, endpoint: 'session/list' })
  for (let i = 0; i < 10; i += 1) await chB.call({ requestId: `b${i}`, endpoint: 'session/list' })
  const peersBefore = h.peers
  const callsBefore = h.gateway.calls.length
  assert.equal(callsBefore, 20)
  // The 21st call, from either connection, is rate limited before the Host.
  await chA.call({ requestId: 'a-over', endpoint: 'session/list' })
  assert.equal(a.sent.at(-1).error.code, 'remote/busy')
  await chB.call({ requestId: 'b-over', endpoint: 'session/list' })
  assert.equal(b.sent.at(-1).error.code, 'remote/busy')
  assert.equal(h.gateway.calls.length, callsBefore)
  assert.equal(h.peers, peersBefore)
  // Streams spend tokens too.
  await chA.openStream({ streamId: 'tok', endpoint: 'session/follow', args: {} })
  assert.equal(a.sent.at(-1).error.code, 'remote/busy')
  await delay(120) // ~2.4 tokens at 20/s
  await chA.call({ requestId: 'a-again', endpoint: 'session/list' })
  assert.equal(a.sent.at(-1).ok, true, 'the bucket refills')
  chA.close(); chB.close()
})

test('T9f: with remoteBridgeLimits configured, a device cannot multiply its connection budget (remote/busy before dispatch)', async (t) => {
  // Explicit gateway config (the plugin Config key); the limits are off otherwise.
  const instance = await factory(t, { config: { remoteBridgeLimits: { maxConnectionsPerDevice: 2 } } })
  assert.equal((await instance.status()).remoteBridgeLimits.maxConnectionsPerDevice, 2, '/mgw/status reports the limits in force')
  const layout = await pairDevice(instance, DESK, { kind: 'desktop', scopes: ALL_REMOTE })
  const sockets = [layout.ws]
  for (let i = 0; i < 3; i += 1) sockets.push(await connectToken(instance, layout.token, DESK))
  const callsBefore = instance.gateway.calls.length
  const replies = []
  for (const ws of sockets) replies.push(await call(ws, 'session/list'))
  const busy = replies.filter((r) => r.ok === false && r.error?.code === 'remote/busy')
  const served = replies.filter((r) => r.ok === true)
  assert.ok(served.length >= 1 && served.length <= 2, `at most 2 bridge connections are served (got ${served.length})`)
  assert.ok(busy.length >= 1, 'the extra connections are refused remote/busy')
  assert.equal(instance.gateway.calls.length - callsBefore, served.length, 'a busy connection never dispatches')
})

test('T9i: limits are OFF by default — many connections, streams, in-flight calls and a burst of calls never see remote/busy', async (t) => {
  // Unit: no `limits` at all, then an explicit all-zero object — both mean unlimited.
  for (const limits of [undefined, {}, { maxConnectionsPerDevice: 0, maxStreamsPerDevice: 0, maxInflightPerDevice: 0, callsPerSecond: 0, maxResultBytes: 0 }]) {
    const gateway = fakeGateway()
    const release = []
    gateway.dispatchRpc = (endpoint, payload, signal, peer) => new Promise((resolve) => {
      gateway.calls.push({ endpoint, payload, peer }); release.push(() => resolve({ ok: true, value: { endpoint } }))
    })
    const h = unitBridge({ gateway, limits })
    assert.deepEqual({ ...h.bridge.limits }, { maxConnectionsPerDevice: 0, maxStreamsPerDevice: 0, maxInflightPerDevice: 0, callsPerSecond: 0, maxResultBytes: 0 })
    const sockets = Array.from({ length: 12 }, () => h.socket())
    const channels = sockets.map((s) => h.bridge.attach(s.ws, 'dev-open'))
    // 12 connections of one device, 12 x 5 streams, 12 x 8 calls held in flight at once.
    for (const channel of channels) {
      for (let i = 0; i < 5; i += 1) await channel.openStream({ streamId: `s${i}`, endpoint: 'session/follow', args: {} })
    }
    assert.equal(h.gateway.opened.length, 60, 'every stream reached the Host')
    const pending = channels.flatMap((channel, c) => Array.from({ length: 8 }, (_, i) => channel.call({ requestId: `c${c}-${i}`, endpoint: 'session/list' })))
    await delay(30)
    assert.equal(gateway.calls.length, 96, 'every call (no rate limit, no in-flight cap) reached the Host')
    release.splice(0).forEach((fn) => fn())
    await Promise.all(pending)
    for (const { sent } of sockets) {
      assert.equal(sent.some((f) => f.error?.code === 'remote/busy'), false, 'nothing is ever remote/busy')
      assert.equal(sent.filter((f) => f.kind === 'remote-result' && f.ok === true).length, 8)
    }
    channels.forEach((channel) => channel.close())
  }
  // Over the wire, with the plugin Config at its defaults: four sockets of one device are all served.
  const instance = await factory(t)
  assert.deepEqual((await instance.status()).remoteBridgeLimits,
    { maxConnectionsPerDevice: 0, maxStreamsPerDevice: 0, maxInflightPerDevice: 0, callsPerSecond: 0, maxResultBytes: 0 })
  const layout = await pairDevice(instance, DESK, { kind: 'desktop', scopes: ALL_REMOTE })
  const sockets = [layout.ws]
  for (let i = 0; i < 5; i += 1) sockets.push(await connectToken(instance, layout.token, DESK))
  for (const ws of sockets) {
    for (let i = 0; i < 4; i += 1) {
      ws.send(JSON.stringify({ type: 'remote-stream-open', streamId: `w${i}`, endpoint: 'session/follow', args: {} }))
    }
  }
  const replies = []
  for (const ws of sockets) replies.push(await call(ws, 'session/list'))
  assert.equal(replies.every((r) => r.ok === true), true, JSON.stringify(replies.map((r) => r.error?.code)))
  for (const ws of sockets) {
    await takeFrame(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'w3')
    assert.equal(framesOf(ws, (f) => f.error?.code === 'remote/busy').length, 0)
  }
  assert.equal(instance.gateway.opened.length, sockets.length * 4)
})

test('T9j: limits stay configurable — each knob refuses at exactly its value (unit)', async () => {
  const gateway = fakeGateway()
  const h = unitBridge({ gateway, limits: { maxStreamsPerDevice: 2, maxInflightPerDevice: 0, callsPerSecond: 0, maxConnectionsPerDevice: 0 } })
  const a = h.socket()
  const channel = h.bridge.attach(a.ws, 'dev-cfg')
  for (const id of ['k1', 'k2', 'k3']) await channel.openStream({ streamId: id, endpoint: 'session/follow', args: {} })
  assert.equal(gateway.opened.length, 2)
  assert.equal(a.sent.find((f) => f.kind === 'remote-stream-closed' && f.streamId === 'k3').error.code, 'remote/busy')
  // Negative, fractional and non-numeric values are not limits (treated as 0 = unlimited).
  const bogus = unitBridge({ limits: { maxStreamsPerDevice: -1, callsPerSecond: 1.5, maxInflightPerDevice: 'x', maxConnectionsPerDevice: null, maxResultBytes: NaN } })
  assert.deepEqual({ ...bogus.bridge.limits }, { maxConnectionsPerDevice: 0, maxStreamsPerDevice: 0, maxInflightPerDevice: 0, callsPerSecond: 0, maxResultBytes: 0 })
  channel.close()
})

test('T9k: a one-shot result above the single-frame budget auto-upgrades to a stream and reassembles byte-exact (any size, with credit)', async (t) => {
  // Unit: a tiny maxPayloadBytes makes the single-frame budget small (floor 1 KiB).
  const gateway = fakeGateway()
  const sent = []
  const ws = { readyState: 1, bufferedAmount: 0, send: (text) => sent.push(JSON.parse(text)) }
  const bridge = createRemoteBridge({
    getGateway: () => gateway,
    createPeer: () => ({ principal: { kind: 'owner' } }),
    getDevice: () => ({ kind: 'desktop', scopes: ALL_REMOTE }),
    decideApproval: async () => ({ kind: 'error', code: 'bad-request', message: 'n/a' }),
    maxPayloadBytes: 8192, // single-frame budget = max(1024, 8192 - 4096) = 4096 bytes
    log: () => {},
  })
  const channel = bridge.attach(ws, 'dev-up')
  // Multi-byte text and surrogate pairs straddling every plausible chunk boundary.
  const tricky = Array.from({ length: 400 }, (_, i) => `é漢😀${i}`).join('|')
  const value = { items: Array.from({ length: 3 }, (_, i) => ({ i, tricky })), nested: { deep: [1, 2, { tricky }] } }
  const exact = JSON.stringify(value)
  gateway.dispatchRpc = async (endpoint) => ({ ok: true, value: endpoint === 'session/list' ? value : { small: true } })

  await channel.call({ requestId: 'small', endpoint: 'session/page' })
  assert.deepEqual(sent.at(-1), { kind: 'remote-result', requestId: 'small', ok: true, value: { small: true } }, 'a small result stays inline')

  await channel.call({ requestId: 'big', endpoint: 'session/list' })
  const reply = sent.find((f) => f.kind === 'remote-result' && f.requestId === 'big')
  assert.equal(reply.ok, true)
  assert.equal(reply.streamed, true)
  assert.equal(reply.value, undefined, 'the value is not in the reply')
  assert.match(reply.streamId, /^res\.\d+$/)
  // The default credit (64) is plenty here; frames arrive in order, then the close.
  await delay(150)
  const frames = sent.filter((f) => f.kind === 'remote-frame' && f.streamId === reply.streamId)
  assert.ok(frames.length >= 1)
  assert.deepEqual(frames.map((f) => f.seq), frames.map((_, i) => i))
  const closed = sent.filter((f) => f.kind === 'remote-stream-closed' && f.streamId === reply.streamId)
  assert.equal(closed.length, 1)
  assert.equal(closed[0].error, undefined, 'a clean close')
  const parts = frames.map((f) => f.value.$json)
  assert.equal(parts.at(-1).last, true)
  assert.equal(parts.slice(0, -1).every((p) => p.last === false), true)
  let offset = 0
  for (const part of parts) { assert.equal(part.offset, offset); offset += part.text.length; assert.equal(part.total, exact.length) }
  for (const part of parts) assert.equal(/[\uD800-\uDBFF]$/.test(part.text), false, 'no chunk ends inside a surrogate pair')
  const joined = parts.map((p) => p.text).join('')
  assert.equal(joined, exact, 'reassembled text is byte-exact')
  assert.deepEqual(JSON.parse(joined), value)
  assert.equal(Buffer.byteLength(joined, 'utf8'), Buffer.byteLength(exact, 'utf8'))
  channel.close()

  // Over the wire: the plugin's smallest allowed maxPayloadBytes (1 MiB, so the single-frame budget is
  // 1 MiB - 4 KiB) and a ~3 MiB result: several 256 KiB chunks, reassembled exactly.
  const instance = await factory(t, { config: { maxPayloadBytes: 1024 * 1024 } })
  const huge = { blob: 'x漢😀'.repeat(300_000), tail: [1, 2, 3] }
  const hugeText = JSON.stringify(huge)
  instance.gateway.dispatchRpc = async () => ({ ok: true, value: huge })
  const { ws: dws } = await desktop(instance)
  const hugeReply = await call(dws, 'session/list')
  assert.equal(hugeReply.ok, true)
  assert.equal(hugeReply.streamed, true)
  assert.ok(hugeText.length > 2 * REMOTE_BINARY_CHUNK_BYTES)
  await takeFrame(dws, (f) => f.kind === 'remote-stream-closed' && f.streamId === hugeReply.streamId, 15_000)
  const hugeFrames = framesOf(dws, (f) => f.kind === 'remote-frame' && f.streamId === hugeReply.streamId)
  assert.ok(hugeFrames.length >= 3, `several chunks (got ${hugeFrames.length})`)
  assert.equal(hugeFrames.map((f) => f.value.$json.text).join(''), hugeText, 'byte-exact over the wire')
  assert.deepEqual(JSON.parse(hugeFrames.map((f) => f.value.$json.text).join('')), huge)
  // Streamed results are credit-controlled like any stream: the Host never exceeds the grant.
  assert.ok(hugeFrames.length <= 64, 'within the default credit window')
})

test('T9m: an auto-upgraded result stream takes a maxStreamsPerDevice slot (remote/busy at the cap, released on close); 0 stays unlimited', async () => {
  const makeBridge = (limits) => {
    const gateway = fakeGateway()
    // Above the 1 KiB single-frame budget AND several 256 KiB chunks, so with a
    // credit of 1 the pump stalls after one frame and the stream (and its slot) stays open.
    const big = { text: 'x'.repeat(1024 * 1024) }
    gateway.dispatchRpc = async () => ({ ok: true, value: big })
    return { gateway, bridge: createRemoteBridge({
      getGateway: () => gateway,
      createPeer: () => ({ principal: { kind: 'owner' } }),
      getDevice: () => ({ kind: 'desktop', scopes: ALL_REMOTE }),
      decideApproval: async () => ({ kind: 'error', code: 'bad-request', message: 'n/a' }),
      maxPayloadBytes: 1024, defaultCredit: 1, limits, log: () => {},
    }) }
  }
  const socket = () => { const sent = []; return { sent, ws: { readyState: 1, bufferedAmount: 0, send: (text) => sent.push(JSON.parse(text)) } } }
  const replyOf = (s, requestId) => s.sent.find((f) => f.kind === 'remote-result' && f.requestId === requestId)

  const { bridge } = makeBridge({ maxStreamsPerDevice: 2, callsPerSecond: 0 })
  const a = socket(); const b = socket()
  const chA = bridge.attach(a.ws, 'dev-m')
  const chB = bridge.attach(b.ws, 'dev-m') // a second connection of the same device shares the budget
  // Hold the credit at 0 so the result streams stay open and keep their slot.
  const open = async (channel, s, id) => {
    await channel.call({ requestId: id, endpoint: 'session/list' })
    const reply = replyOf(s, id)
    assert.equal(reply.streamed, true, JSON.stringify(reply))
    return reply.streamId
  }
  const s1 = await open(chA, a, 'r1')
  await open(chB, b, 'r2')
  // The cap (2 per device, across connections) is reached: the next upgrade is refused, not streamed.
  await chA.call({ requestId: 'r3', endpoint: 'session/list' })
  assert.equal(replyOf(a, 'r3').ok, false)
  assert.equal(replyOf(a, 'r3').error.code, 'remote/busy')
  assert.equal(replyOf(a, 'r3').streamed, undefined)
  // A directly opened stream is refused by the very same budget.
  await chA.openStream({ streamId: 'direct', endpoint: 'session/follow', args: {} })
  assert.equal(a.sent.find((f) => f.kind === 'remote-stream-closed' && f.streamId === 'direct')?.error.code, 'remote/busy')
  // Cancelling a result stream frees its slot: the next upgrade works again.
  chA.cancel({ streamId: s1 })
  await delay(20)
  const s4 = await open(chA, a, 'r4')
  assert.match(s4, /^res\.\d+$/)
  chA.close(); chB.close()

  // 0 = unlimited (the default): many upgraded results, never busy.
  const { bridge: free } = makeBridge({})
  const c = socket()
  const chC = free.attach(c.ws, 'dev-free')
  for (let i = 0; i < 8; i += 1) await open(chC, c, `f${i}`)
  assert.equal(c.sent.some((f) => f.error?.code === 'remote/busy'), false)
  chC.close()
})

test('T9l: a result-stream id is Host-owned — a client cannot open or collide with `res.*`; cancel closes it', async (t) => {
  const instance = await factory(t, { config: { maxPayloadBytes: 1024 * 1024 } })
  const { ws } = await desktop(instance)
  ws.send(JSON.stringify({ type: 'remote-stream-open', requestId: 'resid', streamId: 'res.1', endpoint: 'session/follow', args: {} }))
  assert.equal((await takeFrame(ws, (f) => f.requestId === 'resid')).error.code, 'bad-request')
  // A streamed result that the client does not drain (no credit) is cancelled cleanly.
  // 40 MiB of JSON text = 160 chunks of 256 KiB, more than the 64-frame default credit.
  const bigText = 'x'.repeat(40 * 1024 * 1024)
  instance.gateway.dispatchRpc = async () => ({ ok: true, value: { bigText } })
  const reply = await call(ws, 'session/list')
  assert.equal(reply.streamed, true)
  await takeFrame(ws, (f) => f.kind === 'remote-frame' && f.streamId === reply.streamId && f.seq === 63, 15_000)
  const before = framesOf(ws, (f) => f.kind === 'remote-frame' && f.streamId === reply.streamId).length
  assert.equal(before, 64, 'credit holds the Host at 64 frames')
  ws.send(JSON.stringify({ type: 'remote-stream-cancel', streamId: reply.streamId }))
  await takeFrame(ws, (f) => f.kind === 'remote-stream-closed' && f.streamId === reply.streamId)
  await delay(100)
  assert.equal(framesOf(ws, (f) => f.kind === 'remote-frame' && f.streamId === reply.streamId).length, before, 'no frames after cancel')
})

test('T9g: deferred open → cancel → reopen → the old opener settling must not delete or release the new stream', async () => {
  const gateway = fakeGateway()
  const openers = []
  gateway.openWireStream = (endpoint, payload, uplink, peer, signal) => new Promise((resolve, reject) => {
    const stream = { endpoint, signal, resolve, reject, returned: 0 }
    openers.push(stream)
  })
  const h = unitBridge({ gateway, limits: { maxStreamsPerDevice: 2, callsPerSecond: 1000 } })
  const a = h.socket()
  const channel = h.bridge.attach(a.ws, 'dev-d')
  const source = (tag) => ({
    [Symbol.asyncIterator]() {
      let n = 0
      return { async next() { await delay(2); n += 1; return { done: false, value: { tag, n } } },
        async return() { return { done: true } } }
    },
  })
  const first = channel.openStream({ streamId: 'dup', endpoint: 'session/follow', args: {} })
  await delay(10)
  assert.equal(openers.length, 1)
  // Cancel while the opener is pending: the id stays reserved until it settles.
  channel.cancel({ streamId: 'dup' })
  assert.equal(a.sent.filter((f) => f.kind === 'remote-stream-closed' && f.streamId === 'dup').length, 1)
  assert.equal(openers[0].signal.aborted, true)
  // Reopening the same id is NOT possible yet (still reserved) ...
  await channel.openStream({ streamId: 'dup', endpoint: 'session/follow', args: {} })
  assert.equal(openers.length, 1, 'the reserved id was not reopened')
  // ... the old opener settles; the id is free again.
  openers[0].resolve(source('old'))
  await first
  assert.equal(channel.openStreams, 0)
  const second = channel.openStream({ streamId: 'dup', endpoint: 'session/follow', args: {} })
  await delay(10)
  assert.equal(openers.length, 2)
  openers[1].resolve(source('new'))
  await second
  await delay(40)
  const frames = a.sent.filter((f) => f.kind === 'remote-frame' && f.streamId === 'dup')
  assert.ok(frames.length > 0 && frames.every((f) => f.value.tag === 'new'), 'only the new stream produces frames')
  assert.equal(channel.openStreams, 1, 'the new stream was not deleted by the old opener settling')
  // Slot accounting: the cancelled stream released its slot exactly once.
  const b = h.socket()
  const channelB = h.bridge.attach(b.ws, 'dev-d')
  const third = channelB.openStream({ streamId: 'other', endpoint: 'session/follow', args: {} })
  await delay(10)
  openers[2].resolve(source('third'))
  await third
  await delay(20)
  assert.equal(b.sent.some((f) => f.kind === 'remote-stream-closed' && f.error), false, 'device slots: 2 of 2 in use, not 3')
  await channelB.openStream({ streamId: 'over', endpoint: 'session/follow', args: {} })
  assert.equal(b.sent.at(-1).error.code, 'remote/busy')
  channel.close(); channelB.close()
})

test('T9g2: a late-finishing old pump (slow iterator.return) must not delete or release a reused id', async () => {
  const gateway = fakeGateway()
  let n = 0
  const slowReturn = Promise.withResolvers()
  gateway.openWireStream = () => {
    const tag = (n += 1) === 1 ? 'old' : 'new'
    return Promise.resolve({
      [Symbol.asyncIterator]() {
        return {
          async next() { await delay(2); return { done: false, value: { tag } } },
          // The old iterator takes a long time to unwind after cancel.
          async return() { if (tag === 'old') await slowReturn.promise; return { done: true } },
        }
      },
    })
  }
  const h = unitBridge({ gateway, limits: { maxStreamsPerDevice: 2, callsPerSecond: 1000 } })
  const a = h.socket()
  const channel = h.bridge.attach(a.ws, 'dev-g2')
  await channel.openStream({ streamId: 'same', endpoint: 'session/follow', args: {} })
  await delay(20)
  channel.cancel({ streamId: 'same' }) // old pump is now stuck in iterator.return()
  await channel.openStream({ streamId: 'same', endpoint: 'session/follow', args: {} })
  await delay(20)
  assert.equal(channel.openStreams, 1)
  slowReturn.resolve() // the OLD pump's finally runs now, after the id was reused
  await delay(40)
  assert.equal(channel.openStreams, 1, 'the new stream survives the old pump finishing')
  const before = a.sent.filter((f) => f.kind === 'remote-frame' && f.value.tag === 'new').length
  await delay(40)
  assert.ok(a.sent.filter((f) => f.kind === 'remote-frame' && f.value.tag === 'new').length > before, 'the new stream keeps producing')
  assert.equal(a.sent.filter((f) => f.kind === 'remote-stream-closed').length, 1, 'only the cancel closed anything')
  channel.close()
})

test('T9h: a rejected endpoint shape logs a fixed invalid-endpoint marker, never the text', async () => {
  const h = unitBridge()
  const { sent, ws } = h.socket()
  const channel = h.bridge.attach(ws, 'dev-l')
  const hostile = 'EVIL\nforged-log-line secret-token-123'
  for (const endpoint of [hostile, 42, null, '../etc/passwd', 'a/b/c', '']) {
    await channel.call({ requestId: 'x', endpoint })
    await channel.openStream({ streamId: 'st', endpoint, args: {} })
  }
  const joined = h.logs.join('\n')
  assert.equal(joined.includes('secret-token-123'), false, 'attacker-controlled endpoint text is never logged')
  assert.equal(joined.includes('forged-log-line'), false)
  assert.equal(joined.includes('/etc/passwd'), false)
  assert.ok(h.logs.some((line) => line.includes('endpoint=invalid-endpoint')), 'a fixed marker is logged')
  assert.equal(sent.every((f) => f.ok === false || f.kind === 'remote-stream-closed'), true)
  // A well-formed (even if denied) endpoint is logged after shape validation.
  await channel.call({ requestId: 'y', endpoint: 'terminal/attach' })
  assert.ok(h.logs.some((line) => line.includes('endpoint=terminal/attach') && line.includes('allowed=false')))
  channel.close()
})

// -- T10: spec 008 full control — argument constraints, credentials, terminal ----

const wsStandard = [...SCOPE_PRESETS.standard] // sessions:read, prompt:send, approval:respond, files:read, harness:remote

test('T10a: relative-path guard — no "..", absolute, drive letter, ":", NUL (unit)', () => {
  for (const ok of ['a.txt', 'src/lib/x.mjs', 'src\\lib\\x.mjs', 'dir/with.dots/file', '.hidden', 'a..b/c']) {
    assert.equal(isRelativeWorkspacePath(ok), true, ok)
  }
  for (const bad of ['../x', 'a/../../x', 'a\\..\\x', '..', '/etc/passwd', '\\\\server\\share', 'C:\\Windows', 'c:/x', 'file:///x',
    'a:b', 'a\0b', 'a/\0', 42, null, undefined, {}, 'x'.repeat(5000)]) {
    assert.equal(isRelativeWorkspacePath(bad), false, String(bad))
  }
  assert.equal(isRelativeWorkspacePath('', { allowEmpty: true }), true)
  assert.equal(isRelativeWorkspacePath(''), false)
})

test('T10b: without workspace:manage, file endpoints take relative paths only (path, baseFile, query, nested, arrays)', () => {
  const device = holding('files:read')
  const files = ['workspaceFiles/list', 'workspaceFiles/stat', 'workspaceFiles/read', 'workspaceFiles/readBytes',
    'workspaceFiles/changes', 'officeToPdf/render', 'fileReferences/list']
  for (const endpoint of files) {
    assert.equal(checkArguments(device, endpoint, { path: 'src/a.txt', sessionId: 's1' }), undefined, endpoint)
    assert.equal(checkArguments(device, endpoint, {}), undefined, `${endpoint} without a path is fine`)
    for (const path of ['../secret', 'a/../../b', '/etc/passwd', 'C:\\Users\\x', 'c:x', 'a\0b', 'dir/..\\..\\x']) {
      const refusal = checkArguments(device, endpoint, { sessionId: 's1', path })
      assert.equal(refusal?.code, 'remote/path-denied', `${endpoint} ${JSON.stringify(path)}`)
    }
  }
  // baseFile (readBytes options or flat) is checked as well, at any depth.
  assert.equal(checkArguments(device, 'workspaceFiles/readBytes', { path: 'a', options: { baseFile: '../../x' } })?.code, 'remote/path-denied')
  assert.equal(checkArguments(device, 'workspaceFiles/readBytes', { path: 'a', baseFile: '/abs/file' })?.code, 'remote/path-denied')
  assert.equal(checkArguments(device, 'workspaceFiles/readBytes', { path: 'a', baseFile: 'D:\\f' })?.code, 'remote/path-denied')
  assert.equal(checkArguments(device, 'workspaceFiles/readBytes', { request: { path: 'a', options: { baseFile: 'ok/base.html' } } }), undefined)
  // A non-string path is refused, not coerced.
  assert.equal(checkArguments(device, 'workspaceFiles/read', { path: 7 })?.code, 'remote/path-denied')
  assert.equal(checkArguments(device, 'workspaceFiles/read', { path: ['a', '../b'] })?.code, 'remote/path-denied')
  // fileReferences/list: an absolute or '..' query is refused, a plain one is fine.
  assert.equal(checkArguments(device, 'fileReferences/list', { query: '/etc' })?.code, 'remote/path-denied')
  assert.equal(checkArguments(device, 'fileReferences/list', { query: '../x' })?.code, 'remote/path-denied')
  assert.equal(checkArguments(device, 'fileReferences/list', { query: 'readme' }), undefined)
  // The constraint is not applied to endpoints that are not file endpoints.
  assert.equal(checkArguments(device, 'session/list', { path: '/abs' }), undefined)
})

test('T10c: workspace:manage lifts the path and cwd/agentPreset constraints', () => {
  const manager = holding('files:read', 'prompt:send', 'workspace:manage')
  for (const endpoint of ['workspaceFiles/read', 'workspaceFiles/readBytes', 'officeToPdf/render', 'fileReferences/list']) {
    for (const path of ['../secret', '/etc/passwd', 'C:\\Users\\x']) {
      assert.equal(checkArguments(manager, endpoint, { path, options: { baseFile: '/abs/base' } }), undefined, `${endpoint} ${path}`)
    }
  }
  assert.equal(checkArguments(manager, 'session/create', { request: { cwd: 'C:\\work', agentPreset: 'x' } }), undefined)
  // ... and the same arguments are refused for a device without it.
  const plain = holding('files:read', 'prompt:send')
  assert.equal(checkArguments(plain, 'session/create', { request: { cwd: 'C:\\work' } })?.code, 'remote/argument-denied')
  assert.equal(checkArguments(plain, 'session/create', { request: { workspaceId: 'w1', agentPreset: 'x' } })?.code, 'remote/argument-denied')
  assert.equal(checkArguments(plain, 'session/create', { cwd: '/tmp' })?.code, 'remote/argument-denied')
  assert.equal(checkArguments(plain, 'session/create', { request: { workspaceId: 'w1' } }), undefined)
})

test('T10d: session/create without workspace:manage needs a workspaceId from the Host list (unit, fake Host)', async () => {
  const device = holding('prompt:send')
  const host = { workspaceIds: async () => new Set(['w1', 'w2']) }
  assert.equal(await checkArgumentsWithHost(device, 'session/create', { request: { workspaceId: 'w1' } }, host), undefined)
  assert.equal((await checkArgumentsWithHost(device, 'session/create', { request: { workspaceId: 'nope' } }, host))?.code, 'remote/argument-denied')
  assert.equal((await checkArgumentsWithHost(device, 'session/create', { request: {} }, host))?.code, 'remote/argument-denied')
  assert.equal((await checkArgumentsWithHost(device, 'session/create', { request: { workspaceId: 7 } }, host))?.code, 'remote/argument-denied')
  // A Host list that cannot be read fails closed.
  assert.equal((await checkArgumentsWithHost(device, 'session/create', { request: { workspaceId: 'w1' } },
    { workspaceIds: async () => undefined }))?.code, 'remote/unavailable')
  assert.equal((await checkArgumentsWithHost(device, 'session/create', { request: { workspaceId: 'w1' } },
    { workspaceIds: async () => { throw new Error('boom') } }))?.code, 'remote/unavailable')
  // workspace:manage: no Host-list check at all (a new directory may be created by cwd).
  const manager = holding('prompt:send', 'workspace:manage')
  assert.equal(await checkArgumentsWithHost(manager, 'session/create', { request: { cwd: 'C:\\new' } },
    { workspaceIds: async () => { throw new Error('must not be asked') } }), undefined)
})

test('T10e: over the wire, session/create is checked against the real workspace list; cwd needs workspace:manage', async (t) => {
  const instance = await factory(t)
  const { ws } = await desktop(instance, wsStandard)
  const before = instance.gateway.calls.length
  const ok = await call(ws, 'session/create', { request: { workspaceId: 'w2' } })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(instance.gateway.calls.filter((c) => c.endpoint === 'session/create').length, 1)
  // The workspace list was read from the Host, through an owner Peer.
  const listing = instance.gateway.opened.find((s) => s.endpoint === 'workspace/follow')
  assert.ok(listing, 'the Host workspace list was consulted')
  assert.equal(listing.peer?.principal?.kind, 'owner')
  const unknown = await call(ws, 'session/create', { request: { workspaceId: 'ghost' } })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'remote/argument-denied')
  const cwd = await call(ws, 'session/create', { request: { cwd: 'C:\\Windows' } })
  assert.equal(cwd.error.code, 'remote/argument-denied')
  const preset = await call(ws, 'session/create', { request: { workspaceId: 'w1', agentPreset: 'x' } })
  assert.equal(preset.error.code, 'remote/argument-denied')
  assert.equal(instance.gateway.calls.filter((c) => c.endpoint === 'session/create').length, 1, 'refused creates never reached the Host')
  void before

  const { ws: manager } = await desktop(instance, [...wsStandard, 'workspace:manage'], 'deskmgr0-0000-4000-8000-000000000011')
  const created = await call(manager, 'session/create', { request: { cwd: 'C:\\anywhere', agentPreset: 'p' } })
  assert.equal(created.ok, true, JSON.stringify(created))
  const forwarded = instance.gateway.calls.filter((c) => c.endpoint === 'session/create').at(-1)
  assert.deepEqual(forwarded.payload.args, { request: { cwd: 'C:\\anywhere', agentPreset: 'p' } }, 'arguments pass through unchanged')
})

test('T10f: file endpoints over the wire — ".." and absolute refused without workspace:manage, served with it', async (t) => {
  const instance = await factory(t)
  const { ws } = await desktop(instance, wsStandard)
  const callsBefore = instance.gateway.calls.length
  for (const args of [{ sessionId: 's1', path: '../x' }, { sessionId: 's1', path: '/etc/passwd' }, { sessionId: 's1', path: 'C:\\x' },
    { sessionId: 's1', path: 'a', options: { baseFile: '../b' } }]) {
    const reply = await call(ws, 'workspaceFiles/readBytes', args)
    assert.equal(reply.ok, false, JSON.stringify(args))
    assert.equal(reply.error.code, 'remote/path-denied')
  }
  // A stream endpoint is constrained the same way.
  ws.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'chg', endpoint: 'workspaceFiles/changes', args: { sessionId: 's1', path: '../x' } }))
  assert.equal((await takeFrame(ws, (f) => f.kind === 'remote-stream-closed' && f.streamId === 'chg')).error.code, 'remote/path-denied')
  assert.equal(instance.gateway.calls.length, callsBefore)
  assert.equal(instance.gateway.opened.some((s) => s.endpoint === 'workspaceFiles/changes'), false)
  const fine = await call(ws, 'workspaceFiles/stat', { sessionId: 's1', path: 'src/a.txt' })
  assert.equal(fine.ok, true, JSON.stringify(fine))

  const { ws: manager } = await desktop(instance, [...wsStandard, 'workspace:manage'], 'deskmgr1-0000-4000-8000-000000000012')
  const lifted = await call(manager, 'workspaceFiles/readBytes', { sessionId: 's1', path: '/etc/hosts', options: { baseFile: '../x' } })
  assert.equal(lifted.ok, true, JSON.stringify(lifted))
  assert.deepEqual(instance.gateway.calls.at(-1).payload.args, { sessionId: 's1', path: '/etc/hosts', options: { baseFile: '../x' } })
})

test('T10g: session/selectModel and initializeDefaultModel change the Host global default, so they need settings:write; agentPresets/select too', async (t) => {
  const instance = await factory(t)
  // The fake Host models what the real session-controller does: selectModel and
  // initializeDefaultModel both end in `agentDefaultModel.saveSelection`
  // (session-controller lib/index.js:716 and :3945), i.e. they write the GLOBAL default.
  let globalDefault = { provider: 'deepseek', model: 'deepseek-chat' }
  const dispatch = instance.gateway.dispatchRpc
  instance.gateway.dispatchRpc = async (endpoint, payload, signal, peer) => {
    if (endpoint === 'session/selectModel') {
      const { provider, model } = payload.args.request
      globalDefault = { provider, model }
    }
    if (endpoint === 'session/initializeDefaultModel') globalDefault = { provider: 'deepseek-account', model: 'first' }
    return dispatch(endpoint, payload, signal, peer)
  }
  const { ws } = await desktop(instance, wsStandard)
  const startDefault = { ...globalDefault }
  const hostCalls = () => instance.gateway.calls.filter((c) => ['session/selectModel', 'session/initializeDefaultModel'].includes(c.endpoint)).length
  // prompt:send (the standard preset) cannot touch the global default: refused before the Host.
  for (const [endpoint, args] of [
    ['session/selectModel', { request: { sessionId: 's1', provider: 'deepseek', model: 'deepseek-reasoner' } }],
    ['session/selectModel', { request: { sessionId: 's1', provider: 'anything', model: 'anything' } }],
    ['session/initializeDefaultModel', {}],
  ]) {
    const reply = await call(ws, endpoint, args)
    assert.equal(reply.ok, false, `${endpoint} ${JSON.stringify(args)}`)
    assert.equal(reply.error.code, 'auth/forbidden-scope')
    assert.equal(reply.error.scope, 'settings:write')
  }
  assert.equal(hostCalls(), 0, 'refused calls never reached the Host')
  assert.deepEqual(globalDefault, startDefault, 'the Host global default is unchanged after the refused calls')
  // The model list stays under prompt:send.
  assert.equal((await call(ws, 'session/modelCatalog')).ok, true)
  // With settings:write the call goes through and the global default does change.
  const { ws: writer } = await desktop(instance, [...wsStandard, 'settings:write'], 'deskset0-0000-4000-8000-000000000013')
  const free = await call(writer, 'session/selectModel', { request: { sessionId: 's1', provider: 'anything', model: 'anything' } })
  assert.equal(free.ok, true, JSON.stringify(free))
  assert.deepEqual(globalDefault, { provider: 'anything', model: 'anything' }, 'with settings:write the Host default is written')
  assert.equal((await call(writer, 'session/initializeDefaultModel')).ok, true)
  assert.equal(hostCalls(), 2)
  // agentPresets/select is a settings:write endpoint whatever the preset id.
  const noSettings = await call(ws, 'agentPresets/select', { agentId: 's1', agentPreset: 'any' })
  assert.equal(noSettings.error.code, 'auth/forbidden-scope')
  assert.equal(noSettings.error.scope, 'settings:write')
  assert.equal((await call(writer, 'agentPresets/select', { agentId: 's1', agentPreset: 'any-id' })).ok, true)
  assert.equal(checkArguments(holding('prompt:send'), 'agentPresets/select', {})?.code, 'auth/forbidden-scope')
})

test('T10h: goals — maxGoalRounds is capped at 50 unless settings:write', () => {
  assert.equal(MAX_GOAL_ROUNDS, 50)
  const device = holding('prompt:send')
  for (const endpoint of ['goals/create', 'goals/edit']) {
    assert.equal(checkArguments(device, endpoint, { agentId: 's1', request: { objective: 'x', maxGoalRounds: 50 } }), undefined)
    assert.equal(checkArguments(device, endpoint, { agentId: 's1', request: { objective: 'x', maxGoalRounds: 12 } }), undefined)
    assert.equal(checkArguments(device, endpoint, { agentId: 's1', request: { objective: 'x' } }), undefined, 'absent is the Host default')
    for (const bad of [51, 1000, 0, -1, 1.5, '10', null]) {
      assert.equal(checkArguments(device, endpoint, { agentId: 's1', request: { objective: 'x', maxGoalRounds: bad } })?.code,
        'remote/argument-denied', `${endpoint} maxGoalRounds=${JSON.stringify(bad)}`)
    }
  }
  assert.equal(checkArguments(device, 'goals/pause', { agentId: 's1', ref: { id: 'g', revision: 1 } }), undefined)
  // settings:write lifts the cap.
  assert.equal(checkArguments(holding('prompt:send', 'settings:write'), 'goals/edit', { request: { maxGoalRounds: 5000 } }), undefined)
})

// Review finding 2: the guards inspect a bounded part of the tree but the WHOLE tree is forwarded.
// Exceeding a bound must refuse (never skip), and the documented slots are read directly.
const padding = (n = 70) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`pad${i}`, i]))
const nest = (depth, leaf) => (depth === 0 ? leaf : { next: nest(depth - 1, leaf) })

test('T10m: a traversal bound exceeded (64+ keys, deep nesting) refuses arguments-too-complex for a device without the scope, and a known slot is still read', () => {
  const plain = holding('files:read', 'prompt:send')
  const TOO_COMPLEX = 'remote/arguments-too-complex'
  // 64+ padding keys placed BEFORE the interesting key.
  assert.equal(checkArguments(plain, 'workspaceFiles/read', { ...padding(), options: { baseFile: '../../x' } })?.code, TOO_COMPLEX)
  assert.equal(checkArguments(plain, 'session/create', { ...padding(), meta: { cwd: 'C:\\evil' } })?.code, TOO_COMPLEX)
  assert.equal(checkArguments(plain, 'goals/create', { ...padding(), meta: { maxGoalRounds: 99999 } })?.code, TOO_COMPLEX)
  // A wide array hides a path as well.
  assert.equal(checkArguments(plain, 'workspaceFiles/read', { list: Array.from({ length: 70 }, () => 1), options: { baseFile: '/abs' } })?.code, TOO_COMPLEX)
  // Nesting deeper than the bound, with the dangerous key at the bottom.
  for (const [endpoint, leaf] of [
    ['workspaceFiles/read', { baseFile: '/etc/passwd' }],
    ['session/create', { cwd: 'C:\\evil' }],
    ['session/create', { agentPreset: 'x' }],
    ['goals/edit', { maxGoalRounds: 99999 }],
  ]) {
    assert.equal(checkArguments(plain, endpoint, nest(10, leaf))?.code, TOO_COMPLEX, endpoint)
  }
  // The known locations are checked directly, so padding cannot push them out of reach:
  // the specific refusal wins even though the tree is also too wide.
  assert.equal(checkArguments(plain, 'workspaceFiles/read', { ...padding(), path: '../x' })?.code, 'remote/path-denied')
  assert.equal(checkArguments(plain, 'workspaceFiles/readBytes', { ...padding(), request: { baseFile: '/abs' } })?.code, 'remote/path-denied')
  assert.equal(checkArguments(plain, 'session/create', { ...padding(), cwd: 'C:\\x' })?.code, 'remote/argument-denied')
  assert.equal(checkArguments(plain, 'session/create', { ...padding(), request: { agentPreset: 'x' } })?.code, 'remote/argument-denied')
  assert.equal(checkArguments(plain, 'goals/create', { ...padding(), maxGoalRounds: 99999 })?.code, 'remote/argument-denied')
  // Exactly at the bounds is still fine (64 keys, depth 6).
  assert.equal(checkArguments(plain, 'workspaceFiles/read', { ...padding(63), path: 'a' }), undefined)
  assert.equal(checkArguments(plain, 'workspaceFiles/read', nest(5, { path: 'ok' })), undefined)
  // Endpoints that are not constrained are never refused for being complex.
  assert.equal(checkArguments(plain, 'session/prompt', { ...padding(), deep: nest(10, { cwd: 'x' }) }), undefined)
  // A device holding the matching scope never reaches the walkers (the Host's own behaviour applies).
  assert.equal(checkArguments(holding('files:read', 'workspace:manage'), 'workspaceFiles/read', { ...padding(), options: { baseFile: '/x' } }), undefined)
  assert.equal(checkArguments(holding('prompt:send', 'workspace:manage'), 'session/create', nest(10, { cwd: 'C:\\x' })), undefined)
  assert.equal(checkArguments(holding('prompt:send', 'settings:write'), 'goals/create', { ...padding(), request: { maxGoalRounds: 9999 } }), undefined)
})

test('T10n: the Host-list check refuses too-complex session/create arguments (unit) and the wire never reaches the Host', async (t) => {
  const plain = holding('prompt:send')
  const host = { workspaceIds: async () => { throw new Error('must not be asked') } }
  assert.equal((await checkArgumentsWithHost(plain, 'session/create', { ...padding(), meta: { workspaceId: 'w1' } }, host))?.code, 'remote/arguments-too-complex')
  assert.equal((await checkArgumentsWithHost(plain, 'session/create', nest(10, { workspaceId: 'w1' }), host))?.code, 'remote/arguments-too-complex')
  const instance = await factory(t)
  const { ws } = await desktop(instance, wsStandard)
  const before = instance.gateway.calls.length
  for (const args of [{ ...padding(), request: { workspaceId: 'w1', cwd: 'C:\\evil' } }, nest(10, { cwd: 'C:\\evil' })]) {
    const reply = await call(ws, 'session/create', args)
    assert.equal(reply.ok, false)
    assert.ok(['remote/argument-denied', 'remote/arguments-too-complex'].includes(reply.error.code), reply.error.code)
  }
  const files = await call(ws, 'workspaceFiles/read', { sessionId: 's1', ...padding(), options: { baseFile: '../../x' } })
  assert.equal(files.error.code, 'remote/arguments-too-complex')
  assert.equal(instance.gateway.calls.length, before, 'nothing reached the Host')
})

test('T10i: credentials are write-only — a value is never returned, never logged, no read endpoint is forwardable', async (t) => {
  const instance = await factory(t)
  const { ws } = await desktop(instance, [...ALL_REMOTE, 'credentials:write'])
  const SECRET = 'sk-SECRET-VALUE-123'
  const set = await call(ws, 'credentials/set', { ref: 'DEEPSEEK_API_KEY', value: SECRET })
  assert.equal(set.ok, true, JSON.stringify(set))
  assert.deepEqual(set.value, {}, 'nothing comes back from a set')
  // The Host received the value (that is the point) ...
  const forwarded = instance.gateway.calls.find((c) => c.endpoint === 'credentials/set')
  assert.equal(forwarded.payload.args.value, SECRET)
  // ... and a Host failure that quotes the value is scrubbed to a stable code.
  const failed = await call(ws, 'credentials/unset', { ref: 'DEEPSEEK_API_KEY', value: SECRET })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'credential-failed')
  assert.equal(JSON.stringify(failed).includes(SECRET), false, 'a Host error text is never echoed for credentials')
  // No reply frame carries the value; no log line does either.
  assert.equal(framesOf(ws, () => true).some((frame) => JSON.stringify(frame).includes(SECRET)), false)
  assert.equal(instance.logs.some((line) => String(line).includes(SECRET)), false, 'the secret is never logged')
  assert.ok(instance.logs.some((line) => String(line).includes('remote-bridge call: endpoint=credentials/set')), 'the call itself is audited (endpoint + device)')
  // Every credentials endpoint that could return a secret is refused even with every scope.
  const everything = await desktop(instance, [...SCOPES], 'deskcred-0000-4000-8000-000000000014')
  const callsBefore = instance.gateway.calls.length
  for (const endpoint of ['credentials/describe', 'credentials/resolve', 'credentials/get', 'credentials/list', 'credentials/read']) {
    const reply = await call(everything.ws, endpoint, { ref: 'DEEPSEEK_API_KEY' })
    assert.equal(reply.error.code, 'op/forbidden', endpoint)
  }
  assert.equal(instance.gateway.calls.length, callsBefore)
  // Without credentials:write, set/unset are refused by scope.
  const { ws: plain } = await desktop(instance, ALL_REMOTE, 'deskcred-0000-4000-8000-000000000015')
  assert.equal((await call(plain, 'credentials/set', { ref: 'X', value: SECRET })).error.code, 'auth/forbidden-scope')
  assert.equal(instance.logs.some((line) => String(line).includes(SECRET)), false)
})

test('T10j: terminal frames are streamed to the device but never logged (and need the terminal scope)', async (t) => {
  const instance = await factory(t)
  const SECRET_OUTPUT = 'TERMINAL-FRAME-SECRET-OUTPUT-777'
  instance.gateway.openWireStream = (endpoint, payload, uplink, peer, signal) => {
    const stream = { endpoint, payload, peer, signal, produced: 0 }
    instance.gateway.opened.push(stream)
    return Promise.resolve({
      [Symbol.asyncIterator]() {
        let n = 0
        return { async next() { n += 1; await delay(2); return n <= 3 ? { done: false, value: { type: 'output', data: `${SECRET_OUTPUT}-${n}` } } : { done: true } },
          async return() { return { done: true } } }
      },
    })
  }
  const { ws } = await desktop(instance, [...ALL_REMOTE, 'terminal'])
  ws.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'term', endpoint: 'terminal/follow', args: { sessionId: 's1', input: 'echo hunter2' } }))
  await takeFrame(ws, (f) => f.kind === 'remote-stream-closed' && f.streamId === 'term')
  const frames = framesOf(ws, (f) => f.kind === 'remote-frame' && f.streamId === 'term')
  assert.equal(frames.length, 3, 'the frames reach the device')
  assert.ok(frames[0].value.data.includes(SECRET_OUTPUT))
  assert.equal(instance.logs.some((line) => String(line).includes(SECRET_OUTPUT)), false, 'terminal frames are never logged')
  assert.equal(instance.logs.some((line) => String(line).includes('hunter2')), false, 'terminal arguments are never logged')
  assert.ok(instance.logs.some((line) => String(line).includes('remote-bridge stream-open: endpoint=terminal/follow') && String(line).includes('allowed=true')))
  // Without the terminal scope the stream is refused before the Host.
  const { ws: plain } = await desktop(instance, ALL_REMOTE, 'deskterm-0000-4000-8000-000000000016')
  const opened = instance.gateway.opened.length
  plain.send(JSON.stringify({ type: 'remote-stream-open', streamId: 'term2', endpoint: 'terminal/follow', args: {} }))
  assert.equal((await takeFrame(plain, (f) => f.kind === 'remote-stream-closed' && f.streamId === 'term2')).error.scope, 'terminal')
  assert.equal(instance.gateway.opened.length, opened)
})

test('T10k: every full-control family works end to end over the wire when (and only when) its scope is held', async (t) => {
  const instance = await factory(t)
  const probes = {
    'commands:execute': ['commands/execute', { agentId: 's1', line: '/permission ask' }],
    'workspace:manage': ['workspace/create', { request: { path: 'C:\\new' } }],
    'settings:write': ['settings/describe', {}],
    'plugins:manage': ['pluginManager/listBundles', {}],
    'schedule:write': ['schedule/create', { agentId: 's1' }],
    'credentials:write': ['credentials/set', { ref: 'K', value: 'v' }],
  }
  let n = 40
  for (const [scope, [endpoint, args]] of Object.entries(probes)) {
    n += 2
    const without = await desktop(instance, ALL_REMOTE, `deskfam0-0000-4000-8000-0000000000${n}`)
    const refused = await call(without.ws, endpoint, args)
    assert.equal(refused.error?.code, 'auth/forbidden-scope', `${endpoint} without ${scope}`)
    assert.equal(refused.error.scope, scope)
    const withScope = await desktop(instance, [...ALL_REMOTE, scope], `deskfam1-0000-4000-8000-0000000000${n + 1}`)
    const served = await call(withScope.ws, endpoint, args)
    assert.equal(served.ok, true, `${endpoint} with ${scope}: ${JSON.stringify(served)}`)
    assert.ok(instance.gateway.calls.some((c) => c.endpoint === endpoint), `${endpoint} reached the Host`)
  }
})

test('T10l: presets and the mobile boundary — standard/full are exactly as specified, a mobile never holds a full-control scope', async (t) => {
  assert.deepEqual([...SCOPE_PRESETS.standard], ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote'])
  assert.deepEqual([...SCOPE_PRESETS.full].sort(), [...SCOPES].sort())
  for (const scope of DESKTOP_ONLY_SCOPES) {
    assert.equal(DESKTOP_DEFAULT_SCOPES.includes(scope), false, `${scope} is never a default`)
    assert.ok(SCOPE_PRESETS.full.includes(scope), `full includes ${scope}`)
  }
  assert.deepEqual([...DESKTOP_ONLY_SCOPES],
    ['harness:remote', 'commands:execute', 'workspace:manage', 'credentials:write', 'plugins:manage', 'schedule:write', 'terminal'])

  const instance = await factory(t)
  // A mobile offer drops every desktop-only scope, whether listed explicitly or via "all".
  const mobileExplicit = await instance.post('pair', { kind: 'mobile', scopes: [...SCOPES], publicUrl: instance.lanUrl })
  assert.equal(mobileExplicit.status, 201, JSON.stringify(mobileExplicit.data))
  for (const scope of DESKTOP_ONLY_SCOPES) assert.equal(mobileExplicit.data.pairing.scopes.includes(scope), false, `mobile offer lists ${scope}`)
  const mobileDefault = await instance.post('pair', { publicUrl: instance.lanUrl })
  for (const scope of DESKTOP_ONLY_SCOPES) assert.equal(mobileDefault.data.pairing.scopes.includes(scope), false, `default offer lists ${scope}`)
  // The device a mobile claims does not hold them either, and cannot use the bridge.
  const layout = await pairDevice(instance, 'mobilefc-0000-4000-8000-000000000030', { kind: 'mobile', scopes: [...SCOPES] })
  for (const scope of DESKTOP_ONLY_SCOPES) assert.equal(layout.device.scopes.includes(scope), false, `mobile device holds ${scope}`)
  const stored = (await instance.devices()).devices.find((device) => device.id === layout.device.id)
  for (const scope of DESKTOP_ONLY_SCOPES) assert.equal(stored.scopes.includes(scope), false, `stored mobile record holds ${scope}`)
  // A default desktop offer has none of them either; an explicit "full" preset grants them all.
  const plain = await instance.post('pair', { kind: 'desktop', publicUrl: instance.lanUrl })
  for (const scope of DESKTOP_ONLY_SCOPES) assert.equal(plain.data.pairing.scopes.includes(scope), false)
  const full = await instance.post('pair', { kind: 'desktop', scopes: [...SCOPE_PRESETS.full], publicUrl: instance.lanUrl })
  assert.deepEqual([...full.data.pairing.scopes].sort(), [...SCOPES].sort())
  // authorizeEndpoint: a mobile record listing every scope still gets nothing.
  const mobileRecord = { kind: 'mobile', scopes: [...SCOPES] }
  for (const endpoint of Object.values(SCOPE_TABLE).flat()) {
    assert.equal(authorizeEndpoint(mobileRecord, endpoint).ok, false, endpoint)
  }
})