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
const pluginModule = await import('../lib/index.mjs')
const plugin = pluginModule.default
// Blocker 2: the interface table and the bind aliases are NOT plugin config —
// a config key of that name must never reach a bind. They are also NOT module
// state (round 2): `createMobileGatewayPlugin(seams)` seals them into an
// instance-local frozen copy, and the production export above is built with
// none, so no fixture can inherit another fixture's seams.
const { createMobileGatewayPlugin } = pluginModule

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

// The busy-port tests below each need their own gateway instance, because each
// one is configured with the listen port under test; the fixture is the same as
// the one that drives the instance further down. `console.log` is captured for
// as long as it takes the listener to report, because lib/logging.mjs prints the
// shift and the ready line there — the same lines an operator reads.
//
// `options.seams` is the ONLY way this file injects the interface table or a
// bind alias: a plugin config key of that name must not reach a bind (Blocker 2),
// so the harness builds a plugin instance through the test factory instead.
// `options.applyConfig(temp)` builds the plugin config from scratch, which the
// Config() round-trip test needs to exercise the real schema path.
// `options.production: true` uses the exported production plugin (no seams at
// all), which is how a test proves nothing is inherited process-wide.
async function startLanGateway(lanPort, options = {}) {
  const { seams, applyConfig, production, ...overrides } = options
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-lan-port-'))
  const logs = []
  const originalLog = console.log
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
  console.log = (...args) => { logs.push(args.map((arg) => String(arg)).join(' ')); originalLog(...args) }
  try {
    const config = typeof applyConfig === 'function' ? applyConfig(temp) : {
      gatewayEnabled: true,
      gatewayWaitTimeoutMs: 60_000,
      adminLoopbackOnly: true,
      pairingTtlMs: 60_000,
      deviceFile: path.join(temp, 'devices.json'),
      lanEnabled: true,
      requireHostApproval: false,
      lanHost: '127.0.0.1',
      lanPort,
      tlsCertificateDir: path.join(temp, 'tls'),
      ...overrides,
    }
    try {
      // The seams of THIS instance only; `production` keeps the exported plugin,
      // which was created with no seams at all.
      const instance = production ? plugin : createMobileGatewayPlugin(seams)
      await instance.apply(ctx, config)
    } catch (error) {
      // A refused configuration must not leave this fixture's temp files behind.
      fs.rmSync(temp, { recursive: true, force: true })
      throw error
    }
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    webServer.port = server.address().port
    const base = `http://127.0.0.1:${webServer.port}`
    const status = await waitForLanStatus(base)
    const deviceFile = config.deviceFile || path.join(os.homedir(), '.dsh', 'mobile-gateway-devices.json')
    return {
      base,
      status,
      logs,
      server,
      deviceFile,
      // The choice POST /mgw/listen persists (the concurrency test reads it).
      stateFile: `${deviceFile}.gateway.json`,
      async dispose() {
        if (disposePlugin) disposePlugin()
        server.close()
        await once(server, 'close')
        fs.rmSync(temp, { recursive: true })
      },
    }
  } finally {
    console.log = originalLog
  }
}

// Bind one probe; `null` means the port is taken. Every port a test needs is
// taken from the OS this way, so no assertion depends on a fixed port being free.
function bindProbe(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(null))
    probe.listen(port, '127.0.0.1', () => resolve(probe))
  })
}

// A private address this machine does NOT own, so a bind to it always fails with
// EADDRNOTAVAIL. A fixed address cannot be used for that: the bind-alias seam
// only accepts loopback/private targets (Blocker 2), and any fixed private
// address may be a real adapter on another machine. Chosen, not guessed: every
// address this machine owns is excluded, plus any address in `exclude`.
function unownedPrivateAddress(exclude = []) {
  const owned = new Set(exclude)
  for (const records of Object.values(os.networkInterfaces())) {
    for (const record of records || []) owned.add(record.address)
  }
  for (let third = 0; third <= 255; third += 1) {
    for (const candidate of [`192.168.${third}.254`, `192.168.${third}.253`]) {
      if (!owned.has(candidate)) return candidate
    }
  }
  throw new Error('this machine owns every 192.168/16 address a test could refuse to bind')
}

// A 100.64/10 (Tailscale) address this machine does NOT own: an interface table
// that reports it can only have come from a test seam.
function unownedTailscaleAddress(exclude = []) {
  const owned = new Set(exclude)
  for (const records of Object.values(os.networkInterfaces())) {
    for (const record of records || []) owned.add(record.address)
  }
  for (let third = 0; third <= 255; third += 1) {
    for (let fourth = 1; fourth <= 254; fourth += 1) {
      const candidate = `100.64.${third}.${fourth}`
      if (!owned.has(candidate)) return candidate
    }
  }
  throw new Error('this machine owns every 100.64/16 address a test could fake')
}

// Occupy a contiguous block of `size` free ports outside the ephemeral range.
async function occupyPortBlock(size) {
  for (let base = 41_000; base <= 45_000; base += size) {
    const held = []
    for (let offset = 0; offset < size; offset += 1) {
      const probe = await bindProbe(base + offset)
      if (!probe) break
      held.push(probe)
    }
    if (held.length === size) return { base, blockers: held }
    for (const probe of held) {
      probe.close()
      await once(probe, 'close')
    }
  }
  throw new Error(`no free block of ${size} ports in 41000-45000`)
}

// A real TLS handshake: proves the listener that came up presents the pinned
// certificate (the status reports the same value the phone pins).
async function tlsPeerFingerprint(port) {
  const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false })
  await once(socket, 'secureConnect')
  const presented = socket.getPeerCertificate().fingerprint256.replace(/:/g, '').toLowerCase()
  socket.destroy()
  return presented
}

