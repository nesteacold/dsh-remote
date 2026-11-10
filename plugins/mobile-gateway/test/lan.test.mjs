import { mock } from 'node:test'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const tls = require('node:tls')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const WebSocket = require('ws')
const plugin = (await import('../lib/index.mjs')).default

function expectRejected(url, options = {}) {
  return new Promise((resolve, reject) => {
    // T017: the LAN listener is TLS and self-signed; the pin is the client side.
    const ws = new WebSocket(url, { rejectUnauthorized: false, ...options })
    ws.once('open', () => reject(new Error('expected WebSocket rejection')))
    ws.once('unexpected-response', (_request, response) => resolve(response.statusCode))
    ws.once('error', () => {})
  })
}

// Resolve a refused upgrade's HTTP status and body, so a test can assert the
// existing refusal vocabulary instead of only the status.
function upgradeResult(url, protocols, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, options)
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('upgrade timed out')) }, 5_000)
    ws.once('open', () => { clearTimeout(timer); ws.terminate(); reject(new Error('upgrade unexpectedly opened')) })
    ws.once('unexpected-response', (_request, response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        clearTimeout(timer)
        resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    ws.once('error', () => {})
  })
}

function waitForMessage(ws, kind) {  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${kind}`)), 2000)
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

// FR-011 / R9 (T031): the two helpers that used to live here (a Windows ACL
// assertion for the Cloudflare state file and a PATH lookup for `cloudflared`)
// went away with the running-tunnel block — v1 never writes that state file and
// never resolves that binary. The gateway no longer wires the tunnel at all, so
// the state file cannot exist. The same ACL assertion still runs in auth.test.mjs.
async function waitForLanStatus(base) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await (await fetch(`${base}/mgw/status`)).json()
    if (status.lan && (status.lan.listening || status.lan.error)) return status
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('LAN listener did not become ready')
}

;(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-lan-'))
  let managementRoute
  let upgradeRoute
  let disposePlugin
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
      async invoke() { throw new Error('unexpected Remote invocation') },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'workspace' && request.method === 'follow') {
            yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
            while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
          }
          if (request.namespace === 'session' && request.method === 'control') {
            yield { type: 'baseline', value: { projections: {} } }
            while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
          }
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(factory) { disposePlugin = factory() },
  }

  await plugin.apply(ctx, {
    gatewayEnabled: true,
    gatewayWaitTimeoutMs: 60_000,
    adminLoopbackOnly: true,
    pairingTtlMs: 60_000,
    deviceFile: path.join(temp, 'devices.json'),
    lanEnabled: true,
    requireHostApproval: false, // spec 008 P1b: these tests exercise the direct claim path; pairing-approval.test.mjs covers the default
    lanHost: '127.0.0.1',
    lanPort: 0,
    // T016: the LAN listener is TLS and needs its own certificate directory.
    tlsCertificateDir: path.join(temp, 'tls'),
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  webServer.port = server.address().port
  const base = `http://127.0.0.1:${webServer.port}`

  const status = await waitForLanStatus(base)
  assert.equal(status.cloudflare.supported, false)
  assert.equal(status.cloudflare.state, 'disabled')
  assert.equal(status.lan.enabled, true)
  assert.equal(status.lan.listening, true)
  assert.equal(status.lan.requireAuth, true)
  assert.equal(status.lan.error, null)
  assert.equal(status.lan.urls.length, 1)
  assert.equal(status.lan.tls, true, 'the LAN listener is TLS (T017)')
  assert.match(status.lan.certSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(status.tools, { restartWeb: false, stopWeb: false })
  for (const action of ['restart-web', 'stop-web']) {
    const unavailable = await fetch(`${base}/mgw/tools/${action}`, {
      method: 'POST', headers: { Origin: base },
    })
    assert.equal(unavailable.status, 409)
    const rejected = await fetch(`${base}/mgw/tools/${action}`, {
      method: 'POST', headers: { Origin: 'https://other.example' },
    })
    assert.equal(rejected.status, 403)
  }
  const lanUrl = status.lan.urls[0]
  assert.equal(lanUrl, `wss://127.0.0.1:${status.lan.port}/ws/mobile`)

  // 只在测试中覆盖真实 TCP socket 的只读来源属性，无需给主机添加 Tailscale 网卡。
  // 生产代码仍只读取 req.socket.remoteAddress，不能被代理头绕过。
  let sourceOverride
  // The plugin-owned listener is `https.createServer`, whose prototype chain does
  // not include http.Server, so both prototypes are patched.
  const socketRemoteAddress = Object.getOwnPropertyDescriptor(net.Socket.prototype, 'remoteAddress')
  Object.defineProperty(tls.TLSSocket.prototype, 'remoteAddress', {
    configurable: true,
    get() { return sourceOverride ?? socketRemoteAddress.get.call(this) },
  })
  const restoreSourceAddress = () => { delete tls.TLSSocket.prototype.remoteAddress }
  for (const source of ['100.64.0.0', '100.100.10.20', '100.127.255.255', '::ffff:100.100.10.20', 'fd7a:115c:a1e0::1']) {
    sourceOverride = source
    // 即使主监听器关闭鉴权，Tailscale 来源的 LAN 连接也必须经过设备鉴权。
    assert.equal(await expectRejected(lanUrl), 401, source)
  }
  for (const source of ['100.63.255.255', '100.128.0.0', '203.0.113.1', '::ffff:203.0.113.1']) {
    sourceOverride = source
    assert.equal(await expectRejected(lanUrl, { headers: { 'X-Forwarded-For': '100.100.10.20' } }), 403, source)
  }
  sourceOverride = undefined

  for (const endpoint of ['wss://100.64.0.0:3081/ws/mobile', 'wss://100.127.255.255:3081/ws/mobile', 'wss://[fd7a:115c:a1e0::1]:3081/ws/mobile']) {
    const response = await fetch(`${base}/mgw/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ name: 'Tailscale endpoint', publicUrl: endpoint }),
    })
    assert.equal(response.status, 201, endpoint)
    assert.equal((await response.json()).payload.publicUrl, endpoint)
  }
  for (const host of ['100.63.255.255', '100.128.0.0', '203.0.113.1']) {
    const response = await fetch(`${base}/mgw/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ publicUrl: `ws://${host}:3081/ws/mobile` }),
    })
    assert.equal(response.status, 400, host)
    await response.arrayBuffer()
  }

  // Main loopback listener follows the debug switch, but LAN never does.
  assert.equal(await expectRejected(lanUrl), 401)

  // No management surface on the LAN port, and no plaintext HTTP either: a
  // plain request cannot complete against a TLS-only listener.
  await assert.rejects(
    fetch(`http://127.0.0.1:${status.lan.port}/mgw/status`),
    (error) => error instanceof TypeError,
    'the LAN listener must not speak plaintext HTTP',
  )

  const pairResponse = await fetch(`${base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'LAN iPhone', publicUrl: lanUrl }),
  })
  assert.equal(pairResponse.status, 201)
  const pair = await pairResponse.json()
  assert.equal(pair.payload.publicUrl, lanUrl)
  assert.equal(pair.payload.gatewayId, status.gatewayId)
  assert.deepEqual(pair.payload.endpoints, [lanUrl])
  assert.deepEqual(status.endpoints, [lanUrl])

  const deviceId = '7bb30e78-4a31-4478-aae1-00a41d280637'
  sourceOverride = '::ffff:100.100.10.20'
  const ws = new WebSocket(
    lanUrl,
    ['dsh-mobile-v1', `dsh-pair.${pair.payload.pairingCode}`],
    { rejectUnauthorized: false, headers: { 'X-DSH-Device-ID': deviceId } },
  )
  const pairedPromise = waitForMessage(ws, 'paired')
  const helloPromise = waitForMessage(ws, 'hello')
  await once(ws, 'open')
  const paired = await pairedPromise
  const hello = await helloPromise
  assert.equal(hello.authenticated, true)
  assert.equal(hello.port, status.lan.port)
  assert.equal(typeof paired.token, 'string')
  assert.equal(paired.gatewayId, status.gatewayId)
  assert.equal(hello.gatewayId, status.gatewayId)
  sourceOverride = undefined
  restoreSourceAddress()

  // -------------------------------------------------------------------------
  // (A) Device credentials are accepted ONLY on the plugin-owned TLS listener.
  // The plaintext DSH loopback route presents no certificate, so a token there
  // would bypass the pin the whole pairing binds to (contract §3.1/§3.4). The
  // same token keeps working on the TLS listener the process is paired on.
  // -------------------------------------------------------------------------
  {
    const plaintext = `ws://127.0.0.1:${webServer.port}/ws/mobile`
    // The old behaviour: a token paired through LAN rode the plaintext host
    // listener. It is refused now, before the credential is even looked at.
    const tokenRefusal = await upgradeResult(plaintext, undefined, {
      headers: { Authorization: `Bearer ${paired.token}`, 'X-DSH-Device-ID': deviceId },
    })
    assert.equal(tokenRefusal.statusCode, 401)
    assert.match(tokenRefusal.body, /device credentials are accepted only on the gateway TLS listener/)
    // Both credential forms are refused: header and `dsh-auth.` subprotocol.
    const subprotocolRefusal = await upgradeResult(plaintext, ['dsh-mobile-v1', `dsh-auth.${paired.token}`], {
      headers: { 'X-DSH-Device-ID': deviceId },
    })
    assert.equal(subprotocolRefusal.statusCode, 401)
    assert.match(subprotocolRefusal.body, /device credentials are accepted only on the gateway TLS listener/)
    // A pairing code is a credential too: refused on the plaintext route.
    const pairCreate = await fetch(`${base}/mgw/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ name: 'Plaintext pairing', publicUrl: lanUrl }),
    })
    assert.equal(pairCreate.status, 201)
    const pairOffer = await pairCreate.json()
    const pairingRefusal = await upgradeResult(plaintext,
      ['dsh-mobile-v1', `dsh-pair.${pairOffer.payload.pairingCode}`],
      { headers: { 'X-DSH-Device-ID': '0b9d6a0e-0000-4000-8000-000000000a11' } })
    assert.equal(pairingRefusal.statusCode, 401)
    assert.match(pairingRefusal.body, /device credentials are accepted only on the gateway TLS listener/)

    // The owner/admin path is unchanged: with no credential the answer is still
    // the same 401 `auth/required` T023 has always given (no new vocabulary).
    const noCredential = await upgradeResult(plaintext)
    assert.equal(noCredential.statusCode, 401)
    assert.match(noCredential.body, /auth\/required/)

    // A plaintext listener that is not loopback serves nobody at all, whatever
    // it presents: no certificate to pin means no remote plaintext transport.
    // `remoteAddress` is a prototype getter, so the fixture shadows it on the
    // one socket instead of redefining the prototype.
    const remoteSource = (socket) => Object.defineProperty(socket, 'remoteAddress', {
      configurable: true,
      get() { return '203.0.113.1' },
    })
    server.on('connection', remoteSource)
    try {
      const remotePlaintext = await upgradeResult(plaintext, undefined, {
        headers: { Authorization: `Bearer ${paired.token}`, 'X-DSH-Device-ID': deviceId },
      })
      assert.equal(remotePlaintext.statusCode, 403)
      assert.match(remotePlaintext.body, /plaintext WebSocket is loopback-only/)
    } finally {
      server.off('connection', remoteSource)
    }

    // The credential still authenticates on the plugin-owned TLS listener.
    const tlsToken = new WebSocket(lanUrl, ['dsh-mobile-v1'], {
      rejectUnauthorized: false,
      headers: { Authorization: `Bearer ${paired.token}`, 'X-DSH-Device-ID': deviceId },
    })
    const tlsHelloPromise = waitForMessage(tlsToken, 'hello')
    await once(tlsToken, 'open')
    const tlsHello = await tlsHelloPromise
    assert.equal(tlsHello.authenticated, true)
    assert.equal(tlsHello.gatewayId, hello.gatewayId)
    tlsToken.close()
    await once(tlsToken, 'close')
  }

  // FR-011 / R9 (T031): the Cloudflare Tunnel is hard-disabled in v1 and the
  // gateway no longer wires it at all — no import, no config keys, no routes.
  // The three former routes are 404 now (only the same-origin gate still answers
  // in front of routing), no state file is written, and the status keeps the
  // disabled shape the admin UI reads.
  const refused = await fetch(`${base}/mgw/cloudflare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ enabled: true, mode: 'named', hostname: 'gateway.example.com', token: 'eyJ.test-token' }),
  })
  assert.equal(refused.status, 404, 'POST /mgw/cloudflare is gone')
  const refusal = await refused.json()
  assert.equal(refusal.error, 'not-found')
  assert.equal(JSON.stringify(refusal).includes('eyJ.test-token'), false, 'the request body is never echoed')
  // The same-origin gate still runs before routing, so this stays 403.
  const crossOrigin = await fetch(`${base}/mgw/cloudflare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' },
    body: JSON.stringify({ enabled: true, mode: 'quick' }),
  })
  assert.equal(crossOrigin.status, 403)
  await crossOrigin.arrayBuffer()
  for (const route of ['check', 'restart']) {
    const response = await fetch(`${base}/mgw/cloudflare/${route}`, { method: 'POST', headers: { Origin: base } })
    assert.equal(response.status, 404, route)
    assert.equal((await response.json()).error, 'not-found', route)
  }
  // Nothing was configured and nothing listens: the state file was never written,
  // and no tunnel/origin listener exists because the port setting is gone too.
  assert.equal(fs.existsSync(`${path.join(temp, 'devices.json')}.cloudflare.json`), false)
  // No tunnel or setup surface survives in the config: no executable, port, state
  // file, public-url file or helper socket can be pointed anywhere.
  const config = plugin.Config({})
  for (const removedKey of ['cloudflaredPath', 'cloudflarePort', 'cloudflareStateFile', 'publicUrlFile']) {
    assert.equal(config[removedKey], undefined, `${removedKey} is no longer a gateway setting`)
  }
  const live = await (await fetch(`${base}/mgw/status`)).json()
  assert.equal(live.cloudflare.enabled, false)
  assert.equal(live.cloudflare.state, 'disabled')
  assert.equal(live.cloudflare.hardDisabled, true)
  assert.equal(live.cloudflare.publicUrl, null)
  assert.equal(live.publicUrl, null)
  assert.equal(live.endpoints.some((endpoint) => endpoint.includes('trycloudflare')), false)
  assert.equal(JSON.stringify(live).includes('eyJ.test-token'), false)

  ws.close()
  await once(ws, 'close')
  disposePlugin()
  server.close()
  await once(server, 'close')
  fs.rmSync(temp, { recursive: true })
  console.log('LAN LISTENER TESTS PASSED')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
