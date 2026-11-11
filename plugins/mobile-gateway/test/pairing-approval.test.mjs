// Spec 008 P1b — pairing with manual Host approval (OTP offer -> pending -> Approve/Reject).
//
//   P1  wrong OTP x3 burns the code (a later correct proof is refused too)
//   P2  a pending socket cannot call anything and holds no token
//   P3  approve issues the token on the waiting socket; scopes are narrowed
//   P4  reject closes 4403 and issues nothing
//   P5  a pending request times out (injected clock)
//   P6  a client that disconnects removes its pending request
//   P7  two pending requests are independent
//   P8  the verification code matches on both sides (and differs per connection)
//   P9  the admin routes refuse non-loopback and cross-origin callers
//   P10 the long pairing string also goes through pending (requireHostApproval)
//
// The gateway runs in-process over its real TLS listener, like scope-kind.test.mjs.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

import WebSocket from 'ws'
import plugin from '../lib/index.mjs'
import { createPairingRequests, otpProof, verificationCode } from '../lib/pairing-requests.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function factory(t, config = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-008-pairing-'))
  const sockets = []
  let management
  let upgrade
  let dispose = () => {}
  const hostCalls = []
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) { management.handler(req, res); return }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  // fetch-safe: undici refuses a whole class of ports ("bad port"), and the OS is
  // free to hand this listener one; the helper re-binds until `fetch` accepts it.
  await listenFetchSafe(server)
  const port = server.address().port
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke(request) { hostCalls.push(`${request.namespace}/${request.method}`); return { items: [] } },
      async stream(request) {
        hostCalls.push(`${request.namespace}/${request.method}#stream`)
        return (async function* () {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [], projections: {} } }
          while (!request.signal.aborted) await delay(10)
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(fn) { dispose = fn() },
  }
  await plugin.apply(ctx, {
    remoteControl: { enabled: true }, gatewayMode: 'persistent', gatewayWaitTimeoutMs: 60_000,
    gatewayName: `p1b-${port}`, deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true, lanHost: '127.0.0.1', lanPort: 0, ...config,
  })
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    dispose()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    port, base: `http://127.0.0.1:${port}`, hostCalls,
    async post(route, body, headers = {}) {
      const response = await fetch(`${instance.base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: instance.base, ...headers }, body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    async get(route, headers = {}) {
      const response = await fetch(`${instance.base}/mgw/${route}`, { headers })
      return { status: response.status, data: await response.json() }
    },
    track(socket) { sockets.push(socket); return socket },
    /** Call the management handler with a forged remote address (the real one is always loopback here). */
    rawManagement(method, url, { remoteAddress = '127.0.0.1', headers = {}, body } = {}) {
      return new Promise((resolve) => {
        const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
        const req = {
          method, url, headers: { host: `127.0.0.1:${port}`, ...headers }, socket: { remoteAddress },
          on(event, handler) {
            if (event === 'data') queueMicrotask(() => chunks.forEach((chunk) => handler(chunk)))
            if (event === 'end') queueMicrotask(() => queueMicrotask(() => handler()))
            return req
          },
        }
        const res = {
          writeHead(status) { res.status = status },
          end(text) { resolve({ status: res.status, json: text ? JSON.parse(text) : undefined }) },
        }
        management.handler(req, res)
      })
    },
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = (await instance.get('status')).data
    if (status.lan?.listening && status.lan.urls.length > 0) { instance.lanUrl = status.lan.urls[0]; instance.pin = status.lan.certSha256; return instance }
    if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

const OTP_PROTOCOLS = ['dsh-mobile-v1', 'dsh-pair-otp.v1']
let counter = 0
const nonce = () => crypto.randomBytes(18).toString('base64url')

/** Open the OTP pairing socket and collect every frame it receives. */
async function openPairing(instance, { deviceId, name = 'Test laptop', protocols = OTP_PROTOCOLS } = {}) {
  const id = deviceId ?? `p1bdev-${String(++counter).padStart(4, '0')}-aaaa`
  const ws = instance.track(new WebSocket(instance.lanUrl, protocols, {
    headers: { 'X-DSH-Device-ID': id, 'X-DSH-Device-Name': Buffer.from(name).toString('base64') },
    origin: undefined, rejectUnauthorized: false,
  }))
  const frames = []
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)))
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* not json */ } })
  ws.on('error', () => {})
  await once(ws, 'open')
  const take = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = frames.find(predicate)
      if (found) return found
      await delay(5)
    }
    throw new Error(`timed out waiting for a frame (${frames.map((f) => f.kind).join(', ')})`)
  }
  const challenge = await take((frame) => frame.kind === 'pairing-challenge')
  return { ws, frames, take, closed, challenge, deviceId: id }
}

/** Send a proof for `otp` the way the Devices client does. */
function prove(session, otp, instance) {
  const clientNonce = nonce()
  const proof = otpProof(otp, instance.pin, clientNonce, session.challenge.serverNonce)
  session.clientNonce = clientNonce
  session.ws.send(JSON.stringify({ type: 'pairing-proof', clientNonce, otpProof: proof }))
  return clientNonce
}

async function newOtp(instance, body = {}) {
  const created = await instance.post('pair', { mode: 'otp', kind: 'desktop', ...body })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  assert.match(created.data.otp, /^\d{8}$/)
  return created.data
}

async function waitPending(instance, count) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const list = (await instance.get('pending')).data.pending
    if (list.length === count) return list
    await delay(10)
  }
  throw new Error(`expected ${count} pending requests`)
}

test('P0: an OTP offer is 8 digits, 10-minute TTL, and the registry never sees the plaintext', async (t) => {
  const instance = await factory(t)
  const before = Date.now()
  const offer = await newOtp(instance, { scopes: ['sessions:read', 'harness:remote'] })
  assert.deepEqual(offer.pairing.scopes, ['sessions:read', 'harness:remote'])
  assert.ok(offer.pairing.expiresAt - before >= 9.9 * 60_000 && offer.pairing.expiresAt - before <= 10.1 * 60_000, 'TTL is 10 minutes')
  assert.equal(offer.certSha256, instance.pin)
  // The status/devices views never expose the OTP.
  assert.ok(!JSON.stringify((await instance.get('status')).data).includes(offer.otp))
  assert.ok(!JSON.stringify((await instance.get('devices')).data).includes(offer.otp))
  assert.equal((await instance.get('pending')).data.pending.length, 0)
  // Unit: a mobile offer drops harness:remote; bad modes are refused.
  const mobile = await instance.post('pair', { mode: 'otp', kind: 'mobile', scopes: ['sessions:read', 'harness:remote'] })
  assert.deepEqual(mobile.data.pairing.scopes, ['sessions:read'])
  assert.equal((await instance.post('pair', { mode: 'qr' })).status, 400)
})

test('P1: wrong OTP x3 burns the code', async (t) => {
  const instance = await factory(t)
  const offer = await newOtp(instance)
  const wrong = offer.otp === '00000000' ? '11111111' : '00000000'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await openPairing(instance)
    prove(session, wrong, instance)
    assert.equal(await session.closed, 4410, `wrong proof #${attempt + 1} is refused`)
  }
  // The code is burned: the CORRECT proof no longer works.
  const session = await openPairing(instance)
  prove(session, offer.otp, instance)
  assert.equal(await session.closed, 4410, 'a burned code is refused even with the right proof')
  assert.equal((await instance.get('pending')).data.pending.length, 0)
  assert.equal((await instance.get('devices')).data.devices.length, 0)
})