// Whether something completes a TLS handshake on this address and port. A
// wildcard bind answers on every local address; a loopback bind only on
// 127.0.0.1 — this is how the tests measure what the socket really bound instead
// of trusting `status.lan.host`.
function tlsReachable(host, port) {
  return new Promise((resolve) => {
    const socket = tls.connect({ port, host, rejectUnauthorized: false })
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, 2_000)
    socket.once('secureConnect', () => { clearTimeout(timer); socket.destroy(); resolve(true) })
    socket.once('error', () => { clearTimeout(timer); resolve(false) })
  })
}

// A same-origin management write (the only form POST /mgw/listen accepts).
async function postJson(base, pathname, body, options = {}) {
  const origin = options.origin === undefined ? base : options.origin
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch (error) { /* a refusal need not be JSON */ }
  return { status: response.status, body: json, text }
}

const readStatus = async (base) => (await fetch(`${base}/mgw/status`)).json()

// A request that looks like it came from another machine. The management route
// reads `req.socket.remoteAddress` (a prototype getter), so the fixture's server
// shadows it on the socket it accepts; `agent: false` guarantees a fresh
// connection, so the hook really runs for this request.
async function postFromRemote(gateway, pathname, body, remoteAddress) {
  const hook = (socket) => Object.defineProperty(socket, 'remoteAddress', {
    configurable: true,
    get() { return remoteAddress },
  })
  gateway.server.on('connection', hook)
  try {
    const url = new URL(pathname, gateway.base)
    const payload = JSON.stringify(body)
    return await new Promise((resolve, reject) => {
      const request = http.request({
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Origin: gateway.base,
          Connection: 'close',
        },
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = JSON.parse(text) } catch (error) { /* a refusal need not be JSON */ }
          resolve({ status: response.statusCode, body: json, text })
        })
      })
      request.once('error', reject)
      request.end(payload)
    })
  } finally {
    gateway.server.off('connection', hook)
  }
}

