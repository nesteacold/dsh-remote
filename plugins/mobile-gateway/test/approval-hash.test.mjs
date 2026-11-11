// T024/T026/T027 — approval content binding (spec 001 US4, FR-008).
//
// The Host emits `tool/call` (raw argument JSON string) on the session stream and
// `approval/request` on the remote-event waterfall; neither order is guaranteed
// (research V1). These tests drive the real plugin over a loopback WS control
// socket and a real `session/event` listener, so the join, the frame contents,
// the hash refusal receipt and the desktop fallback are exercised end to end.
//
// Rules under test (contract §5, constitution B3, research V2):
//   - frame carries `argsHash` = sha256(JCS({toolName, callId, arguments})) and a
//     bounded `argsPreview` that is always a string;
//   - a `tool/call` up to 1 s late still joins; after that the hash is unbound
//     (`null`) and the request is desktop-only (`return next()`), never a card
//     and never a remote decision;
//   - echoing a different/absent hash is a normal receipt
//     `accepted:false, reason:'hash-mismatch'`; the request stays pending;
//   - a matching decision applies at most once; repeats get `not-pending`;
//   - no phone (or a phone that goes away) means the exact downstream result is
//     handed back to the waterfall — `allowed-once`/`rejected`/`cancelled`/
//     `unavailable`/`undefined` pass through unchanged;
//   - the `tool/call` cache is bounded by count, age and total raw characters
//     (4 MiB): content that is evicted, expired or too large is unbound and
//     desktop-only, never a card;
//   - the cache is keyed by (session, callId): a callId is only unique inside one
//     session, so two sessions that use the same one must never exchange
//     arguments, and a `tool/call` published for another tool is not joined;
//   - `argsPreview` is at most 2 KiB of UTF-8 and never splits a code point;
//   - an abort, a switch-off or a disposal during the argument join resolves the
//     wait at once and leaves the decision to the desktop (`next()`), so no card
//     and no pending approval can be registered after the gateway stopped being
//     available;
//   - the raw arguments never reach a log line.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import test from 'node:test'
import WebSocket from 'ws'
import plugin from '../lib/index.mjs'
import { approvalArgsHash } from '../lib/approval-hash.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'

const SESSION = 'approval-session'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    assert.ok(Date.now() < deadline, '等待网关帧超时')
    await delay(5)
  }
}

// T019/T023: the v3 pairing offer is redeemed on the plugin TLS listener; the
// token then authenticates the loopback route the suite drives.
async function pairDevice(server) {
  const base = `http://127.0.0.1:${server.address().port}`
  const created = await (await fetch(`${base}/mgw/pair`, { method: 'POST' })).json()
  const status = await (await fetch(`${base}/mgw/status`)).json()
  const socket = new WebSocket(status.lan.urls[0], ['dsh-mobile-v1', `dsh-pair.${created.payload.pairingCode}`], {
    rejectUnauthorized: false, headers: { 'X-DSH-Device-ID': 'binding-suite-device-01' },
  })
  const paired = await new Promise((resolve, reject) => {
    socket.on('message', (data) => { const frame = JSON.parse(data.toString()); if (frame.kind === 'paired') resolve(frame) })
    socket.on('error', reject)
  })
  socket.close()
  return paired.token
}

