// T015 / US2 — "A phone pairs over an encrypted, pinned channel".
//
// Covers FR-003/FR-004, SC-003 and the contract's pairing rules (§2, §3):
//   1. the QR payload is v3, unpadded base64url JSON, every endpoint `wss://`,
//      `expiresAt` within 5 min and `certSha256` the listener's own fingerprint;
//   2. pairing over the plugin's TLS listener (`dsh-mobile-v1, dsh-pair.<code>`
//      + `X-DSH-Device-ID`) answers `paired` and then `hello`;
//   3. replaying the same code is refused with HTTP 401 `pairing/expired`;
//   4. a client pinning a different certificate aborts during the TLS
//      handshake: the gateway neither upgrades it nor receives a credential;
//   5. a pairing code or device token in the URL query is refused (HTTP 401)
//      on every listener, even when valid;
//   6. only the owner action regenerates the certificate, and the new
//      fingerprint replaces the old one.
//
// The DSH loopback route the plugin also serves is a plain HTTP server owned by
// DSH (R2, research) whose certificate is fixed before the plugin loads, so the
// plugin cannot pin `hello.certSha256` there. The pinning scenarios therefore
// run against the plugin-owned TLS listener, which is the only remote surface.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { once } from 'node:events'
import WebSocket from 'ws'
import plugin from '../lib/index.mjs'
import { loadOrCreateTlsIdentity } from '../lib/tls.mjs'
import { assertOwnerOnly, ownerOnlyViolation, powerShellLiteral, windowsAclViolation } from '../lib/secure-file.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import {
  connect, createImpostorCertificate, decodePairingPayload, observeServerTraffic, pair,
  pinnedTlsOptions, sha256HexOfCertificate, startInterceptionProxy, upgradeStatus,
} from './client/pair.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-tls-pin-'))
const failures = []
const passed = (label) => console.log(`PASS: ${label}`)
const failed = (label, error) => {
  failures.push({ label, error })
  console.error(`FAIL: ${label}\n${error?.stack ?? error}`)
}

// The plugin creates its TLS listeners through https.createServer; wrapping the
// factory keeps a handle on the one under test without a test-only export.
const httpsServers = []
const realCreateServer = https.createServer.bind(https)
https.createServer = function trackedCreateServer(options, listener) {
  const server = realCreateServer(options, listener)
  httpsServers.push(server)
  return server
}
// Keep the run readable: the plugin logs to console.log through lib/logging.mjs.
// TLS_PIN_DEBUG=1 restores everything.
const quiet = !process.env.TLS_PIN_DEBUG
const realLog = console.log
console.log = (message, ...rest) => {
  if (!quiet || (typeof message === 'string' && message.startsWith('PASS'))) realLog(message, ...rest)
}

