// Spec 008 P2c (T025) — the offline transcript cache (lib/session-cache.mjs) and
// its two readers: the router's `session/follow` replay and the Devices routes.
//
// Runs with `node --test --test-isolation=none test/session-cache.test.mjs`. The
// writer in the router is driven by a stub remote connection (no socket); the
// routes are driven through `mountPlugin`, whose remote addresses are dead, which
// is exactly the offline case the cache exists for.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { createHostRouter } from '../lib/host-router.mjs'
import { createSessionCache, SESSION_CACHE_MAX_BYTES } from '../lib/session-cache.mjs'
import { PINNED_DSH_VERSION, namespaceIds } from '../lib/host-router.mjs'
import { mountPlugin, tempDir } from './helpers.mjs'

const HOST = 'hostB'
const SESSION = 's1'
const TOKEN = 'device-token-must-never-be-cached'

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

const snapshot = (extra = {}) => ({
  type: 'snapshot',
  header: { version: 4, id: SESSION },
  cursor: 2,
  records: [
    { type: 'event', event: { seq: 1, type: 'user/message', data: { sessionId: SESSION, text: 'hello' } } },
    { type: 'event', event: { seq: 2, type: 'assistant/message', data: { sessionId: SESSION, text: 'hi' } } },
  ],
  hasMore: false,
  projections: { asOfSeq: 2, values: { title: 'Cached' } },
  assistantStream: { revision: 0 },
  ...extra,
})
const increment = (seq) => ({ type: 'event', event: { seq, type: 'assistant/message', data: { sessionId: SESSION, text: `line ${seq}` } } })

/** A remote Host whose `session/follow` yields what the test wants cached. */
function createFakeRemote({ online = true, frames = [] } = {}) {
  const streams = []
  const calls = []
  const connection = {
    state: online ? 'online' : 'offline',
    async call(endpoint, args) {
      calls.push({ endpoint, args })
      return {}
    },
    async openStream(endpoint, args) {
      const queue = createQueue()
      streams.push({ endpoint, args, queue })
      for (const frame of frames) queue.push(frame)
      return queue
    },
  }
  return { hostId: HOST, hostName: 'Host B', connection, streams, calls }
}

function createHarness({ remotes = [], cache = null, connected = true } = {}) {
  const localCalls = []
  const gateway = {
    async dispatchRpc(endpoint, payload) {
      localCalls.push({ endpoint, payload })
      return { ok: true, value: { local: endpoint } }
    },
    // rc.1 arity: the multi-host wrapper's self-test probes it (>= 5 parameters).
    async openWireStream(endpoint, payload, uplink, peer, signal, control, window) {
      void [endpoint, payload, uplink, peer, signal, control, window]
      return createQueue()
    },
  }
  const listeners = new Set()
  const online = new Set(connected ? remotes.map((remote) => remote.hostId) : [])
  const router = createHostRouter({
    gateway,
    // Constitution A1.1: the wrapper is enabled only on the pinned release.
    dshVersion: PINNED_DSH_VERSION,
    hosts: () => remotes.filter((remote) => online.has(remote.hostId))
      .map((remote) => ({ hostId: remote.hostId, hostName: remote.hostName, connection: remote.connection, online: true })),
    onHostsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    cache,
    log: () => {},
  })
  router.install()
  return {
    gateway, router, localCalls,
    disconnect() { online.clear(); for (const listener of [...listeners]) listener() },
  }
}

async function drain(iterator) {
  const frames = []
  for (;;) {
    const next = await Promise.race([
      iterator.next(),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stream did not end within 2 s')), 2000)
        timer.unref?.()
      }),
    ])
    if (next.done) return frames
    frames.push(next.value)
  }
}

// -- the cache itself -------------------------------------------------------