async function gateway(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-approval-binding-'))
  const listeners = {}
  const sockets = []
  let upgrade, dispose, connections = 0
  let management
  let seq = 0
  const server = http.createServer((req, res) => {
    if (management && req.url.startsWith('/mgw')) management.handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  server.on('upgrade', (req, socket, head) => {
    connections += 1
    socket.once('close', () => { connections -= 1 })
    upgrade.handler(req, socket, head)
  })
  // WHATWG fetch refuses a few "bad ports" (e.g. 1719, 10080); an ephemeral
  // listener that lands on one makes `fetch` fail with `bad port`, which is the
  // harness's fault and not the gateway's. The shared helper re-binds until the
  // port is one `fetch` accepts (test/support/fetch-safe-listen.mjs).
  await listenFetchSafe(server)
  const ctx = {
    webServer: {
      port: server.address().port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => {} },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      // 36d9: a device only receives cards for sessions the Host lists to it.
      async invoke() { return { items: [SESSION, 'session-a', 'session-b'].map(sessionId => ({ sessionId })) } },
      async stream(request) {
        return (async function* () {
          yield { type: 'baseline', value: request.namespace === 'workspace'
            ? { items: [], archivedSessionIds: [] } : { projections: {} } }
          while (!request.signal.aborted) await delay(5)
        })()
      },
    },
    agentDefaultModel: {},
    on(name, handler) { listeners[name] = handler; return () => {} },
    effect(factory) { dispose = factory() },
  }
  await plugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    deviceFile: path.join(directory, 'devices.json'),
    tlsCertificateDir: path.join(directory, 'tls'),
    lanEnabled: true,
    requireHostApproval: false, // spec 008 P1b: these tests exercise the direct claim path; pairing-approval.test.mjs covers the default
    lanHost: '127.0.0.1',
    lanPort: 0,
  })
  // Idempotent so a test may tear the plugin down itself and `t.after` stays quiet.
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    sockets.forEach(socket => socket.terminate())
    dispose()
    await new Promise(resolve => server.close(resolve))
  }
  t.after(async () => {
    await stop()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return {
    /** A `tool/call` as the Host emits it: raw arguments string, one per callId. */
    toolCall(callId, rawArguments, sessionId = SESSION, name = 'bash') {
      listeners['session/event']({ id: sessionId }, {
        type: 'tool/call', seq: ++seq, time: Date.now(),
        data: { turn: 1, step: 0, callId, name, arguments: rawArguments },
      })
    },
    /** The `approval/request` waterfall: `next` is the desktop chain. */
    request({ callId, toolName = 'bash', sessionId = SESSION, next, signal } = {}) {
      return listeners['approval/request']({
        agent: { id: sessionId }, toolName,
        ...(callId === undefined ? {} : { callId }),
        reason: 'binding suite', signal,
      }, next ?? (() => new Promise(() => {})))
    },
    /** Owner management routes (`/mgw/...`) on the loopback listener. */
    async post(route, body) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, body: await response.json() }
    },
    stop,
    async connect() {
      const frames = []
      const token = await pairDevice(server)
      // Device credentials are accepted only on the plugin-owned TLS listener.
      const status = await (await fetch(`http://127.0.0.1:${server.address().port}/mgw/status`)).json()
      const socket = new WebSocket(status.lan.urls[0], ['dsh-mobile-v1'], {
        rejectUnauthorized: false,
        headers: { 'X-DSH-Channel': 'control', Authorization: `Bearer ${token}` },
      })
      sockets.push(socket)
      socket.on('message', data => frames.push(JSON.parse(data.toString())))
      await waitUntil(() => frames.some(frame => frame.kind === 'hello'))
      // Contract §3.6: operations wait for the acknowledged client-hello.
      socket.send(JSON.stringify({ type: 'client-hello', requestId: 'binding-hello', companionProtocol: 1, appVersion: 'test', platform: 'ios' }))
      await waitUntil(() => frames.some(frame => frame.kind === 'client-hello' && frame.requestId === 'binding-hello'))
      await waitUntil(() => frames.some(frame => frame.kind === 'projection-baseline'))
      return { socket, frames }
    },
    async disconnect(socket) {
      const closed = once(socket, 'close')
      socket.close()
      await closed
      await waitUntil(() => connections === 0)
    },
  }
}

let responseCounter = 0
/** Send an `approval-response` and return its receipt (which echoes requestId). */
async function respond(socket, frames, live, overrides = {}) {
  const requestId = `binding-${++responseCounter}`
  const frame = {
    type: 'approval-response', requestId,
    rpcId: live.rpcId, sessionId: live.sessionId, approvalId: live.approvalId,
    argsHash: live.argsHash, outcome: 'allowed-once',
    ...overrides,
  }
  if (frame.argsHash === undefined) delete frame.argsHash
  socket.send(JSON.stringify(frame))
  await waitUntil(() => frames.some(reply => reply.kind === 'approval-response'
    && reply.requestId === requestId && reply.rpcId === live.rpcId))
  return frames.find(reply => reply.kind === 'approval-response'
    && reply.requestId === requestId && reply.rpcId === live.rpcId)
}