test('P1b: two wrong proofs do not burn the code; the third attempt can still be right', async (t) => {
  const instance = await factory(t)
  const offer = await newOtp(instance)
  const wrong = offer.otp === '00000000' ? '11111111' : '00000000'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await openPairing(instance)
    prove(session, wrong, instance)
    assert.equal(await session.closed, 4410)
  }
  const session = await openPairing(instance)
  prove(session, offer.otp, instance)
  await session.take((frame) => frame.kind === 'pairing-pending')
  assert.equal((await instance.get('pending')).data.pending.length, 1)
  // Single use: the same OTP does not open a second request.
  const again = await openPairing(instance)
  prove(again, offer.otp, instance)
  assert.equal(await again.closed, 4410)
})

test('P2: a pending socket gets no token and cannot call anything', async (t) => {
  const instance = await factory(t)
  const offer = await newOtp(instance)
  const session = await openPairing(instance)
  prove(session, offer.otp, instance)
  const pending = await session.take((frame) => frame.kind === 'pairing-pending')
  assert.match(pending.verificationCode, /^\d{6}$/)
  // Everything the companion protocol offers is refused, including bridge frames.
  const before = instance.hostCalls.length
  for (const type of ['sessions', 'message', 'history', 'subscribe', 'client-hello', 'remote-call', 'device-info', 'ping']) {
    session.ws.send(JSON.stringify({ type, requestId: `x-${type}`, sessionId: 's1', text: 'hi', clientMsgId: 'm-1' }))
  }
  await delay(150)
  assert.equal(instance.hostCalls.length, before, 'nothing reached the Host')
  assert.ok(!session.frames.some((frame) => frame.kind === 'paired' || frame.token || frame.kind === 'hello' || frame.kind === 'sessions'),
    `no token, hello or data on a pending socket: ${JSON.stringify(session.frames.map((f) => f.kind))}`)
  assert.ok(session.frames.filter((frame) => frame.kind === 'error').length >= 1, 'refusals are explicit')
  assert.equal((await instance.get('devices')).data.devices.length, 0, 'no device exists yet')
})

