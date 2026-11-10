// Authentication and pairing, adapted to contract revision 2 (US2/US3).
//
// Kept from upstream: the hashed device registry, single-use pairing codes,
// device listing/renaming/revocation, the browser subprotocol transport and the
// gateway switch. Changed by the contract:
//  - authentication is permanent (T023): `/mgw/auth` is gone and a stale
//    `requireAuth: false` has no effect;
//  - the QR payload is v3 with `certSha256` and `wss://` only (T018/T019);
//  - pairing is claimed on the plugin TLS listener, never through the query
//    (T020);
//  - `hello.capabilities` is exactly the package CAPABILITIES (contract §3.5);
//  - a device token may use only the `companion-v1` operations (T022), so the
//    speech, file-upload and plugin-management flows of the upstream suite are
//    now asserted as refusals (their admin-channel coverage lives in
//    `test/gateway.test.mjs`);
//  - the public URL is the owner-set `publicUrl` only, and the public-setup
//    helper route is gone (T031): both verbs are 404, only the cross-origin gate
//    still answers (403) in front of routing.
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const WebSocket = require('ws')
const crypto = require('node:crypto')
const plugin = (await import('../lib/index.mjs')).default
const { createRegistry } = await import('../lib/devices.js')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function waitForMessage(ws, kind) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${kind}`)), 4_000)
    const onMessage = (data) => {
      const frame = JSON.parse(data.toString())
      if (frame.kind !== kind) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(frame)
    }
    ws.on('message', onMessage)
  })
}

/** A WebSocket whose TLS layer accepts the test certificate (the pin is tested in tls-pin.test.mjs). */
function open(url, protocols, headers) {
  return new WebSocket(url, protocols, { rejectUnauthorized: false, headers })
}

/** Contract §3.6/§5a: the client is ready only after the acknowledged client-hello. */
async function negotiate(socket) {
  const requestId = `hello-${crypto.randomBytes(4).toString('hex')}`
  const ack = waitForMessage(socket, 'client-hello')
  socket.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: '1.0.0', platform: 'ios' }))
  const frame = await ack
  assert.equal(frame.requestId, requestId)
  assert.equal(frame.accepted, true)
}

/** Resolve the upgrade outcome: an HTTP status, 'open', or the TLS error code. */
function upgradeOutcome(url, protocols, headers) {
  return new Promise((resolve) => {
    const ws = open(url, protocols, headers)
    const timer = setTimeout(() => { ws.terminate(); resolve('timeout') }, 5_000)
    ws.once('open', () => { ws.terminate(); clearTimeout(timer); resolve('open') })
    ws.once('unexpected-response', (_request, response) => { response.resume(); clearTimeout(timer); resolve(response.statusCode) })
    ws.once('error', (error) => { clearTimeout(timer); resolve(`error:${error?.code ?? error?.message}`) })
  })
}

;(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-auth-'))
  const registryFile = path.join(temp, 'devices.json')
  // T031: an owner-set endpoint is the only public URL left; the `publicUrlFile`
  // fallback (written by the disabled setup-ip helper) is gone.
  const configuredPublicUrl = 'wss://203.0.113.10/ws/mobile'

  // Registry contract: pairing is single-use and neither the pairing code nor
  // the long-lived token is persisted; an offer pins the endpoint and the
  // certificate it was issued for (T019).
  const registry = createRegistry(registryFile, { pairingTtlMs: 60_000 })
  const pinnedOffer = registry.createPairing('Pinned offer', { endpoint: 'wss://192.0.2.10:3081/ws/mobile', certSha256: 'a'.repeat(64) })
  assert.equal(pinnedOffer.certSha256, 'a'.repeat(64))
  assert.equal(pinnedOffer.endpoint, 'wss://192.0.2.10:3081/ws/mobile')
  assert.equal(registry.claimPairing(pinnedOffer.code, 'ffff0000-0000-4000-8000-000000000001', 'Other cert',
    { certSha256: 'b'.repeat(64) }), undefined, 'a code cannot be redeemed over another certificate')
  assert.equal(registry.hasPairing(pinnedOffer.code), false, 'a mismatched claim still consumes the single-use code')
  const pinnedClaim = registry.claimPairing(registry.createPairing('Pinned', { certSha256: 'c'.repeat(64) }).code,
    'ffff0000-0000-4000-8000-000000000002', 'Matching cert', { certSha256: 'c'.repeat(64) })
  assert.ok(pinnedClaim, 'the matching certificate redeems the offer')
  registry.revoke(pinnedClaim.device.id)

  const pairing = registry.createPairing('Test iPhone')
  assert.equal(registry.hasPairing(pairing.code), true)
  const clientDeviceId = '8f22f2b1-b4c0-42bd-bd91-b145f8b375a4'
  let claimed = registry.claimPairing(pairing.code)
  assert.ok(claimed)
  assert.equal(registry.claimPairing(pairing.code), undefined)
  assert.equal(registry.authenticate(claimed.token, clientDeviceId).id, claimed.device.id)
  const firstDeviceId = claimed.device.id
  const firstToken = claimed.token
  const secondPairing = registry.createPairing('Renamed Test iPhone')
  claimed = registry.claimPairing(secondPairing.code, clientDeviceId, 'Renamed Test iPhone')
  assert.equal(claimed.device.id, firstDeviceId)
  assert.equal(registry.list().length, 1)
  assert.equal(registry.list()[0].name, 'Renamed Test iPhone')
  assert.equal(registry.authenticate(firstToken), undefined)
  assert.equal(registry.authenticate(claimed.token).id, firstDeviceId)
  const stored = fs.readFileSync(registryFile, 'utf8')
  assert.equal(stored.includes(pairing.code), false)
  assert.equal(stored.includes(claimed.token), false)
  if (process.platform === 'win32') {
    // NTFS ignores POSIX modes; the ACL written by lib/secure-file.mjs is the
    // owner-only guarantee (same assertion as the other suites).
    const { execFileSync } = require('node:child_process')
    const acl = execFileSync('icacls', [registryFile], { encoding: 'utf8' })
    const grants = acl.split(/\r?\n/)
      .filter((line) => line.includes(registryFile) && line.includes(':'))
      .flatMap((line) => line.split(registryFile).at(-1).trim().split(/\s(?=[^)]*$)/))
      .filter(Boolean)
    assert.equal(acl.includes('(I)'), false, `inherited ACL entries remain: ${acl}`)
    assert.equal(grants.length, 1, `expected one explicit grant: ${acl}`)
    assert.match(grants[0], new RegExp(`\\\\(?:.+\\\\)?${os.userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\(F\\)$`, 'i'), acl)
  } else {
    assert.equal(fs.statSync(registryFile).mode & 0o777, 0o600)
  }
  registry.connected(claimed.device.id)
  assert.equal(registry.list()[0].online, true)
  registry.disconnected(claimed.device.id)
  assert.equal(registry.list()[0].online, false)
  assert.equal(registry.get(claimed.device.id).id, claimed.device.id)
  assert.equal(registry.revoke(claimed.device.id), true)
  assert.equal(registry.authenticate(claimed.token), undefined)
  assert.equal(registry.get(claimed.device.id), undefined, 'a revoked device is gone from the registry')

  const firstNamed = registry.claimPairing(registry.createPairing('Ignored desktop name').code, 'named-device-001', '我的手机')
  const secondNamed = registry.claimPairing(registry.createPairing().code, 'named-device-002', '我的手机')
  assert.deepEqual(registry.list().map((device) => device.displayName), ['我的手机 (1)', '我的手机 (2)'])
  assert.equal(registry.list()[0].name, '我的手机')
  registry.authenticate(firstNamed.token, 'named-device-001', '新名称')
  assert.deepEqual(registry.list().map((device) => device.displayName), ['新名称', '我的手机'])
  registry.revoke(firstNamed.device.id)
  registry.revoke(secondNamed.device.id)
  const unnamed = registry.claimPairing(registry.createPairing('Ignored desktop name').code, 'unnamed-device-001')
  assert.equal(unnamed.device.name, '未命名设备')
  registry.revoke(unnamed.device.id)

  let managementRoute
  let upgradeRoute
  let disposePlugin
  const prompts = []
  const events = {}
  const server = http.createServer((req, res) => {
    if (managementRoute && (req.url === managementRoute.path || req.url.startsWith(`${managementRoute.path}/`))) {
      managementRoute.handler(req, res)
      return
    }
    res.writeHead(404).end()
  })
  const webServer = {
    port: 0,
    register(route) { managementRoute = route; return () => { managementRoute = undefined } },
    registerUpgrade(route) { upgradeRoute = route; return () => { upgradeRoute = undefined } },
  }
  server.on('upgrade', (req, socket, head) => {
    if (upgradeRoute) upgradeRoute.handler(req, socket, head)
    else socket.destroy()
  })
  const ctx = {
    webServer,
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke(request) {
        if (request.namespace === 'session' && request.method === 'list') return { items: [{ sessionId: 's1' }, { sessionId: 's2' }] }
        if (request.namespace === 'session' && request.method === 'prompt') {
          const prompt = request.args.request
          prompts.push(prompt)
          events['session/event']({ id: prompt.sessionId }, { type: 'user/message', seq: 1, time: 1,
            data: { content: prompt.content, source: { kind: 'user' } } })
          return { accepted: true }
        }
        throw new Error('unexpected Remote invocation')
      },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'workspace' && request.method === 'follow') {
            yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
            while (!request.signal.aborted) await delay(5)
          }
          if (request.namespace === 'session' && request.method === 'control') {
            yield { type: 'baseline', value: { projections: {} } }
            while (!request.signal.aborted) await delay(5)
          }
        })()
      },
    },
    agentDefaultModel: {},
    on(name, listener) { events[name] = listener; return () => {} },
    effect(factory) { disposePlugin = factory() },
  }
  ctx.connection.createSharedFetchHandler = channel => {
    assert.equal(channel, '/api')
    return {
      requestBodyMode: () => 'streaming',
      async fetch(request) {
        const bytes = Buffer.from(await request.arrayBuffer())
        return Response.json({ ok: true, value: { receiptId: crypto.randomUUID(), file: { bytes: bytes.length } } })
      },
    }
  }
  await plugin.apply(ctx, {
    // T011: the owner switch must be on for the management UI to be able to
    // start the gateway (remoteControl.enabled gates every transition to on).
    remoteControl: { enabled: true },
    gatewayEnabled: false,
    gatewayWaitTimeoutMs: 1_000,
    adminLoopbackOnly: true,
    pairingTtlMs: 60_000,
    deviceFile: path.join(temp, 'integration-devices.json'),
    publicUrl: configuredPublicUrl,
    // T016/T017: the plugin-owned TLS listener pairs every v3 offer.
    lanEnabled: true,
    requireHostApproval: false, // spec 008 P1b: these tests exercise the direct claim path; pairing-approval.test.mjs covers the default
    lanHost: '127.0.0.1',
    lanPort: 0,
    tlsCertificateDir: path.join(temp, 'tls'),
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  webServer.port = server.address().port
  const base = `http://127.0.0.1:${webServer.port}`
  const wsUrl = `ws://127.0.0.1:${webServer.port}/ws/mobile`
  async function lanStatus() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await (await fetch(`${base}/mgw/status`)).json()
      if (current.lan === undefined) {
        // The gateway is restarting: the TLS listener starts with it.
        await delay(20)
        continue
      }
      if (current.lan.listening && current.lan.urls.length > 0) return current
      if (current.lan.error) throw new Error(`TLS listener failed: ${current.lan.error}`)
      await delay(20)
    }
    throw new Error('TLS listener did not become ready')
  }

  const initialStatus = await (await fetch(`${base}/mgw/status`)).json()
  assert.equal(initialStatus.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  assert.equal(initialStatus.publicUrl, configuredPublicUrl, 'the owner-set publicUrl is the reported endpoint')
  assert.equal(initialStatus.webPort, webServer.port)
  assert.equal(initialStatus.requireAuth, true, 'authentication is always on (T023)')
  assert.equal(initialStatus.queryTokenAllowed, false, 'no credential is accepted in a URL query')
  assert.match(initialStatus.tls.fingerprint256, /^[a-f0-9]{64}$/)
  // FR-011/R9 (T031): the public-setup helper surface is gone from the gateway —
  // no route, no Unix-socket client, no helper status. Nothing answers but the
  // generic not-found, and no config key remains to point one at a helper.
  const publicSetupGet = await fetch(`${base}/mgw/public-setup`)
  assert.equal(publicSetupGet.status, 404, 'GET /mgw/public-setup is gone')
  assert.equal((await publicSetupGet.json()).error, 'not-found')
  const publicSetupPost = await fetch(`${base}/mgw/public-setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ publicIp: '8.8.8.8' }),
  })
  assert.equal(publicSetupPost.status, 404, 'POST /mgw/public-setup is gone')
  await publicSetupPost.arrayBuffer()
  // Same-origin is required before routing, so this stays 403 — evidence that the
  // removal did not also remove the management gate.
  const blockedPublicSetup = await fetch(`${base}/mgw/public-setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ publicIp: '8.8.8.8' }),
  })
  assert.equal(blockedPublicSetup.status, 403)
  await blockedPublicSetup.arrayBuffer()
  // No tunnel/setup config surface survives either.
  for (const removedKey of ['publicUrlFile', 'cloudflaredPath', 'cloudflarePort', 'cloudflareStateFile']) {
    assert.equal(plugin.Config({})[removedKey], undefined, `${removedKey} is no longer a gateway setting`)
  }
  assert.equal(initialStatus.cloudflare.state, 'disabled', 'the tunnel status stays the disabled shape')
  assert.equal(initialStatus.cloudflare.hardDisabled, true)

  assert.equal(await upgradeOutcome(wsUrl), 503)

  const enableGatewayResponse = await fetch(`${base}/mgw/gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(enableGatewayResponse.status, 200)
  const enableGatewayBody = await enableGatewayResponse.json()
  assert.equal(enableGatewayBody.gatewayEnabled, true)
  assert.equal(typeof enableGatewayBody.waitExpiresAt, 'number')
  assert.equal(await upgradeOutcome(wsUrl), 401)
  const status = await lanStatus()
  const tlsUrl = status.lan.urls[0]
  assert.ok(tlsUrl.startsWith('wss://'), `every endpoint is wss:// (FR-003), got ${tlsUrl}`)

  await delay(1_100)
  const timedOutStatus = await (await fetch(`${base}/mgw/status`)).json()
  assert.equal(timedOutStatus.gatewayEnabled, false)
  assert.equal(await upgradeOutcome(wsUrl), 503)
  const reopenResponse = await fetch(`${base}/mgw/gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(reopenResponse.status, 200)

  // T023 (FR-007): no route disables authentication and a stale
  // `requireAuth: false` has no effect — an unauthenticated socket is refused.
  const removeAuth = await fetch(`${base}/mgw/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ enabled: false }),
  })
  assert.equal(removeAuth.status, 404, 'POST /mgw/auth is gone')
  await removeAuth.arrayBuffer()
  assert.equal(plugin.Config({}).requireAuth, true, 'the schema declares authentication on by default')
  const legacySchema = plugin.Config({ requireAuth: false })
  assert.equal(legacySchema.requireAuth, false, 'a legacy config keeps loading')
  assert.equal(await upgradeOutcome(wsUrl), 401, 'a legacy requireAuth:false opens no unauthenticated socket')

  const crossOrigin = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ name: 'Blocked', publicUrl: tlsUrl }),
  })
  assert.equal(crossOrigin.status, 403)

  // FR-003: there is no plaintext remote endpoint any more.
  const insecurePublic = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Blocked', publicUrl: 'ws://gateway.example.com/ws/mobile' }),
  })
  assert.equal(insecurePublic.status, 400)
  await insecurePublic.arrayBuffer()

  const pairResponse = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Integration iPhone', publicUrl: tlsUrl }),
  })
  assert.equal(pairResponse.status, 201)
  const pairBody = await pairResponse.json()
  assert.equal(pairBody.payload.version, 3, 'QR payload version 3 (contract §2)')
  assert.equal(pairBody.payload.publicUrl, tlsUrl)
  assert.equal(pairBody.payload.certSha256, status.lan.certSha256, 'the QR carries the pinned fingerprint')
  assert.match(pairBody.payload.certSha256, /^[a-f0-9]{64}$/)
  assert.ok(pairBody.payload.endpoints.every((endpoint) => endpoint.startsWith('wss://')))
  assert.ok(pairBody.payload.expiresAt - Date.now() <= 5 * 60 * 1000)
  assert.equal(typeof pairBody.payload.pairingCode, 'string')
  assert.match(pairBody.qrPayload, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(
    JSON.parse(Buffer.from(pairBody.qrPayload, 'base64url').toString('utf8')),
    pairBody.payload,
  )
  assert.equal('token' in pairBody, false)
  const pairingProtocols = ['dsh-mobile-v1', `dsh-pair.${pairBody.payload.pairingCode}`]

  // Without a stable device id the pairing upgrade is refused and the single-use
  // code survives the rejection. The offer is bound to the certificate the QR
  // pins, so it can never be redeemed on the plaintext DSH loopback route
  // (asserted in test/tls-pin.test.mjs).

  // Contract §3.1-§3.2: pin first, then present the code on the TLS listener.
  const pairedSocket = open(tlsUrl, pairingProtocols, { 'X-DSH-Device-ID': clientDeviceId })
  const pairedPromise = waitForMessage(pairedSocket, 'paired')
  const helloPromise = waitForMessage(pairedSocket, 'hello')
  await once(pairedSocket, 'open')
  const pairedFrame = await pairedPromise
  const hello = await helloPromise
  assert.equal(pairedSocket.protocol, 'dsh-mobile-v1')
  assert.equal(hello.authenticated, true)
  assert.equal(hello.protocol, 3)
  // Contract §3.5: exactly the package CAPABILITIES, never the upstream list.
  assert.deepEqual(hello.capabilities, ['sessions-read', 'prompt', 'cancel', 'approval-v1'])
  assert.equal(hello.companionProtocol, 1)
  assert.equal(hello.minClientVersion, 1)
  assert.equal(hello.certSha256, pairBody.payload.certSha256)
  assert.equal(hello.gatewayId, pairBody.payload.gatewayId)
  const connectedStatus = await (await fetch(`${base}/mgw/status`)).json()
  assert.equal(connectedStatus.gatewayEnabled, true)
  assert.equal(connectedStatus.waitExpiresAt, null)
  assert.equal(typeof pairedFrame.token, 'string')

  // A used code is single-use; a credential in the query is never accepted.
  assert.equal(await upgradeOutcome(tlsUrl, pairingProtocols, { 'X-DSH-Device-ID': clientDeviceId }), 401)
  assert.equal(await upgradeOutcome(`${wsUrl}?pairingCode=${encodeURIComponent(pairBody.payload.pairingCode)}`,
    ['dsh-mobile-v1'], { 'X-DSH-Device-ID': clientDeviceId }), 401)
  assert.equal(await upgradeOutcome(`${wsUrl}?token=${encodeURIComponent(pairedFrame.token)}`, ['dsh-mobile-v1'], {}), 401)

  // (A) The plaintext DSH loopback route has no certificate of its own, so a
  // device credential presented there is refused outright instead of being
  // authenticated without the pin.
  assert.equal(await upgradeOutcome(wsUrl, ['dsh-mobile-v1'], { Authorization: `Bearer ${pairedFrame.token}` }), 401,
    'a device token is refused on the plaintext route')

  // Token connections: header form on the TLS listener (the only listener that
  // accepts a device credential).
  const tokenSocket = open(tlsUrl, ['dsh-mobile-v1'],
    { Authorization: `Bearer ${pairedFrame.token}`, 'X-DSH-Channel': 'control', 'X-DSH-Device-ID': clientDeviceId })
  const tokenHelloPromise = waitForMessage(tokenSocket, 'hello')
  await once(tokenSocket, 'open')
  assert.equal((await tokenHelloPromise).authenticated, true)
  const conversationSocket = open(tlsUrl, ['dsh-mobile-v1'],
    { Authorization: `Bearer ${pairedFrame.token}`, 'X-DSH-Channel': 'conversation', 'X-DSH-Device-ID': clientDeviceId })
  const conversationHello = waitForMessage(conversationSocket, 'hello')
  await once(conversationSocket, 'open')
  assert.equal((await conversationHello).authenticated, true)
  const tlsTokenSocket = open(tlsUrl, ['dsh-mobile-v1'], { Authorization: `Bearer ${pairedFrame.token}`, 'X-DSH-Device-ID': clientDeviceId })
  const tlsTokenHello = waitForMessage(tlsTokenSocket, 'hello')
  await once(tlsTokenSocket, 'open')
  assert.equal((await tlsTokenHello).certSha256, pairBody.payload.certSha256)
  // Contract §3.6/§5a: operations wait for the acknowledged client-hello.
  await negotiate(conversationSocket)
  await negotiate(tlsTokenSocket)

  // Contract §4 (T022): a device token may not reach the admin surface. Two
  // refusals are possible and both fail closed before any Host call:
  // `op/forbidden` for a type outside `COMPANION_V1_TYPES`, and (spec 005)
  // `auth/forbidden-scope` for a scoped device — this device is paired with
  // scopes, so the scope refusal answers first.
  const witnessed = []
  for (const [type, requestId] of [
    ['file-upload-open', 'device-upload'], ['speech-catalog', 'device-speech'],
    ['plugin-catalog', 'device-plugin'], ['settings-update', 'device-settings'],
    ['session-create', 'device-create'], ['command-execute', 'device-command'],
  ]) {
    const refusal = waitForMessage(tlsTokenSocket, 'error')
    tlsTokenSocket.send(JSON.stringify({ type, requestId, sessionId: 's1', line: '/compact' }))
    const frame = await refusal
    assert.equal(frame.requestId, requestId, `${type} refusal echoes the requestId`)
    assert.ok(['op/forbidden', 'auth/forbidden-scope'].includes(frame.code),
      `${type} must be refused for a device token, got ${frame.code}`)
    witnessed.push(type)
  }
  assert.equal(witnessed.length, 6)
  const sessionsFrame = waitForMessage(tlsTokenSocket, 'sessions')
  tlsTokenSocket.send(JSON.stringify({ type: 'sessions', requestId: 'device-sessions' }))
  const sessionsReply = await sessionsFrame
  assert.equal(sessionsReply.requestId, 'device-sessions')
  const deviceInfo = waitForMessage(tlsTokenSocket, 'device-info')
  tlsTokenSocket.send(JSON.stringify({ type: 'device-info', requestId: 'device-info-1' }))
  const deviceInfoFrame = await deviceInfo
  assert.equal(deviceInfoFrame.device.id, pairedFrame.device.id)
  assert.equal(deviceInfoFrame.requestId, 'device-info-1')
  // Contract §3.6: an unsupported companion protocol is refused and the socket
  // is closed (4003); the other sockets of the device are untouched.
  const unsupportedHello = waitForMessage(tlsTokenSocket, 'error')
  const tlsSocketClosed = once(tlsTokenSocket, 'close')
  tlsTokenSocket.send(JSON.stringify({ type: 'client-hello', requestId: 'old-client', companionProtocol: 0 }))
  assert.equal((await unsupportedHello).code, 'protocol/unsupported')
  assert.equal((await tlsSocketClosed)[0], 4003)

  // Contract §4: `message` needs an existing session and a clientMsgId, and a
  // retry with the same clientMsgId is idempotent.
  const missingSession = waitForMessage(conversationSocket, 'error')
  conversationSocket.send(JSON.stringify({ type: 'message', requestId: 'no-session', text: 'hi', clientMsgId: 'c-1' }))
  assert.equal((await missingSession).code, 'bad-request')
  const missingClientMsg = waitForMessage(conversationSocket, 'error')
  conversationSocket.send(JSON.stringify({ type: 'message', requestId: 'no-msg-id', sessionId: 's1', text: 'hi' }))
  assert.equal((await missingClientMsg).code, 'bad-request')
  const firstSent = waitForMessage(conversationSocket, 'sent')
  conversationSocket.send(JSON.stringify({ type: 'message', requestId: 'msg-1', sessionId: 's1', text: '你好', clientMsgId: 'c-1' }))
  assert.equal((await firstSent).requestId, 'msg-1')
  const promptCount = prompts.length
  const retried = waitForMessage(conversationSocket, 'sent')
  conversationSocket.send(JSON.stringify({ type: 'message', requestId: 'msg-2', sessionId: 's1', text: '你好', clientMsgId: 'c-1' }))
  assert.equal((await retried).requestId, 'msg-2')
  assert.equal(prompts.length, promptCount, 'a retried clientMsgId does not prompt again')

  const devicesResponse = await fetch(`${base}/mgw/devices`)
  const devicesBody = await devicesResponse.json()
  assert.equal(devicesBody.devices.length, 1)
  assert.equal(devicesBody.devices[0].online, true)
  // The pairing socket was closed by the server after `protocol/unsupported`
  // (contract §3.6); the control, conversation and TLS token sockets remain.
  assert.equal(devicesBody.devices[0].connections, 3)

  // Re-pairing the same installation rotates the token, keeps the device and
  // closes what the previous grant opened (spec 005 review D006): a live socket
  // must never outlive the grant that covers its scopes.
  const rePairResponse = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Integration iPhone Renamed', publicUrl: tlsUrl }),
  })
  assert.equal(rePairResponse.status, 201)
  const rePairBody = await rePairResponse.json()
  // Listen before the pairing upgrade lands: the old sockets are closed inside
  // it, so a listener registered afterwards would miss the close.
  const replacedCloses = [tokenSocket, conversationSocket].map((socket) => once(socket, 'close'))
  const rePairedSocket = open(tlsUrl, ['dsh-mobile-v1', `dsh-pair.${rePairBody.payload.pairingCode}`], {
    'X-DSH-Device-ID': clientDeviceId,
    'X-DSH-Device-Name': Buffer.from('Integration iPhone Renamed').toString('base64'),
  })
  const rePairedPromise = waitForMessage(rePairedSocket, 'paired')
  await once(rePairedSocket, 'open')
  const rePairedFrame = await rePairedPromise
  assert.equal(rePairedFrame.device.id, pairedFrame.device.id)
  assert.notEqual(rePairedFrame.token, pairedFrame.token)
  for (const [code] of await Promise.all(replacedCloses)) {
    assert.equal(code, 4401, 'a re-pair closes the sockets opened under the previous grant')
  }
  const rePairedDevices = await (await fetch(`${base}/mgw/devices`)).json()
  assert.equal(rePairedDevices.devices.length, 1)
  assert.equal(rePairedDevices.devices[0].name, 'Integration iPhone Renamed')
  // Only the socket this re-pair opened is left.
  assert.equal(rePairedDevices.devices[0].connections, 1)
  assert.equal(await upgradeOutcome(tlsUrl, ['dsh-mobile-v1'], { Authorization: `Bearer ${pairedFrame.token}` }), 401)

  // Revocation closes the live sockets with the contract code 4401. The
  // listeners are registered before the request so no synchronous close is lost.
  // The sockets carry the re-paired token: the previous grant's sockets were
  // closed by the re-pair above.
  const revokeControl = open(tlsUrl, ['dsh-mobile-v1'], {
    Authorization: `Bearer ${rePairedFrame.token}`, 'X-DSH-Channel': 'control', 'X-DSH-Device-ID': clientDeviceId,
  })
  const revokeConversation = open(tlsUrl, ['dsh-mobile-v1'], {
    Authorization: `Bearer ${rePairedFrame.token}`, 'X-DSH-Channel': 'conversation', 'X-DSH-Device-ID': clientDeviceId,
  })
  const revokeControlHello = waitForMessage(revokeControl, 'hello')
  const revokeConversationHello = waitForMessage(revokeConversation, 'hello')
  await Promise.all([once(revokeControl, 'open'), once(revokeConversation, 'open')])
  assert.equal((await revokeControlHello).authenticated, true)
  assert.equal((await revokeConversationHello).authenticated, true)
  const closed = new WeakSet()
    const closePromises = [revokeControl, revokeConversation]
    .map((socket) => new Promise((resolve) => {
      socket.on('close', (code) => { closed.add(socket); resolve(code) })
    }))
  const revokeResponse = await fetch(`${base}/mgw/devices/${pairedFrame.device.id}/revoke`, {
    method: 'POST',
    headers: { Origin: base },
  })
  assert.equal(revokeResponse.status, 200)
  const closeCodes = await Promise.race([Promise.all(closePromises), delay(5_000).then(() => ['timeout'])])
  for (const code of closeCodes) assert.equal(code, 4401, 'a revoked device closes with 4401')
  assert.equal(await upgradeOutcome(tlsUrl, ['dsh-mobile-v1'], { Authorization: `Bearer ${pairedFrame.token}` }), 401)
  assert.equal(await upgradeOutcome(tlsUrl, ['dsh-mobile-v1'], { Authorization: `Bearer ${rePairedFrame.token}` }), 401)

  // Browser-style clients cannot set X-DSH-Device-ID: they carry the same
  // installation id in a `dsh-device.` subprotocol (contract §3.2 fallback).
  const browserDeviceId = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d._-'
  if (typeof globalThis.WebSocket === 'function') {
    for (const id of ['abcd.efgh', 'abcd_efgh', 'abcd-efgh']) {
      const nativeSocket = new globalThis.WebSocket(tlsUrl, ['dsh-mobile-v1', `dsh-device.${id}`])
      nativeSocket.addEventListener('error', () => {})
      nativeSocket.close()
    }
    assert.throws(
      () => new globalThis.WebSocket(tlsUrl, ['dsh-mobile-v1', 'dsh-device.abcd:efgh']),
      { name: 'SyntaxError' },
    )
  }
  const browserPairResponse = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Browser WebUI', publicUrl: tlsUrl }),
  })
  assert.equal(browserPairResponse.status, 201)
  const browserPairBody = await browserPairResponse.json()
  // A malformed subprotocol id counts as a missing device id; the single-use
  // code must survive the rejection so the client can retry with a valid id.
  assert.equal(await upgradeOutcome(tlsUrl,
    ['dsh-mobile-v1', `dsh-pair.${browserPairBody.payload.pairingCode}`, 'dsh-device.short'],
    {}), 400)
  const browserDeviceNameText = '浏览器 WebUI'
  const browserDeviceName = Buffer.from(browserDeviceNameText, 'utf8').toString('base64url')
  const oversizedDeviceName = `${Buffer.from('x'.repeat(384), 'utf8').toString('base64url')}A`
  assert.equal(oversizedDeviceName.length, 513)
  const controlDeviceName = Buffer.from('Bad\u0001Name', 'utf8').toString('base64url')
  const replacementDeviceName = Buffer.from('Bad\uFFFDName', 'utf8').toString('base64url')
  const browserSocket = open(tlsUrl,
    ['dsh-mobile-v1', `dsh-pair.${browserPairBody.payload.pairingCode}`,
      `dsh-device.${browserDeviceId}`, `dsh-device-name.${oversizedDeviceName}`,
      'dsh-device-name.A', `dsh-device-name.${controlDeviceName}`,
      `dsh-device-name.${replacementDeviceName}`, `dsh-device-name.${browserDeviceName}`], )
  const browserPairedPromise = waitForMessage(browserSocket, 'paired')
  const browserHelloPromise = waitForMessage(browserSocket, 'hello')
  await once(browserSocket, 'open')
  const browserPairedFrame = await browserPairedPromise
  const browserHello = await browserHelloPromise
  assert.equal(browserSocket.protocol, 'dsh-mobile-v1')
  assert.equal(browserHello.authenticated, true)
  assert.equal(browserPairedFrame.device.name, browserDeviceNameText)
  assert.equal(typeof browserPairedFrame.token, 'string')
  const storedDevices = JSON.parse(fs.readFileSync(path.join(temp, 'integration-devices.json'), 'utf8'))
  assert.equal(storedDevices.devices.at(-1).clientDeviceId, browserDeviceId)
  // Browser reconnect: the token travels in the `dsh-auth.` subprotocol, no header.
  // A 512-character encoded name remains valid and is truncated to 80 chars.
  const maxEncodedDeviceName = Buffer.from('x'.repeat(384), 'utf8').toString('base64url')
  assert.equal(maxEncodedDeviceName.length, 512)
  const browserTokenSocket = open(tlsUrl,
    ['dsh-mobile-v1', `dsh-auth.${browserPairedFrame.token}`, `dsh-device.${browserDeviceId}`,
      `dsh-device-name.${maxEncodedDeviceName}`], )
  const browserTokenHelloPromise = waitForMessage(browserTokenSocket, 'hello')
  await once(browserTokenSocket, 'open')
  assert.equal((await browserTokenHelloPromise).authenticated, true)
  const browserDevices = await (await fetch(`${base}/mgw/devices`)).json()
  assert.equal(browserDevices.devices.length, 1)
  assert.equal(browserDevices.devices[0].name, 'x'.repeat(80))
  browserSocket.close()
  browserTokenSocket.close()

  const disableGatewayResponse = await fetch(`${base}/mgw/gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(disableGatewayResponse.status, 200)
  assert.equal((await disableGatewayResponse.json()).gatewayEnabled, false)
  assert.equal(await upgradeOutcome(wsUrl), 503)

  pairedSocket.close()
  rePairedSocket.close()
  for (const device of (await (await fetch(`${base}/mgw/devices`)).json()).devices) {
    const revoked = await fetch(`${base}/mgw/devices/${device.id}/revoke`, { method: 'POST', headers: { Origin: base } })
    await revoked.arrayBuffer()
  }
  disposePlugin()
  server.close()
  await once(server, 'close')
  fs.rmSync(temp, { recursive: true })
  console.log('AUTH AND PAIRING TESTS PASSED')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