function approvalFrames(frames, sessionId = SESSION) {
  return frames.filter(frame => frame.kind === 'approval-requested' && frame.sessionId === sessionId)
}

const expectedHash = (callId, rawArguments, toolName = 'bash') => approvalArgsHash({ toolName, callId, rawArguments })

/** True when every surrogate in `text` is part of a valid pair (decodable text). */
function isWellFormedText(text) {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}


test('the frame carries the hash of the exact tool/call content and a readable preview', async t => {
  const host = await gateway(t)
  const { frames, socket } = await host.connect()
  const rawArguments = '{"command":"ls","cwd":"/work"}'
  host.toolCall('call-1', rawArguments)
  const pending = host.request({ callId: 'call-1' })

  await waitUntil(() => approvalFrames(frames).length === 1)
  const live = approvalFrames(frames)[0]
  assert.equal(live.callId, 'call-1')
  assert.equal(live.toolName, 'bash')
  assert.match(live.argsHash, /^[a-f0-9]{64}$/)
  assert.equal(live.argsHash, expectedHash('call-1', rawArguments))
  assert.equal(live.argsPreview, rawArguments)
  assert.equal(live.replay, undefined, 'a live request is not a replay')

  const receipt = await respond(socket, frames, live, { outcome: 'allowed-once' })
  assert.equal(receipt.accepted, true, JSON.stringify(receipt))
  assert.equal(await pending, 'allowed-once')
  await waitUntil(() => frames.some(frame => frame.kind === 'approval-resolved'
    && frame.rpcId === live.rpcId && frame.outcome === 'allowed-once'))
})

test('a tool/call that arrives within 1 s is joined into the approval', async t => {
  const host = await gateway(t)
  const { frames, socket } = await host.connect()
  const pending = host.request({ callId: 'call-late' })
  await delay(300)
  host.toolCall('call-late', '{"command":"whoami"}')

  await waitUntil(() => approvalFrames(frames).length === 1)
  const live = approvalFrames(frames)[0]
  assert.equal(live.argsHash, expectedHash('call-late', '{"command":"whoami"}'))
  assert.equal(live.argsPreview, '{"command":"whoami"}')
  await respond(socket, frames, live, { outcome: 'rejected' })
  assert.equal(await pending, 'rejected')
})

test('re-emitted content for the same callId binds the newest arguments', async t => {
  const host = await gateway(t)
  const { frames, socket } = await host.connect()
  // The Host can re-emit a call; a stale binding would let the phone approve
  // content that is no longer what the tool is about to run.
  host.toolCall('call-repeat', '{"command":"first"}')
  host.toolCall('call-repeat', '{"command":"second"}')

  const pending = host.request({ callId: 'call-repeat' })
  await waitUntil(() => approvalFrames(frames).length === 1)
  const live = approvalFrames(frames)[0]
  assert.equal(live.argsHash, expectedHash('call-repeat', '{"command":"second"}'))
  assert.equal(live.argsPreview, '{"command":"second"}')
  await respond(socket, frames, live, { outcome: 'rejected' })
  assert.equal(await pending, 'rejected')
})

