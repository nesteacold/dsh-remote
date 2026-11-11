// Spec 008 link supervisor, the four review findings that were fixed after the first
// auto-reconnect pass (test/auto-reconnect.test.mjs keeps the supervisor's happy paths):
//
//  1. a dial closed during its TLS handshake must never reach the credential-bearing
//     upgrade (DELETE, re-pair in place, teardown), and a stale entry must never write
//     to the store row of the pairing that took its id over;
//  2. a host that greets and hangs up must climb the backoff, not reset it every time;
//  3. the configured delays are clamped into [100, 300000] ms;
//  4. a certificate that no longer matches the pin is terminal, with a reason on the row.
//
// The remote Host is a fake one (pinned TLS + the two WebSocket handshakes this package
// speaks), behind a TCP relay whose delay is what puts a dial "in its handshake". Every
// assertion about what the host received is counted server side; a token is only ever
// compared by hash of the Authorization header and never printed.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import { once } from 'node:events'

import { WebSocketServer, check, delay, finish, mountPlugin, pinOf, selfsigned, tempDir } from './helpers.mjs'
import { openPinnedSocket } from '../lib/remote-client.mjs'

console.log('reconnect-hardening')

const GATEWAY_ID = '11111111-1111-4111-8111-111111111111'
const OLD_TOKEN = 'seeded-device-token-'.padEnd(43, 'x')
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

const mkCert = async (cn) => {
  const result = await selfsigned.generate([{ name: 'commonName', value: cn }], { days: 1, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] })
  return { cert: result.cert, key: result.private }
}
const served = await mkCert('served')
const replaced = await mkCert('replaced-after-restart')
assert.notEqual(pinOf(served.cert), pinOf(replaced.cert))

/**
 * A fake remote Host with the three levers these checks need: a swappable certificate,
 * counts of every TLS connection / upgrade / Authorization header it received, and a
 * "greet then hang up" mode.
 */
async function fakeRemote() {
  const seen = { connections: 0, upgrades: 0, auth: [], paired: 0, mode: 'hello' }
  const server = https.createServer({ cert: served.cert, key: served.key })
  server.on('secureConnection', () => { seen.connections += 1 })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    seen.upgrades += 1
    // The header is the whole secret: keep its digest only.
    if (typeof req.headers.authorization === 'string') seen.auth.push(sha256(req.headers.authorization))
    const pairing = String(req.headers['sec-websocket-protocol'] ?? '').includes('dsh-pair.')
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (pairing) {
        seen.paired += 1
        ws.send(JSON.stringify({ kind: 'pairing-challenge', serverNonce: crypto.randomBytes(9).toString('base64url') }))
        ws.on('message', () => {
          ws.send(JSON.stringify({ kind: 'paired', token: `paired-token-${seen.paired}`,
            device: { id: 'dev-1', kind: 'desktop', scopes: ['sessions:read', 'harness:remote'] },
            gatewayId: GATEWAY_ID, gatewayName: 'fake host' }))
          ws.send(JSON.stringify({ kind: 'hello', authenticated: true }))
        })
        return
      }
      ws.send(JSON.stringify({ kind: 'hello', authenticated: true }))
      // A peer that says hello and leaves: the case the backoff must not reset on.
      if (seen.mode === 'greet-and-hang-up') setTimeout(() => { try { ws.terminate() } catch { /* gone */ } }, 5)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return {
    seen, port, url: `wss://127.0.0.1:${port}/ws/mobile`,
    swapCertificate(next) { server.setSecureContext({ cert: next.cert, key: next.key }) },
    drop() { for (const ws of wss.clients) { try { ws.terminate() } catch { /* gone */ } } },
    close() { wss.close(); server.closeAllConnections?.(); server.close() },
  }
}

/**
 * A TCP relay in front of the fake Host. `delayMs` is read when a connection is
 * accepted, so a dial accepted during the delay sits in its TLS handshake — the window
 * finding 1 is about — while later dials are immediate.
 */