// A management write with caller-chosen `Host`/`Origin` headers. `fetch` refuses
// to set `Host`, and the DNS-rebinding test has to send exactly the pair a
// rebinding page would send, so this goes through `http.request`.
async function postWithHeaders(gateway, pathname, body, headers) {
  const url = new URL(pathname, gateway.base)
  const payload = JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Connection: 'close',
        ...headers,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch (error) { /* a refusal need not be JSON */ }
        resolve({ status: response.statusCode, body: json, text })
      })
    })
    request.once('error', reject)
    request.end(payload)
  })
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

  // -------------------------------------------------------------------------
  // A busy port must not kill the TLS listener: a non-zero configured port
  // shifts forward one port at a time (10 ports at most), reports the port that
  // really bound, and keeps the same TLS/authentication properties. Every port
  // here is occupied by the test itself, so nothing depends on a fixed port
  // being free.
  // -------------------------------------------------------------------------
  {
    // One occupied port: the listener comes up on the next one.
    const { base: busyPort, blockers } = await occupyPortBlock(2)
    blockers[1].close()
    await once(blockers[1], 'close')
    const shifted = await startLanGateway(busyPort)
    try {
      assert.equal(shifted.status.lan.listening, true)
      assert.equal(shifted.status.lan.error, null)
      assert.equal(shifted.status.lan.port, busyPort + 1, 'the port that really bound is reported')
      assert.equal(shifted.status.lan.tls, true)
      assert.equal(shifted.status.lan.requireAuth, true)
      assert.deepEqual(shifted.status.lan.urls, [`wss://127.0.0.1:${busyPort + 1}/ws/mobile`])
      assert.ok(shifted.logs.some((line) => line.includes(`TLS listener port ${busyPort} is busy; trying ${busyPort + 1}`)),
        'the shift names the busy port and its successor')
      const ready = shifted.logs.find((line) => line.includes('TLS listener ready:')) || ''
      assert.ok(ready.includes(`127.0.0.1:${busyPort + 1}/ws/mobile`), 'the ready line reports the bound port')
      assert.ok(ready.includes(`; configured ${busyPort} was busy`), 'the ready line names the configured port')
      assert.ok(ready.includes('certSha256='), 'the ready line still reports the pin')
      assert.ok(ready.includes('authentication forced'), 'a shifted listener still forces authentication')
      // The listener that actually bound is the pinned one, and it still refuses
      // an unauthenticated upgrade.
      assert.equal(await tlsPeerFingerprint(busyPort + 1), shifted.status.lan.certSha256)
      assert.equal(await expectRejected(`wss://127.0.0.1:${busyPort + 1}/ws/mobile`), 401)
    } finally {
      await shifted.dispose()
      blockers[0].close()
      await once(blockers[0], 'close')
    }
  }
  {
    // Ten occupied ports: every attempt fails, the failure names the whole
    // range, and the listener keeps none of the ports.
    const { base: blockedFrom, blockers } = await occupyPortBlock(10)
    const blockedTo = blockedFrom + 9
    const failed = await startLanGateway(blockedFrom)
    try {
      assert.equal(failed.status.lan.listening, false)
      assert.equal(failed.status.lan.error, `EADDRINUSE: ports ${blockedFrom}-${blockedTo} are all in use`)
      assert.deepEqual(failed.status.lan.urls, [], 'a dead listener advertises nothing')
      assert.equal(failed.status.lan.tls, false)
      assert.ok(failed.logs.some((line) => line.includes(`TLS listener failed: EADDRINUSE: ports ${blockedFrom}-${blockedTo} are all in use`)),
        'the give-up log names the whole range')
      for (let port = blockedFrom; port < blockedTo; port += 1) {
        assert.ok(failed.logs.some((line) => line.includes(`TLS listener port ${port} is busy; trying ${port + 1}`)),
          `the shift from ${port} to ${port + 1} is logged`)
      }
    } finally {
      await failed.dispose()
    }
    // Release the blockers, then prove the failed listener holds nothing: each
    // of the ten ports binds again straight away.
    for (const blocker of blockers) {
      blocker.close()
      await once(blocker, 'close')
    }
    for (let port = blockedFrom; port <= blockedTo; port += 1) {
      const probe = await bindProbe(port)
      assert.ok(probe, `port ${port} must not be held by the listener that gave up`)
      probe.close()
      await once(probe, 'close')
    }
  }
  {
    // `lanPort: 0` is unchanged: the OS assigns the port and nothing shifts.
    const ephemeral = await startLanGateway(0)
    try {
      assert.equal(ephemeral.status.lan.listening, true)
      assert.equal(ephemeral.status.lan.error, null)
      assert.ok(ephemeral.status.lan.port > 0, 'the OS-assigned port is reported')
      assert.deepEqual(ephemeral.status.lan.urls, [`wss://127.0.0.1:${ephemeral.status.lan.port}/ws/mobile`])
      assert.equal(ephemeral.logs.some((line) => line.includes('is busy; trying')), false, 'port 0 never shifts')
      assert.equal(ephemeral.logs.some((line) => line.includes('was busy')), false)
    } finally {
      await ephemeral.dispose()
    }
  }

  // -------------------------------------------------------------------------
  // POST /mgw/listen — the Devices page moves the plugin-owned TLS listener onto
  // this machine's LAN or Tailscale address in one click, instead of the owner
  // editing `lanHost`. These fixtures inject the interface table (and an alias so
  // a resolved address is bound as one this machine really owns), so no assertion
  // depends on which adapters this machine happens to have.
  // -------------------------------------------------------------------------
  {
    // (1) `loopback` is always resolvable and moves a listener that sits
    // elsewhere back onto 127.0.0.1 — with a real TLS handshake on the port the
    // answer and the status report.
    const elsewhere = '192.168.77.7'
    const gateway = await startLanGateway(0, {
      lanHost: elsewhere,
      seams: { listenAliases: { [elsewhere]: '127.0.0.1' } },
    })
    try {
      assert.equal(gateway.status.lan.host, elsewhere)
      assert.equal(gateway.status.lan.listening, true)
      const moved = await postJson(gateway.base, '/mgw/listen', { target: 'loopback' })
      assert.equal(moved.status, 200)
      assert.equal(moved.body.applied, '127.0.0.1')
      assert.equal(moved.body.persists, true, 'the choice is written to the gateway state file')
      assert.equal(moved.body.lan.host, '127.0.0.1')
      assert.equal(moved.body.lan.listening, true)
      assert.equal(moved.body.lan.requireAuth, true)
      assert.equal(moved.body.lan.tls, true)
      assert.deepEqual(moved.body.lan.urls, [`wss://127.0.0.1:${moved.body.port}/ws/mobile`])
      const status = await readStatus(gateway.base)
      assert.equal(status.lan.host, '127.0.0.1')
      assert.equal(status.lan.port, moved.body.port)
      // The listener that came up is the pinned one and really speaks TLS.
      assert.equal(await tlsPeerFingerprint(moved.body.port), status.lan.certSha256)
      assert.equal(await expectRejected(`wss://127.0.0.1:${moved.body.port}/ws/mobile`), 401)
    } finally {
      await gateway.dispose()
    }
  }
  {
    // (2) `tailscale` binds the detected 100.64/10 address and every surface the
    // phone reads (status, pairing addresses, advertised endpoints) names it.
    const tailscaleHost = '100.64.0.7'
    const table = {
      tailscale0: [{ address: tailscaleHost, family: 'IPv4', internal: false, netmask: '255.192.0.0', mac: '00:00:00:00:00:00', cidr: `${tailscaleHost}/10` }],
    }
    const gateway = await startLanGateway(0, {
      seams: {
        networkInterfaces: table,
        listenAliases: { [tailscaleHost]: '127.0.0.1' },
      },
    })
    try {
      assert.deepEqual(gateway.status.tailscale.addresses, [tailscaleHost])
      assert.deepEqual(gateway.status.tailscale.urls, [], 'nothing is advertised before the bind')
      const moved = await postJson(gateway.base, '/mgw/listen', { target: 'tailscale' })
      assert.equal(moved.status, 200)
      assert.equal(moved.body.applied, tailscaleHost)
      assert.equal(moved.body.lan.host, tailscaleHost)
      assert.deepEqual(moved.body.lan.urls, [`wss://${tailscaleHost}:${moved.body.port}/ws/mobile`])
      assert.deepEqual(moved.body.tailscale.urls, [`wss://${tailscaleHost}:${moved.body.port}/ws/mobile`])
      const status = await readStatus(gateway.base)
      assert.equal(status.lan.host, tailscaleHost)
      assert.deepEqual(status.lan.urls, [`wss://${tailscaleHost}:${status.lan.port}/ws/mobile`])
      assert.deepEqual(status.tailscale.urls, [`wss://${tailscaleHost}:${status.lan.port}/ws/mobile`])
      assert.deepEqual(status.endpoints, [`wss://${tailscaleHost}:${status.lan.port}/ws/mobile`])
      // A pairing offer carries the address the listener really sits on.
      const offer = await postJson(gateway.base, '/mgw/pair', { mode: 'otp' })
      assert.equal(offer.status, 201)
      assert.deepEqual(offer.body.addresses, [`${tailscaleHost}:${status.lan.port}`])
      // The listener, not just the report: a real handshake on the same port.
      assert.equal(await tlsPeerFingerprint(moved.body.port), status.lan.certSha256)
    } finally {
      await gateway.dispose()
    }
  }
  {
    // (3) No Tailscale address: a 409 that names the reason, and the listener is
    // left exactly where it was.
    const gateway = await startLanGateway(0, {
      seams: { networkInterfaces: { Ethernet: [{ address: '192.168.1.50', family: 'IPv4', internal: false }] } },
    })
    try {
      const before = await readStatus(gateway.base)
      const refused = await postJson(gateway.base, '/mgw/listen', { target: 'tailscale' })
      assert.equal(refused.status, 409)
      assert.equal(refused.body.error, 'tailscale/not-detected')
      assert.equal(refused.body.code, 'tailscale/not-detected')
      const after = await readStatus(gateway.base)
      assert.equal(after.lan.host, before.lan.host)
      assert.equal(after.lan.port, before.lan.port)
      assert.equal(after.lan.listening, true)
      assert.deepEqual(after.lan.urls, [`wss://127.0.0.1:${after.lan.port}/ws/mobile`])
      // Still reachable on the old address.
      assert.equal(await tlsPeerFingerprint(after.lan.port), after.lan.certSha256)
      assert.equal(await expectRejected(`wss://127.0.0.1:${after.lan.port}/ws/mobile`), 401)
    } finally {
      await gateway.dispose()
    }
  }
  {
    // (4a) Only a Tailscale address: that is not a LAN address, so `lan` is a 409
    // and the listener does not move.
    const gateway = await startLanGateway(0, {
      seams: {
        networkInterfaces: { tailscale0: [{ address: '100.64.0.7', family: 'IPv4', internal: false }] },
        listenAliases: { '100.64.0.7': '127.0.0.1' },
      },
    })
    try {
      const before = await readStatus(gateway.base)
      const refused = await postJson(gateway.base, '/mgw/listen', { target: 'lan' })
      assert.equal(refused.status, 409)
      assert.equal(refused.body.error, 'lan/not-detected')
      const after = await readStatus(gateway.base)
      assert.equal(after.lan.host, before.lan.host)
      assert.equal(after.lan.port, before.lan.port)
      assert.equal(await expectRejected(`wss://127.0.0.1:${after.lan.port}/ws/mobile`), 401)
    } finally {
      await gateway.dispose()
    }
  }
  {
    // (4b) A routable 192.168 address beats a link-local one, whatever order the
    // adapters are reported in, and the listener really moves there.
    const lanHost = '192.168.50.20'
    const gateway = await startLanGateway(0, {
      seams: {
        networkInterfaces: {
          Ethernet: [{ address: '169.254.10.10', family: 'IPv4', internal: false }],
          'Wi-Fi': [{ address: lanHost, family: 'IPv4', internal: false }],
        },
        listenAliases: { [lanHost]: '127.0.0.1' },
      },
    })
    try {
      const moved = await postJson(gateway.base, '/mgw/listen', { target: 'lan' })
      assert.equal(moved.status, 200)
      assert.equal(moved.body.applied, lanHost)
      assert.equal(moved.body.lan.host, lanHost)
      assert.deepEqual(moved.body.lan.urls, [`wss://${lanHost}:${moved.body.port}/ws/mobile`])
      assert.equal(await tlsPeerFingerprint(moved.body.port), moved.body.lan.certSha256)
    } finally {
      await gateway.dispose()
    }
  }
  {
    // (5) The route is loopback-only even when the surrounding management API is
    // not, and a cross-origin caller is refused; neither moves the listener.
    const elsewhere = '192.168.88.8'
    const gateway = await startLanGateway(0, {
      adminLoopbackOnly: false,
      lanHost: elsewhere,
      seams: { listenAliases: { [elsewhere]: '127.0.0.1' } },
    })
    try {
      const before = await readStatus(gateway.base)
      const remote = await postFromRemote(gateway, '/mgw/listen', { target: 'loopback' }, '203.0.113.9')
      assert.equal(remote.status, 403)
      assert.equal(remote.body.error, 'forbidden')
      assert.match(remote.body.message, /loopback-only/)
      const crossOrigin = await postJson(gateway.base, '/mgw/listen', { target: 'loopback' }, { origin: 'https://other.example' })
      assert.equal(crossOrigin.status, 403)
      const after = await readStatus(gateway.base)
      assert.equal(after.lan.host, before.lan.host)
      assert.equal(after.lan.port, before.lan.port)
      assert.equal(await expectRejected(`wss://127.0.0.1:${after.lan.port}/ws/mobile`), 401)
    } finally {
      await gateway.dispose()
    }
  }
  {
    // (6) The retry loop of the previous task still governs a rebind: with the
    // configured port busy the re-opened listener shifts forward.
    const { base: blockedFrom, blockers } = await occupyPortBlock(10)
    const gateway = await startLanGateway(blockedFrom)
    try {
      assert.equal(gateway.status.lan.listening, false)
      assert.equal(gateway.status.lan.port, blockedFrom)
      // Free exactly one port inside the block: the listener can only come up
      // by shifting, and every port is still one this test holds.
      blockers[1].close()
      await once(blockers[1], 'close')
      const shiftLogs = []
      const originalLog = console.log
      console.log = (...args) => { shiftLogs.push(args.map((arg) => String(arg)).join(' ')); originalLog(...args) }
      let moved
      try {
        moved = await postJson(gateway.base, '/mgw/listen', { target: 'loopback' })
      } finally {
        console.log = originalLog
      }
      assert.equal(moved.status, 200)
      assert.equal(moved.body.applied, '127.0.0.1')
      assert.equal(moved.body.port, blockedFrom + 1, 'the rebind shifted past the busy port')
      assert.equal(moved.body.lan.listening, true)
      assert.equal(moved.body.lan.error, null)
      assert.ok(shiftLogs.some((line) => line.includes(`TLS listener port ${blockedFrom} is busy; trying ${blockedFrom + 1}`)),
        'the retry loop still reports the shift it took')
      assert.equal(await tlsPeerFingerprint(blockedFrom + 1), moved.body.lan.certSha256)
    } finally {
      await gateway.dispose()
      for (const blocker of blockers) {
        if (!blocker.listening) continue
        blocker.close()
        await once(blocker, 'close')
      }
    }
  }
  {
    // (7) An unknown target is a 400 and closes nothing: the same listener, on
    // the same port, with the same certificate, still answers.
    const gateway = await startLanGateway(0)
    try {
      const before = await readStatus(gateway.base)
      for (const body of [{ target: 'wan' }, {}]) {
        const refused = await postJson(gateway.base, '/mgw/listen', body)
        assert.equal(refused.status, 400, JSON.stringify(body))
        assert.equal(refused.body.error, 'bad-request')
      }
      const after = await readStatus(gateway.base)
      assert.equal(after.lan.listening, true)
      assert.equal(after.lan.host, before.lan.host)
      assert.equal(after.lan.port, before.lan.port)
      assert.equal(after.lan.error, null)
      assert.equal(await tlsPeerFingerprint(after.lan.port), before.lan.certSha256)
      assert.equal(await expectRejected(`wss://127.0.0.1:${after.lan.port}/ws/mobile`), 401)
    } finally {
      await gateway.dispose()
    }
  }
  {
    // (8) The choice survives a restart: a second gateway on the same state file
    // comes up on the saved address instead of the configured `lanHost`.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-listen-state-'))
    const deviceFile = path.join(stateDir, 'devices.json')
    const savedHost = '192.168.60.9'
    const table = { Ethernet: [{ address: savedHost, family: 'IPv4', internal: false }] }
    const aliases = { [savedHost]: '127.0.0.1' }
    const first = await startLanGateway(0, { deviceFile, seams: { networkInterfaces: table, listenAliases: aliases } })
    try {
      const moved = await postJson(first.base, '/mgw/listen', { target: 'lan' })
      assert.equal(moved.status, 200)
      assert.equal(moved.body.persists, true)
    } finally {
      await first.dispose()
    }
    const second = await startLanGateway(0, { deviceFile, seams: { networkInterfaces: table, listenAliases: aliases } })
    try {
      assert.equal(second.status.lan.host, savedHost, 'the saved listen address is back in force')
      assert.equal(second.status.lan.listening, true)
      assert.deepEqual(second.status.lan.urls, [`wss://${savedHost}:${second.status.lan.port}/ws/mobile`])
    } finally {
      await second.dispose()
      fs.rmSync(stateDir, { recursive: true })
    }
  }

  {
    // (9) A rebind the OS refuses answers 500 and puts the listener back where it
    // was — same address AND same port — so one bad pick cannot leave the
    // gateway deaf.
    const unbound = '100.64.0.8'
    const refusedTarget = unownedPrivateAddress()
    const gateway = await startLanGateway(0, {
      seams: {
        networkInterfaces: { tailscale0: [{ address: unbound, family: 'IPv4', internal: false }] },
        // A private address this machine does not own always fails to bind with
        // EADDRNOTAVAIL — a deterministic refusal, and one the alias rule accepts
        // (TEST-NET-1 is public and is rejected as a seam target now).
        listenAliases: { [unbound]: refusedTarget },
      },
    })
    try {
      const before = await readStatus(gateway.base)
      const failed = await postJson(gateway.base, '/mgw/listen', { target: 'tailscale' })
      assert.equal(failed.status, 500)
      assert.equal(failed.body.error, 'internal')
      assert.match(failed.body.message, /could not be rebound to 100\.64\.0\.8/)
      assert.match(failed.body.message, /back on 127\.0\.0\.1/)
      const after = await readStatus(gateway.base)
      assert.equal(after.lan.host, '127.0.0.1')
      assert.equal(after.lan.port, before.lan.port, 'rollback restores the previous port too')
      assert.equal(after.lan.listening, true)
      assert.equal(await tlsPeerFingerprint(after.lan.port), before.lan.certSha256)
      assert.equal(await expectRejected(`wss://127.0.0.1:${after.lan.port}/ws/mobile`), 401)
      // Nothing was persisted for an address that never bound.
      const offer = await postJson(gateway.base, '/mgw/pair', { mode: 'otp' })
      assert.equal(offer.status, 201)
      assert.deepEqual(offer.body.addresses, [`127.0.0.1:${after.lan.port}`])
    } finally {
      await gateway.dispose()
    }
  }

  {
    // (10) Blocker 1: the consent guard for this route does not trust a
    // caller-supplied Host/Origin pair. A DNS-rebinding page reaches the loopback
    // socket with headers that agree with each other (`Host: attacker.example`,
    // `Origin: http://attacker.example`), so only a loopback authority passes and
    // an absent Origin does not help either.
    const gateway = await startLanGateway(0)
    try {
      const before = await readStatus(gateway.base)
      const port = new URL(gateway.base).port
      const attacker = `attacker.example:${port}`
      const cases = [
        // The exact rebinding pair: Host and Origin agree, but neither is local.
        { headers: { Host: attacker, Origin: `http://${attacker}` }, why: 'rebinding Host+Origin' },
        // No Origin at all: the shared same-origin guard allows that outright.
        { headers: { Host: attacker }, why: 'rebinding Host without Origin' },
        // A local Host with somebody else's Origin is still a cross-origin caller.
        { headers: { Host: `127.0.0.1:${port}`, Origin: `http://${attacker}` }, why: 'foreign Origin' },
        // The Origin scheme must be http(s): `ws:`/`file:` are not page origins.
        { headers: { Host: `127.0.0.1:${port}`, Origin: `ws://127.0.0.1:${port}` }, why: 'non-http Origin scheme' },
      ]
      for (const { headers, why } of cases) {
        const refused = await postWithHeaders(gateway, '/mgw/listen', { target: 'loopback' }, headers)
        assert.equal(refused.status, 403, why)
        assert.equal(refused.body.error, 'forbidden', why)
        assert.equal(/attacker\.example/.test(refused.body.message), false, 'the refusal names no caller input')
      }
      // The listener did not move for any of them.
      const after = await readStatus(gateway.base)
      assert.equal(after.lan.host, before.lan.host)
      assert.equal(after.lan.port, before.lan.port)
      assert.equal(after.lan.listening, true)
      assert.equal(await expectRejected(`wss://127.0.0.1:${after.lan.port}/ws/mobile`), 401)
      // The legitimate loopback form still succeeds: 127.0.0.1 Host + matching
      // http Origin is exactly what the Devices page sends.
      const accepted = await postWithHeaders(gateway, '/mgw/listen', { target: 'loopback' },
        { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` })
      assert.equal(accepted.status, 200)
      assert.equal(accepted.body.applied, '127.0.0.1')
    } finally {
      await gateway.dispose()
    }
  }
  {
    // (11) Blocker 2: a test seam is instance state, not configuration. Config()
    // preserves unknown keys (measured) and apply() spreads the config into
    // `options`, so this exact round trip used to reach bindHost(): the alias
    // mapped 127.0.0.1 onto 0.0.0.0 and the wildcard was bound while the status
    // still said 127.0.0.1. It must now have no effect at all.
    const configured = plugin.Config({ testListenAliases: { '127.0.0.1': '0.0.0.0' }, testNetworkInterfaces: {} })
    assert.deepEqual(configured.testListenAliases, { '127.0.0.1': '0.0.0.0' },
      'the schema still round-trips the key (measured); only apply() refusing to read it protects the bind')
    const gateway = await startLanGateway(0, {
      applyConfig: (temp) => ({
        ...plugin.Config({
          // The schema injects `remoteControl.enabled: false` as an EXPLICIT
          // value, and an explicit value wins over the legacy `gatewayEnabled`
          // alias — so the owner switch has to be turned on through its own key.
          remoteControl: { enabled: true },
          // The runtime MODE still comes from the saved/configured mode, so the
          // schema's default `gatewayEnabled: false` would leave it off.
          gatewayMode: 'persistent',
          gatewayWaitTimeoutMs: 60_000,
          requireHostApproval: false,
          lanEnabled: true,
          lanHost: '127.0.0.1',
          lanPort: 0,
          testListenAliases: { '127.0.0.1': '0.0.0.0' },
          testNetworkInterfaces: {},
        }),
        deviceFile: path.join(temp, 'devices.json'),
        tlsCertificateDir: path.join(temp, 'tls'),
      }),
    })
    try {
      assert.equal(gateway.status.lan.host, '127.0.0.1', 'config cannot move the listen host')
      assert.equal(gateway.status.lan.listening, true)
      assert.deepEqual(gateway.status.lan.urls, [`wss://127.0.0.1:${gateway.status.lan.port}/ws/mobile`])
      // The listener really is the pinned one on this port (a wildcard bind would
      // also answer here, so the decisive check is the one below).
      assert.equal(await tlsPeerFingerprint(gateway.status.lan.port), gateway.status.lan.certSha256)
    } finally {
      await gateway.dispose()
    }
    // A config alias onto an address this machine cannot bind would have made the
    // listener fail. It has no effect, so the listener comes up normally — and if
    // a config value ever reached the seam again, the seam's own address rule
    // would reject it and apply() would throw instead.
    const unbindable = await startLanGateway(0, {
      applyConfig: (temp) => ({
        ...plugin.Config({
          // The schema injects `remoteControl.enabled: false` as an EXPLICIT
          // value, and an explicit value wins over the legacy `gatewayEnabled`
          // alias — so the owner switch has to be turned on through its own key.
          remoteControl: { enabled: true },
          // The runtime MODE still comes from the saved/configured mode, so the
          // schema's default `gatewayEnabled: false` would leave it off.
          gatewayMode: 'persistent',
          gatewayWaitTimeoutMs: 60_000,
          requireHostApproval: false,
          lanEnabled: true,
          lanHost: '127.0.0.1',
          lanPort: 0,
          testListenAliases: { '127.0.0.1': '192.0.2.1' },
          testNetworkInterfaces: {},
        }),
        deviceFile: path.join(temp, 'devices.json'),
        tlsCertificateDir: path.join(temp, 'tls'),
      }),
    })
    try {
      assert.equal(unbindable.status.lan.listening, true, 'a configured alias never reaches bindHost()')
      assert.equal(unbindable.status.lan.host, '127.0.0.1')
      assert.equal(unbindable.status.lan.error, null)
    } finally {
      await unbindable.dispose()
    }
    // And the seam itself refuses an alias onto a wildcard or a public address,
    // whatever injects it: an alias can never widen the surface.
    for (const target of ['0.0.0.0', '::', '203.0.113.7']) {
      await assert.rejects(
        startLanGateway(0, { seams: { listenAliases: { '127.0.0.1': target } } }),
        (error) => /must be a loopback or private address/.test(error.message),
        `${target} must be refused as a bind alias`,
      )
    }
  }
  {
    // (12) Blocker 3: two overlapping POST /mgw/listen calls are serialized. Both
    // are started before either has settled; the second queues and then applies,
    // so there is exactly one final state and the saved address is the one the
    // winning listener really sits on.
    const lanHost = '192.168.70.10'
    const tailscaleHost = '100.64.0.9'
    const gateway = await startLanGateway(0, {
      seams: {
        networkInterfaces: {
          Ethernet: [{ address: lanHost, family: 'IPv4', internal: false }],
          tailscale0: [{ address: tailscaleHost, family: 'IPv4', internal: false }],
        },
        listenAliases: { [lanHost]: '127.0.0.1', [tailscaleHost]: '127.0.0.1' },
      },
    })
    try {
      const before = await readStatus(gateway.base)
      const [first, second] = await Promise.all([
        postJson(gateway.base, '/mgw/listen', { target: 'lan' }),
        postJson(gateway.base, '/mgw/listen', { target: 'tailscale' }),
      ])
      // Both are answered 200: the loser queued and applied, it was not refused.
      assert.equal(first.status, 200, 'the queued request is applied, not refused')
      assert.equal(second.status, 200, 'the queued request is applied, not refused')
      assert.deepEqual([first.body.applied, second.body.applied].sort(), [lanHost, tailscaleHost].sort(),
        'each request applied its own target, one after the other')
      // Each answer describes the listener ITS generation brought up.
      assert.equal(first.body.lan.host, first.body.applied)
      assert.equal(second.body.lan.host, second.body.applied)
      assert.equal(first.body.persists, true)
      assert.equal(second.body.persists, true)
      const after = await readStatus(gateway.base)
      // Exactly one final state, and it is the winning generation's address.
      assert.ok(after.lan.host === lanHost || after.lan.host === tailscaleHost, after.lan.host)
      assert.equal(after.lan.listening, true)
      const persisted = JSON.parse(fs.readFileSync(gateway.stateFile, 'utf8')).listenHost
      assert.equal(after.lan.host, persisted, 'status.lan.host equals the persisted listenHost')
      const winner = first.body.applied === after.lan.host ? first : second
      const loser = winner === first ? second : first
      assert.equal(winner.body.persists, true)
      assert.notEqual(loser.body.applied, winner.body.applied)
      // The rebind moved the address only: the same certificate is in force, and
      // the listener still refuses an unauthenticated upgrade.
      assert.equal(after.lan.certSha256, before.lan.certSha256, 'a rebind does not rotate the certificate')
      assert.equal(await tlsPeerFingerprint(after.lan.port), before.lan.certSha256)
      assert.equal(await expectRejected(`wss://127.0.0.1:${after.lan.port}/ws/mobile`), 401)
    } finally {
      await gateway.dispose()
    }
  }
  {
    // (13) Should-fix 4: start-up re-adopts a saved choice with the SAME rule the
    // route uses. A saved public or unspecified address is ignored (the loopback
    // default wins) even when this machine "owns" it; a saved private/Tailscale
    // one is adopted.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-listen-adopt-'))
    const deviceFile = path.join(stateDir, 'devices.json')
    const stateFile = `${deviceFile}.gateway.json`
    const writeListenHost = (host) => {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      state.listenHost = host
      fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
    }
    const publicAddress = '203.0.113.7'
    // Just a helper: creates the state file the rewrites below need.
    const seed = await startLanGateway(0, { deviceFile })
    await seed.dispose()
    try {
      for (const saved of [publicAddress, '0.0.0.0']) {
        writeListenHost(saved)
        // The table claims this machine OWNS the public address, which is the
        // case the old `net.isIP(...) !== 0` test wrongly accepted.
        const ignored = await startLanGateway(0, {
          deviceFile,
          seams: { networkInterfaces: { Ethernet: [{ address: publicAddress, family: 'IPv4', internal: false }] } },
        })
        try {
          assert.equal(ignored.status.lan.host, '127.0.0.1', `a saved ${saved} address is not re-adopted`)
          assert.equal(ignored.status.lan.listening, true)
          assert.deepEqual(ignored.status.lan.urls, [`wss://127.0.0.1:${ignored.status.lan.port}/ws/mobile`])
        } finally {
          await ignored.dispose()
        }
      }
      const tailscaleHost = '100.64.0.11'
      writeListenHost(tailscaleHost)
      const adopted = await startLanGateway(0, {
        deviceFile,
        seams: {
          networkInterfaces: { tailscale0: [{ address: tailscaleHost, family: 'IPv4', internal: false }] },
          listenAliases: { [tailscaleHost]: '127.0.0.1' },
        },
      })
      try {
        assert.equal(adopted.status.lan.host, tailscaleHost, 'a saved Tailscale address is adopted')
        assert.equal(adopted.status.lan.listening, true)
        assert.deepEqual(adopted.status.lan.urls, [`wss://${tailscaleHost}:${adopted.status.lan.port}/ws/mobile`])
      } finally {
        await adopted.dispose()
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true })
    }
  }

  // ---------------------------------------------------------------------------
  // Round 2 of review 2026-11-10: the test-seam boundary itself. These three
  // blocks measure exactly the symptoms the reviewer measured against the old
  // module state: an inherited alias, a caller-side mutation that reached the
  // bind, and an alias widened to a wildcard after it was validated.
  // ---------------------------------------------------------------------------
  {
    // (14) A second instance in the same process does not inherit the first
    // instance's seams. The old boundary was module state, so `apply()` after a
    // previous harness had configured any seams still saw them ("second instance
    // inherits aliases: true"). Now the factory seals one copy per instance and
    // the production export is built with none.
    const lanHost = unownedPrivateAddress()
    const tailscaleHost = unownedTailscaleAddress()
    const first = await startLanGateway(0, {
      lanHost,
      seams: {
        networkInterfaces: { tailscale0: [{ address: tailscaleHost, family: 'IPv4', internal: false }] },
        listenAliases: { [lanHost]: '127.0.0.1' },
      },
    })
    try {
      assert.equal(first.status.lan.host, lanHost)
      assert.equal(first.status.lan.listening, true, 'the first instance binds through its own alias')
      assert.deepEqual(first.status.tailscale.addresses, [tailscaleHost], 'the first instance sees its own table')
    } finally {
      await first.dispose()
    }
    // Same process, same config, no seams — and the PRODUCTION export, not another
    // factory instance: if any seam state survived, this bind would succeed.
    const second = await startLanGateway(0, { production: true, lanHost })
    try {
      assert.equal(second.status.lan.host, lanHost)
      assert.equal(second.status.lan.listening, false, 'nothing was inherited, so the bind to an unowned address fails')
      assert.match(String(second.status.lan.error), /EADDRNOTAVAIL/)
      assert.equal(second.status.tailscale.addresses.includes(tailscaleHost), false,
        "the first instance's interface table is gone")
    } finally {
      await second.dispose()
    }
  }
  {
    // (15) Mutating the caller's own alias/interface objects after apply() does
    // not change what the listener binds: the instance holds a frozen deep copy,
    // never the caller's objects.
    const lanHost = unownedPrivateAddress()
    const tailscaleHost = unownedTailscaleAddress()
    const callerAliases = { [lanHost]: '127.0.0.1' }
    const callerTable = {
      'Ethernet-Test': [{ address: lanHost, family: 'IPv4', internal: false }],
      tailscale0: [{ address: tailscaleHost, family: 'IPv4', internal: false }],
    }
    const gateway = await startLanGateway(0, {
      seams: { networkInterfaces: callerTable, listenAliases: callerAliases },
    })
    try {
      const before = await readStatus(gateway.base)
      assert.equal(before.lan.listening, true)
      assert.deepEqual(before.tailscale.addresses, [tailscaleHost])
      // The harness now edits its own objects: a different (unowned) alias target
      // would fail to bind, and a different table address would be resolved as
      // the `lan` target.
      const mutatedLanHost = unownedPrivateAddress([lanHost])
      const mutatedTailscaleHost = unownedTailscaleAddress([tailscaleHost])
      callerAliases[lanHost] = mutatedLanHost
      callerTable['Ethernet-Test'][0].address = mutatedLanHost
      callerTable.tailscale0[0].address = mutatedTailscaleHost
      callerTable.tailscale0.push({ address: mutatedTailscaleHost, family: 'IPv4', internal: false })
      const moved = await postJson(gateway.base, '/mgw/listen', { target: 'lan' })
      assert.equal(moved.status, 200, 'the alias in force is the one validated at apply()')
      assert.equal(moved.body.applied, lanHost, 'the interface table in force is the one from apply()')
      assert.equal(moved.body.lan.host, lanHost)
      assert.equal(moved.body.lan.listening, true)
      const after = await readStatus(gateway.base)
      assert.equal(after.lan.port, moved.body.port)
      assert.deepEqual(after.tailscale.addresses, [tailscaleHost], "the caller's table edit did not reach the status")
      assert.equal(await tlsPeerFingerprint(moved.body.port), after.lan.certSha256)
    } finally {
      await gateway.dispose()
    }
  }
  {
    // (16) An alias mutated to 0.0.0.0, :: or a public address after apply()
    // cannot widen the bind. The sealed copy keeps the validated loopback value,
    // so the rebind neither fails (a public target would) nor answers on every
    // local address (a wildcard target would).
    const callerAliases = { '127.0.0.1': '127.0.0.1' }
    const gateway = await startLanGateway(0, { seams: { listenAliases: callerAliases } })
    try {
      const initial = await readStatus(gateway.base)
      assert.equal(initial.lan.listening, true)
      assert.equal(initial.lan.host, '127.0.0.1')
      const interfaceRecords = Object.values(os.networkInterfaces()).flat().filter(Boolean)
      const localIPv4 = interfaceRecords.find((record) => !record.internal && record.family === 'IPv4')?.address
      // `::1` is an INTERNAL record, so it must not be filtered out here.
      const hasV6Loopback = interfaceRecords.some((record) => record.address === '::1')
      for (const widened of ['0.0.0.0', '::', '203.0.113.7']) {
        callerAliases['127.0.0.1'] = widened
        const moved = await postJson(gateway.base, '/mgw/listen', { target: 'loopback' })
        assert.equal(moved.status, 200, `${widened} never reaches the bind`)
        assert.equal(moved.body.applied, '127.0.0.1')
        assert.equal(moved.body.lan.host, '127.0.0.1', 'the status keeps naming the logical host')
        assert.equal(moved.body.lan.listening, true)
        const port = moved.body.port
        // The socket really sits on loopback: a wildcard bind would also answer on
        // this machine's own addresses, which a loopback bind never does.
        if (localIPv4) {
          assert.equal(await tlsReachable(localIPv4, port), false, `${widened} did not widen the bind to ${localIPv4}`)
        }
        if (hasV6Loopback) {
          assert.equal(await tlsReachable('::1', port), false, `${widened} did not widen the bind to ::1`)
        }
        assert.equal(await tlsPeerFingerprint(port), moved.body.lan.certSha256)
      }
    } finally {
      await gateway.dispose()
    }
  }

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