test('an unbound request is desktop-only: next() decides, no card reaches the phone', async t => {
  const host = await gateway(t)
  const { frames } = await host.connect()

  // No `callId` at all → immediate delegation, never a remote card.
  let calls = 0
  const noCallId = await host.request({ next: () => { calls += 1; return 'allowed-once' } })
  assert.equal(noCallId, 'allowed-once')
  assert.equal(calls, 1)

  // Unparsable arguments → unbound, desktop decides.
  host.toolCall('call-bad-json', '{"command":')
  calls = 0
  const unparsable = await host.request({ callId: 'call-bad-json', next: () => { calls += 1; return 'rejected' } })
  assert.equal(unparsable, 'rejected')
  assert.equal(calls, 1)

  // A `tool/call` outside the 1 s join window → unbound after the wait.
  const startedAt = Date.now()
  calls = 0
  const timedOut = await host.request({ callId: 'call-never-arrives', next: () => { calls += 1; return 'cancelled' } })
  const waited = Date.now() - startedAt
  assert.equal(timedOut, 'cancelled')
  assert.equal(calls, 1)
  assert.ok(waited >= 900, `the join must wait up to 1 s before delegating, waited ${waited} ms`)

  await delay(100)
  assert.deepEqual(approvalFrames(frames), [], 'a desktop-only request is never sent to the phone')
})

test('a tool/call larger than the whole cache budget is unbound and desktop-only', async t => {
  const host = await gateway(t)
  const { frames } = await host.connect()
  // > 4 MiB of raw arguments: caching it would evict every other binding, so the
  // gateway refuses the entry and the approval falls back to the desktop.
  const rawArguments = JSON.stringify({ command: 'cat', blob: 'x'.repeat(4 * 1024 * 1024) })
  assert.ok(rawArguments.length > 4 * 1024 * 1024)
  host.toolCall('call-huge', rawArguments)

  let calls = 0
  const value = await host.request({ callId: 'call-huge', next: () => { calls += 1; return 'allowed-once' } })
  assert.equal(value, 'allowed-once')
  assert.equal(calls, 1)
  await delay(100)
  assert.deepEqual(approvalFrames(frames), [], 'an over-budget call never produces a card')
})

test('the cache is bounded by total characters: the oldest entry is evicted', async t => {
  const host = await gateway(t)
  const { frames, socket } = await host.connect()
  const blob = 'x'.repeat(Math.ceil(2.5 * 1024 * 1024))
  const first = JSON.stringify({ command: 'a', blob })
  const second = JSON.stringify({ command: 'b', blob })
  host.toolCall('call-old', first)
  host.toolCall('call-new', second)

  // Together they exceed 4 MiB, so the first entry is gone: unbound, desktop.
  let calls = 0
  const value = await host.request({ callId: 'call-old', next: () => { calls += 1; return 'rejected' } })
  assert.equal(value, 'rejected')
  assert.equal(calls, 1)
  await delay(100)
  assert.deepEqual(approvalFrames(frames), [], 'an evicted call never produces a card')

  // The newest entry survived and is still decidable on the phone.
  const pending = host.request({ callId: 'call-new' })
  await waitUntil(() => approvalFrames(frames).length === 1)
  const live = approvalFrames(frames)[0]
  assert.equal(live.argsHash, expectedHash('call-new', second))
  await respond(socket, frames, live, { outcome: 'allowed-once' })
  assert.equal(await pending, 'allowed-once')
})

test('the cache is bounded by count: the oldest entry is evicted', async t => {
  const host = await gateway(t)
  const { frames } = await host.connect()
  // 257 small calls: one more than the 256-entry limit, so `call-0` is gone.
  for (let index = 0; index <= 256; index += 1) {
    host.toolCall(`call-${index}`, `{"step":${index}}`)
  }

  let calls = 0
  const value = await host.request({ callId: 'call-0', next: () => { calls += 1; return 'rejected' } })
  assert.equal(value, 'rejected')
  assert.equal(calls, 1)
  await delay(100)
  assert.deepEqual(approvalFrames(frames), [], 'an evicted call never produces a card')
})

test('the cache is bounded by age: an expired tool/call is not joined', async t => {
  const host = await gateway(t)
  const { frames } = await host.connect()
  host.toolCall('call-stale', '{"command":"ls"}')

  // Jump past the 10-minute TTL; the entry is useless because the approval for
  // it already happened, and re-using it could bind stale content.
  const realNow = Date.now
  const base = realNow()
  Date.now = () => base + 11 * 60 * 1000
  try {
    let calls = 0
    const value = await host.request({ callId: 'call-stale', next: () => { calls += 1; return 'cancelled' } })
    assert.equal(value, 'cancelled')
    assert.equal(calls, 1)
  } finally {
    Date.now = realNow
  }
  await delay(100)
  assert.deepEqual(approvalFrames(frames), [], 'an expired call never produces a card')
})

