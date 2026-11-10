// Spec 008 P2c (T026) — remote approval/question cards inside the NATIVE
// conversation stream (lib/host-router.mjs `$events` merge).
//
// Runs with `node --test --test-isolation=none test/interactions.test.mjs`. The
// card-shape cases use no socket: the local carrier is a fake `typertGateway` with
// the rc.1 signatures and each remote is a stub connection (an EventEmitter, like
// `RemoteConnection`), so every assertion is about what the controller's own UI
// sees and about what actually crosses the wire to a remote Host. The last case
// runs the REAL plugins/mobile-gateway in-process (as test/e2e.test.mjs does) so a
// question answer is measured end to end over the pinned WSS + the bridge.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { PINNED_DSH_VERSION, createHostRouter, hostIdsIn, namespaceId } from '../lib/host-router.mjs'
import { RemoteConnection, claimPairing } from '../lib/remote-client.mjs'

// The remote gateway is imported read-only; nothing in it is edited (spec 008).
const gatewayPlugin = (await import('../../mobile-gateway/lib/index.mjs')).default
const { createTestConnection, createTestRemoteAccess } = await import('../../mobile-gateway/test/helpers/peer.mjs')

const HOST = 'hostB'
const HASH = 'a'.repeat(64)
const clone = (value) => (value === undefined ? undefined : structuredClone(value))

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

/** A remote Host: its bridge answers `$events/result`, its device socket pushes cards. */
function createFakeRemote(hostId, hostName, options = {}) {
  const calls = []
  const requests = []
  const streams = []
  const connection = new EventEmitter()
  connection.state = 'online'
  connection.call = async (endpoint, args, callOptions) => {
    calls.push({ endpoint, args: clone(args), options: callOptions })
    const reply = options.replies?.[endpoint]
    if (reply instanceof Error) throw reply
    return typeof reply === 'function' ? reply(args) : clone(reply) ?? {}
  }
  connection.request = async (frame, requestOptions) => {
    requests.push({ frame: clone(frame), options: requestOptions })
    const reply = options.requestReply
    return typeof reply === 'function' ? reply(frame) : clone(reply) ?? { kind: 'question-response', accepted: true }
  }
  connection.openStream = async (endpoint, args) => {
    const queue = createQueue()
    streams.push({ endpoint, args: clone(args), queue })
    return queue
  }
  return {
    hostId, hostName, connection, calls, requests, streams,
    /** The Host pushes one of its own cards to this device. */
    card(frame) { connection.emit(frame.kind === 'question-requested' ? 'question' : 'approval', frame) },
    resolved(frame) { connection.emit(frame.kind === 'question-resolved' ? 'questionResolved' : 'resolved', frame) },
    setState(state) { connection.state = state; connection.emit('state', state) },
  }
}