async function delayProxy(targetPort) {
  // `closed` is the counter the cancellation checks read: a socket the client dropped
  // must END here, not merely stop being written to.
  const state = { delayMs: 0, connections: 0, closed: 0 }
  const server = net.createServer((client) => {
    state.connections += 1
    client.on('error', () => {})
    client.on('close', () => { state.closed += 1 })
    const connect = () => {
      const upstream = net.connect(targetPort, '127.0.0.1')
      upstream.on('error', () => client.destroy())
      upstream.on('close', () => client.destroy())
      client.on('error', () => upstream.destroy())
      client.on('close', () => upstream.destroy())
      client.pipe(upstream)
      upstream.pipe(client)
    }
    if (state.delayMs > 0) setTimeout(connect, state.delayMs).unref?.()
    else connect()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return { state, port, url: `wss://127.0.0.1:${port}/ws/mobile`, address: `127.0.0.1:${port}`,
    close() { server.close() } }
}

/**
 * A peer that accepts TCP and then says nothing at all: no certificate, no hello. A dial
 * against it sits inside its TLS handshake until the client's own timeout — the window in
 * which a cancelled dial used to keep one socket and one 8 s timer per close() until that
 * timeout expired.
 */
async function silentPeer() {
  const state = { connections: 0, bytes: 0, closed: 0 }
  const sockets = []
  const server = net.createServer((socket) => {
    state.connections += 1
    sockets.push(socket)
    socket.on('error', () => {})
    socket.on('data', (chunk) => { state.bytes += chunk.length })
    socket.on('close', () => { state.closed += 1 })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return { state, url: `wss://127.0.0.1:${port}/ws/mobile`, address: `127.0.0.1:${port}`,
    close() { for (const socket of sockets) socket.destroy(); server.close() } }
}

/** Timers still holding the process open: an awaited `delay()` is already gone from it. */
const pendingTimeouts = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length

/** Write the store a previous mount would have left: one remote record + its token file. */
function seedRemote(dataDir, { url, address, certSha256, token = OLD_TOKEN }) {
  const id = crypto.randomUUID()
  fs.mkdirSync(path.join(dataDir, 'tokens'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'remotes.json'), JSON.stringify({
    version: 1, clientDeviceId: `dshdev-${crypto.randomUUID()}`,
    remotes: [{
      id, name: 'Fake host', address, publicUrl: url, certSha256, gatewayId: GATEWAY_ID,
      createdAt: Date.now(), device: { id: 'dev-1', kind: 'desktop', scopes: ['sessions:read', 'harness:remote'] },
      revoked: false,
    }],
  }, null, 2))
  fs.writeFileSync(path.join(dataDir, 'tokens', `${id}.token`), token)
  return id
}

const pairingString = (url, certSha256) => Buffer.from(JSON.stringify({
  version: 3, publicUrl: url, pairingCode: 'A'.repeat(43), expiresAt: Date.now() + 120_000, certSha256,
  gatewayId: GATEWAY_ID, gatewayName: 'fake host', endpoints: [url],
}), 'utf8').toString('base64url')

/** Poll `fn` until it returns a truthy value, then return it. */
async function until(fn, label, { tries = 400, every = 10 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await fn()
    if (value) return value
    await delay(every)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const viewOf = async (mounted, id) => (await mounted.call('GET', `/devices/remotes/${id}`)).json.remote
/** The attempt numbers the supervisor scheduled, in order, taken from its own log. */
const scheduledAttempts = (logs) => logs
  .map((line) => /redial in (\d+) ms \(attempt (\d+)\)/.exec(line))
  .filter(Boolean)
  .map((match) => ({ delayMs: Number(match[1]), attempt: Number(match[2]) }))

// ---------------------------------------------------------------- finding 1 (blocker)
// One check per caller that closes a connection (DELETE, re-pair in place, teardown):
// each closes while the start-up dial is still doing its TLS handshake, which is the
// window where `this.ws` is null and the old code left the dial detached and alive.
const MID_HANDSHAKE_MS = 250

async function midHandshake({ mounted, proxy, id }) {
  await until(() => proxy.state.connections >= 1, 'the start-up dial to reach the relay')
  const connection = mounted.instance.live.get(id).connection
  assert.equal(connection.state, 'connecting', 'the dial is inside its handshake, before any upgrade')
  return connection
}

await check('DELETE during the TLS handshake: no upgrade, no Authorization header, never online', async () => {
  const remote = await fakeRemote()
  const proxy = await delayProxy(remote.port)
  const dataDir = tempDir()
  const id = seedRemote(dataDir, { url: proxy.url, address: proxy.address, certSha256: pinOf(served.cert) })
  proxy.state.delayMs = MID_HANDSHAKE_MS
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: [100], reconnectStableMs: 100 })
  try {
    const connection = await midHandshake({ mounted, proxy, id })
    const removed = await mounted.call('DELETE', `/devices/remotes/${id}`)
    assert.equal(removed.status, 200, removed.text)
    await delay(MID_HANDSHAKE_MS + 250) // the held handshake has finished by now
    assert.equal(remote.seen.upgrades, 0, `a removed remote never issues a WebSocket upgrade (upgrades: ${remote.seen.upgrades})`)
    assert.equal(remote.seen.auth.length, 0, `no Authorization header reached the host (headers: ${remote.seen.auth.length})`)
    assert.notEqual(connection.state, 'online', 'the detached dial never came online')
  } finally { mounted.close(); proxy.close(); remote.close() }
})

await check('teardown during the TLS handshake: no upgrade and no credential after the plugin is gone', async () => {
  const remote = await fakeRemote()
  const proxy = await delayProxy(remote.port)
  const dataDir = tempDir()
  const id = seedRemote(dataDir, { url: proxy.url, address: proxy.address, certSha256: pinOf(served.cert) })
  proxy.state.delayMs = MID_HANDSHAKE_MS
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: [100], reconnectStableMs: 100 })
  try {
    const connection = await midHandshake({ mounted, proxy, id })
    mounted.close()
    await delay(MID_HANDSHAKE_MS + 250)
    assert.equal(remote.seen.upgrades, 0, `teardown stops the dial before its upgrade (upgrades: ${remote.seen.upgrades})`)
    assert.equal(remote.seen.auth.length, 0, `the token never left this host (headers: ${remote.seen.auth.length})`)
    assert.notEqual(connection.state, 'online')
  } finally { proxy.close(); remote.close() }
})

await check('re-pair in place during the TLS handshake: the old dial sends nothing, the new pairing takes the row', async () => {
  const remote = await fakeRemote()
  const proxy = await delayProxy(remote.port)
  const dataDir = tempDir()
  const id = seedRemote(dataDir, { url: proxy.url, address: proxy.address, certSha256: pinOf(served.cert) })
  proxy.state.delayMs = MID_HANDSHAKE_MS
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: [100], reconnectStableMs: 100 })
  try {
    await midHandshake({ mounted, proxy, id })
    // Only the dial already accepted keeps its held handshake; the pairing dial and the
    // re-paired connection that follow are immediate.
    proxy.state.delayMs = 0
    const answer = await mounted.call('POST', '/devices/remotes', {
      body: { address: proxy.address, pairingString: pairingString(proxy.url, pinOf(served.cert)) },
    })
    assert.equal(answer.status, 201, answer.text)
    assert.equal(answer.json.remote.id, id, 'the same gateway re-pairs in place, keeping the id')
    await until(async () => (await viewOf(mounted, id)).status === 'online', 'the re-paired connection online')
    await delay(MID_HANDSHAKE_MS + 250)
    // Two legitimate upgrades: the pairing handshake and the connection the new pairing
    // opened. A third — or the seeded token — would be the stale dial.
    assert.equal(remote.seen.upgrades, 2, `upgrades: ${remote.seen.upgrades}`)
    assert.equal(remote.seen.paired, 1)
    assert.equal(remote.seen.auth.length, 1, 'only the new connection sent a credential')
    assert.equal(remote.seen.auth.includes(sha256(`Bearer ${OLD_TOKEN}`)), false,
      'the credential of the pairing that was replaced never reached the host')
    assert.equal((await viewOf(mounted, id)).status, 'online')
  } finally { mounted.close(); proxy.close(); remote.close() }
})