test('an oversized preview is truncated but the hash still binds the full content', async t => {
  const host = await gateway(t)
  const { frames, socket } = await host.connect()
  const rawArguments = JSON.stringify({ command: 'echo', blob: 'x'.repeat(4_000) })
  host.toolCall('call-long', rawArguments)
  const pending = host.request({ callId: 'call-long' })
  await waitUntil(() => approvalFrames(frames).length === 1)
  const live = approvalFrames(frames)[0]
  assert.equal(typeof live.argsPreview, 'string')
  assert.equal(live.argsPreview.length, 2 * 1024)
  assert.equal(live.argsHash, expectedHash('call-long', rawArguments))
  await respond(socket, frames, live, { outcome: 'allowed-once' })
  assert.equal(await pending, 'allowed-once')
})

test('a mismatched or missing hash is refused as a receipt and the request stays pending', async t => {
  const host = await gateway(t)
  const { frames, socket } = await host.connect()
  const rawArguments = '{"command":"rm -rf build"}'
  host.toolCall('call-guard', rawArguments)
  const pending = host.request({ callId: 'call-guard' })
  await waitUntil(() => approvalFrames(frames).length === 1)
  const live = approvalFrames(frames)[0]

  const wrong = await respond(socket, frames, live, { argsHash: 'f'.repeat(64), outcome: 'allowed-once' })
  assert.equal(wrong.kind, 'approval-response')
  assert.equal(wrong.accepted, false)
  assert.equal(wrong.reason, 'hash-mismatch')
  assert.equal(wrong.outcome, 'allowed-once')

  const missing = await respond(socket, frames, live, { argsHash: undefined, outcome: 'rejected' })
  assert.equal(missing.accepted, false)
  assert.equal(missing.reason, 'hash-mismatch')

  // Nothing was applied: the request is still pending and the phone can retry.
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await delay(50)
  assert.equal(settled, false, 'a refused decision must not resolve the request')
  assert.equal(approvalFrames(frames).length, 1, 'no replay is invented by a refusal')

  const accepted = await respond(socket, frames, live, { argsHash: live.argsHash, outcome: 'rejected' })
  assert.equal(accepted.accepted, true, JSON.stringify(accepted))
  assert.equal(await pending, 'rejected')

  // At most once: the same decision twice is a normal not-pending receipt.
  const duplicate = await respond(socket, frames, live, { argsHash: live.argsHash, outcome: 'rejected' })
  assert.equal(duplicate.accepted, false)
  assert.equal(duplicate.reason, 'not-pending')
  assert.equal(frames.filter(frame => frame.kind === 'approval-resolved' && frame.rpcId === live.rpcId).length, 1)
})

test('without a phone the exact downstream result is handed back to the waterfall', async t => {
  const host = await gateway(t)
  for (const [index, outcome] of ['allowed-once', 'rejected', 'cancelled', 'unavailable'].entries()) {
    host.toolCall(`call-desktop-${index}`, `{"step":${index}}`)
    let calls = 0
    const value = await host.request({ callId: `call-desktop-${index}`, next: () => { calls += 1; return outcome } })
    assert.equal(value, outcome, `${outcome} must pass through unchanged`)
    assert.equal(calls, 1)
  }
  // No other handler: `next()` resolves undefined — delegation, not a fabricated
  // reject value. DSH normalises that to `unavailable` (fail closed) itself.
  host.toolCall('call-desktop-none', '{"step":9}')
  let noHandlerCalls = 0
  const noHandler = await host.request({ callId: 'call-desktop-none', next: () => { noHandlerCalls += 1; return undefined } })
  assert.equal(noHandler, undefined)
  assert.equal(noHandlerCalls, 1)

  const { frames } = await host.connect()
  await delay(100)
  assert.deepEqual(approvalFrames(frames), [], 'desktop-decided requests are not replayed')
})