function createHarness({ remotes = [], pending = () => [], dispatchRpc } = {}) {
  const localCalls = []
  const localStreams = []
  const logs = []
  const gateway = {
    async dispatchRpc(endpoint, payload, signal, peer) {
      localCalls.push({ endpoint, payload: clone(payload) })
      return typeof dispatchRpc === 'function' ? dispatchRpc(endpoint, payload, peer) : { ok: true, value: { local: endpoint } }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, window) {
      const queue = createQueue()
      localStreams.push({ endpoint, payload: clone(payload), window, queue })
      if (endpoint === '$events') queue.push({ type: 'ready', clientId: 'local-client', host: { home: '/home/owner' } })
      return queue
    },
  }
  const listeners = new Set()
  const connected = new Set(remotes.map((remote) => remote.hostId))
  const notify = () => { for (const listener of [...listeners]) listener() }
  const router = createHostRouter({
    gateway,
    dshVersion: PINNED_DSH_VERSION,
    hosts: () => remotes.filter((remote) => connected.has(remote.hostId))
      .map((remote) => ({ hostId: remote.hostId, hostName: remote.hostName, connection: remote.connection, online: true })),
    onHostsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    approvals: { pending: (hostId) => pending(hostId) },
    log: (line) => logs.push(line),
  })
  router.install()
  return {
    gateway, router, localCalls, localStreams, remotes, logs,
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

async function openEvents(harness) {
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('$events', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const ready = await nextFrame(iterator, '$events ready')
  assert.equal(ready.value.type, 'ready', 'the local stream must start with its own ready frame')
  assert.equal(ready.value.clientId, 'local-client')
  return { control, iterator }
}

const approvalCard = (rpcId = 'rpc-1', extra = {}) => ({
  kind: 'approval-requested',
  rpcId,
  sessionId: 's1',
  approvalId: 'a1',
  toolName: 'bash',
  callId: 'call-9',
  reason: 'needs a shell',
  argsHash: HASH,
  argsPreview: '{"command":"rm -rf build"}',
  ...extra,
})

const answer = (eventId, value, extra = {}) => ({
  args: { clientId: 'local-client', eventId, outcome: { kind: 'result', value }, ...extra },
})

test('a remote approval card is injected into the native $events stream with a namespaced id', async () => {
  const remote = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card(approvalCard())
    const card = (await nextFrame(iterator, 'card')).value
    assert.deepEqual(card, {
      type: 'waterfall',
      event: 'approval/request',
      eventId: namespaceId(HOST, 'rpc-1'),
      agentId: namespaceId(HOST, 's1'),
      request: {
        toolName: 'bash',
        callId: 'call-9',
        reason: 'needs a shell',
        argsPreview: '{"command":"rm -rf build"}',
      },
    })
    // The frame is exactly the five keys the rc.1 client validates, and the
    // request carries no `agent`/`signal` (it would be rejected as invalid).
    assert.deepEqual(Object.keys(card).sort(), ['agentId', 'event', 'eventId', 'request', 'type'])
    assert.equal(Object.hasOwn(card.request, 'agent'), false)
    assert.equal(Object.hasOwn(card.request, 'signal'), false)
    // Nothing was sent to the Host just because a card showed up.
    assert.equal(remote.calls.length, 0)
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('answering through the native path sends $events/result to that Host with its ids and argsHash', async () => {
  const remote = createFakeRemote(HOST, 'Host B', { replies: { '$events/result': { accepted: true, outcome: 'allowed-once' } } })
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card(approvalCard())
    await nextFrame(iterator, 'card')

    // The native UI answers with the namespaced eventId it was shown. It has no
    // argsHash of its own: the router binds the card the Host issued.
    const result = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'rpc-1'), 'allowed-once'), undefined, {})
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value, { accepted: true, outcome: 'allowed-once' })
    assert.equal(remote.calls.length, 1)
    assert.equal(remote.calls[0].endpoint, '$events/result')
    assert.deepEqual(remote.calls[0].args, {
      clientId: 'local-client',
      eventId: 'rpc-1',
      rpcId: 'rpc-1',
      sessionId: 's1',
      approvalId: 'a1',
      argsHash: HASH,
      outcome: { kind: 'result', value: 'allowed-once' },
    })
    // No namespaced id may reach a remote Host.
    assert.deepEqual([...hostIdsIn(remote.calls[0].args)], [])
    assert.equal(/h:hostB:/.test(JSON.stringify(remote.calls[0].args)), false)
    // The decision went to the Host, never to the local gateway.
    assert.equal(harness.localCalls.length, 0)
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a wrong argsHash is refused by the Host and the card stays pending', async () => {
  const remote = createFakeRemote(HOST, 'Host B', {
    replies: {
      '$events/result': (args) => (args.argsHash === HASH
        ? { accepted: true, outcome: 'allowed-once' }
        : { accepted: false, reason: 'hash-mismatch' }),
    },
  })
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card(approvalCard())
    await nextFrame(iterator, 'card')

    const wrong = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'rpc-1'), 'allowed-once', { argsHash: 'b'.repeat(64) }), undefined, {})
    assert.equal(wrong.ok, true)
    assert.deepEqual(wrong.value, { accepted: false, reason: 'hash-mismatch' })
    // The echoed hash travels verbatim (the Host is the authority) …
    assert.equal(remote.calls[0].args.argsHash, 'b'.repeat(64))
    // … and the card is still addressable: the same decision without a hash binds
    // the buffered one and applies exactly once.
    const retried = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'rpc-1'), 'allowed-once'), undefined, {})
    assert.deepEqual(retried.value, { accepted: true, outcome: 'allowed-once' })
    assert.equal(remote.calls[1].args.argsHash, HASH)
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a decision the controller cannot bind is remote/approval-unbound, not forwarded', async () => {
  const remote = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [remote] })
  const result = await harness.gateway.dispatchRpc('$events/result',
    answer(namespaceId(HOST, 'rpc-unknown'), 'allowed-once'), undefined, {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'remote/approval-unbound')
  assert.equal(remote.calls.length, 0)
})