test('P3: approve issues the token on the waiting socket and narrows the scopes', async (t) => {
  const instance = await factory(t)
  const offer = await newOtp(instance, { scopes: ['sessions:read', 'prompt:send', 'approval:respond', 'harness:remote'] })
  const session = await openPairing(instance, { name: 'Anh laptop' })
  prove(session, offer.otp, instance)
  await session.take((frame) => frame.kind === 'pairing-pending')
  const [request] = await waitPending(instance, 1)
  assert.equal(request.name, 'Anh laptop')
  assert.equal(request.kind, 'desktop')
  assert.equal(request.clientIp, '127.0.0.1')
  assert.deepEqual(request.requestedScopes, ['sessions:read', 'prompt:send', 'approval:respond', 'harness:remote'])
  assert.match(request.verificationCode, /^\d{6}$/)
  // Widening beyond the offer is refused and keeps the request pending.
  const widen = await instance.post(`pending/${request.id}/approve`, { scopes: ['sessions:read', 'files:write'] })
  assert.equal(widen.status, 400)
  assert.equal((await instance.get('pending')).data.pending.length, 1)

  const approved = await instance.post(`pending/${request.id}/approve`, { scopes: ['sessions:read', 'harness:remote'] })
  assert.equal(approved.status, 200, JSON.stringify(approved.data))
  assert.deepEqual(approved.data.device.scopes, ['sessions:read', 'harness:remote'])
  const paired = await session.take((frame) => frame.kind === 'paired')
  assert.match(paired.token, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(paired.device.scopes, ['sessions:read', 'harness:remote'])
  await session.take((frame) => frame.kind === 'hello')
  assert.equal((await instance.get('pending')).data.pending.length, 0)
  // The registered device holds the narrowed grant, and the token works.
  const [device] = (await instance.get('devices')).data.devices
  assert.deepEqual(device.scopes, ['sessions:read', 'harness:remote'])
  const second = instance.track(new WebSocket(instance.lanUrl, ['dsh-mobile-v1'], {
    headers: { Authorization: `Bearer ${paired.token}`, 'X-DSH-Device-ID': session.deviceId }, origin: undefined, rejectUnauthorized: false }))
  const helloFrames = []
  second.on('message', (data) => helloFrames.push(JSON.parse(data.toString())))
  await once(second, 'open')
  for (let attempt = 0; attempt < 100 && !helloFrames.some((f) => f.kind === 'hello'); attempt += 1) await delay(10)
  assert.ok(helloFrames.some((frame) => frame.kind === 'hello'), 'the issued token authenticates')
  // Approving twice is a 404, never a second token.
  assert.equal((await instance.post(`pending/${request.id}/approve`, {})).status, 404)
})

test('P4: reject closes the waiting socket with 4403 and issues nothing', async (t) => {
  const instance = await factory(t)
  const offer = await newOtp(instance)
  const session = await openPairing(instance)
  prove(session, offer.otp, instance)
  await session.take((frame) => frame.kind === 'pairing-pending')
  const [request] = await waitPending(instance, 1)
  const rejected = await instance.post(`pending/${request.id}/reject`, {})
  assert.equal(rejected.status, 200)
  assert.equal(await session.closed, 4403)
  assert.ok(!session.frames.some((frame) => frame.kind === 'paired' || frame.token))
  assert.equal((await instance.get('devices')).data.devices.length, 0)
  assert.equal((await instance.get('pending')).data.pending.length, 0)
  assert.equal((await instance.post(`pending/${request.id}/reject`, {})).status, 404)
})

test('P5: a pending request expires after its timeout and the client is closed', async (t) => {
  // Unit level with an injected clock: the 5-minute rule of the state machine.
  let now = 1_000_000
  const expired = []
  const requests = createPairingRequests({ now: () => now, onExpire: (request) => expired.push(request.id) })
  const { otp } = requests.createOffer({ kind: 'desktop', scopes: ['sessions:read'] })
  const proof = otpProof(otp, 'a'.repeat(64), 'c'.repeat(20), 's'.repeat(20))
  const checked = requests.verifyProof({ proof, certSha256: 'a'.repeat(64), clientNonce: 'c'.repeat(20), serverNonce: 's'.repeat(20) })
  assert.equal(checked.ok, true)
  const request = requests.addPending({ offer: checked.offer, name: 'n', clientIp: '10.0.0.2', certSha256: 'a'.repeat(64), clientNonce: 'c'.repeat(20), serverNonce: 's'.repeat(20) })
  assert.equal(requests.pendingCount(), 1)
  now += 5 * 60_000 - 1
  assert.equal(requests.pendingCount(), 1, 'still pending just before the timeout')
  now += 2
  assert.equal(requests.pendingCount(), 0, 'gone after 5 minutes')
  assert.deepEqual(expired, [request.id], 'the owner of the socket is told so it can close it')
  // The OTP offer itself dies at 10 minutes.
  const second = requests.createOffer({ kind: 'desktop', scopes: [] })
  assert.equal(requests.offerCount(), 1)
  now += 10 * 60_000 + 1
  assert.equal(requests.offerCount(), 0)
  void second

  // Integration: the live gateway ends the waiting socket when the table prunes it.
  const instance = await factory(t, { testPendingTtlMs: 400 })
  const offer = await newOtp(instance)
  const session = await openPairing(instance)
  prove(session, offer.otp, instance)
  await session.take((frame) => frame.kind === 'pairing-pending')
  assert.equal((await waitPending(instance, 1)).length, 1)
  await delay(500)
  // Reading the list prunes; the waiting socket is told and closed, no token.
  assert.equal((await instance.get('pending')).data.pending.length, 0)
  assert.equal(await session.closed, 4410)
  assert.ok(session.frames.some((frame) => frame.kind === 'pairing-rejected' && frame.reason === 'pairing/expired'))
  assert.ok(!session.frames.some((frame) => frame.kind === 'paired'))
  assert.equal((await instance.get('devices')).data.devices.length, 0)
})

test('P6: a client that disconnects removes its pending request', async (t) => {
  const instance = await factory(t)
  const offer = await newOtp(instance)
  const session = await openPairing(instance)
  prove(session, offer.otp, instance)
  await session.take((frame) => frame.kind === 'pairing-pending')
  await waitPending(instance, 1)
  session.ws.terminate()
  await session.closed
  await waitPending(instance, 0)
  assert.equal((await instance.get('devices')).data.devices.length, 0)
})

test('P7: two pending requests are independent', async (t) => {
  const instance = await factory(t)
  const otpA = await newOtp(instance, { scopes: ['sessions:read'] })
  const otpB = await newOtp(instance, { scopes: ['sessions:read', 'prompt:send'] })
  const a = await openPairing(instance, { name: 'Laptop A' })
  const b = await openPairing(instance, { name: 'Laptop B' })
  prove(a, otpA.otp, instance)
  prove(b, otpB.otp, instance)
  await a.take((frame) => frame.kind === 'pairing-pending')
  await b.take((frame) => frame.kind === 'pairing-pending')
  const list = await waitPending(instance, 2)
  const byName = Object.fromEntries(list.map((request) => [request.name, request]))
  assert.deepEqual(byName['Laptop A'].requestedScopes, ['sessions:read'])
  assert.deepEqual(byName['Laptop B'].requestedScopes, ['sessions:read', 'prompt:send'])
  assert.notEqual(byName['Laptop A'].verificationCode + byName['Laptop A'].id, byName['Laptop B'].verificationCode + byName['Laptop B'].id)

  // Reject A: B is untouched and can still be approved.
  assert.equal((await instance.post(`pending/${byName['Laptop A'].id}/reject`, {})).status, 200)
  assert.equal(await a.closed, 4403)
  assert.equal((await instance.get('pending')).data.pending.length, 1)
  assert.equal(b.ws.readyState, 1, 'B is still waiting')
  assert.equal((await instance.post(`pending/${byName['Laptop B'].id}/approve`, {})).status, 200)
  const paired = await b.take((frame) => frame.kind === 'paired')
  assert.ok(paired.token)
  assert.deepEqual(paired.device.scopes, ['sessions:read', 'prompt:send'])
  assert.equal((await instance.get('devices')).data.devices.length, 1)
})

test('P8: the verification code is the same on both sides', async (t) => {
  const instance = await factory(t)
  const offer = await newOtp(instance)
  const session = await openPairing(instance)
  const clientNonce = prove(session, offer.otp, instance)
  const pending = await session.take((frame) => frame.kind === 'pairing-pending')
  // What the client computes from what it saw on its own side.
  const clientSide = verificationCode(instance.pin, clientNonce, session.challenge.serverNonce)
  assert.equal(pending.verificationCode, clientSide)
  const [request] = await waitPending(instance, 1)
  assert.equal(request.verificationCode, clientSide, 'the Host UI shows the same code')
  // Spec formula, spelled out: SHA-256(cert || clientNonce || serverNonce || 'dsh-verify') mod 10^6.
  const digest = crypto.createHash('sha256').update(instance.pin).update(clientNonce).update(session.challenge.serverNonce).update('dsh-verify').digest()
  assert.equal(clientSide, String(BigInt(`0x${digest.toString('hex')}`) % 1_000_000n).padStart(6, '0'))
  // A different pin (an interposed certificate) gives a different code.
  assert.notEqual(verificationCode('f'.repeat(64), clientNonce, session.challenge.serverNonce), clientSide)
})

test('P9: the admin routes refuse non-loopback and cross-origin callers', async (t) => {
  const instance = await factory(t)
  const offer = await newOtp(instance)
  const session = await openPairing(instance)
  prove(session, offer.otp, instance)
  await session.take((frame) => frame.kind === 'pairing-pending')
  const [request] = await waitPending(instance, 1)

  for (const [method, url] of [['GET', '/mgw/pending'], ['POST', `/mgw/pending/${request.id}/approve`], ['POST', `/mgw/pending/${request.id}/reject`]]) {
    const remote = await instance.rawManagement(method, url, { remoteAddress: '192.168.1.50', body: {} })
    assert.equal(remote.status, 403, `${method} ${url} from a LAN address`)
    const foreign = await instance.rawManagement(method, url, { headers: { origin: 'https://evil.example' }, body: {} })
    assert.equal(foreign.status, 403, `${method} ${url} with a foreign Origin`)
  }
  // OTP creation is refused the same way.
  assert.equal((await instance.rawManagement('POST', '/mgw/pair', { remoteAddress: '10.0.0.9', body: { mode: 'otp' } })).status, 403)
  assert.equal((await instance.rawManagement('POST', '/mgw/pair', { headers: { origin: 'https://evil.example' }, body: { mode: 'otp' } })).status, 403)
  // The request survived every refused attempt, and nobody was paired.
  assert.equal((await instance.get('pending')).data.pending.length, 1)
  assert.equal(session.ws.readyState, 1)
  assert.equal((await instance.get('devices')).data.devices.length, 0)
})

test('P10: the long pairing string goes through pending too (requireHostApproval)', async (t) => {
  const instance = await factory(t)
  const created = await instance.post('pair', { kind: 'desktop', publicUrl: instance.lanUrl })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const deviceId = 'longstr-0000-4000-8000-000000000001'
  const ws = instance.track(new WebSocket(instance.lanUrl, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], {
    headers: { 'X-DSH-Device-ID': deviceId }, origin: undefined, rejectUnauthorized: false }))
  const frames = []
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())))
  ws.on('error', () => {})
  await once(ws, 'open')
  for (let attempt = 0; attempt < 200 && !frames.some((f) => f.kind === 'pairing-challenge'); attempt += 1) await delay(10)
  const challenge = frames.find((frame) => frame.kind === 'pairing-challenge')
  assert.ok(challenge && challenge.otpRequired === false)
  const clientNonce = nonce()
  ws.send(JSON.stringify({ type: 'pairing-proof', clientNonce }))
  for (let attempt = 0; attempt < 200 && !frames.some((f) => f.kind === 'pairing-pending'); attempt += 1) await delay(10)
  assert.ok(frames.some((frame) => frame.kind === 'pairing-pending'), 'no token before approval')
  assert.ok(!frames.some((frame) => frame.kind === 'paired'))
  const [request] = await waitPending(instance, 1)
  assert.equal((await instance.post(`pending/${request.id}/approve`, {})).status, 200)
  for (let attempt = 0; attempt < 200 && !frames.some((f) => f.kind === 'paired'); attempt += 1) await delay(10)
  assert.ok(frames.some((frame) => frame.kind === 'paired' && frame.token))
  // The spent string cannot be redeemed again.
  const replay = instance.track(new WebSocket(instance.lanUrl, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], {
    headers: { 'X-DSH-Device-ID': 'longstr-0000-4000-8000-000000000002' }, origin: undefined, rejectUnauthorized: false }))
  replay.on('error', () => {})
  const status = await new Promise((resolve) => {
    replay.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode) })
    replay.once('open', () => resolve('open'))
  })
  assert.equal(status, 401)
})