test('a phone that goes away releases a pending approval to the desktop', async t => {
  const host = await gateway(t)
  const { frames, socket } = await host.connect()
  host.toolCall('call-leave', '{"command":"ls"}')
  let resolveDesktop
  const pending = host.request({
    callId: 'call-leave',
    next: () => new Promise(resolve => { resolveDesktop = resolve }),
  })
  await waitUntil(() => approvalFrames(frames).length === 1)
  await host.disconnect(socket)
  resolveDesktop('allowed-once')
  assert.equal(await pending, 'allowed-once')
})

test('raw arguments never reach a log line', async t => {
  const captured = []
  const originalLog = console.log
  console.log = (...args) => { captured.push(args.map(String).join(' ')) }
  try {
    const host = await gateway(t)
    const { frames, socket } = await host.connect()
    const secret = 'sk-binding-secret-123'
    const rawArguments = JSON.stringify({ command: 'echo', apiKey: secret })
    host.toolCall('call-secret', rawArguments)
    const pending = host.request({ callId: 'call-secret' })
    await waitUntil(() => approvalFrames(frames).length === 1)
    const live = approvalFrames(frames)[0]
    assert.equal(live.argsHash, expectedHash('call-secret', rawArguments))
    await respond(socket, frames, live, { outcome: 'allowed-once' })
    assert.equal(await pending, 'allowed-once')
    const lines = captured.filter(line => line.startsWith('mobile-gateway:'))
    assert.ok(lines.length > 0, 'the suite must actually observe gateway log lines')
    for (const line of lines) assert.equal(line.includes(secret), false, line)
  } finally {
    console.log = originalLog
  }
})

// M1 (review bb6): a callId is only unique within one session. Keying the cache
// by callId alone let two sessions exchange argument strings, so a phone could be
// shown — and asked to hash-approve — another session's content.
test('the same callId in two sessions binds each session its own arguments', async t => {
  const host = await gateway(t)
  const { frames, socket } = await host.connect()
  const argsA = '{"command":"rm -rf /srv/a"}'
  const argsB = '{"command":"ls /srv/b"}'
  host.toolCall('call-dup', argsA, 'session-a')
  host.toolCall('call-dup', argsB, 'session-b')

  const first = host.request({ callId: 'call-dup', sessionId: 'session-a' })
  await waitUntil(() => approvalFrames(frames, 'session-a').length === 1)
  const liveA = approvalFrames(frames, 'session-a')[0]
  assert.equal(liveA.argsHash, expectedHash('call-dup', argsA), 'session-a must bind its own content')
  assert.equal(liveA.argsPreview, argsA)

  const second = host.request({ callId: 'call-dup', sessionId: 'session-b' })
  await waitUntil(() => approvalFrames(frames, 'session-b').length === 1)
  const liveB = approvalFrames(frames, 'session-b')[0]
  assert.equal(liveB.argsHash, expectedHash('call-dup', argsB), 'session-b must bind its own content')
  assert.notEqual(liveB.argsHash, liveA.argsHash, 'the two sessions must never share one binding')

  await respond(socket, frames, liveA, { outcome: 'rejected' })
  assert.equal(await first, 'rejected')
  await respond(socket, frames, liveB, { outcome: 'rejected' })
  assert.equal(await second, 'rejected')
})