async function startGateway(overrides = {}) {
  let management
  let upgrade
  let lanServer = null
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management) management.handler(req, res)
    else res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (upgrade) upgrade.handler(req, socket, head)
    else socket.destroy()
  })
  // fetch-safe: undici refuses whole classes of ports ("bad port"), and `listen(0)`
  // returns whatever the OS picks; the helper re-binds until `fetch` accepts it.
  await listenFetchSafe(server)
  const port = server.address().port
  const config = {
    deviceFile: path.join(temp, `devices-${port}.json`),
    gatewayName: `tls-${port}`,
    gatewayWaitTimeoutMs: 60_000,
    adminLoopbackOnly: true,
    pairingTtlMs: 60_000,
    lanEnabled: true,
    requireHostApproval: false, // spec 008 P1b: these tests exercise the direct claim path; pairing-approval.test.mjs covers the default
    lanHost: '127.0.0.1',
    lanPort: 0,
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    ...overrides,
  }
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke(request) {
        if (request.namespace === 'session' && request.method === 'list') return { items: [{ sessionId: 's1' }] }
        throw new Error(`unexpected invoke ${request.namespace}/${request.method}`)
      },
      async stream(request) {
        return (async function* () {
          yield { type: 'baseline', value: request.namespace === 'workspace'
            ? { items: [], archivedSessionIds: [] } : { projections: {} } }
          while (!request.signal.aborted) await delay(5)
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(factory) { dispose = factory() },
  }
  const before = httpsServers.length
  await plugin.apply(ctx, config)
  assert.equal(httpsServers.length, before + 1, 'the plugin must own exactly one TLS listener')
  lanServer = httpsServers.at(-1)
  const base = `http://127.0.0.1:${port}`
  const instance = {
    port,
    base,
    wsUrl: `ws://127.0.0.1:${port}/ws/mobile`,
    config,
    get lanServer() { return lanServer },
    async status() { return (await (await fetch(`${base}/mgw/status`)).json()) },
    async post(route, body) {
      const response = await fetch(`${base}/mgw/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    async waitForLan() {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const status = await instance.status()
        if (status.lan?.listening && status.lan.urls.length > 0) return status
        if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
        await delay(20)
      }
      throw new Error('TLS listener did not become ready')
    },
    async close() {
      dispose()
      server.close()
      await once(server, 'close')
    },
  }
  return instance
}

async function peerCertificate(target) {
  const socket = tls.connect({ host: target.host, port: target.port, rejectUnauthorized: false })
  await once(socket, 'secureConnect')
  const raw = socket.getPeerCertificate().raw
  const authorized = socket.authorized
  socket.destroy()
  return { raw, authorized, sha256: sha256HexOfCertificate(raw) }
}

async function rawUpgradeFailure(url, payload, protocols, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { ...pinnedTlsOptions(payload), headers })
    ws.once('open', () => { ws.terminate(); resolve({ status: 'open', body: '' }) })
    ws.once('unexpected-response', (_request, response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    ws.once('error', (error) => reject(error))
  })
}

async function scenario1(instance, tlsUrl, target) {
  const pairResponse = await instance.post('pair', { name: 'TLS phone', publicUrl: tlsUrl })
  assert.equal(pairResponse.status, 201, `POST /mgw/pair → ${pairResponse.status}: ${JSON.stringify(pairResponse.data)}`)
  const body = pairResponse.data
  const payload = body.payload
  assert.equal(payload.version, 3, 'QR payload version must be 3')
  assert.equal(payload.publicUrl, tlsUrl)
  assert.ok(payload.publicUrl.startsWith('wss://'), 'publicUrl must be wss://')
  assert.ok(Array.isArray(payload.endpoints) && payload.endpoints.length > 0)
  for (const endpoint of payload.endpoints) assert.ok(endpoint.startsWith('wss://'), `endpoint ${endpoint} must be wss://`)
  assert.equal(payload.endpoints[0], payload.publicUrl, 'publicUrl is always the first endpoint')
  assert.match(payload.pairingCode, /^[A-Za-z0-9_-]{43}$/, '256-bit base64url pairing code')
  assert.equal(typeof payload.expiresAt, 'number', 'expiresAt is epoch milliseconds')
  assert.ok(payload.expiresAt > Date.now(), 'the code must still be valid')
  assert.ok(payload.expiresAt - Date.now() <= 5 * 60 * 1000, 'expiresAt must be at most 5 minutes ahead')
  assert.match(payload.certSha256, /^[a-f0-9]{64}$/, 'certSha256 is 64 lowercase hex characters')
  assert.match(payload.gatewayId, /^[0-9a-f-]{36}$/, 'gatewayId is a uuid')
  assert.equal(typeof payload.gatewayName, 'string')
  assert.match(body.qrPayload, /^[A-Za-z0-9_-]+$/, 'QR text is unpadded base64url')
  assert.deepEqual(decodePairingPayload(body.qrPayload), payload, 'QR text decodes to the payload')
  const presented = await peerCertificate(target)
  assert.equal(presented.authorized, false, 'the certificate is self-signed (trust comes from the pin)')
  assert.equal(presented.sha256, payload.certSha256, 'certSha256 is the listener certificate fingerprint')
  passed('QR payload is v3 (wss endpoints, ≤ 5 min TTL, listener certSha256, ids)')
}

async function scenario2(instance, payload) {
  const deviceId = '6f1e5f77-71c4-4f62-9a41-2c0f7f9a1d10'
  const paired = await pair({ payload, deviceId, deviceName: 'TLS phone' })
  assert.equal(paired.ws.protocol, 'dsh-mobile-v1', 'the server negotiates only dsh-mobile-v1')
  assert.equal(paired.token.length, 43)
  assert.equal(paired.paired.device.id, paired.device.id)
  assert.equal(typeof paired.paired.device.createdAt, 'number')
  assert.equal(paired.hello.authenticated, true)
  assert.equal(paired.hello.protocol, 3)
  assert.equal(paired.hello.companionProtocol, 1)
  assert.equal(paired.hello.minClientVersion, 1)
  assert.deepEqual(paired.hello.capabilities, ['sessions-read', 'prompt', 'cancel', 'approval-v1'])
  assert.equal(paired.hello.certSha256, payload.certSha256, 'hello carries the pinned fingerprint')
  assert.equal(paired.hello.gatewayId, payload.gatewayId)
  assert.equal(paired.hello.device.id, paired.device.id)
  passed('pairing over pinned WSS sends paired (token + device) then hello with companion protocol 1')

  const session = await connect({ payload, token: paired.token, deviceId })
  assert.equal(session.hello.gatewayId, payload.gatewayId, JSON.stringify(session.hello))
  assert.equal(session.hello.authenticated, true, JSON.stringify(session.hello))
  const info = await session.request({ type: 'device-info', requestId: 'info-1' })
  assert.equal(info.kind, 'device-info', JSON.stringify(info))
  assert.equal(info.requestId, 'info-1', JSON.stringify(info))
  assert.equal(info.device.id, paired.device.id)
  assert.equal(info.device.name, 'TLS phone')
  assert.equal(typeof info.device.createdAt, 'number')
  const sessions = await session.request({ type: 'sessions', requestId: 'sessions-1' })
  assert.equal(sessions.kind, 'sessions')
  assert.equal(sessions.requestId, 'sessions-1')
  const hello = await session.request({ type: 'client-hello', requestId: 'hello-1', companionProtocol: 1, appVersion: '1.0.0', platform: 'ios' })
  assert.equal(hello.kind, 'client-hello')
  assert.equal(hello.accepted, true)
  const viaSubprotocol = await connect({ payload, token: paired.token, deviceId, viaSubprotocol: true })
  assert.equal(viaSubprotocol.hello.authenticated, true)
  const subprotocolInfo = await viaSubprotocol.request({ type: 'device-info', requestId: 'info-2' })
  assert.equal(subprotocolInfo.requestId, 'info-2', JSON.stringify(subprotocolInfo))
  viaSubprotocol.close()
  passed('token connection over WSS is served hello and allowlisted operations')
  return { session, paired, deviceId }
}

async function scenario3(tlsUrl, payload, deviceId) {
  const replay = await rawUpgradeFailure(tlsUrl, payload,
    ['dsh-mobile-v1', `dsh-pair.${payload.pairingCode}`], { 'X-DSH-Device-ID': deviceId })
  assert.equal(replay.status, 401, `replayed pairing code must be 401, got ${replay.status}`)
  assert.match(replay.body, /pairing\/expired/)
  passed('replaying a used pairing code → HTTP 401 pairing/expired')
}

async function scenario4(instance, tlsUrl, gatewayPin, target) {
  const observer = observeServerTraffic(instance.lanServer)
  const interception = await startInterceptionProxy(target, { certificate: createImpostorCertificate() })
  try {
    const fresh = await instance.post('pair', { name: 'Intercepted phone', publicUrl: tlsUrl })
    assert.equal(fresh.status, 201)
    const freshPayload = fresh.data.payload
    assert.equal(freshPayload.certSha256, gatewayPin, 'the QR carries the gateway pin')
    const proxyUrl = `wss://127.0.0.1:${interception.port}${new URL(tlsUrl).pathname}`
    let refused = null
    try {
      // The gateway's own pin (the `hello.certSha256` and the QR's): the proxy
      // presents the impostor certificate instead, so the client must abort.
      await pair({ payload: { ...freshPayload, certSha256: gatewayPin }, url: proxyUrl, deviceId: '7c8b1a10-0000-4000-8000-000000000001' })
    } catch (error) {
      refused = error
    }
    assert.ok(refused, 'a client pinning a different certificate must not pair')
    await delay(100)
    assert.equal(observer.traffic.upgrades, 0, 'the gateway must receive no WebSocket upgrade through the proxy')
    assert.equal(observer.traffic.upgradesWithCredential, 0, 'no pairing code may cross the gateway')

    // The same client pinning the certificate the proxy actually presents does
    // pair, so the abort above came from the pin check, not from the proxy path.
    const proxyPin = (await peerCertificate({ host: '127.0.0.1', port: interception.port })).sha256
    assert.notEqual(proxyPin, gatewayPin, 'the proxy must present a different certificate')
    const throughProxy = await pair({
      payload: { ...freshPayload, certSha256: proxyPin },
      url: proxyUrl, deviceId: '7c8b1a10-0000-4000-8000-000000000002',
    })
    assert.equal(throughProxy.hello.authenticated, true)
    throughProxy.close()
    assert.equal(observer.traffic.upgrades, 1)
    passed('wrong pin aborts before sending: gateway saw 0 upgrades and 0 pairing codes')
  } finally {
    observer.restore()
    await interception.close()
  }
}

async function scenario5(instance, tlsUrl, payload, token) {
  const queryPairing = await instance.post('pair', { name: 'Query phone', publicUrl: tlsUrl })
  assert.equal(queryPairing.status, 201)
  const queryPayload = queryPairing.data.payload
  // `wss://` upgrades need an explicit TLS agent for the self-signed listener;
  // the query refusal must precede any credential handling.
  const pinned = { ...pinnedTlsOptions(payload), rejectUnauthorized: false }
  assert.equal(await upgradeStatus(`${tlsUrl}?pairingCode=${encodeURIComponent(queryPayload.pairingCode)}`, { tls: pinned }), 401,
    'pairing code in the query must be refused even when valid')
  const queryReply = await rawUpgradeFailure(`${tlsUrl}?token=${encodeURIComponent(token)}`, payload, ['dsh-mobile-v1'], {})
  assert.equal(queryReply.status, 401, `token in the query must be refused even when valid, got ${queryReply.status}`)
  assert.match(queryReply.body, /auth\/required/)
  assert.equal(await upgradeStatus(`${instance.wsUrl}?pairingCode=${encodeURIComponent(queryPayload.pairingCode)}`), 401,
    'the DSH loopback route must also refuse a query pairing code')
  assert.equal(await upgradeStatus(`${instance.wsUrl}?token=${encodeURIComponent(token)}`), 401,
    'the DSH loopback route must also refuse a query token')
  const subprotocolPairing = await pair({ payload: queryPayload, deviceId: '9a2e4a10-0000-4000-8000-000000000005' })
  assert.ok(subprotocolPairing.token)
  subprotocolPairing.close()
  passed('pairing code and token in the URL query are refused (401) on TLS and loopback listeners')
}

async function scenario6(instance, tlsUrl, target, fingerprint) {
  const before = await instance.status()
  const regenerated = await instance.post('tls/regenerate')
  assert.equal(regenerated.status, 200, `regenerate → ${regenerated.status}: ${JSON.stringify(regenerated.data)}`)
  assert.match(regenerated.data.fingerprint256, /^[a-f0-9]{64}$/)
  assert.notEqual(regenerated.data.fingerprint256, fingerprint, 'a new certificate is issued')
  const after = await instance.waitForLan()
  assert.equal(after.lan.port, before.lan.port, 'regeneration keeps the listener port')
  const afterPairing = await instance.post('pair', { name: 'After regenerate', publicUrl: tlsUrl })
  assert.equal(afterPairing.status, 201)
  assert.equal(afterPairing.data.payload.certSha256, regenerated.data.fingerprint256, 'the QR carries the new fingerprint')
  const rotated = await peerCertificate(target)
  assert.equal(rotated.sha256, regenerated.data.fingerprint256, 'the listener presents the new certificate')
  passed('POST /mgw/tls/regenerate replaces the certificate and its fingerprint')
}

// Whole-gateway review 2026-11-10: the private key IS the listener identity, so
// an ACL that cannot be verified must refuse the identity instead of serving the
// key (the previous code ignored the restriction result). `ownerOnlyCheck` is the
// test seam for that verification — the bundle never passes it — so the refusal
// path is exercised without needing a second Windows account.
async function scenario7OwnerOnlyRefusal() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-tls-acl-'))
  try {
    // (a) the key cannot be verified → the identity is refused and names the key.
    let refusedKey = null
    try {
      await loadOrCreateTlsIdentity({
        directory,
        ownerOnlyCheck: (target) => (target.endsWith('.key') ? 'simulated permissive ACL: access is granted to BUILTIN\\Users' : null),
      })
    } catch (error) { refusedKey = error }
    assert.ok(refusedKey, 'an unverifiable key must refuse the TLS identity')
    assert.equal(refusedKey.code, 'secret-file/not-owner-only')
    assert.match(refusedKey.message, /mobile-gateway-tls\.key/, 'the refusal names the key path')
    assert.match(refusedKey.message, /simulated permissive ACL/, 'and the reason')

    // (b) the DIRECTORY cannot be verified → refused BEFORE the key is written.
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-tls-acl-'))
    try {
      let refusedDirectory = null
      try {
        await loadOrCreateTlsIdentity({ directory: second, ownerOnlyCheck: () => 'simulated permissive ACL on the directory' })
      } catch (error) { refusedDirectory = error }
      assert.ok(refusedDirectory, 'an unverifiable directory must refuse the TLS identity')
      assert.equal(refusedDirectory.code, 'secret-file/not-owner-only')
      assert.equal(fs.existsSync(path.join(second, 'mobile-gateway-tls.key')), false,
        'the key is never written into a directory that cannot be verified')
    } finally {
      fs.rmSync(second, { recursive: true, force: true })
    }

    // (b2) the creation path verifies the directory a SECOND time, after the key
    // was written: before-write directory, after-write key, then the directory
    // again. Failing that third check must still refuse the identity, and no
    // certificate store may exist afterwards (nothing is left to be served).
    const third = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-tls-acl-'))
    try {
      const checks = []
      let refusedRecheck = null
      try {
        await loadOrCreateTlsIdentity({
          directory: third,
          ownerOnlyCheck: (target) => {
            checks.push(target)
            // 1: directory before the write, 2: the key, 3: the directory again.
            return checks.length === 3 ? 'simulated permissive ACL re-read after the key write' : null
          },
        })
      } catch (error) { refusedRecheck = error }
      assert.deepEqual(checks, [third, path.join(third, 'mobile-gateway-tls.key'), third],
        `the creation path must verify directory, key, directory — got ${JSON.stringify(checks)}`)
      assert.ok(refusedRecheck, 'a failing second directory check must refuse the TLS identity')
      assert.equal(refusedRecheck.code, 'secret-file/not-owner-only')
      assert.match(refusedRecheck.message, /simulated permissive ACL re-read after the key write/,
        'the refusal carries the reason of the AFTER-write directory check')
      assert.equal(fs.existsSync(path.join(third, 'mobile-gateway-tls.json')), false,
        'no certificate store is written when the directory cannot be re-verified after the key write')
    } finally {
      fs.rmSync(third, { recursive: true, force: true })
    }

    // (c) the REAL probe (POSIX mode or the Windows DACL) accepts a path this code
    // restricted, so the check is not simply "refuse everything".
    const identity = await loadOrCreateTlsIdentity({ directory })
    assert.equal(assertOwnerOnly(identity.paths.key), true, 'the generated key is provably owner-only')
    assert.equal(assertOwnerOnly(identity.paths.directory), true, 'and so is its directory')
    passed('an unverifiable key or directory refuses the TLS identity (fail closed)')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// The decision logic behind the refusal, fed with the structured DACL listing the
// Windows probe produces (`AccessControlType|SID|IsInherited`, one ACE per line)
// so the policy is measurable on any platform. SIDs — never localized display
// names — are what gets compared.
function scenario8AclDecision() {
  const userSid = 'S-1-5-21-3623811015-3361044348-30300820-1001'
  const otherUserSid = 'S-1-5-21-3623811015-3361044348-30300820-1105'
  const systemSid = 'S-1-5-18'
  const administratorsSid = 'S-1-5-32-544'
  const allow = (sid, inherited = 'False') => `Allow|${sid}|${inherited}`
  const deny = (sid, inherited = 'False') => `Deny|${sid}|${inherited}`
  const listing = (...lines) => `${lines.join('\r\n')}\r\n`

  // Accepted: the current user's SID, SYSTEM and Administrators — inherited or
  // not — and any Deny, which grants nothing.
  assert.equal(windowsAclViolation(listing(allow(userSid), allow(systemSid), allow(administratorsSid)), userSid), null,
    'current-user SID + SYSTEM + Administrators (explicit) are owner-only')
  assert.equal(windowsAclViolation(listing(allow(userSid, 'True'), allow(systemSid, 'True'), allow(administratorsSid, 'True')), userSid), null,
    'the inherited flag alone is not a refusal (an inherited trusted ACE grants nothing extra)')
  assert.equal(windowsAclViolation(listing(allow(userSid), allow(administratorsSid), deny('S-1-1-0')), userSid), null,
    'a Deny ACE anywhere is acceptable')

  // Refused: an Allow for any SID that is not one of the three.
  assert.match(windowsAclViolation(listing(allow(userSid), allow(otherUserSid)), userSid), new RegExp(otherUserSid),
    'another user SID is refused (HOST\\neste is not DOMAIN\\neste)')
  assert.match(windowsAclViolation(listing(allow('S-1-1-0')), userSid), /S-1-1-0/, 'Everyone is refused')
  assert.match(windowsAclViolation(listing(allow('S-1-5-11')), userSid), /S-1-5-11/, 'Authenticated Users is refused')
  // The reported hole: one trusted ACE used to be enough to pass such a listing.
  assert.match(windowsAclViolation(listing(allow(userSid), allow('S-1-1-0')), userSid), /access is granted to S-1-1-0/,
    'one fine ACE does not mask a permissive ACE beside it')

  // Refused: anything that is not exactly one recognizable ACE per line.
  assert.match(windowsAclViolation(listing(allow(userSid), 'C:\\data\\mobile-gateway-tls.key HOST\\neste:(F)'), userSid),
    /unrecognized entry/, 'a line outside the grammar refuses instead of being skipped')
  assert.match(windowsAclViolation(listing(allow(userSid), '', allow(systemSid)), userSid), /unrecognized entry/,
    'a blank line inside the listing refuses')
  assert.match(windowsAclViolation(listing('Allow|S-1-1-0|True|extra'), userSid), /unrecognized entry/,
    'a recognized prefix with trailing garbage refuses')
  assert.match(windowsAclViolation('', userSid), /empty/, 'an empty listing refuses')

  // A probe that cannot read the path refuses instead of passing: on Windows that
  // is the real `powershell` child process failing (a missing path is a
  // terminating error, so a non-zero exit), on POSIX `stat` failing. Either
  // refusal reason is acceptable — a pass never is.
  const missing = path.join(temp, `missing-${process.pid}.key`)
  const missingReason = ownerOnlyViolation(missing)
  assert.match(missingReason, /could not be read|is empty/,
    `an uninspectable path refuses, got ${JSON.stringify(missingReason)}`)

  // A check that throws (a child process failure surfacing as an exception) is
  // turned into the same typed refusal, not leaked as a raw error.
  let thrownProbe = null
  try {
    assertOwnerOnly('C:\\data\\z.key', () => { throw Object.assign(new Error('Command failed: powershell -Command …'), { code: 'EPERM' }) })
  } catch (error) { thrownProbe = error }
  assert.equal(thrownProbe?.code, 'secret-file/not-owner-only', 'a throwing probe is a typed refusal')
  assert.match(thrownProbe.message, /could not be read \[EPERM\]/, 'and names the probe failure')

  // A crafted file name cannot close the PowerShell literal and inject a command:
  // an embedded single quote is doubled, the only escape such a string has.
  assert.equal(powerShellLiteral("C:\\x\\it's.key"), "'C:\\x\\it''s.key'")
  assert.equal(powerShellLiteral("C:\\x'; Start-Process calc; '"), "'C:\\x''; Start-Process calc; '''")
  assert.equal(powerShellLiteral('C:\\plain\\file.key'), "'C:\\plain\\file.key'")

  let typed = null
  try { assertOwnerOnly('C:\\data\\x.key', () => 'simulated permissive ACL') } catch (error) { typed = error }
  assert.equal(typed?.code, 'secret-file/not-owner-only', 'the refusal is typed')
  assert.match(typed.message, /x\.key/, 'it names the path')
  assert.match(typed.message, /simulated permissive ACL/, 'and the reason')

  if (process.platform !== 'win32') {
    const file = path.join(temp, 'mode-check.key')
    fs.writeFileSync(file, 'secret', { mode: 0o644 })
    fs.chmodSync(file, 0o644)
    assert.match(ownerOnlyViolation(file), /accessible to group or other/, 'a 0644 key is refused')
    fs.chmodSync(file, 0o600)
    assert.equal(ownerOnlyViolation(file), null, 'a 0600 key passes')
  }
  passed('owner-only decision: foreign/everyone ACEs, unparseable listings and failed probes are refused')
}

const instance = await startGateway()
try {
  const lanStatus = await instance.waitForLan()
  const tlsUrl = lanStatus.lan.urls[0]
  assert.ok(tlsUrl.startsWith('wss://'), `LAN listener must advertise wss://, got ${tlsUrl}`)
  const target = { host: '127.0.0.1', port: lanStatus.lan.port }
  const fingerprint = lanStatus.lan.certSha256

  await scenario1(instance, tlsUrl, target).catch((error) => failed('QR payload', error))
  // One code is shared by the scenarios that redeem it: scenario 1 only inspects
  // the payload, scenario 2 pairs with it, scenarios 3-5 use that token.
  const created = await instance.post('pair', { name: 'TLS phone', publicUrl: tlsUrl })
  const payload = created.data.payload
  let session
  let token
  try {
    const result = await scenario2(instance, payload)
    session = result.session
    token = result.paired.token
  } catch (error) {
    failed('pairing over TLS', error)
  }
  if (token) {
    await scenario3(tlsUrl, payload, '6f1e5f77-71c4-4f62-9a41-2c0f7f9a1d10').catch((error) => failed('replay', error))
    await scenario4(instance, tlsUrl, fingerprint, target).catch((error) => failed('wrong pin', error))
    await scenario5(instance, tlsUrl, payload, token).catch((error) => failed('query credentials', error))
    await scenario6(instance, tlsUrl, target, fingerprint).catch((error) => failed('regenerate', error))
  }
  session?.close()
  // Independent of the listening gateway: the refusal path and the ACL decision.
  await scenario7OwnerOnlyRefusal().catch((error) => failed('owner-only refusal', error))
  try { scenario8AclDecision() } catch (error) { failed('owner-only decision', error) }
} finally {
  await instance.close()
  fs.rmSync(temp, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} TLS PIN SCENARIO(S) FAILED`)
  process.exit(1)
}
console.log('TLS PIN TESTS PASSED (9/9)')
