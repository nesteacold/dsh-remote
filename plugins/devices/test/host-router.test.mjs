// Spec 008 P2a — the multi-host gateway wrapper (lib/host-router.mjs).
//
// Runs with `node --test --test-isolation=none test/host-router.test.mjs`. No real
// socket is involved: the local carrier is a fake `typertGateway` with the rc.1
// signatures and each remote is a stub `RemoteConnection`, so every assertion is
// about routing / renaming / merging and about what actually crosses the wire to
// a remote Host.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RemoteConnection } from '../lib/remote-client.mjs'
import {
  HOST_HINT, ID_FIELDS, PINNED_DSH_VERSION, createHostRouter, hostHintOf, hostIdOfId, hostIdsIn, namespaceId,
  namespaceIds, selfTest, stripHostIds, taggedIdsIn,
} from '../lib/host-router.mjs'
import { mountPlugin } from './helpers.mjs'

// -- harness ---------------------------------------------------------------

/** A pushable async sequence, the shape both carrier streams and stubs need. */
function createQueue() {
  const items = []
  const waiters = []
  let closed = false
  return {
    push(value) {
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else items.push(value)
    },
    close() {
      if (closed) return
      closed = true
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (items.length > 0) return { value: items.shift(), done: false }
          if (closed) return { value: undefined, done: true }
          return new Promise((resolve) => waiters.push(resolve))
        },
        async return() {
          closed = true
          for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
          return { value: undefined, done: true }
        },
      }
    },
  }
}

const clone = (value) => (value === undefined ? undefined : structuredClone(value))

const session = (id, updatedAt, extra = {}) => ({ sessionId: id, updatedAt, running: false, blank: false, projections: { kind: 'sequenced', asOfSeq: 1, values: {} }, ...extra })

/** A remote Host as the router sees it: one connection, recorded traffic. */
function createFakeRemote(hostId, hostName, options = {}) {
  const calls = []
  const streams = []
  const connection = {
    state: 'online',
    async call(endpoint, args, callOptions) {
      calls.push({ endpoint, args: clone(args), options: callOptions })
      const reply = options.replies?.[endpoint]
      if (reply instanceof Error) throw reply
      return typeof reply === 'function' ? reply(args) : clone(reply) ?? {}
    },
    async openStream(endpoint, args, streamOptions) {
      const queue = createQueue()
      streams.push({ endpoint, args: clone(args), options: streamOptions, queue })
      if (endpoint === 'workspace/follow') {
        queue.push({ type: 'baseline', value: {
          items: options.workspaces ?? [],
          archivedSessionIds: options.archived ?? [],
          pinnedSessionIds: options.pinned ?? [],
        } })
      }
      return queue
    },
  }
  return {
    hostId, hostName, connection, calls, streams,
    /** Push one more frame into the most recent stream (e.g. a workspace upsert). */
    send(frame) { streams.at(-1).queue.push(frame) },
    closeStream() { streams.at(-1).queue.close() },
  }
}

const workspaceView = (workspaceId, sessionIds, extra = {}) => ({
  workspaceId, path: `/tmp/${workspaceId}`, title: workspaceId, sessionIds,
  createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', ...extra,
})

function createHarness({ remotes = [], dispatchRpc, baseline = { items: [], archivedSessionIds: [], pinnedSessionIds: [] } } = {}) {
  const localCalls = []
  const localStreams = []
  const logs = []
  const gateway = {
    // rc.1 signatures: dispatchRpc(endpoint, payload, signal, peer) and
    // openWireStream(endpoint, payload, uplink, peer, signal, control, window).
    async dispatchRpc(endpoint, payload, signal, peer) {
      localCalls.push({ endpoint, payload: clone(payload) })
      return typeof dispatchRpc === 'function' ? dispatchRpc(endpoint, payload, peer) : { ok: true, value: { local: endpoint } }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, window) {
      const queue = createQueue()
      localStreams.push({ endpoint, payload: clone(payload), window, queue })
      if (endpoint === 'workspace/follow') queue.push({ type: 'baseline', value: baseline })
      return queue
    },
  }
  const cards = new Map()
  const listeners = new Set()
  const connected = new Set(remotes.map((remote) => remote.hostId))
  const notify = () => { for (const listener of [...listeners]) listener() }
  const router = createHostRouter({
    gateway,
    // Constitution A1.1: the wrapper is enabled only on the pinned release.
    dshVersion: PINNED_DSH_VERSION,
    hosts: () => remotes.filter((remote) => connected.has(remote.hostId))
      .map((remote) => ({ hostId: remote.hostId, hostName: remote.hostName, connection: remote.connection, online: true })),
    onHostsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    approvals: {
      card(hostId, ids) {
        for (const key of [ids?.rpcId, ids?.eventId, ids?.approvalId]) {
          if (typeof key === 'string' && cards.has(`${hostId}|${key}`)) return cards.get(`${hostId}|${key}`)
        }
        return undefined
      },
    },
    mergeBaselineTimeoutMs: 100,
    log: (line) => logs.push(line),
  })
  const status = router.install()
  return {
    gateway, router, status, localCalls, localStreams, remotes, cards, logs,
    connect(hostId) { connected.add(hostId); notify() },
    disconnect(hostId) { connected.delete(hostId); notify() },
  }
}