test('a delayed join never borrows another session’s tool/call', async t => {
  const host = await gateway(t)
  const { frames, socket } = await host.connect()
  const pendingB = host.request({ callId: 'call-race', sessionId: 'session-b' })
  await delay(150)
  // Another session emits the very same callId while session-b is still waiting:
  // waking that waiter with foreign content is exactly the cross-session leak.
  host.toolCall('call-race', '{"command":"from-a"}', 'session-a')
  await delay(200)
  assert.deepEqual(approvalFrames(frames, 'session-b'), [],
    'a foreign session’s tool/call must not resolve another session’s join')
  host.toolCall('call-race', '{"command":"from-b"}', 'session-b')
  await waitUntil(() => approvalFrames(frames, 'session-b').length === 1)
  const liveB = approvalFrames(frames, 'session-b')[0]
  assert.equal(liveB.argsHash, expectedHash('call-race', '{"command":"from-b"}'))
  await respond(socket, frames, liveB, { outcome: 'rejected' })
  assert.equal(await pendingB, 'rejected')

  // The other session's binding is still its own and still cached.
  const pendingA = host.request({ callId: 'call-race', sessionId: 'session-a' })
  await waitUntil(() => approvalFrames(frames, 'session-a').length === 1)
  const liveA = approvalFrames(frames, 'session-a')[0]
  assert.equal(liveA.argsHash, expectedHash('call-race', '{"command":"from-a"}'))
  await respond(socket, frames, liveA, { outcome: 'rejected' })
  assert.equal(await pendingA, 'rejected')
})

test('a tool/call published for a different tool is not joined', async t => {
  const host = await gateway(t)
  const { frames, socket } = await host.connect()
  // A card that wrongly binds would leave the request pending forever; racing the
  // desktop result against a timeout makes that a prompt assertion, not a hang.
  const settle = (pending) => Promise.race([pending, delay(3_000).then(() => 'STILL-PENDING')])

  // The cached call belongs to `write`; the approval asks about `bash`.
  host.toolCall('call-name', '{"path":"a.txt"}', SESSION, 'write')
  let calls = 0
  const immediate = await settle(host.request({
    callId: 'call-name', toolName: 'bash', next: () => { calls += 1; return 'unavailable' },
  }))
  assert.equal(immediate, 'unavailable', 'the desktop decides content that cannot be bound')
  assert.equal(calls, 1)
  assert.deepEqual(approvalFrames(frames), [], 'a tool name mismatch never produces a card')

  // Same rule when the `tool/call` wins the race: the late event must name the
  // approved tool, otherwise it is not this approval's content.
  calls = 0
  const late = host.request({ callId: 'call-late-name', next: () => { calls += 1; return 'rejected' } })
  await delay(100)
  host.toolCall('call-late-name', '{"path":"b.txt"}', SESSION, 'write')
  assert.equal(await settle(late), 'rejected')
  assert.equal(calls, 1)
  assert.deepEqual(approvalFrames(frames), [], 'a late name mismatch never produces a card')

  // A matching name still binds, so the check rejects only real mismatches.
  host.toolCall('call-name-ok', '{"path":"c.txt"}', SESSION, 'write')
  const bound = host.request({ callId: 'call-name-ok', toolName: 'write' })
  await waitUntil(() => approvalFrames(frames).length === 1)
  const live = approvalFrames(frames)[0]
  assert.equal(live.argsHash, expectedHash('call-name-ok', '{"path":"c.txt"}', 'write'))
  await respond(socket, frames, live, { outcome: 'rejected' })
  assert.equal(await bound, 'rejected')
})