test('P10b: requireHostApproval=false keeps the direct claim of the long pairing string', async (t) => {
  const instance = await factory(t, { requireHostApproval: false })
  const created = await instance.post('pair', { kind: 'desktop', publicUrl: instance.lanUrl })
  const ws = instance.track(new WebSocket(instance.lanUrl, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], {
    headers: { 'X-DSH-Device-ID': 'direct-0000-4000-8000-000000000001', 'X-DSH-Cert-SHA256': instance.pin }, origin: undefined, rejectUnauthorized: false }))
  const frames = []
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())))
  ws.on('error', () => {})
  await once(ws, 'open')
  for (let attempt = 0; attempt < 200 && !frames.some((f) => f.kind === 'paired'); attempt += 1) await delay(10)
  assert.ok(frames.some((frame) => frame.kind === 'paired' && frame.token), 'direct claim, no pending request')
})

// -- Review finding 1: approve reads+validates the body FIRST, then atomically takes the still-live request --

/** POST /mgw/pending/:id/approve whose body is held open: `finish()` completes it, the result is `done`. */
function stalledApprove(instance, id, body = {}) {
  const payload = JSON.stringify(body)
  const url = new URL(`${instance.base}/mgw/pending/${id}/approve`)
  let finish
  const done = new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: instance.base, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, data: text ? JSON.parse(text) : undefined }))
    })
    req.on('error', reject)
    req.write(payload.slice(0, 1)) // headers + the first byte are out; the rest is withheld
    finish = () => req.end(payload.slice(1))
  })
  return { finish: () => finish(), done }
}