await check('a cancelled dial rejects as cancelled (offline, no detail) and connect() still works afterwards', async () => {
  const remote = await fakeRemote()
  const proxy = await delayProxy(remote.port)
  const dataDir = tempDir()
  const id = seedRemote(dataDir, { url: proxy.url, address: proxy.address, certSha256: pinOf(served.cert) })
  proxy.state.delayMs = MID_HANDSHAKE_MS
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: [100], reconnectStableMs: 100 })
  try {
    const entry = mounted.instance.live.get(id)
    const dial = entry.connection.connect() // the start-up dial already in flight
    await midHandshake({ mounted, proxy, id })
    entry.connection.close()
    await assert.rejects(dial, (error) => error.code === 'cancelled', 'the cancelled dial is reported as our own stop')
    assert.equal(entry.connection.state, 'offline')
    assert.equal(entry.detail, null, 'no detail: the supervisor must not read it as an unexpected loss')
    assert.deepEqual(remote.seen.auth, [])
    // A fresh generation dials again — the manual Reconnect path relies on it.
    proxy.state.delayMs = 0
    await entry.connection.connect()
    assert.equal(entry.connection.state, 'online')
    assert.equal(remote.seen.upgrades, 1, 'exactly the one dial that was wanted')
    assert.equal(remote.seen.auth.length, 1)
  } finally { mounted.close(); proxy.close(); remote.close() }
})