/** Read one frame with a deadline, so a broken merge fails instead of hanging. */
function nextFrame(iterator, label = 'stream') {
  return Promise.race([
    iterator.next(),
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: no frame within 2 s`)), 2000)
      timer.unref?.()
    }),
  ])
}

/** Nothing that names another host may reach a remote Host. */
function assertNoNamespacedId(remote) {
  for (const entry of [...remote.calls, ...remote.streams]) {
    assert.deepEqual([...hostIdsIn(entry.args)], [],
      `${entry.endpoint} carried a host namespace: ${JSON.stringify(entry.args)}`)
    assert.equal(/h:[A-Za-z0-9._-]+:/.test(JSON.stringify(entry.args)), false,
      `${entry.endpoint} carried a namespaced id: ${JSON.stringify(entry.args)}`)
  }
}

// -- the table and the rename ----------------------------------------------

test('the rename table is one place and covers the documented fields', () => {
  for (const field of ['sessionId', 'workspaceId', 'agentId', 'parentSessionId', 'childSessionId', 'rpcId',
    'sessionIds', 'archivedSessionIds', 'pinnedSessionIds', 'workspaceIds', 'subagentCatalog']) {
    assert.ok(Object.hasOwn(ID_FIELDS, field), `${field} must be routable`)
  }
  assert.equal(hostIdOfId('h:hostB:s1'), 'hostB')
  assert.equal(hostIdOfId('local-session'), null)
  assert.equal(hostIdOfId('h:'), null)
})

test('rename round-trip: nested ids, subagent ids, arrays and $events payloads', () => {
  const local = {
    sessionId: 'h:hostB:s1',
    address: { kind: 'subagent', parentSessionId: 'h:hostB:s1', childSessionId: 'h:hostB:c1', mode: 'continuable' },
    items: [{ sessionId: 'h:hostB:s2' }],
    sessionIds: ['h:hostB:s1', 'h:hostB:s2'],
    pinnedSessionIds: [],
    projections: { values: { subagentCatalog: [{ id: 'h:hostB:c1', mode: 'one-shot', label: 'x' }] } },
    // $events payloads carry plain event args; ids inside them are renamed too.
    events: [{ type: 'emit', event: 'approval/request', args: { sessionId: 'h:hostB:s1', callId: 'call-9', text: 'see https://example.test/h:not-an-id:' } }],
    // Opaque fields are never touched.
    callId: 'h:hostB:not-an-id',
  }
  const raw = {
    sessionId: 's1',
    address: { kind: 'subagent', parentSessionId: 's1', childSessionId: 'c1', mode: 'continuable' },
    items: [{ sessionId: 's2' }],
    sessionIds: ['s1', 's2'],
    pinnedSessionIds: [],
    projections: { values: { subagentCatalog: [{ id: 'c1', mode: 'one-shot', label: 'x' }] } },
    events: [{ type: 'emit', event: 'approval/request', args: { sessionId: 's1', callId: 'call-9', text: 'see https://example.test/h:not-an-id:' } }],
    callId: 'h:hostB:not-an-id',
  }
  assert.deepEqual(stripHostIds(local, 'hostB'), raw)
  assert.deepEqual(namespaceIds(raw, 'hostB'), local)
  // A binary payload keeps its exact bytes (never rebuilt by the walker).
  const bytes = Buffer.from([1, 2, 3])
  assert.equal(namespaceIds({ sessionId: 's1', data: bytes }, 'hostB').data, bytes)
  // The namespace of one host is not applied to another host's ids.
  assert.deepEqual(stripHostIds({ sessionId: 'h:hostB:s1' }, 'hostC'), { sessionId: 'h:hostB:s1' })
  assert.deepEqual([...hostIdsIn({ args: { sessionId: 'h:hostB:s1', sessionIds: ['h:hostC:s2'] } })], ['hostB', 'hostC'])
})

// -- install / self-test ---------------------------------------------------

test('the most fundamental failure wins: gateway presence and carrier methods precede the version', () => {
  // A Host that composes no `typertGateway` reports the missing gateway whatever
  // the running version says — the version probe cannot describe a carrier that is
  // not there, and the Devices page must not blame the release for our fake Host.
  assert.equal(selfTest(undefined, {}), 'no-gateway')
  assert.equal(selfTest(undefined, { dshVersion: '0.3.0' }), 'no-gateway')
  assert.equal(selfTest(null, { dshVersion: PINNED_DSH_VERSION }), 'no-gateway')
  // Not an object (nor a function) is no gateway either.
  assert.equal(selfTest('typertGateway', { dshVersion: PINNED_DSH_VERSION }), 'no-gateway')
  assert.equal(selfTest(42, {}), 'no-gateway')
  // A present carrier with a missing method is still more specific than the version.
  assert.equal(selfTest({}, {}), 'dispatchRpc-missing')
  assert.equal(selfTest({ dispatchRpc() {} }, { dshVersion: '0.3.0' }), 'openWireStream-missing')
  // Only a carrier that has both methods can be blamed on the version.
  const carrier = () => ({ async dispatchRpc() { return { ok: true } }, openWireStream(a, b, c, d, e) {} })
  assert.equal(selfTest(carrier(), { dshVersion: '0.3.0' }), 'dsh-version-mismatch')
  assert.equal(selfTest(carrier(), {}), 'dsh-version-unknown')
  // Correct version + correct carrier is the only null.
  assert.equal(selfTest(carrier(), { dshVersion: PINNED_DSH_VERSION }), null)
})

test('self-test mismatch: nothing is wrapped and status says why', () => {
  const legacy = (endpoint, payload, signal) => ({ endpoint, payload, signal }) // 3 params = pre-rc.1 opener
  const gateway = { async dispatchRpc() { return { ok: true } }, openWireStream: legacy }
  const dispatch = gateway.dispatchRpc
  const router = createHostRouter({ gateway, dshVersion: PINNED_DSH_VERSION })
  const status = router.install()
  assert.deepEqual({ remote: status.remote, reason: status.reason }, { remote: false, reason: 'openWireStream-signature' })
  assert.equal(gateway.dispatchRpc, dispatch, 'the carrier was not patched')
  assert.equal(gateway.openWireStream, legacy)

  assert.equal(selfTest(undefined, { dshVersion: PINNED_DSH_VERSION }), 'no-gateway')
  assert.equal(selfTest({}, { dshVersion: PINNED_DSH_VERSION }), 'dispatchRpc-missing')
  assert.equal(selfTest({ dispatchRpc() {} }, { dshVersion: PINNED_DSH_VERSION }), 'openWireStream-missing')
  assert.equal(selfTest({ dispatchRpc() {}, openWireStream(a, b, c, d, e) {} }, { dshVersion: PINNED_DSH_VERSION }), null)
})

test('A1.1: an unknown or different DSH version means no wrap, and the reason is reported', async () => {
  // The pinned release is the only one this wrapper was self-tested against.
  assert.equal(PINNED_DSH_VERSION, '0.2.2-rc.1')
  const carrier = () => ({ async dispatchRpc() { return { ok: true } }, openWireStream(a, b, c, d, e) {} })
  assert.equal(selfTest(carrier(), {}), 'dsh-version-unknown')
  assert.equal(selfTest(carrier(), { dshVersion: '' }), 'dsh-version-unknown')
  assert.equal(selfTest(carrier(), { dshVersion: '0.2.2-rc.2' }), 'dsh-version-mismatch')

  for (const [label, options, reason] of [
    ['no version at all', {}, 'dsh-version-unknown'],
    ['another release', { dshVersion: '0.3.0' }, 'dsh-version-mismatch'],
  ]) {
    const gateway = carrier()
    const dispatch = gateway.dispatchRpc
    const stream = gateway.openWireStream
    const router = createHostRouter({ gateway, ...options })
    const status = router.install()
    assert.deepEqual({ remote: status.remote, reason: status.reason }, { remote: false, reason }, label)
    assert.equal(gateway.dispatchRpc, dispatch, `${label}: dispatchRpc was not patched`)
    assert.equal(gateway.openWireStream, stream, `${label}: openWireStream was not patched`)
    // Responsible for the Devices page: the reason travels in the status.
    router.uninstall()
    assert.equal(router.status().reason, reason)
  }
})

test('a Host without a gateway stays "no-gateway" even on an unknown version, and never wraps', () => {
  // The guards suite composes exactly this Host; its reason must not be a version
  // one, and the A1.1 promise (a non-null reason means no wrap) has to hold.
  for (const options of [{}, { dshVersion: '' }, { dshVersion: '0.3.0' }]) {
    const router = createHostRouter({ gateway: undefined, ...options })
    const status = router.install()
    assert.deepEqual({ remote: status.remote, reason: status.reason },
      { remote: false, reason: 'no-gateway' }, JSON.stringify(options))
    assert.equal(router.status().reason, 'no-gateway')
    router.uninstall()
  }
})

test('install wraps both carrier methods and keeps the rc.1 arity the bridge probes', () => {
  const remote = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [remote] })
  assert.equal(harness.status.remote, true)
  assert.equal(harness.status.reason, null)
  assert.equal(harness.gateway.openWireStream.length, 7, 'openWireStream arity survives the wrap')
  assert.equal(harness.gateway.dispatchRpc.length, 4)
  assert.deepEqual(harness.status.merged, ['session/list', 'workspace/follow'])
  assert.deepEqual(harness.status.hosts, [{ hostId: 'hostB', hostName: 'Host B', online: true }])
  harness.router.uninstall()
})

test('uninstall restores the originals', async () => {
  const remote = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [remote] })
  const wrapped = { dispatch: harness.gateway.dispatchRpc, open: harness.gateway.openWireStream }
  harness.router.uninstall()
  assert.notEqual(harness.gateway.dispatchRpc, wrapped.dispatch)
  assert.notEqual(harness.gateway.openWireStream, wrapped.open)
  assert.equal(harness.router.status().remote, false)
  // After the restore a tagged id is just an id again: the call stays Local.
  const answer = await harness.gateway.dispatchRpc('session/prompt', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.deepEqual(answer, { ok: true, value: { local: 'session/prompt' } })
  assert.equal(remote.calls.length, 0)
})

// -- routing ---------------------------------------------------------------

test('a tagged id routes the call to that host and the result comes back renamed', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/prompt': { accepted: true, sessionId: 's1' } } })
  const hostC = createFakeRemote('hostC', 'Host C')
  const harness = createHarness({ remotes: [hostB, hostC] })

  const answer = await harness.gateway.dispatchRpc('session/prompt', { args: { sessionId: 'h:hostB:s1', text: 'hi' } }, new AbortController().signal, {})
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value, { accepted: true, sessionId: 'h:hostB:s1' }, 'raw remote id never reaches the UI')
  assert.equal(hostB.calls.length, 1)
  assert.equal(hostB.calls[0].endpoint, 'session/prompt')
  assert.deepEqual(hostB.calls[0].args, { sessionId: 's1', text: 'hi' })
  assert.equal(hostC.calls.length, 0)
  assert.equal(harness.localCalls.length, 0)
  assertNoNamespacedId(hostB)

  // A remote failure keeps the Host's code instead of becoming a local answer.
  hostB.connection.call = async () => { throw Object.assign(new Error('nope'), { code: 'auth/forbidden-scope' }) }
  const refused = await harness.gateway.dispatchRpc('session/prompt', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.deepEqual(refused, { ok: false, error: { code: 'auth/forbidden-scope', message: 'nope', details: {} } })
})

test('a global call stays Local by default and follows the host hint', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'llm/listProviders': { providers: ['b-only'] } } })
  const harness = createHarness({ remotes: [hostB] })

  const local = await harness.gateway.dispatchRpc('llm/listProviders', { args: {} }, undefined, {})
  assert.deepEqual(local, { ok: true, value: { local: 'llm/listProviders' } })
  assert.equal(hostB.calls.length, 0)

  const hinted = await harness.gateway.dispatchRpc('llm/listProviders', { args: { [HOST_HINT]: 'hostB' } }, undefined, {})
  assert.deepEqual(hinted, { ok: true, value: { providers: ['b-only'] } })
  assert.equal(hostB.calls.length, 1)
  assert.deepEqual(hostB.calls[0].args, {}, 'the hint itself is never forwarded')
  assert.equal(hostHintOf({ args: { [HOST_HINT]: 'hostB' } }), 'hostB')
  assertNoNamespacedId(hostB)
})

test('an unknown or offline host is a clear remote/host-offline, never a local fallback', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  harness.disconnect('hostB')

  for (const sessionId of ['h:hostB:s1', 'h:ghost:s1']) {
    const answer = await harness.gateway.dispatchRpc('session/prompt', { args: { sessionId } }, undefined, {})
    assert.equal(answer.ok, false)
    assert.equal(answer.error.code, 'remote/host-offline')
    assert.match(answer.error.message, /not connected/)
  }
  assert.equal(harness.localCalls.length, 0, 'an offline host is not served by Local')
  assert.equal(hostB.calls.length, 0)
})

test('two host ids in one payload are refused instead of guessed', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const hostC = createFakeRemote('hostC', 'Host C')
  const harness = createHarness({ remotes: [hostB, hostC] })
  const answer = await harness.gateway.dispatchRpc('session/prompt', {
    args: { sessionId: 'h:hostB:s1', parentSessionId: 'h:hostC:s2' },
  }, undefined, {})
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'remote/host-conflict')
  assert.equal(hostB.calls.length + hostC.calls.length, 0)
})

// -- inbound ids are opaque (a remote may not choose a namespace) -----------

test('a remote result whose id already names a host namespace is refused: remote/id-leak', async () => {
  // A compromised Host B claims A's namespace. If that id were trusted (or merely
  // wrapped "unless it already looks tagged"), B's card/row would appear under A
  // and every later decision would route to the wrong Host.
  const hostile = {
    'session/page': { sessionId: 'h:hostA:s1', items: [{ sessionId: 'h:hostA:s2' }] },
    'session/search': { sessionIds: ['h:hostA:s1'], nested: { agentId: 'h:hostA:c1' } },
    'session/events': { sessionId: 'h:hostA:s1', rpcId: 'h:hostA:rpc-1', eventId: 'h:hostA:e1' },
  }
  for (const [endpoint, reply] of Object.entries(hostile)) {
    const hostB = createFakeRemote('hostB', 'Host B', { replies: { [endpoint]: reply } })
    const harness = createHarness({ remotes: [hostB] })
    const answer = await harness.gateway.dispatchRpc(endpoint,
      { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
    assert.equal(answer.ok, false, `${endpoint}: the payload was refused`)
    assert.equal(answer.error.code, 'remote/id-leak', endpoint)
    assert.ok(harness.logs.some((line) => line.includes('remote/id-leak')), `${endpoint}: the refusal is logged`)
    // The Host was still asked (the ids are checked on the way back), but nothing
    // of what it answered reached this machine.
    assert.equal(hostB.calls.length, 1)
    assert.equal(JSON.stringify(answer.value ?? null).includes('h:hostA:'), false)
  }
})

test('anything a remote sends is wrapped in ITS namespace, never passed through', async () => {
  // Not hostile, just an id that happens to look tagged in a way that resolves to
  // no host: it is still wrapped in the authenticated source's namespace.
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/page': { sessionId: 'h:' } } })
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('session/page', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'remote/id-leak', 'even a half-tag is refused, never trusted')
  // The wrapper itself has no "already tagged, keep it" branch: it refuses.
  assert.throws(() => namespaceId('hostB', 'h:'), (error) => error.code === 'remote/id-leak')
  assert.throws(() => namespaceId('hostB', 'h:hostA:s1'), (error) => error.code === 'remote/id-leak')
  assert.equal(namespaceId('hostB', 's1'), 'h:hostB:s1')
})

test('session/list refuses a hostile row from one host and keeps the others', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', {
    replies: { 'session/list': { items: [session('h:hostA:s1', 500), session('sb1', 300)] } },
  })
  const hostC = createFakeRemote('hostC', 'Host C', { replies: { 'session/list': { items: [session('sc1', 200)] } } })
  const harness = createHarness({ remotes: [hostB, hostC] })
  const answer = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.equal(answer.ok, true)
  // B's whole contribution is refused (the row is checked before it is trusted),
  // C's rows are untouched and every id is this controller's namespacing.
  assert.deepEqual(answer.value.items.map((row) => row.sessionId), ['h:hostC:sc1'])
  assert.ok(harness.logs.some((line) => line.includes('remote/id-leak')))
})

test('a workspace/follow baseline that names a namespace is refused and drops that host', async () => {
  // The hostile baseline arrives as the host's very first frame, so the refusal is
  // what keeps A's ids out of the merged map — not a race the test could win.
  const hostB = createFakeRemote('hostB', 'Host B', { workspaces: [workspaceView('h:hostA:w1', ['h:hostA:s1'])] })
  const hostC = createFakeRemote('hostC', 'Host C', { workspaces: [workspaceView('w2', ['s2'])] })
  const harness = createHarness({ remotes: [hostB, hostC] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('workspace/follow', { args: {} }, undefined, {}, control.signal, control, 64)
  try {
    const iterator = source[Symbol.asyncIterator]()
    const baseline = await nextFrame(iterator, 'merged baseline')
    assert.equal(baseline.value.type, 'baseline')
    assert.deepEqual([...hostIdsIn(baseline.value)], ['hostC'], 'only the clean host contributes')
    assert.equal(JSON.stringify(baseline.value).includes('h:hostA:'), false)
    assert.equal(baseline.value.value.items.length, 1)
    assert.equal(/^h:hostC:/.test(baseline.value.value.items[0].workspaceId), true)
    assert.ok(harness.logs.some((line) => line.includes('remote/id-leak')))
    await iterator.return()
  } finally {
    control.abort()
  }
})

test('the same raw id from two hosts stays two ids and each call reaches its own host', async () => {
  const hostA = createFakeRemote('hostA', 'Host A', { replies: {
    'session/list': { items: [session('s1', 100)] },
    'session/prompt': { accepted: true },
  } })
  const hostB = createFakeRemote('hostB', 'Host B', { replies: {
    'session/list': { items: [session('s1', 200)] },
    'session/prompt': { accepted: true },
  } })
  const harness = createHarness({ remotes: [hostA, hostB] })
  const listed = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  const ids = listed.value.items.map((row) => row.sessionId)
  assert.deepEqual(ids.sort(), ['h:hostA:s1', 'h:hostB:s1'].sort(), 'a colliding raw id becomes two namespaced ids')

  // Each decision goes to the host that owns the tag, with the RAW id.
  for (const [tag, host] of [['h:hostA:s1', hostA], ['h:hostB:s1', hostB]]) {
    const answer = await harness.gateway.dispatchRpc('session/prompt', { args: { sessionId: tag, text: 'x' } }, undefined, {})
    assert.equal(answer.ok, true)
    assert.deepEqual(host.calls.at(-1).args, { sessionId: 's1', text: 'x' })
  }
  assert.deepEqual(hostA.calls.filter((call) => call.endpoint === 'session/prompt').map((call) => call.args.sessionId), ['s1'])
  assert.deepEqual(hostB.calls.filter((call) => call.endpoint === 'session/prompt').map((call) => call.args.sessionId), ['s1'])
  assertNoNamespacedId(hostA)
  assertNoNamespacedId(hostB)
})

// -- payload shape: prototype-safe, depth-bounded ---------------------------

test('a __proto__ key in a remote payload neither pollutes nor survives the rename', async () => {
  // `JSON.parse` makes `__proto__` an own property; a plain assignment would then
  // rebuild the prototype of the renamed copy instead of copying a field.
  const hostile = JSON.parse('{"sessionId":"s1","__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}')
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/page': hostile } })
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('session/page', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(answer.ok, true, JSON.stringify(answer))
  const value = answer.value
  assert.equal({}.polluted, undefined, 'Object.prototype was not polluted')
  assert.equal(Object.getPrototypeOf(value), Object.prototype, 'the renamed copy is a plain object')
  assert.equal(Object.hasOwn(value, '__proto__'), false, 'the key was dropped, not assigned')
  assert.equal(Object.hasOwn(value, 'constructor'), false)
  assert.equal(Object.hasOwn(value, 'prototype'), false)
  assert.equal(value.sessionId, 'h:hostB:s1', 'the real data still arrived, renamed')
})

test('a payload nested past the depth bound is refused instead of passed through', async () => {
  const deep = (levels) => {
    let value = { sessionId: 's1' }
    for (let index = 0; index < levels; index += 1) value = { child: value }
    return value
  }
  // 32 levels are fine (the bound), 33 are refused — a deeper subtree would come
  // back unrenamed, i.e. a raw remote id in the local UI.
  const ok = createFakeRemote('hostB', 'Host B', { replies: { 'session/page': deep(32) } })
  const bounded = createHarness({ remotes: [ok] })
  const fine = await bounded.gateway.dispatchRpc('session/page', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(fine.ok, true, JSON.stringify(fine))

  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/page': deep(33) } })
  const harness = createHarness({ remotes: [hostB] })
  const refused = await harness.gateway.dispatchRpc('session/page', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'remote/payload-too-deep')
  assert.equal(refused.value, undefined, 'no subtree was returned')
  assert.ok(harness.logs.some((line) => line.includes('remote/payload-too-deep')))

  // The same bound guards what is SENT: a payload that names a host at the top but
  // nests past the bound deeper down is refused before any Host sees it.
  const hostC = createFakeRemote('hostC', 'Host C')
  const sending = createHarness({ remotes: [hostC] })
  const outbound = await sending.gateway.dispatchRpc('session/prompt',
    { args: { ...deep(33), sessionId: 'h:hostC:s1' } }, undefined, {})
  assert.equal(outbound.ok, false)
  assert.equal(outbound.error.code, 'remote/payload-too-deep')
  assert.equal(hostC.calls.length, 0, 'the Host never received the payload')
  // A too-deep payload that names no host is an ordinary Local call: nothing is
  // renamed on that path, so there is no id to leak.
  const localDeep = await sending.gateway.dispatchRpc('session/page', { args: deep(33) }, undefined, {})
  assert.deepEqual(localDeep, { ok: true, value: { local: 'session/page' } })
})

test('a stream opened for a remote session goes through remote-stream-open', async () => {  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  const source = await harness.gateway.openWireStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: 'h:hostB:s1' } } } }, undefined, {}, new AbortController().signal, new AbortController(), 64)
  hostB.streams.at(-1).queue.push({ type: 'snapshot', header: { version: 4, id: 's1' } })
  hostB.streams.at(-1).queue.push({ type: 'event', event: { type: 'session/title', seq: 2, time: 1, data: { sessionId: 's1' } } })
  const iterator = source[Symbol.asyncIterator]()
  const snapshot = await nextFrame(iterator)
  assert.deepEqual(snapshot.value, { type: 'snapshot', header: { version: 4, id: 'h:hostB:s1' } })
  const event = await nextFrame(iterator)
  assert.deepEqual(event.value.event.data, { sessionId: 'h:hostB:s1' })
  assert.equal(hostB.streams[0].endpoint, 'session/follow')
  assert.deepEqual(hostB.streams[0].args, { request: { address: { kind: 'session', sessionId: 's1' } } })
  assertNoNamespacedId(hostB)
  await iterator.return()
})

test('$events is the Local stream, plus the remotes cards (spec 008 P2c)', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('$events', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const first = iterator.next()
  // The Local carrier is opened as the spine of the merged stream; nothing is
  // asked of a remote just because the UI subscribed to its events.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.localStreams.length, 1)
  assert.equal(harness.localStreams[0].endpoint, '$events')
  harness.localStreams[0].queue.push({ type: 'ready', clientId: 'c1', host: { home: '/home/owner' } })
  assert.deepEqual((await first).value, { type: 'ready', clientId: 'c1', host: { home: '/home/owner' } })
  assert.equal(hostB.streams.length, 0, 'no remote stream is opened for the Local event feed')
  control.abort()
  await iterator.return()
})

// -- approvals -------------------------------------------------------------

test('a remote $events/result carries the argsHash of the Host card and the right ids', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { '$events/result': { accepted: true } } })
  const harness = createHarness({ remotes: [hostB] })
  const card = { rpcId: 'rpc-1', sessionId: 's1', approvalId: 'a1', argsHash: 'a'.repeat(64), toolName: 'bash' }
  harness.cards.set('hostB|rpc-1', card)

  const answer = await harness.gateway.dispatchRpc('$events/result', {
    args: { clientId: 'c1', eventId: 'h:hostB:rpc-1', outcome: { kind: 'result', value: 'allowed-once' } },
  }, undefined, {})
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value, { accepted: true })
  assert.equal(hostB.calls.length, 1)
  assert.deepEqual(hostB.calls[0].args, {
    clientId: 'c1',
    eventId: 'rpc-1',
    outcome: { kind: 'result', value: 'allowed-once' },
    argsHash: card.argsHash,
    rpcId: 'rpc-1',
    approvalId: 'a1',
    sessionId: 's1',
  })
  assertNoNamespacedId(hostB)
})

test('a remote decision the UI cannot bind is refused, not forwarded', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('$events/result', {
    args: { clientId: 'c1', eventId: 'h:hostB:rpc-1', outcome: { kind: 'result', value: 'rejected' } },
  }, undefined, {})
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'remote/approval-unbound')
  assert.equal(hostB.calls.length, 0)
})

test('an argsHash already in the payload is kept verbatim', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { '$events/result': { accepted: true } } })
  const harness = createHarness({ remotes: [hostB] })
  const argsHash = 'b'.repeat(64)
  await harness.gateway.dispatchRpc('$events/result', {
    args: { sessionId: 'h:hostB:s1', rpcId: 'h:hostB:rpc-9', approvalId: 'h:hostB:a9', argsHash, outcome: 'allowed-once' },
  }, undefined, {})
  assert.deepEqual(hostB.calls[0].args, { sessionId: 's1', rpcId: 'rpc-9', approvalId: 'a9', argsHash, outcome: 'allowed-once' })
  assertNoNamespacedId(hostB)
})

// -- merge: workspace/follow ----------------------------------------------

test('workspace/follow merges Local plus each host: baseline, renamed upsert, reconnect replace', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', {
    workspaces: [workspaceView('wb1', ['sb1'])], archived: ['sb9'], pinned: ['sb1'],
  })
  const hostC = createFakeRemote('hostC', 'Host C', {
    workspaces: [workspaceView('wc1', ['sc1'])], archived: ['sc9'],
  })
  const harness = createHarness({
    remotes: [hostB, hostC],
    baseline: { items: [workspaceView('w1', ['s1'])], archivedSessionIds: ['s9'], pinnedSessionIds: [] },
  })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('workspace/follow', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()

  const first = await nextFrame(iterator, 'merged baseline')
  assert.equal(first.value.type, 'baseline')
  assert.deepEqual(first.value.value.items.map((item) => item.workspaceId), ['w1', 'h:hostB:wb1', 'h:hostC:wc1'])
  // The extra host fields are additive (`additionalProperties` is allowed); the
  // path and title of a remote workspace are host-side text, never renamed.
  assert.deepEqual(first.value.value.items[1], {
    workspaceId: 'h:hostB:wb1', path: '/tmp/wb1', title: 'wb1', sessionIds: ['h:hostB:sb1'],
    createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
    hostId: 'hostB', hostName: 'Host B',
  })
  assert.deepEqual(first.value.value.archivedSessionIds, ['s9', 'h:hostB:sb9', 'h:hostC:sc9'], 'archived is a union')
  assert.deepEqual(first.value.value.pinnedSessionIds, ['h:hostB:sb1'], 'pinned is a union')

  hostB.send({ type: 'upsert', workspace: workspaceView('wb2', ['sb2']) })
  const upsert = await nextFrame(iterator, 'upsert')
  assert.deepEqual(upsert.value, {
    type: 'upsert',
    workspace: {
      workspaceId: 'h:hostB:wb2', path: '/tmp/wb2', title: 'wb2', sessionIds: ['h:hostB:sb2'],
      createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
      hostId: 'hostB', hostName: 'Host B',
    },
  })

  hostB.send({ type: 'archived', archivedSessionIds: ['sb1'] })
  const archived = await nextFrame(iterator, 'archived')
  assert.deepEqual(archived.value, { type: 'archived', archivedSessionIds: ['s9', 'h:hostB:sb1', 'h:hostC:sc9'] })

  hostB.send({ type: 'remove', workspaceId: 'wb1' })
  const removed = await nextFrame(iterator, 'remove')
  assert.deepEqual(removed.value, { type: 'remove', workspaceId: 'h:hostB:wb1' })

  // Disconnect: the host's workspaces leave the merged state and the UI is told
  // to republish everything (a `replace`, not a silent drop).
  harness.disconnect('hostC')
  const dropped = await nextFrame(iterator, 'replace after disconnect')
  assert.equal(dropped.value.type, 'replace')
  assert.deepEqual(dropped.value.value.items.map((item) => item.workspaceId), ['w1', 'h:hostB:wb2'])
  assert.deepEqual(dropped.value.value.archivedSessionIds, ['s9', 'h:hostB:sb1'])

  // Reconnect: the host's baseline comes back and the merged state is republished.
  harness.connect('hostC')
  const refreshed = await nextFrame(iterator, 'replace after reconnect')
  assert.equal(refreshed.value.type, 'replace')
  assert.deepEqual(refreshed.value.value.items.map((item) => item.workspaceId), ['w1', 'h:hostB:wb2', 'h:hostC:wc1'])
  hostC.send({ type: 'upsert', workspace: workspaceView('wc2', ['sc2']) })
  const reupsert = await nextFrame(iterator, 'upsert after reconnect')
  assert.deepEqual(reupsert.value, {
    type: 'upsert',
    workspace: {
      workspaceId: 'h:hostC:wc2', path: '/tmp/wc2', title: 'wc2', sessionIds: ['h:hostC:sc2'],
      createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
      hostId: 'hostC', hostName: 'Host C',
    },
  })

  control.abort()
  await iterator.return()
  assertNoNamespacedId(hostB)
  assertNoNamespacedId(hostC)
})

// -- merge: session/list ---------------------------------------------------

test('session/list concatenates Local and every host, newest activity first', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/list': { items: [session('sb1', 200)] } } })
  const hostC = createFakeRemote('hostC', 'Host C', { replies: { 'session/list': { items: [session('sc1', 400)] } } })
  const harness = createHarness({
    remotes: [hostB, hostC],
    dispatchRpc: (endpoint) => (endpoint === 'session/list'
      ? { ok: true, value: { items: [session('s1', 100), session('s3', 300, { parentSessionId: 's1', projections: { kind: 'sequenced', asOfSeq: 2, values: { subagentCatalog: [{ id: 's3', mode: 'one-shot' }] } } })] } }
      : { ok: true, value: {} }),
  })
  const answer = await harness.gateway.dispatchRpc('session/list', { args: { cursor: 'page-2', [HOST_HINT]: 'hostB' } }, undefined, {})
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value.items.map((item) => [item.sessionId, item.updatedAt]), [
    ['h:hostC:sc1', 400], ['s3', 300], ['h:hostB:sb1', 200], ['s1', 100],
  ])
  // Local entries keep their raw ids (including their own subagent ids), remote
  // subagent ids are renamed with the host's namespace.
  assert.deepEqual(answer.value.items[1].projections.values.subagentCatalog, [{ id: 's3', mode: 'one-shot' }])
  // The merged view is not paginated: the request cursor is not forwarded, and
  // the hint is stripped before any Host sees it.
  assert.deepEqual(hostB.calls[0].args, {})
  assert.deepEqual(hostC.calls[0].args, {})
  assert.equal(harness.localCalls[0].payload.args.cursor, undefined)
  assertNoNamespacedId(hostB)
})

test('a host that refuses session/list is reported in status(); a later success clears it', async () => {
  // Measured end to end: a grant without `harness:remote` makes the Host refuse the
  // bridge call, the merged list keeps only Local rows, and the only symptom used to
  // be the log line. The refusal now rides `status().hosts[].error`, which the
  // Devices page shows on that host's row.
  const refusal = Object.assign(new Error('scope refused'), { code: 'auth/forbidden-scope', scope: 'harness:remote' })
  let reply = refusal
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { get 'session/list'() { return reply } } })
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.equal(answer.ok, true, 'a failing remote must not fail the merged list')
  const [host] = harness.router.status().hosts
  assert.equal(host.hostId, 'hostB')
  assert.equal(host.error.code, 'auth/forbidden-scope')
  assert.equal(host.error.scope, 'harness:remote')
  assert.ok(harness.logs.some((line) => line.includes('session/list from hostB failed: auth/forbidden-scope')),
    'the id-only log line stays the audit trail')
  // Re-paired with the scope: the next merged list carries the rows and no error.
  reply = { items: [session('sb1', 200)] }
  const healed = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.deepEqual(healed.value.items.map((item) => item.sessionId), ['h:hostB:sb1'])
  assert.deepEqual(harness.router.status().hosts, [{ hostId: 'hostB', hostName: 'Host B', online: true }],
    'a host that never refused a call carries no error field')
  harness.router.uninstall()
})

// -- transport: remote streams --------------------------------------------

// -- reload stacking (measured live on 0.2.2-rc.1) --------------------------

test('a reload that stacks a second router never breaks the carrier', async () => {
  const harness = createHarness()
  const dsh = harness.gateway.dispatchRpc
  // Router A installs, then a reload installs Router B on top of A's wrapper.
  const a = harness.router
  const b = createHostRouter({
    gateway: harness.gateway,
    dshVersion: PINNED_DSH_VERSION,
    hosts: () => [],
    onHostsChanged: () => () => {},
    approvals: { pending: () => [], onCard: () => () => {} },
    audit: () => {},
  })
  b.install()
  // A is disposed first (the reload order that used to null A's originals while
  // A's wrapper was still under B) — a call must still reach the real DSH method.
  a.uninstall()
  const reply = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.ok(reply, 'the carrier still answers')
  assert.equal(harness.gateway.dispatchRpc, harness.gateway.dispatchRpc)
  b.uninstall()
  assert.equal(harness.gateway.dispatchRpc, dsh, 'the true DSH original is restored')
})

// -- index.mjs wiring ------------------------------------------------------

test('GET /devices/remotes exposes the routing status and teardown restores the carrier', async () => {
  const harness = createHarness()
  const original = harness.gateway.dispatchRpc
  const mounted = await mountPlugin({ services: { typertGateway: harness.gateway },
    // The running DSH version resolved from process.argv is not this test runner.
    testDshVersion: PINNED_DSH_VERSION })
  const answer = await mounted.call('GET', '/devices/remotes')
  assert.equal(answer.status, 200)
  assert.equal(answer.json.routing.remote, true)
  assert.equal(answer.json.routing.reason, null)
  assert.deepEqual(answer.json.routing.merged, ['session/list', 'workspace/follow'])
  assert.equal(harness.gateway.dispatchRpc.length, 4, 'the Host carrier is wrapped while the plugin is mounted')
  mounted.close()
  assert.equal(harness.gateway.dispatchRpc, original, 'plugin teardown uninstalls the wrapper')
})

test('remoteSessions:false leaves the carrier alone and reports why', async () => {
  const harness = createHarness()
  const original = harness.gateway.dispatchRpc
  const mounted = await mountPlugin({ remoteSessions: false, services: { typertGateway: harness.gateway } })
  const answer = await mounted.call('GET', '/devices/remotes')
  assert.deepEqual(answer.json.routing, { remote: false, reason: 'disabled', hosts: [], merged: [] })
  assert.equal(harness.gateway.dispatchRpc, original)
  mounted.close()
})

test('RemoteConnection.call stops waiting when the caller cancels', async () => {
  const sent = []
  const connection = new RemoteConnection({ remote: { publicUrl: 'wss://127.0.0.1:9' }, readToken: () => 'token' })
  connection.ws = { readyState: 1, send(text, callback) { sent.push(JSON.parse(text)); callback?.() } }
  connection.state = 'online'
  const control = new AbortController()
  const pending = connection.call('session/prompt', { sessionId: 's1' }, { signal: control.signal })
  pending.catch(() => {})
  // `call` awaits the connection before it writes the frame.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sent[0].type, 'remote-call')
  control.abort()
  await assert.rejects(() => pending, (error) => error.code === 'cancelled')
  assert.equal(connection.waiters.size, 0, 'no waiter is left behind')
})

test('RemoteConnection.openStream speaks remote-stream-open and cancels on abort', async () => {
  const sent = []
  const fakeSocket = {
    readyState: 1,
    send(text, callback) { sent.push(JSON.parse(text)); callback?.() },
  }
  const connection = new RemoteConnection({ remote: { publicUrl: 'wss://127.0.0.1:9' }, readToken: () => 'token' })
  connection.ws = fakeSocket
  connection.state = 'online'

  const control = new AbortController()
  const source = await connection.openStream('session/follow', { request: { address: { kind: 'session', sessionId: 's1' } } }, { signal: control.signal })
  assert.equal(sent[0].type, 'remote-stream-open')
  assert.match(sent[0].streamId, /^[A-Za-z0-9._-]{1,64}$/)
  assert.equal(sent[0].streamId.startsWith('res.'), false)
  assert.equal(sent[0].endpoint, 'session/follow')
  assert.deepEqual(sent[0].args, { request: { address: { kind: 'session', sessionId: 's1' } } })

  const iterator = source[Symbol.asyncIterator]()
  const pending = iterator.next()
  control.abort()
  assert.equal(sent[1].type, 'remote-stream-cancel')
  assert.equal(sent[1].streamId, sent[0].streamId)
  await assert.rejects(() => pending, (error) => error.code === 'cancelled')
  assert.equal(connection.wireStreams.size, 0, 'the stream is released')
})