// M2 (review bb6): the 2 KB bound is bytes on the wire, and truncation must land
// on a code-point boundary — a 2048-code-unit slice is 6 KiB of CJK and can cut a
// surrogate pair in half.
test('an oversized preview stays within 2 KiB of UTF-8 and never splits a code point', async t => {
  const host = await gateway(t)
  const { frames, socket } = await host.connect()
  const cases = [
    // 3 bytes per character: a code-unit slice would emit 6 KiB here.
    { callId: 'call-cjk', raw: JSON.stringify({ command: '说'.repeat(1_200) }) },
    // The emoji starts at byte 2047, so a 2048-code-unit slice would end on a
    // lone high surrogate — text the phone cannot decode.
    { callId: 'call-emoji', raw: `{"note":"${'a'.repeat(2_038)}😀😀"}` },
    // Plain ASCII still reaches the byte bound exactly.
    { callId: 'call-ascii', raw: JSON.stringify({ command: 'echo', blob: 'x'.repeat(4_000) }) },
  ]
  for (const { callId, raw } of cases) {
    host.toolCall(callId, raw)
    const pending = host.request({ callId })
    await waitUntil(() => approvalFrames(frames).some(frame => frame.callId === callId))
    const live = approvalFrames(frames).find(frame => frame.callId === callId)
    const bytes = Buffer.byteLength(live.argsPreview, 'utf8')
    assert.equal(typeof live.argsPreview, 'string', `${callId}: the preview is always a string`)
    assert.ok(bytes <= 2 * 1024, `${callId}: preview must stay within 2 KiB, got ${bytes} bytes`)
    assert.ok(raw.startsWith(live.argsPreview), `${callId}: the preview must be a prefix of the arguments`)
    assert.equal(isWellFormedText(live.argsPreview), true, `${callId}: the preview must not split a surrogate pair`)
    assert.equal(live.argsHash, expectedHash(callId, raw), `${callId}: the hash still binds the full content`)
    await respond(socket, frames, live, { outcome: 'allowed-once' })
    assert.equal(await pending, 'allowed-once')
  }
})

// M3 (review bb6): everything after the join runs on a gateway that may no longer
// accept remote decisions, so each case must delegate to the desktop instead of
// registering a card nothing can answer.
test('a switch-off during the argument join delegates to the desktop', async t => {
  const captured = []
  const originalLog = console.log
  console.log = (...args) => { captured.push(args.map(String).join(' ')) }
  try {
    const host = await gateway(t)
    const { frames } = await host.connect()
    let calls = 0
    const pending = host.request({
      callId: 'call-switch-off', next: () => { calls += 1; return 'unavailable' },
    })
    await delay(150)
    const off = await host.post('/mgw/remote-control', { enabled: false })
    assert.equal(off.status, 200)
    assert.equal(off.body.remoteControl.enabled, false, JSON.stringify(off.body))
    // The `tool/call` lands after the switch went off, so the join still succeeds
    // and only the post-await gate can stop the card.
    host.toolCall('call-switch-off', '{"command":"late"}')
    assert.equal(await pending, 'unavailable', 'the exact desktop result is handed back')
    assert.equal(calls, 1)
    assert.deepEqual(approvalFrames(frames), [], 'no card may follow the switch-off')
    const registered = captured.filter(line => line.includes('approval requested'))
    assert.deepEqual(registered, [], `no pending approval may be registered: ${registered.join(' | ')}`)
  } finally {
    console.log = originalLog
  }
})

test('a disposal during the argument join wakes it at once and registers nothing', async t => {
  const captured = []
  const originalLog = console.log
  console.log = (...args) => { captured.push(args.map(String).join(' ')) }
  try {
    const host = await gateway(t)
    await host.connect()
    let calls = 0
    const pending = host.request({
      callId: 'call-dispose', next: () => { calls += 1; return 'cancelled' },
    })
    await delay(150)
    const stoppedAt = Date.now()
    await host.stop()
    assert.equal(await pending, 'cancelled', 'a disposed plugin delegates to the desktop chain')
    const waited = Date.now() - stoppedAt
    assert.ok(waited < 500, `disposal must cancel the join instead of waiting out the 1 s window, waited ${waited} ms`)
    assert.equal(calls, 1)
    assert.deepEqual(captured.filter(line => line.includes('approval requested')), [],
      'a disposed plugin must not register a pending approval')
  } finally {
    console.log = originalLog
  }
})

test('an aborted request stops waiting for its tool/call immediately', async t => {
  const host = await gateway(t)
  await host.connect()
  const controller = new AbortController()
  const startedAt = Date.now()
  const pending = host.request({
    callId: 'call-abort', signal: controller.signal, next: () => 'allowed-once',
  })
  await delay(100)
  controller.abort()
  assert.equal(await pending, 'cancelled', 'an aborted request reports cancelled, not a decision')
  const waited = Date.now() - startedAt
  assert.ok(waited < 500, `an abort must wake the join immediately, waited ${waited} ms`)
})