async function pendingRequest(instance, scopes = ['sessions:read', 'prompt:send']) {
  const offer = await newOtp(instance, { scopes })
  const session = await openPairing(instance)
  prove(session, offer.otp, instance)
  await session.take((frame) => frame.kind === 'pairing-pending')
  const [request] = await waitPending(instance, 1)
  return { session, request }
}

test('P11: a stalled approve body that outlives the pending timeout issues no token and leaves nothing behind', async (t) => {
  const instance = await factory(t, { testPendingTtlMs: 300 })
  const { session, request } = await pendingRequest(instance)
  const stalled = stalledApprove(instance, request.id)
  await delay(450) // the request expires while the body is still being read
  stalled.finish()
  assert.equal((await stalled.done).status, 404)
  assert.equal(await session.closed, 4410)
  assert.ok(!session.frames.some((frame) => frame.kind === 'paired' || frame.token), 'no token for an expired request')
  assert.equal((await instance.get('devices')).data.devices.length, 0)
  assert.equal((await instance.get('pending')).data.pending.length, 0)
})

test('P12: a stalled approve body, then the client disconnects: 404, no device, no leftover', async (t) => {
  const instance = await factory(t)
  const { session, request } = await pendingRequest(instance)
  const stalled = stalledApprove(instance, request.id)
  await delay(50)
  session.ws.terminate()
  await session.closed
  await waitPending(instance, 0)
  stalled.finish()
  assert.equal((await stalled.done).status, 404)
  assert.equal((await instance.get('devices')).data.devices.length, 0)
  assert.equal((await instance.get('pending')).data.pending.length, 0)
})