test('a remote disconnect withdraws its pending cards from the native stream', async () => {
  const remote = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card(approvalCard('rpc-1'))
    remote.card(approvalCard('rpc-2', { approvalId: 'a2' }))
    await nextFrame(iterator, 'card 1')
    await nextFrame(iterator, 'card 2')

    harness.disconnect(HOST)
    const withdrawn = []
    for (let index = 0; index < 2; index += 1) withdrawn.push((await nextFrame(iterator, 'cancel')).value)
    assert.deepEqual(withdrawn.map((frame) => frame.type), ['cancel', 'cancel'])
    assert.deepEqual(withdrawn.map((frame) => frame.eventId).sort(),
      [namespaceId(HOST, 'rpc-1'), namespaceId(HOST, 'rpc-2')].sort())
    // A withdrawn card can no longer be decided: the Host is gone (and had the
    // decision been attempted while it was up, the card would be unbound).
    const late = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'rpc-1'), 'allowed-once'), undefined, {})
    assert.equal(late.ok, false)
    assert.equal(late.error.code, 'remote/host-offline')
    assert.equal(remote.calls.length, 0, 'nothing was sent to the offline Host')
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a Host that reports offline withdraws too (state, not only the host list)', async () => {
  const remote = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card(approvalCard())
    await nextFrame(iterator, 'card')
    remote.setState('offline')
    const cancelled = (await nextFrame(iterator, 'cancel')).value
    assert.deepEqual(cancelled, { type: 'cancel', eventId: namespaceId(HOST, 'rpc-1') })
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('cards buffered before the stream opened are seeded in, and a Host resolve withdraws', async () => {
  const remote = createFakeRemote(HOST, 'Host B')
  const buffered = [approvalCard('rpc-early')]
  const harness = createHarness({ remotes: [remote], pending: () => buffered })
  const { control, iterator } = await openEvents(harness)
  try {
    const seeded = (await nextFrame(iterator, 'seeded card')).value
    assert.equal(seeded.type, 'waterfall')
    assert.equal(seeded.eventId, namespaceId(HOST, 'rpc-early'))
    // The Host resolved it elsewhere (another device, the desktop): the card goes.
    remote.resolved({ kind: 'approval-resolved', rpcId: 'rpc-early', sessionId: 's1', approvalId: 'a1', outcome: 'rejected' })
    const cancelled = (await nextFrame(iterator, 'cancel')).value
    assert.deepEqual(cancelled, { type: 'cancel', eventId: namespaceId(HOST, 'rpc-early') })
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a remote question card is answered through the bridge userQuestions/answer, never question-answer', async () => {
  // The Host's question service accepts the answer batch and reports `true`; the
  // bridge forwards exactly this call (question-answer is ADMIN_ONLY for a device).
  const remote = createFakeRemote(HOST, 'Host B', { replies: { 'userQuestions/answer': true } })
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    const questions = [{ id: 'q1', header: 'Pick one', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }]
    remote.card({ kind: 'question-requested', rpcId: 'q-1', sessionId: 's1', callId: 'call-42', questions })
    const card = (await nextFrame(iterator, 'question card')).value
    assert.deepEqual(card, {
      type: 'waterfall',
      event: 'user-questions/request',
      eventId: namespaceId(HOST, 'q-1'),
      agentId: namespaceId(HOST, 's1'),
      request: { questions },
    })

    const answers = [{ id: 'q1', selected: ['B'] }]
    const result = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'q-1'), { answers }), undefined, {})
    assert.equal(result.ok, true, JSON.stringify(result))
    // rc.1 shape: agentId (the session), callId (the tool call the card named) and
    // the answer batch. `question-answer` must not appear at all.
    assert.equal(remote.calls.length, 1)
    assert.equal(remote.calls[0].endpoint, 'userQuestions/answer')
    assert.deepEqual(remote.calls[0].args, { agentId: 's1', callId: 'call-42', answer: { answers } })
    assert.equal(remote.requests.length, 0, 'the admin-only question-answer frame was not sent')
    assert.equal(JSON.stringify(remote.calls[0].args).includes('question-answer'), false)
    // The receipt travels back namespaced, like every other remote answer.
    assert.deepEqual(result.value, { kind: 'question-response', rpcId: namespaceId(HOST, 'q-1'),
      sessionId: namespaceId(HOST, 's1'), action: 'answer', accepted: true })
    assert.deepEqual([...hostIdsIn(remote.calls[0].args)], [])
    // A Host that answers `false` (the question is no longer continuable) leaves
    // the card addressable and the receipt says so.
    const stale = createFakeRemote(HOST, 'Host B', { replies: { 'userQuestions/answer': false } })
    const second = createHarness({ remotes: [stale] })
    const opened = await openEvents(second)
    try {
      stale.card({ kind: 'question-requested', rpcId: 'q-2', sessionId: 's1', callId: 'call-43', questions })
      await nextFrame(opened.iterator, 'question card 2')
      const refused = await second.gateway.dispatchRpc('$events/result',
        answer(namespaceId(HOST, 'q-2'), { answers }), undefined, {})
      assert.equal(refused.ok, true)
      assert.equal(refused.value.accepted, false)
      assert.equal(refused.value.reason, 'not-accepted')
    } finally {
      opened.control.abort()
      await opened.iterator.return()
    }
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a question card without a tool-call id is refused instead of guessed', async () => {
  const remote = createFakeRemote(HOST, 'Host B', { replies: { 'userQuestions/answer': true } })
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    // An older Host may not publish the tool-call id; nothing can be answered then.
    remote.card({ kind: 'question-requested', rpcId: 'q-3', sessionId: 's1', questions: [{ id: 'q1', header: 'Pick' }] })
    await nextFrame(iterator, 'question card')
    const result = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'q-3'), { answers: [{ id: 'q1', selected: ['A'] }] }), undefined, {})
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'remote/question-unbound')
    assert.equal(remote.calls.length, 0, 'nothing was sent to the Host')
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a card that claims another host namespace is refused, not injected', async () => {
  const hostA = createFakeRemote('hostA', 'Host A')
  const hostB = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [hostA, hostB] })
  const { control, iterator } = await openEvents(harness)
  try {
    // A compromised B sends cards whose ids already name A's namespace. Trusting the
    // tag would put B's card into A's conversation, and answering it would route to
    // A — the wrong Host.
    hostB.card(approvalCard('h:hostA:rpc-1'))
    hostB.card({ ...approvalCard('rpc-2'), sessionId: 'h:hostA:s1' })
    hostB.card({ kind: 'question-requested', rpcId: 'h:hostA:q-1', sessionId: 's1', callId: 'call-1', questions: [] })
    // A clean card from the same Host still works: the refusal is per card.
    hostB.card(approvalCard('rpc-3'))
    const injected = (await nextFrame(iterator, 'only the clean card')).value
    assert.deepEqual(injected.eventId, namespaceId(HOST, 'rpc-3'))
    assert.equal(JSON.stringify(injected).includes('h:hostA:'), false)
    assert.equal(harness.logs.filter((line) => line.includes('remote/id-leak')).length, 3)

    // A decision aimed at A's namespace never binds B's card: nothing is sent, and A
    // is never asked about a card B forged.
    const wrongHost = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId('hostA', 'rpc-3'), 'allowed-once'), undefined, {})
    assert.equal(wrongHost.ok, false)
    assert.equal(wrongHost.error.code, 'remote/approval-unbound')
    assert.equal(hostA.calls.length, 0)
    assert.equal(hostB.calls.length, 0, 'B card stays with B, undecided')
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a card whose ONLY hostile id is approvalId is refused, live and pre-buffered', async () => {
  const hostA = createFakeRemote('hostA', 'Host A')
  const hostB = createFakeRemote(HOST, 'Host B')
  // `approvalId` is copied verbatim into the card table (and into the plugin's
  // approval buffer), unlike rpcId/sessionId: it is validated as part of the WHOLE
  // card, so a tag it carries must refuse the card even when every other id is clean.
  const buffered = [{ ...approvalCard('rpc-early'), approvalId: 'h:hostA:early-approval' }]
  const harness = createHarness({ remotes: [hostA, hostB], pending: (hostId) => (hostId === HOST ? buffered : []) })
  const { control, iterator } = await openEvents(harness)
  try {
    hostB.card({ ...approvalCard('rpc-1'), approvalId: 'h:hostA:approval' })
    hostB.card({ ...approvalCard('rpc-2'), approvalId: 'a2', callId: 'h:hostA:call' })
    // A clean card from the same Host still works: the refusal is per card.
    hostB.card({ ...approvalCard('rpc-3'), approvalId: 'a3' })
    const seeded = (await nextFrame(iterator, 'only the clean cards')).value
    assert.deepEqual(seeded.eventId, namespaceId(HOST, 'rpc-3'),
      `hostile approvalId must refuse a card before it is stored (got ${JSON.stringify(seeded)})`)
    assert.equal(JSON.stringify(seeded).includes('h:hostA:'), false)
    // Live card, buffered-before-subscribe card, and the hostile callId: three refusals.
    assert.equal(harness.logs.filter((line) => line.includes('remote/id-leak')).length, 3)
    // A refused card is not addressable at all: no decision reaches either Host.
    const decide = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'rpc-1'), 'allowed-once'), undefined, {})
    assert.equal(decide.ok, false)
    assert.equal(decide.error.code, 'remote/approval-unbound')
    assert.equal(hostA.calls.length + hostB.calls.length, 0)
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a cancellation from one host never withdraws another host card', async () => {
  const hostA = createFakeRemote('hostA', 'Host A')
  const hostB = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [hostA, hostB] })
  const { control, iterator } = await openEvents(harness)
  try {
    // The same raw rpcId on two hosts: two cards, two namespaces (a collision).
    hostA.card(approvalCard('rpc-1'))
    hostB.card(approvalCard('rpc-1'))
    const cards = [(await nextFrame(iterator, 'A card')).value, (await nextFrame(iterator, 'B card')).value]
    assert.deepEqual(cards.map((frame) => frame.eventId).sort(),
      [namespaceId('hostA', 'rpc-1'), namespaceId(HOST, 'rpc-1')].sort())

    // B resolves its own id: only B's card is withdrawn, and the cancel frame names
    // B's namespace — a cancellation can never target another host's event.
    hostB.resolved({ kind: 'approval-resolved', rpcId: 'rpc-1', sessionId: 's1', approvalId: 'a1', outcome: 'rejected' })
    const cancelled = (await nextFrame(iterator, 'cancel')).value
    assert.deepEqual(cancelled, { type: 'cancel', eventId: namespaceId(HOST, 'rpc-1') })
    assert.equal(hostA.calls.length + hostB.calls.length, 0, 'a resolve is not a decision')

    // A's card survived: A's own card is still decidable and goes to A only.
    hostA.card(approvalCard('rpc-2'))
    await nextFrame(iterator, 'A card 2')
    hostA.connection.call = async (endpoint, args) => {
      hostA.calls.push({ endpoint, args: clone(args) })
      return { accepted: true, outcome: 'allowed-once' }
    }
    const decided = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId('hostA', 'rpc-2'), 'allowed-once'), undefined, {})
    assert.equal(decided.ok, true, JSON.stringify(decided))
    assert.equal(hostA.calls.length, 1)
    assert.equal(hostA.calls[0].endpoint, '$events/result')
    assert.equal(hostA.calls[0].args.eventId, 'rpc-2', 'A got its own raw id')
    assert.equal(hostB.calls.length, 0, 'B was never asked about A card')
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('the Local $events frames pass through unchanged and unknown cards are ignored', async () => {
  const remote = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    // A Host frame that is not a card (a status card, a resolve with no card) must
    // never be invented into the stream.
    remote.card({ kind: 'approval-resolved', rpcId: 'nobody', sessionId: 's1', approvalId: 'a9', outcome: 'rejected' })
    harness.localStreams[0].queue.push({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    const local = (await nextFrame(iterator, 'local emit')).value
    assert.deepEqual(local, { type: 'emit', event: 'api-session/status', args: ['s1', true] })
  } finally {
    control.abort()
    await iterator.return()
  }
})

// -- the same question path over the REAL gateway ---------------------------
//
// The cases above use a stub remote, so the bridge's own authorization and wire
// shape of `userQuestions/answer` were only simulated. This one runs the real
// `plugins/mobile-gateway` in-process (as test/e2e.test.mjs does): the card is
// pushed by the gateway, the answer crosses the pinned WSS into the bridge, and the
// Host's own `userQuestions/answer` RPC carries it with `{agentId, callId, answer}`.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The Host behind the real gateway: a question service that reports true/false. */
function fakeHost() {
  const calls = []
  /** Verdicts the Host will answer with, in order (rc.1: true = applied). */
  const verdicts = []
  const gateway = {
    async invoke(request) {
      // 36d9: a device only receives cards for sessions the Host lists to it.
      if (request?.namespace === 'session' && request?.method === 'list') return { items: [{ sessionId: 's1' }] }
      return {}
    },
    async stream(request) {
      return (async function* () {
        yield { type: 'baseline', value: request?.namespace === 'workspace'
          ? { items: [], archivedSessionIds: [] } : { projections: {} } }
        while (!request?.signal?.aborted) await delay(10)
      })()
    },
    async dispatchRpc(endpoint, payload, signal, peer) {
      calls.push({ endpoint, args: clone(payload?.args), peer })
      if (endpoint === 'userQuestions/answer') return { ok: true, value: verdicts.shift() ?? false }
      if (endpoint === 'session/list') return { ok: true, value: { items: [{ sessionId: 's1' }] } }
      return { ok: true, value: null }
    },
    async openWireStream() {
      return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }),
        async return() { return { done: true, value: undefined } } }) }
    },
  }
  return { gateway, calls, verdicts }
}