// ------------------------------------- cancellation inside a handshake that never ends
// The peer accepts TCP and then never answers: the dial is inside `tls.connect` with no
// WebSocket to terminate yet. `close()` must stop it there and then, not after the
// 8 s handshake timeout — and each cancelled dial must take its socket and timer with it.
await check('close() during a TLS handshake the peer never finishes rejects at once and drops the socket', async () => {
  const peer = await silentPeer()
  const dataDir = tempDir()
  const id = seedRemote(dataDir, { url: peer.url, address: peer.address, certSha256: pinOf(served.cert) })
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: [100], reconnectStableMs: 100 })
  try {
    const entry = mounted.instance.live.get(id)
    const dial = entry.connection.connect() // the start-up dial, stuck in its handshake
    dial.catch(() => { /* awaited below; an earlier failed assertion must not crash the run */ })
    await until(() => peer.state.connections >= 1, 'the start-up dial to reach the silent peer')
    await until(() => peer.state.bytes > 0, 'the ClientHello to arrive (the dial is in its TLS handshake)')
    assert.equal(entry.connection.state, 'connecting', 'no upgrade yet: the handshake never finished')
    const startedAt = Date.now()
    entry.connection.close()
    await assert.rejects(dial, (error) => error.code === 'cancelled', 'the cancelled dial is reported as our own stop')
    const settledMs = Date.now() - startedAt
    assert.ok(settledMs < 1000, `the cancelled dial settles at once (${settledMs} ms, not the 8000 ms handshake timeout)`)
    // The dial's own bookkeeping is gone too: nothing is left waiting on that generation.
    assert.equal(entry.connection.dial, null, 'no dial record is left behind')
    await until(() => peer.state.closed >= 1, 'the peer to see the cancelled socket end')
    assert.equal(peer.state.closed, peer.state.connections, 'the cancelled dial left no socket open at the peer')
    assert.equal(entry.connection.state, 'offline')
    assert.equal(entry.detail, null, 'no detail: our own stop is not an unexpected loss')
  } finally { mounted.close(); peer.close() }
})

await check('a TLS dial cancelled while the peer is silent clears its handshake timer', async () => {
  const peer = await silentPeer()
  try {
    const timeoutsBefore = pendingTimeouts()
    const controller = new AbortController()
    let outcome = null
    // `openPinnedSocket` is where the timeout lives: the connection level only sees the
    // rejection, so a timer left here would keep the Host process up for 8 s per dial.
    const dial = openPinnedSocket({ url: peer.url, protocols: ['dsh-mobile-v1'], headers: {},
      certSha256: pinOf(served.cert), signal: controller.signal })
    dial.catch((error) => { outcome = error })
    await until(() => peer.state.bytes > 0, 'the ClientHello to reach the silent peer')
    controller.abort()
    await until(() => outcome !== null, 'the aborted dial to settle')
    assert.equal(outcome?.code, 'cancelled', 'the aborted dial reports our own stop')
    await delay(20) // the dial's own `finally` has run by now
    assert.equal(pendingTimeouts(), timeoutsBefore, 'the handshake timer went with the socket')
    // The peer did see that socket end: the abort destroyed it rather than leaving it open.
    await until(() => peer.state.closed >= 1, 'the peer to see the cancelled socket end')
  } finally { peer.close() }
})