test('P13: a stalled approve body, then reject wins: 4403, the late approve gets 404 and no token', async (t) => {
  const instance = await factory(t)
  const { session, request } = await pendingRequest(instance)
  const stalled = stalledApprove(instance, request.id)
  await delay(50)
  assert.equal((await instance.post(`pending/${request.id}/reject`, {})).status, 200)
  assert.equal(await session.closed, 4403)
  stalled.finish()
  assert.equal((await stalled.done).status, 404)
  assert.ok(!session.frames.some((frame) => frame.kind === 'paired' || frame.token))
  assert.equal((await instance.get('devices')).data.devices.length, 0)
})

test('P14: a bad body is refused BEFORE the request is taken: the request stays pending and can still be approved', async (t) => {
  const instance = await factory(t)
  const { session, request } = await pendingRequest(instance, ['sessions:read', 'prompt:send'])
  const stalled = stalledApprove(instance, request.id, { scopes: ['sessions:read', 'files:write'] })
  await delay(30)
  stalled.finish()
  assert.equal((await stalled.done).status, 400)
  assert.equal((await instance.get('pending')).data.pending.length, 1, 'a refused body does not consume the request')
  assert.equal(session.ws.readyState, 1)
  assert.equal((await instance.post(`pending/${request.id}/approve`, {})).status, 200)
  assert.ok((await session.take((frame) => frame.kind === 'paired')).token)
})

test('P15: two concurrent approvals of one request produce exactly one token and one device', async (t) => {
  const instance = await factory(t)
  const { session, request } = await pendingRequest(instance)
  const a = stalledApprove(instance, request.id)
  const b = stalledApprove(instance, request.id)
  await delay(50)
  a.finish(); b.finish()
  const results = await Promise.all([a.done, b.done])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 404], JSON.stringify(results))
  await session.take((frame) => frame.kind === 'paired')
  await delay(100)
  assert.equal(session.frames.filter((frame) => frame.kind === 'paired').length, 1, 'exactly one token frame')
  assert.equal((await instance.get('devices')).data.devices.length, 1, 'exactly one device')
  assert.equal((await instance.get('pending')).data.pending.length, 0)
})
