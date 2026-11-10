// Spec 008 P2b (server): the two routes the composer chip and the offline banner
// need on top of the spec 008 P1 routes.
//  - POST /devices/remotes/:id/connect  — "Reconnect" from the host popover.
//  - DELETE /devices/remotes/:id/sessions/:sid — "Remove local copy": deletes OUR
//    cached transcript, never talks to the remote (the host is exactly the thing
//    that is offline when this button shows), and is an idempotent no-op.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { createSessionCache } from '../lib/session-cache.mjs'
import { check, finish, mountPlugin, tempDir } from './helpers.mjs'

console.log('remove-copy')

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function seed(config = {}) {
  const dataDir = tempDir()
  const remote = {
    id: ID, name: 'Qoder-Sigma', address: '127.0.0.1:1', publicUrl: 'wss://127.0.0.1:1/ws/mobile',
    certSha256: 'a'.repeat(64), gatewayId: 'gw-1', createdAt: 1_700_000_000_000,
    device: { kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'harness:remote', 'terminal'] },
    revoked: false,
  }
  fs.writeFileSync(path.join(dataDir, 'remotes.json'),
    JSON.stringify({ version: 1, clientDeviceId: 'dshdev-test-0001', remotes: config.remotes ?? [remote] }))
  return { dataDir, remote }
}

// The single-page file an older build (spec 008 P2b) wrote, at `sessions/<id>/<sid>.json`.
// It is the one legacy shape left on disk, and the route sweeps it (see lib/index.mjs).
const legacyCopy = (dataDir, remoteId, sessionId) => path.join(dataDir, 'sessions', remoteId, `${sessionId}.json`)
const writeLegacyCopy = (dataDir, remoteId, sessionId) => {
  const file = legacyCopy(dataDir, remoteId, sessionId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ sessionId, items: [] }))
  return file
}

await check('both new routes are under the guarded /devices prefix (loopback + same-origin, on every method)', async () => {
  const { dataDir } = seed()
  const mounted = await mountPlugin({ dataDir })
  try {
    const routes = [
      ['POST', `/devices/remotes/${ID}/connect`, undefined],
      ['DELETE', `/devices/remotes/${ID}/sessions/s-1`, undefined],
    ]
    for (const [method, url, body] of routes) {
      for (const remoteAddress of ['192.168.1.50', '8.8.8.8', '::ffff:192.168.1.5']) {
        const answer = await mounted.call(method, url, { body, remoteAddress })
        assert.equal(answer.status, 403, `${method} ${url} from ${remoteAddress}`)
        assert.match(answer.json.message, /loopback-only/)
      }
      for (const origin of ['https://evil.example', 'http://127.0.0.1:9999']) {
        const answer = await mounted.call(method, url, { body, headers: { origin } })
        assert.equal(answer.status, 403, `${method} ${url} from ${origin}`)
        assert.match(answer.json.message, /cross-origin/)
      }
    }
  } finally { mounted.close() }
})