await check('a dial cancelled inside its TLS handshake is destroyed before the relay can finish it: no handshake, no upgrade, no credential', async () => {
  const remote = await fakeRemote()
  const proxy = await delayProxy(remote.port)
  const dataDir = tempDir()
  const id = seedRemote(dataDir, { url: proxy.url, address: proxy.address, certSha256: pinOf(served.cert) })
  // A handshake this relay holds for longer than a cancellation may take: the dial can
  // only settle "at once" if the abort itself ends the pending TLS socket instead of
  // waiting for the peer to complete it.
  const HELD_MS = 400
  proxy.state.delayMs = HELD_MS
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: [100], reconnectStableMs: 100 })
  try {
    const entry = mounted.instance.live.get(id)
    const dial = entry.connection.connect() // the start-up dial, held inside its handshake
    dial.catch(() => { /* awaited below; an earlier failed assertion must not crash the run */ })
    await until(() => proxy.state.connections >= 1, 'the start-up dial to reach the relay')
    const startedAt = Date.now()
    entry.connection.close()
    await assert.rejects(dial, (error) => error.code === 'cancelled')
    const settledMs = Date.now() - startedAt
    assert.ok(settledMs < HELD_MS / 2,
      `the cancelled dial settles before the held handshake could finish (${settledMs} ms vs a ${HELD_MS} ms hold)`)
    await until(() => proxy.state.closed >= 1, 'the relay to see the cancelled socket end')
    // Past the held delay: an abandoned handshake must never be connected to the Host.
    await delay(HELD_MS + 250)
    assert.equal(remote.seen.connections, 0, 'the Host never saw a TLS handshake from the cancelled dial')
    assert.equal(remote.seen.upgrades, 0, 'no WebSocket upgrade was ever sent')
    assert.deepEqual(remote.seen.auth, [], 'no Authorization header was sent')
    assert.notEqual(entry.connection.state, 'online')
  } finally { mounted.close(); proxy.close(); remote.close() }
})

// ---------------------------------------- one connection, two sockets: the stale one is deaf
// The entry-level guard in index.mjs only covers a REPLACED entry. A dial started on the
// same live entry after close() is not covered: the old socket's late events used to
// mark the new dial offline, reject its waiters and let a late 4401 revoke the live row.
await check('a superseded socket\'s late message and close cannot touch the dial that replaced it', async () => {
  const remote = await fakeRemote()
  const proxy = await delayProxy(remote.port)
  const dataDir = tempDir()
  const id = seedRemote(dataDir, { url: proxy.url, address: proxy.address, certSha256: pinOf(served.cert) })
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: [100], reconnectStableMs: 100 })
  const tokenFile = path.join(dataDir, 'tokens', `${id}.token`)
  try {
    const entry = mounted.instance.live.get(id)
    await until(() => entry.connection.state === 'online', 'the seeded pairing online')
    const connection = entry.connection
    const oldSocket = connection.ws
    assert.ok(oldSocket, 'the live socket is adopted')
    let revoked = 0
    connection.on('revoked', () => { revoked += 1 })
    // Hold the fresh dial inside its handshake so the old socket's events land in the
    // window this finding is about: between one dial's close() and the next dial's hello.
    proxy.state.delayMs = MID_HANDSHAKE_MS
    connection.close()
    const nextDial = connection.connect() // NOT awaited: the cancelled attempt is still settling
    nextDial.catch(() => { /* awaited below; an earlier failed assertion must not crash the run */ })
    assert.notEqual(connection.state, 'revoked', 'the fresh dial is not revoked by its own start')
    // A waiter the live connection owns and a card the old socket still "owes" it.
    let waiterRejected = 0
    connection.waiters.set('stale-probe', {
      resolve: () => {}, reject: () => { waiterRejected += 1 }, timer: setTimeout(() => {}, 2000),
    })
    const staleCard = { kind: 'approval-requested', rpcId: 'stale-rpc-1', approvalId: 'stale-approval-1', sessionId: 'stale-session-1' }
    oldSocket.emit('message', Buffer.from(JSON.stringify(staleCard)))
    oldSocket.emit('close', 1006)
    oldSocket.emit('close', 4401) // the revocation a superseded socket is not allowed to deliver
    await delay(50)
    assert.equal(revoked, 0, 'a 4401 from a superseded socket does not revoke the live entry')
    assert.equal(waiterRejected, 0, 'a stale close does not reject the live connection\'s waiters')
    assert.equal(connection.waiters.has('stale-probe'), true, 'the live waiter is still pending')
    assert.equal(entry.approvals.size, 0, 'a stale card is not buffered on the live entry')
    assert.equal(fs.existsSync(tokenFile), true, 'the stale 4401 did not wipe the token')
    assert.notEqual(connection.state, 'revoked')
    await nextDial
    assert.equal(connection.state, 'online', 'the replacement dial comes up online')
    assert.notEqual(connection.ws, oldSocket, 'the replacement is a different socket')
    // And once it is online, the same superseded socket speaks again.
    let hellos = 0
    let approvals = 0
    connection.on('hello', () => { hellos += 1 })
    connection.on('approval', () => { approvals += 1 })
    oldSocket.emit('message', Buffer.from(JSON.stringify({ kind: 'hello', authenticated: true })))
    oldSocket.emit('message', Buffer.from(JSON.stringify(staleCard)))
    oldSocket.emit('close', 4401)
    await delay(50)
    assert.equal(hellos, 0, 'a stale hello does not resolve the current dial')
    assert.equal(approvals, 0, 'a stale card does not reach the live entry')
    assert.equal(revoked, 0)
    assert.equal(waiterRejected, 0)
    assert.equal(connection.waiters.has('stale-probe'), true)
    assert.equal(connection.state, 'online', 'the live connection stays online')
    assert.equal((await viewOf(mounted, id)).status, 'online')
    assert.notEqual(mounted.instance.store.get(id)?.revoked, true, 'the row is not marked revoked')
    assert.equal(fs.existsSync(tokenFile), true, 'the token is still there')
  } finally { mounted.close(); proxy.close(); remote.close() }
})