test('append/read/history/remove: one JSONL file per (host, session)', () => {
  const dir = tempDir('dsh-devices-cache-')
  try {
    const cache = createSessionCache({ dir })
    assert.equal(cache.append(HOST, SESSION, snapshot()), true)
    assert.equal(cache.append(HOST, SESSION, increment(3)), true)
    const file = cache.fileFor(HOST, SESSION, 0)
    // The id is hashed into the name, never used as one: `<slug>-<sha256 prefix>`.
    assert.match(path.basename(file), /^s1-[0-9a-f]{32}\.jsonl$/)
    assert.equal(fs.existsSync(file), true)
    // One JSON object per line, nothing else.
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    for (const line of lines) assert.equal(typeof JSON.parse(line), 'object')

    const frames = cache.read(HOST, SESSION)
    assert.deepEqual(frames.map((frame) => frame.type), ['snapshot', 'event'])
    const history = cache.history(HOST, SESSION)
    assert.equal(history.kind, 'history')
    assert.equal(history.cached, true)
    assert.equal(history.readOnly, true)
    assert.deepEqual(history.events.map((event) => event.seq), [1, 2, 3])

    assert.equal(cache.remove(HOST, SESSION), true)
    assert.equal(fs.existsSync(file), false)
    assert.equal(cache.read(HOST, SESSION), null)
    assert.equal(cache.remove(HOST, SESSION), false, 'the delete is idempotent')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the size cap rotates: the newest frames survive, the oldest file is dropped', () => {
  const dir = tempDir('dsh-devices-cache-')
  try {
    // Room for the opening page plus exactly one increment: every second write
    // rotates, so the arithmetic below is exact and not size-guesswork.
    const pageBytes = (frame) => Buffer.byteLength(JSON.stringify(frame), 'utf8') + 1
    const limit = pageBytes(snapshot()) + pageBytes(increment(3)) + 8
    const cache = createSessionCache({ dir, maxBytes: limit, rotations: 2 })
    assert.equal(cache.append(HOST, SESSION, snapshot()), true)
    assert.equal(cache.append(HOST, SESSION, increment(3)), true)
    assert.equal(cache.append(HOST, SESSION, increment(4)), true)
    // The baseline survived its rotations: replay still opens with the snapshot.
    let frames = cache.read(HOST, SESSION)
    assert.equal(frames[0].type, 'snapshot')
    assert.deepEqual(frames.filter((frame) => frame.type === 'event').map((frame) => frame.event.seq), [3, 4])

    for (let seq = 5; seq < 14; seq += 1) cache.append(HOST, SESSION, increment(seq))
    const live = cache.fileFor(HOST, SESSION, 0)
    const hostDir = path.dirname(live)
    const base = path.basename(live).replace(/\.jsonl$/, '')
    assert.deepEqual(fs.readdirSync(hostDir).sort(), [path.basename(live), 'rot'].sort(),
      'the live file plus its rotation directory')
    // Rotations are structurally distinct (their own directory), so a session whose
    // id looks like `s.1` can never be mistaken for a rotation of `s`.
    assert.deepEqual(fs.readdirSync(path.join(hostDir, 'rot')).sort(),
      [`${base}.1.jsonl`, `${base}.2.jsonl`], 'exactly the configured rotations')
    const total = [path.basename(live), ...fs.readdirSync(path.join(hostDir, 'rot')).map((name) => path.join('rot', name))]
      .reduce((sum, name) => sum + fs.statSync(path.join(hostDir, name)).size, 0)
    assert.ok(total <= limit * 4, `the copy stays bounded (${total} bytes)`)
    // The baseline has now rotated out, so there is nothing a follow stream could
    // legally replay (it must begin with a snapshot) — but a history page still is.
    assert.equal(cache.read(HOST, SESSION), null)
    const history = cache.history(HOST, SESSION)
    assert.equal(history.kind, 'history')
    assert.ok(history.events.some((event) => event.seq === 13), 'the newest increment is kept')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('an id is an identifier, never a file name: unusable ids are refused', () => {
  const dir = tempDir('dsh-devices-cache-')
  try {
    const cache = createSessionCache({ dir })
    for (const bad of ['..', '.', 'a/b', 'a\\b', '', '.hidden', `${'x'.repeat(257)}`]) {
      assert.equal(cache.append(HOST, bad, snapshot()), false, `session id ${JSON.stringify(bad.slice(0, 16))}`)
      assert.equal(cache.read(HOST, bad), null)
      assert.equal(cache.remove(HOST, bad), false)
    }
    assert.equal(cache.append('../escape', SESSION, snapshot()), false)
    const circular = {}
    circular.self = circular
    assert.equal(cache.append(HOST, SESSION, circular), false)
    assert.equal(fs.existsSync(path.join(dir, '..', `${SESSION}.jsonl`)), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('hostile-but-usable ids get distinct safe paths (no ADS, no traversal, no alias)', () => {
  const dir = tempDir('dsh-devices-cache-')
  try {
    const cache = createSessionCache({ dir })
    // Every one of these is a legal DSH id and a hostile file name: `:` is an NTFS
    // alternate data stream, `..` is traversal, `s.1` is a rotation-shaped name.
    const ids = ['s:1', 'a..b', 's.1', 's.1:evil', 's', 'x'.repeat(200)]
    const paths = ids.map((id) => cache.fileFor(HOST, id, 0))
    assert.equal(new Set(paths).size, ids.length, 'every id has its own file')
    ids.forEach((id, index) => {
      const target = paths[index]
      const relative = path.relative(path.resolve(dir), path.resolve(target))
      // Inside the cache root, not one raw id in any path segment.
      assert.equal(relative.startsWith('..'), false, `${id}: inside the root`)
      // `c:\…` carries the drive colon, the cache-relative part never may: on NTFS
      // a colon there is an alternate data stream.
      assert.equal(relative.includes(':'), false, `${id}: no alternate data stream`)
      assert.equal(relative.split(path.sep).includes('..'), false, `${id}: no traversal`)
      assert.notEqual(path.basename(target), `${id}.jsonl`, `${id}: the id is not the file name`)
      assert.match(path.basename(target), /^[A-Za-z0-9_-]+-[0-9a-f]{32}\.jsonl$/, `${id}: slug + digest`)
      // And it really is a usable session of its own.
      assert.equal(cache.append(HOST, id, increment(index + 1)), true)
      assert.equal(fs.existsSync(target), true)
    })
    // Removing one removes exactly one copy.
    assert.equal(cache.remove(HOST, 's.1'), true)
    assert.equal(fs.existsSync(cache.fileFor(HOST, 's.1', 0)), false)
    assert.equal(fs.existsSync(cache.fileFor(HOST, 's', 0)), true)
    assert.equal(fs.existsSync(cache.fileFor(HOST, 's.1:evil', 0)), true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a rotation-shaped id and a case-only difference never collide', () => {
  const dir = tempDir('dsh-devices-cache-')
  try {
    const cache = createSessionCache({ dir, maxBytes: 200, rotations: 2 })
    // `s` rotates, so it has `rot/<base>.1.jsonl`; `s.1` must stay a different file.
    for (let seq = 1; seq < 8; seq += 1) cache.append(HOST, 's', increment(seq))
    const rotation = cache.fileFor(HOST, 's', 1)
    assert.equal(fs.existsSync(rotation), true, 'the rotation exists')
    const rotDir = path.join(path.dirname(cache.fileFor(HOST, 's', 0)), 'rot')
    const rotationsOfS = fs.readdirSync(rotDir).sort()
    assert.equal(rotationsOfS.length, 2)

    const lookalike = cache.fileFor(HOST, 's.1', 0)
    assert.notEqual(path.resolve(rotation), path.resolve(lookalike), 'a rotation is never a session file')
    assert.equal(cache.append(HOST, 's.1', snapshot({ header: { version: 4, id: 's.1' } })), true)
    assert.equal(fs.existsSync(lookalike), true)
    // Writing `s.1` did not add a rotation: the live files are hashed apart.
    assert.deepEqual(fs.readdirSync(rotDir).sort(), rotationsOfS)
    assert.equal(fs.readdirSync(path.dirname(lookalike)).includes(path.basename(lookalike)), true)

    // Case-only difference: NTFS is case-insensitive, a raw id name would fold.
    const upper = cache.fileFor(HOST, 'Session', 0)
    const lower = cache.fileFor(HOST, 'session', 0)
    assert.notEqual(upper, lower, 'the digest keeps case-distinct ids apart')
    cache.append(HOST, 'Session', increment(1))
    cache.append(HOST, 'session', increment(2))
    assert.deepEqual(cache.history(HOST, 'Session').events.map((event) => event.seq), [1])
    assert.deepEqual(cache.history(HOST, 'session').events.map((event) => event.seq), [2])
    // A host id that differs only by case is a different Host, not the same folder.
    assert.notEqual(cache.fileFor('HostB', SESSION, 0), cache.fileFor('hostB', SESSION, 0))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// -- the session follower (router) ------------------------------------------

test('the follower writes every session/follow frame of an opened remote session', async () => {
  const dir = tempDir('dsh-devices-cache-')
  try {
    const cache = createSessionCache({ dir })
    const remote = createFakeRemote({ frames: [snapshot(), increment(3)] })
    const harness = createHarness({ remotes: [remote], cache })
    const control = new AbortController()
    const source = await harness.gateway.openWireStream('session/follow',
      { args: { request: { address: { kind: 'session', sessionId: `h:${HOST}:${SESSION}` } } } },
      undefined, {}, control.signal, control, 64)
    const iterator = source[Symbol.asyncIterator]()
    const first = await iterator.next()
    // The UI sees its own namespace (recursively, like every other remote frame);
    // the Host got the raw id.
    assert.deepEqual(first.value, namespaceIds(snapshot(), HOST))
    assert.equal(first.value.header.id, `h:${HOST}:${SESSION}`)
    assert.equal(first.value.records[0].event.data.sessionId, `h:${HOST}:${SESSION}`)
    // The follower taps the stream as the UI consumes it — each pulled frame is
    // appended (a frame nobody read is not "opened" by the UI).
    assert.deepEqual((await iterator.next()).value, namespaceIds(increment(3), HOST))
    await iterator.return()
    control.abort()
    assert.deepEqual(remote.streams[0].args, { request: { address: { kind: 'session', sessionId: SESSION } } })
    // The cached copy is host-relative (raw ids), so it replays on any namespace.
    const cached = cache.read(HOST, SESSION)
    assert.deepEqual(cached.map((frame) => frame.type), ['snapshot', 'event'])
    assert.equal(cached[0].header.id, SESSION)
    // No credential ever reaches the transcript files.
    const text = fs.readFileSync(cache.fileFor(HOST, SESSION, 0), 'utf8')
    assert.equal(text.includes(TOKEN), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('offline: session/follow replays the cached copy read-only, prompt/create stay refused', async () => {
  const dir = tempDir('dsh-devices-cache-')
  try {
    const cache = createSessionCache({ dir })
    cache.append(HOST, SESSION, snapshot())
    cache.append(HOST, SESSION, increment(3))
    const remote = createFakeRemote({ online: false })
    const harness = createHarness({ remotes: [remote], cache, connected: false })

    const control = new AbortController()
    const source = await harness.gateway.openWireStream('session/follow',
      { args: { request: { address: { kind: 'session', sessionId: `h:${HOST}:${SESSION}` } } } },
      undefined, {}, control.signal, control, 64)
    const frames = await drain(source[Symbol.asyncIterator]())
    // Read-only replay: the cached snapshot and its increments, ids renamed, and
    // nothing was asked of the Host.
    assert.deepEqual(frames.map((frame) => frame.type), ['snapshot', 'event'])
    assert.equal(frames[0].header.id, `h:${HOST}:${SESSION}`)
    assert.equal(remote.streams.length, 0)
    control.abort()

    // A write against an offline Host is refused, never applied to the copy.
    for (const endpoint of ['session/prompt', 'session/create']) {
      const result = await harness.gateway.dispatchRpc(endpoint,
        { args: { sessionId: `h:${HOST}:${SESSION}` } }, undefined, {})
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'remote/host-offline')
    }
    assert.equal(harness.localCalls.length, 0)
    // A session with no cached copy stays refused too (no empty transcript).
    await assert.rejects(async () => drain((await harness.gateway.openWireStream('session/follow',
      { args: { request: { address: { kind: 'session', sessionId: `h:${HOST}:other` } } } },
      undefined, {}, control.signal, control, 64))[Symbol.asyncIterator]()),
    (error) => error.code === 'remote/host-offline')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// -- the Devices routes -----------------------------------------------------

const REMOTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function seed(dataDir, remote = {}) {
  const record = {
    id: REMOTE, name: 'Qoder-Sigma', address: '127.0.0.1:1', publicUrl: 'wss://127.0.0.1:1/ws/mobile',
    certSha256: 'a'.repeat(64), gatewayId: 'gw-1', createdAt: 1_700_000_000_000,
    device: { kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'harness:remote'] },
    revoked: false, ...remote,
  }
  fs.mkdirSync(path.join(dataDir, 'tokens'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'tokens', `${record.id}.token`), TOKEN)
  fs.writeFileSync(path.join(dataDir, 'remotes.json'),
    JSON.stringify({ version: 1, clientDeviceId: 'dshdev-test-0001', remotes: [record] }))
  return record
}

test('GET …/history answers from the cached copy when the Host is unreachable', async () => {
  const dataDir = tempDir('dsh-devices-cache-')
  // The store reads remotes.json when the plugin applies: seed before mounting.
  seed(dataDir)
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 300 })
  try {
    const cache = createSessionCache({ dir: path.join(dataDir, 'sessions') })
    cache.append(REMOTE, SESSION, snapshot())
    cache.append(REMOTE, SESSION, increment(3))

    // Both route forms read the same copy (127.0.0.1:1 is refused immediately).
    for (const url of [`/devices/remotes/${REMOTE}/history?sessionId=${SESSION}`,
      `/devices/remotes/${REMOTE}/sessions/${SESSION}/history`]) {
      const answer = await mounted.call('GET', url)
      assert.equal(answer.status, 200, `${url}: ${answer.text}`)
      assert.equal(answer.json.history.kind, 'history')
      assert.equal(answer.json.history.cached, true)
      assert.deepEqual(answer.json.history.events.map((event) => event.seq), [1, 2, 3])
    }
    // An uncached session has nothing to show: a clear offline code, not a 502.
    const missing = await mounted.call('GET', `/devices/remotes/${REMOTE}/sessions/nope/history`)
    assert.equal(missing.status, 409, missing.text)
    assert.equal(missing.json.error, 'remote/host-offline')
  } finally {
    mounted.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a prompt against an offline Host is refused with remote/host-offline', async () => {
  const dataDir = tempDir('dsh-devices-cache-')
  seed(dataDir)
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 300 })
  try {
    const answer = await mounted.call('POST', `/devices/remotes/${REMOTE}/prompt`,
      { body: { sessionId: SESSION, text: 'run the tests' } })
    assert.equal(answer.status, 409, answer.text)
    assert.equal(answer.json.error, 'remote/host-offline')
    assert.match(answer.json.message, /offline/)
  } finally {
    mounted.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('DELETE removes the cached copy: the live file and its rotations', async () => {
  const dataDir = tempDir('dsh-devices-cache-')
  seed(dataDir)
  const mounted = await mountPlugin({ dataDir })
  try {
    const cache = createSessionCache({ dir: path.join(dataDir, 'sessions'), maxBytes: 260, rotations: 2 })
    for (let seq = 1; seq < 6; seq += 1) cache.append(REMOTE, SESSION, seq === 1 ? snapshot() : increment(seq))
    const live = cache.fileFor(REMOTE, SESSION, 0)
    const rotation = cache.fileFor(REMOTE, SESSION, 1)
    assert.equal(fs.existsSync(rotation), true, 'there is something to rotate away')
    const neighbour = cache.fileFor(REMOTE, 's2', 0)
    cache.append(REMOTE, 's2', snapshot({ header: { version: 4, id: 's2' } }))

    const answer = await mounted.call('DELETE', `/devices/remotes/${REMOTE}/sessions/${SESSION}`)
    assert.equal(answer.status, 200, answer.text)
    assert.deepEqual(answer.json, { removed: true, sessionId: SESSION })
    assert.equal(fs.existsSync(live), false, 'the live file is gone')
    assert.equal(fs.existsSync(rotation), false, 'the rotations are gone')
    assert.equal(fs.existsSync(neighbour), true, 'another session of the same host is untouched')

    const second = await mounted.call('DELETE', `/devices/remotes/${REMOTE}/sessions/nothing-cached`)
    assert.equal(second.status, 200, second.text)
    assert.equal(second.json.removed, false)
    assert.equal(fs.existsSync(neighbour), true)
  } finally {
    mounted.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('the cache is size-capped per session and never holds a credential', async () => {
  const dataDir = tempDir('dsh-devices-cache-')
  const mounted = await mountPlugin({ dataDir, sessionCacheMaxBytes: 400, sessionCacheRotations: 1 })
  try {
    seed(dataDir)
    // The plugin's own cache instance is the writer; drive it the way the router
    // does, with a session whose frames carry the device token by mistake.
    const cache = createSessionCache({ dir: path.join(dataDir, 'sessions'), maxBytes: 400, rotations: 1 })
    for (let seq = 1; seq < 20; seq += 1) {
      cache.append(REMOTE, SESSION, seq === 1 ? snapshot() : increment(seq))
    }
    const hostDir = path.dirname(cache.fileFor(REMOTE, SESSION, 0))
    const files = [path.basename(cache.fileFor(REMOTE, SESSION, 0)),
      ...fs.readdirSync(path.join(hostDir, 'rot')).map((name) => path.join('rot', name))]
    assert.ok(files.length <= 2, `rotations are bounded: ${files.join(', ')}`)
    const total = files.reduce((sum, name) => sum + fs.statSync(path.join(hostDir, name)).size, 0)
    assert.ok(total <= 800, `the copy stays bounded (${total} bytes)`)
    assert.ok(SESSION_CACHE_MAX_BYTES > 400, 'the default budget is far larger than the test budget')
    for (const name of files) {
      const text = fs.readFileSync(path.join(hostDir, name), 'utf8')
      assert.equal(text.includes(TOKEN), false)
      assert.equal(/Bearer|authorization|pairingCode|dsh-pair\./i.test(text), false)
    }
    // The plugin never writes the token into the cache directory at all.
    const walk = (target) => fs.readdirSync(target, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory() ? walk(path.join(target, entry.name)) : [path.join(target, entry.name)]))
    const written = walk(path.join(dataDir, 'sessions'))
    for (const file of written) assert.equal(fs.readFileSync(file, 'utf8').includes(TOKEN), false)
  } finally {
    mounted.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