await check('DELETE /devices/remotes/:id/sessions/:sid removes the cached copy, and is idempotent', async () => {
  const { dataDir } = seed()
  const mounted = await mountPlugin({ dataDir })
  // The copies are written through the real cache API the session follower uses,
  // so the DELETE has to remove what is actually on disk instead of a path this
  // test guessed. A tiny budget forces rotations, so the whole chain must go.
  const cache = createSessionCache({ dir: path.join(dataDir, 'sessions'), maxBytes: 256, rotations: 2 })
  const filesFor = (sessionId) => [0, 1, 2].map((index) => cache.fileFor(ID, sessionId, index))
  try {
    // Nothing cached yet: a no-op that still answers, so the banner can report it.
    const first = await mounted.call('DELETE', `/devices/remotes/${ID}/sessions/s-1`)
    assert.equal(first.status, 200, first.text)
    assert.deepEqual(first.json, { removed: false, sessionId: 's-1' })
    // A cached copy is deleted, and only that one.
    assert.equal(cache.append(ID, 's-1', { type: 'snapshot', records: [] }), true)
    // ~250 bytes each: three of them push the first frames into `rot/`.
    for (let index = 0; index < 3; index += 1) {
      assert.equal(cache.append(ID, 's-1', { type: 'event', event: { type: 'message', text: `${index}:${'x'.repeat(200)}` } }), true)
    }
    assert.equal(cache.append(ID, 's-2', { type: 'snapshot', records: [] }), true)
    const [mine, mineRotated1, mineRotated2] = filesFor('s-1')
    const neighbour = filesFor('s-2')[0]
    for (const file of [mine, mineRotated1, mineRotated2, neighbour]) assert.equal(fs.existsSync(file), true, `seeded ${file}`)
    assert.ok(cache.history(ID, 's-1'), 'the cache serves the seeded transcript')
    // The single-page copy an older build wrote next to the cache: the route
    // removes it too, or "Remove local copy" would leave a transcript behind.
    const legacy = writeLegacyCopy(dataDir, ID, 's-1')
    const legacyNeighbour = writeLegacyCopy(dataDir, ID, 's-2')

    const second = await mounted.call('DELETE', `/devices/remotes/${ID}/sessions/s-1`)
    assert.equal(second.status, 200, second.text)
    assert.deepEqual(second.json, { removed: true, sessionId: 's-1' })
    for (const file of [mine, mineRotated1, mineRotated2]) assert.equal(fs.existsSync(file), false, `${path.basename(file)} is gone`)
    assert.equal(fs.existsSync(legacy), false, 'the older single-page copy is gone too')
    assert.equal(fs.existsSync(neighbour), true, 'another session of the same host is untouched')
    assert.equal(fs.existsSync(legacyNeighbour), true, 'and so is its single-page copy')
    // What the cache API itself answers: nothing left to replay for that session.
    assert.equal(cache.history(ID, 's-1'), null)
    assert.equal(cache.read(ID, 's-2')?.length, 1, 'the neighbour copy is still replayable')
    // Second click: the same answer with removed:false, never an error.
    const again = await mounted.call('DELETE', `/devices/remotes/${ID}/sessions/s-1`)
    assert.deepEqual(again.json, { removed: false, sessionId: 's-1' })
    // The sweep stands on its own: a single-page copy with no JSONL cache is still
    // a copy the button promises to remove, so it counts as `removed:true`.
    const onlyLegacy = writeLegacyCopy(dataDir, ID, 's-3')
    const swept = await mounted.call('DELETE', `/devices/remotes/${ID}/sessions/s-3`)
    assert.deepEqual(swept.json, { removed: true, sessionId: 's-3' })
    assert.equal(fs.existsSync(onlyLegacy), false)
    // The route never dials the remote: the seeded endpoint (127.0.0.1:1) is dead,
    // yet the answer arrives without a connect error and without an approval list.
    assert.equal(again.json.error, undefined)
  } finally { mounted.close() }
})

await check('the session id is a file name: traversal, separators and empty names are refused', async () => {
  const { dataDir } = seed()
  const mounted = await mountPlugin({ dataDir })
  try {
    const escaped = writeLegacyCopy(dataDir, ID, 'victim')
    assert.equal(fs.existsSync(escaped), true)
    for (const raw of ['..', '.', '%2e%2e', 'a%2Fb', 'a/b', 'a%5Cb', `x${'y'.repeat(300)}`, '.hidden']) {
      const answer = await mounted.call('DELETE', `/devices/remotes/${ID}/sessions/${raw}`)
      assert.ok([400, 404].includes(answer.status), `${raw}: ${answer.status} ${answer.text}`)
    }
    assert.equal(fs.existsSync(escaped), true, 'nothing outside the exact file was deleted')
    // An empty id collapses to the collection path, which is not a delete route.
    const empty = await mounted.call('DELETE', `/devices/remotes/${ID}/sessions/`)
    assert.equal(empty.status, 404)
  } finally { mounted.close() }
})

await check('unknown remote, and a remote with a valid shape but no cache entry, are still safe', async () => {
  const { dataDir } = seed()
  const mounted = await mountPlugin({ dataDir })
  try {
    const unknown = await mounted.call('DELETE', `/devices/remotes/${OTHER}/sessions/s-1`)
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.error, 'not-found')
    const badId = await mounted.call('DELETE', `/devices/remotes/not-a-uuid/sessions/s-1`)
    assert.equal(badId.status, 404)
  } finally { mounted.close() }
})

await check('POST /devices/remotes/:id/connect refuses a revoked device and an unknown id without dialing', async () => {
  const revoked = { id: ID, name: 'Gone', address: '127.0.0.1:1', publicUrl: 'wss://127.0.0.1:1/ws/mobile',
    certSha256: 'b'.repeat(64), gatewayId: 'gw-2', createdAt: 1, device: { kind: 'desktop', scopes: [] }, revoked: true }
  const { dataDir } = seed({ remotes: [revoked] })
  const mounted = await mountPlugin({ dataDir })
  try {
    const refused = await mounted.call('POST', `/devices/remotes/${ID}/connect`)
    assert.equal(refused.status, 401, refused.text)
    assert.equal(refused.json.error, 'auth/revoked')
    const unknown = await mounted.call('POST', `/devices/remotes/${OTHER}/connect`)
    assert.equal(unknown.status, 404)
    // GET on the same path is still the plain view, and only POST is the action.
    const view = await mounted.call('GET', `/devices/remotes/${ID}`)
    assert.equal(view.status, 200)
    assert.equal(view.json.remote.status, 'revoked')
    const wrongMethod = await mounted.call('PUT', `/devices/remotes/${ID}/connect`)
    assert.equal(wrongMethod.status, 404)
  } finally { mounted.close() }
})

finish('remove-copy')