/** The real gateway over the pinned TLS listener, with the Host above behind it. */
async function startRealGateway(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-008-question-'))
  const host = fakeHost()
  const listeners = {}
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
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: host.gateway,
    agentDefaultModel: {},
    on(name, handler) { listeners[name] = handler; return () => { delete listeners[name] } },
    effect(fn) { dispose = fn() },
  }
  await gatewayPlugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: `spec008-q-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    requireHostApproval: false,
    log: () => {},
  })
  const base = `http://127.0.0.1:${port}`
  const api = {
    base, listeners, calls: host.calls, verdicts: host.verdicts,
    async post(route, body) {
      const response = await fetch(`${base}/mgw/${route}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body ?? {}) })
      return { status: response.status, data: await response.json() }
    },
    async get(route) { return (await fetch(`${base}/mgw/${route}`)).json() },
  }
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const status = await api.get('status')
    if (status.lan?.listening && status.lan.urls.length > 0) {
      api.lanUrl = status.lan.urls[0]
      api.pin = status.lan.certSha256
      t.after(async () => {
        dispose()
        await new Promise((resolve) => server.close(resolve))
        fs.rmSync(directory, { recursive: true, force: true })
      })
      return api
    }
    if (status.lan?.error) throw new Error(`gateway TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('gateway TLS listener did not become ready')
}

/** Push one question through the gateway's own `user-questions/request` listener. */
function askOnHost(gateway, callId, questions) {
  const controller = new AbortController()
  const pending = gateway.listeners['user-questions/request']({
    agent: { id: 's1' }, questions, wait: { callId }, signal: controller.signal,
  }, () => undefined)
  return { controller, pending }
}

test('real gateway: the native answer is applied over userQuestions/answer (true, false, pending after)', async (t) => {
  const gateway = await startRealGateway(t)
  const clientDeviceId = 'deskq-real-0000-4000-8000-000000000q01'
  const questions = [{ id: 'q1', header: 'Pick one', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }]
  const created = await gateway.post('pair', {
    kind: 'desktop', scopes: ['sessions:read', 'approval:respond', 'harness:remote'], publicUrl: gateway.lanUrl,
  })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const payload = created.data.payload
  const paired = await claimPairing({ url: gateway.lanUrl, payload, clientDeviceId, deviceName: 'e2e controller' })
  assert.equal(paired.device.kind, 'desktop')
  // The device's own pinned connection, exactly what the plugin stores per remote.
  const connection = new RemoteConnection({
    remote: { id: HOST, publicUrl: gateway.lanUrl, certSha256: payload.certSha256, clientDeviceId },
    readToken: () => paired.token,
    requestTimeoutMs: 8000,
  })
  t.after(() => { try { connection.ws?.terminate() } catch { /* already gone */ } })
  await connection.connect()
  // The card gate needs the session in this device's visible set (the Host list).
  await delay(400)

  const harness = createHarness({ remotes: [{ hostId: HOST, hostName: 'Host B', connection }] })
  const { control, iterator } = await openEvents(harness)
  const answers = [{ id: 'q1', selected: ['B'] }]
  try {
    // (1) The Host applies the answer (`true`): the receipt says accepted and the
    // card is no longer addressable, so a repeat cannot reach the Host again.
    gateway.verdicts.push(true)
    const first = askOnHost(gateway, 'call-77', questions)
    const card = (await nextFrame(iterator, 'question card over the wire')).value
    // The card was minted by the real gateway (its rpcId is a fresh UUID), so the
    // event id is checked as "this host's namespace", which is what the UI routes by.
    assert.equal(card.type, 'waterfall')
    assert.equal(card.event, 'user-questions/request')
    assert.ok(card.eventId.startsWith(namespaceId(HOST, '')), `eventId must be namespaced (${card.eventId})`)
    assert.equal(card.agentId, namespaceId(HOST, 's1'))
    assert.deepEqual(card.request, { questions })
    const applied = await harness.gateway.dispatchRpc('$events/result',
      answer(card.eventId, { answers }), undefined, {})
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.deepEqual(applied.value, { kind: 'question-response', rpcId: card.eventId,
      sessionId: namespaceId(HOST, 's1'), action: 'answer', accepted: true })
    const hostAnswers = gateway.calls.filter((call) => call.endpoint === 'userQuestions/answer')
    assert.equal(hostAnswers.length, 1)
    // rc.1 shape, measured on the real bridge: agentId (the session), the card's
    // tool-call id and the answer batch. A namespaced id never crosses the wire.
    assert.deepEqual(hostAnswers[0].args, { agentId: 's1', callId: 'call-77', answer: { answers } })
    assert.deepEqual([...hostIdsIn(hostAnswers[0].args)], [])
    // Answered → no longer pending: a repeat is refused here and sends nothing.
    const repeat = await harness.gateway.dispatchRpc('$events/result',
      answer(card.eventId, { answers }), undefined, {})
    assert.equal(repeat.ok, false)
    assert.equal(repeat.error.code, 'remote/approval-unbound')
    assert.equal(gateway.calls.filter((call) => call.endpoint === 'userQuestions/answer').length, 1)
    first.controller.abort()
    await first.pending.catch(() => undefined)

    // (2) The Host reports `false` (the question is no longer continuable): the
    // receipt says so and the card STAYS addressable, so the next attempt is sent.
    gateway.verdicts.push(false)
    const second = askOnHost(gateway, 'call-78', questions)
    const stale = (await nextFrame(iterator, 'second question card')).value
    const refused = await harness.gateway.dispatchRpc('$events/result',
      answer(stale.eventId, { answers }), undefined, {})
    assert.equal(refused.ok, true, JSON.stringify(refused))
    assert.equal(refused.value.accepted, false)
    assert.equal(refused.value.reason, 'not-accepted')
    assert.equal((await harness.gateway.dispatchRpc('$events/result',
      answer(stale.eventId, { answers }), undefined, {})).value.accepted, false, 'a not-accepted card stays pending')
    const all = gateway.calls.filter((call) => call.endpoint === 'userQuestions/answer')
    assert.equal(all.length, 3, 'the third attempt was forwarded again (the card was never dropped)')
    assert.equal(all[1].args.callId, 'call-78')
    assert.equal(all[2].args.callId, 'call-78')
    second.controller.abort()
    await second.pending.catch(() => undefined)
  } finally {
    control.abort()
    await iterator.return()
    try { connection.ws?.terminate() } catch { /* already gone */ }
  }
})