await check('a stale entry\'s revoked event leaves the store row of its replacement untouched', async () => {
  const remote = await fakeRemote()
  const dataDir = tempDir()
  const id = seedRemote(dataDir, { url: remote.url, address: `127.0.0.1:${new URL(remote.url).port}`, certSha256: pinOf(served.cert) })
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: [100], reconnectStableMs: 100 })
  const tokenFile = path.join(dataDir, 'tokens', `${id}.token`)
  try {
    await until(async () => (await viewOf(mounted, id)).status === 'online', 'the seeded pairing online')
    const replacedConnection = mounted.instance.live.get(id).connection
    // Re-pair in place: a NEW entry (and token) now owns this id.
    const answer = await mounted.call('POST', '/devices/remotes', {
      body: { address: `127.0.0.1:${new URL(remote.url).port}`, pairingString: pairingString(remote.url, pinOf(served.cert)) },
    })
    assert.equal(answer.status, 201, answer.text)
    await until(async () => (await viewOf(mounted, id)).status === 'online', 'the re-paired connection online')
    const live = mounted.instance.live.get(id)
    assert.notEqual(live.connection, replacedConnection, 'the entry was replaced')
    const tokenBefore = sha256(fs.readFileSync(tokenFile, 'utf8'))
    // The socket of the pairing that is gone speaks one last time. It must not wipe the
    // token the replacement stored, nor mark the row revoked.
    replacedConnection.emit('revoked')
    await delay(50)
    assert.equal(fs.existsSync(tokenFile), true, 'the replacement keeps its token file')
    assert.equal(sha256(fs.readFileSync(tokenFile, 'utf8')), tokenBefore, 'the replacement keeps its token')
    assert.notEqual(mounted.instance.store.get(id)?.revoked, true, 'the row is not marked revoked')
    assert.equal((await viewOf(mounted, id)).status, 'online')
    // Control: the event from the entry that owns the row still revokes it.
    live.connection.emit('revoked')
    await delay(50)
    assert.equal(fs.existsSync(tokenFile), false, 'a 4401 on the current link still wipes the token')
    assert.equal(mounted.instance.store.get(id)?.revoked, true)
  } finally { mounted.close(); remote.close() }
})

// ------------------------------------------------------------- finding 2 (backoff reset)
await check('a host that greets and hangs up climbs the backoff instead of resetting it', async () => {
  const remote = await fakeRemote()
  remote.seen.mode = 'greet-and-hang-up'
  const dataDir = tempDir()
  const id = seedRemote(dataDir, { url: remote.url, address: `127.0.0.1:${new URL(remote.url).port}`, certSha256: pinOf(served.cert) })
  // A stability window well above the ~5 ms the peer stays up, so it can never reset.
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: [100, 150, 250, 400], reconnectStableMs: 200 })
  try {
    await until(() => new Set(scheduledAttempts(mounted.logs).map((step) => step.attempt)).size >= 4, 'four scheduled attempts', { tries: 600 })
    const attempts = scheduledAttempts(mounted.logs).map((step) => step.attempt)
    assert.deepEqual(attempts.slice(0, 4), [1, 2, 3, 4], `the sequence was ${JSON.stringify(attempts)}`)
    assert.equal(mounted.logs.some((line) => line.includes('retry sequence reset')), false,
      'a link that drops before the stability window never resets the sequence')
    assert.equal((await viewOf(mounted, id)).retry.attempt, 4, 'the attempt number stays bounded at the last step')
  } finally { mounted.close(); remote.close() }
})

await check('a link that stays up past reconnectStableMs resets the sequence', async () => {
  const remote = await fakeRemote()
  remote.seen.mode = 'greet-and-hang-up'
  const dataDir = tempDir()
  const id = seedRemote(dataDir, { url: remote.url, address: `127.0.0.1:${new URL(remote.url).port}`, certSha256: pinOf(served.cert) })
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: [100, 150, 250, 400], reconnectStableMs: 200 })
  try {
    await until(() => new Set(scheduledAttempts(mounted.logs).map((step) => step.attempt)).size >= 2, 'the sequence to climb')
    remote.seen.mode = 'hello'
    await until(() => mounted.logs.some((line) => /link stable, retry sequence reset \(was attempt [2-9]\)/.test(line)),
      'the stability window to reset the sequence', { tries: 600 })
    const mark = mounted.logs.length
    remote.drop() // a drop now starts over
    await until(() => scheduledAttempts(mounted.logs.slice(mark)).length >= 1, 'the next attempt after the reset')
    assert.equal(scheduledAttempts(mounted.logs.slice(mark))[0].attempt, 1, 'the backoff starts over after a stable link')
  } finally { mounted.close(); remote.close() }
})

// ---------------------------------------------------------- finding 3 (clamped delays)
/**
 * Mount with one seeded remote that can never be reached (a dead port) and return the
 * scheduled steps the supervisor logged, once it has logged `want` of them.
 */
async function scheduledSteps(config, want) {
  const dataDir = tempDir()
  const port = 9 // nothing listens here: the dial fails at once
  seedRemote(dataDir, { url: `wss://127.0.0.1:${port}/ws/mobile`, address: `127.0.0.1:${port}`, certSha256: 'a'.repeat(64) })
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 2000, ...config })
  try {
    return await until(() => {
      const seen = scheduledAttempts(mounted.logs)
      return seen.length >= want ? seen : null
    }, `${want} scheduled step(s)`)
  } finally { mounted.close() }
}

await check('reconnectDelaysMs entries are clamped to integers in [100, 300000] ms before jitter', async () => {
  // 0.5 and 1.7 are below the floor: both become 100 ms (80..120 after the ±20% jitter).
  for (const configured of [[0.5], [1.7]]) {
    const [step] = await scheduledSteps({ reconnectDelaysMs: configured }, 1)
    assert.equal(step.attempt, 1)
    assert.ok(step.delayMs >= 80 && step.delayMs <= 120, `${JSON.stringify(configured)} -> ${step.delayMs} ms`)
  }
  // Above 2^31: the third step is clamped to the 5-minute ceiling (240000..360000 after
  // the jitter) instead of building a timer for decades.
  const steps = await scheduledSteps({ reconnectDelaysMs: [100, 100, 2 ** 31] }, 3)
  assert.deepEqual(steps.slice(0, 3).map((step) => step.attempt), [1, 2, 3])
  assert.ok(steps[2].delayMs >= 240_000 && steps[2].delayMs <= 360_000, `2^31 -> ${steps[2].delayMs} ms`)
})

await check('an empty or invalid reconnectDelaysMs falls back to the default sequence', async () => {
  for (const configured of [[], ['soon', -5, Number.POSITIVE_INFINITY], [0], null]) {
    const [step] = await scheduledSteps({ reconnectDelaysMs: configured }, 1)
    assert.equal(step.attempt, 1)
    assert.ok(step.delayMs >= 800 && step.delayMs <= 1200,
      `${JSON.stringify(configured)} -> ${step.delayMs} ms (the default first step is 1000 ±20%)`)
  }
})

// ------------------------------------------------------- finding 4 (pin mismatch terminal)
await check('a host that now presents another certificate: one failed dial, no retry, a reason on the row, no credential', async () => {
  const remote = await fakeRemote()
  // The relay counts every dial that was actually made. The fake's own
  // `secureConnection` cannot: the client drops the socket as soon as the pin
  // comparison fails, before the server sees the handshake finish.
  const proxy = await delayProxy(remote.port)
  const dataDir = tempDir()
  const id = seedRemote(dataDir, { url: proxy.url, address: proxy.address, certSha256: pinOf(replaced.cert) })
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: [100, 150, 200, 400], reconnectStableMs: 100 })
  try {
    const view = await until(async () => {
      const remoteView = await viewOf(mounted, id)
      return remoteView.linkError === 'pin-mismatch' ? remoteView : null
    }, 'the terminal pin-mismatch reason')
    assert.equal(view.retry, null, 'nothing is scheduled after a terminal failure')
    assert.notEqual(view.status, 'online')
    assert.equal(remote.seen.upgrades, 0, 'the pin is checked before the upgrade')
    assert.deepEqual(remote.seen.auth, [], 'nothing was sent')
    assert.equal(proxy.state.connections, 1, 'exactly one dial')
    // Longer than every configured delay: a retry would have dialled again by now.
    await delay(700)
    assert.equal(proxy.state.connections, 1, 'no further dial after a pin mismatch')
    assert.equal((await viewOf(mounted, id)).linkError, 'pin-mismatch')
    // A human may still ask once; it fails the same way and keeps the same reason.
    const retried = await mounted.call('POST', `/devices/remotes/${id}/connect`)
    assert.equal(retried.status, 502, retried.text)
    assert.equal(retried.json.error, 'pin-mismatch')
    assert.match(retried.json.message, /no credential was sent/)
    assert.equal(proxy.state.connections, 2, 'the manual Reconnect did try once')
    assert.equal(remote.seen.upgrades, 0)
    assert.deepEqual(remote.seen.auth, [])
    assert.equal((await viewOf(mounted, id)).linkError, 'pin-mismatch')
    assert.equal((await viewOf(mounted, id)).retry, null)
  } finally { mounted.close(); proxy.close(); remote.close() }
})

await check('a certificate swapped under a live link turns the next redial terminal instead of looping', async () => {
  const remote = await fakeRemote()
  const dataDir = tempDir()
  const id = seedRemote(dataDir, { url: remote.url, address: `127.0.0.1:${new URL(remote.url).port}`, certSha256: pinOf(served.cert) })
  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: [100, 150, 200, 400], reconnectStableMs: 100 })
  try {
    await until(async () => (await viewOf(mounted, id)).status === 'online', 'the seeded pairing online')
    assert.equal(remote.seen.upgrades, 1)
    assert.equal(remote.seen.auth.length, 1, 'the healthy link did send its credential')
    // The host restarts with another certificate; its live socket goes away with it.
    remote.swapCertificate(replaced)
    remote.drop()
    const view = await until(async () => {
      const remoteView = await viewOf(mounted, id)
      return remoteView.linkError === 'pin-mismatch' ? remoteView : null
    }, 'the redial to stop on the pin mismatch')
    assert.equal(view.retry, null)
    assert.equal(remote.seen.upgrades, 1, 'the mismatching dial never upgraded')
    assert.equal(remote.seen.auth.length, 1, 'and it never sent a credential')
    const dials = remote.seen.connections
    await delay(700) // longer than every configured delay
    assert.equal(remote.seen.connections, dials, 'no redial is scheduled after a pin mismatch')
    assert.equal(mounted.instance.store.get(id)?.certSha256, pinOf(served.cert),
      'the stored pin is never replaced automatically')
  } finally { mounted.close(); remote.close() }
})

finish('reconnect-hardening')
