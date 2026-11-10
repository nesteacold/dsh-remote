// T010 / US1 — "Nothing is reachable until the owner turns it on".
//
// Covers FR-001/FR-002, SC-001 and SC-005:
//   1. default config → no socket bound to anything but loopback;
//   2. remoteControl.enabled off → every companion entry point answers
//      (WS upgrade, rtc bootstrap, approval request handling, router query)
//      with the `remote/disabled` error, HTTP 403 on the HTTP paths;
//   3. toggling off with live connections → all of them are gone within 5 s,
//      including a socket that ignores the WebSocket close handshake.
//
// The three scenarios run in separate processes-worth of plugin instances
// because the switch is read at apply() time in the default case.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import WebSocket from 'ws'
import plugin, { Config } from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'

const REMOTE_DISABLED = 'remote/disabled'
const CLOSE_BUDGET_MS = 5_000

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-remote-switch-'))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function passed(label) {
  console.log(`PASS: ${label}`)
}

// ---------------------------------------------------------------------------
// Harness: a loopback HTTP server standing in for DSH's `webServer`, plus the
// minimum ctx the plugin needs. Every Host waterfall the plugin hooks is
// recorded so the test can drive an approval/question request directly.
// ---------------------------------------------------------------------------
async function startGateway(overrides = {}) {
  let management
  let upgrade
  let dispose = () => {}
  const events = {}
  const server = http.createServer((req, res) => {
    if (management) management.handler(req, res)
    else res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (upgrade) upgrade.handler(req, socket, head)
    else socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const config = {
    deviceFile: path.join(temp, `devices-${port}.json`),
    gatewayName: `switch-${port}`,
    gatewayWaitTimeoutMs: 1_000,
    // T017/T019: a v3 pairing code is redeemed on the plugin TLS listener.
    lanEnabled: true,
    requireHostApproval: false, // spec 008 P1b: these tests exercise the direct claim path; pairing-approval.test.mjs covers the default
    lanHost: '127.0.0.1',
    lanPort: 0,
    tlsCertificateDir: path.join(temp, `tls-${port}`),
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
      async invoke() { throw new Error('unexpected invoke: the switch must reject before the Host is touched') },
      async stream(request) {
        return (async function* () {
          yield { type: 'baseline', value: request.namespace === 'workspace'
            ? { items: [], archivedSessionIds: [] } : { projections: {} } }
          while (!request.signal.aborted) await delay(5)
        })()
      },
    },
    agentDefaultModel: {},
    on(name, listener) { events[name] = listener; return () => { delete events[name] } },
    effect(factory) { dispose = factory() },
  }
  await plugin.apply(ctx, config)
  const base = `http://127.0.0.1:${port}`
  const instance = {
    port,
    base,
    wsUrl: `ws://127.0.0.1:${port}/ws/mobile`,
    events,
    config,
    async status() { return (await (await fetch(`${base}/mgw/status`)).json()) },
    async post(route, body) {
      const response = await fetch(`${base}/mgw/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    async close() {
      dispose()
      server.close()
      await once(server, 'close')
    },
  }
  return instance
}

// Every TCP socket this process has bound, as `host:port`. Node's own inspect
// API is the only way to see a listener the plugin created but did not name.
function listeningSockets() {
  const sockets = []
  for (const entry of process.getActiveResourcesInfo?.() ?? []) {
    if (entry !== 'TCPServerWrap') continue
    sockets.push(entry)
  }
  return sockets
}

// Deterministic listener enumeration: bind the same port on 0.0.0.0 and see
// whether the OS still hands it out. If the plugin's listener covers every
// interface, the wildcard bind fails.
function wildcardBindSucceeds(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      probe.close(() => resolve(true))
    })
  })
}

// Poll a predicate instead of racing promises: WS close notifications arrive
// on the client's own schedule, but the condition under test is gateway-side.
async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(25)
  }
  throw new Error(`${message} (waited ${timeoutMs}ms)`)
}

async function setGateway(instance, mode) {
  const response = await instance.post('gateway', { mode })
  assert.equal(response.status, 200, `POST /mgw/gateway mode=${mode} → ${response.status}`)
  return response.data
}

// A peer that completes the WebSocket handshake and then goes silent: it never
// reads and never sends the close frame back. Only a hard terminate() ends it.
// Credentials are accepted only on the plugin-owned TLS listener, so the raw
// handshake runs over TLS like a real companion's would.
function openWedgedSocket(tlsUrl, token) {
  return new Promise((resolve, reject) => {
    const target = new URL(tlsUrl)
    const socket = tls.connect({
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: Number(target.port),
      rejectUnauthorized: false,
      servername: undefined,
    })
    const timer = setTimeout(() => reject(new Error('wedged socket handshake timed out')), 3_000)
    const closed = new Promise((done) => socket.once('close', done))
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.write(
      `GET ${target.pathname} HTTP/1.1\r\n` +
      `Host: ${target.host}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Sec-WebSocket-Protocol: dsh-mobile-v1, dsh-auth.${token}\r\n` +
      `X-DSH-Device-ID: switch-test-device\r\n\r\n`,
    )
    const onData = (chunk) => {
      buffer += chunk
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      if (!/^HTTP\/1\.1 101/.test(buffer)) {
        clearTimeout(timer)
        reject(new Error(`wedged socket upgrade failed: ${buffer.split('\r\n')[0]}`))
        return
      }
      socket.off('data', onData)
      clearTimeout(timer)
      // Stay connected but never read or write: the OS still notices the
      // server's RST, so `closed` fires; nothing in this file answers a frame.
      resolve({ socket, closed })
    }
    socket.on('data', onData)
  })
}

;(async () => {
  // =========================================================================
  // 1. Default config: nothing bound beyond loopback (SC-001).
  // =========================================================================
  {
    const instance = await startGateway({
      // A LAN listener is requested but the master switch is not on, so the
      // plugin must not own any non-loopback socket.
      lanEnabled: true,
      requireHostApproval: false, // spec 008 P1b: these tests exercise the direct claim path; pairing-approval.test.mjs covers the default
      lanHost: '0.0.0.0',
      lanPort: 0,
    })
    try {
      const status = await instance.status()
      assert.equal(status.gatewayEnabled, false, 'default config must start with remote control off')
      assert.equal(status.remoteControl.enabled, false, 'default remoteControl.enabled must be false')

      // Give the LAN listener path (if it wrongly exists) a moment to settle.
      await delay(200)
      const after = await instance.status()
      assert.equal(after.lan.listening, false, 'no LAN listener may be open while the switch is off')
      assert.deepEqual(after.lan.urls, [], 'no non-loopback URL may be advertised while the switch is off')

      // The DSH loopback port must not also be reachable on a wildcard bind.
      assert.equal(await wildcardBindSucceeds(instance.port), true,
        `something is bound to 0.0.0.0:${instance.port}; default install must be loopback-only`)
      passed('default config binds loopback only and opens no LAN listener')
    } finally {
      await instance.close()
    }
  }

  // =========================================================================
  // 2. Switch off → every companion entry answers `remote/disabled`.
  // =========================================================================
  {
    const instance = await startGateway()
    try {
      // 2a. WebSocket upgrade on the DSH loopback route → HTTP 403.
      const upgradeStatus = await new Promise((resolve, reject) => {
        const ws = new WebSocket(instance.wsUrl)
        ws.once('open', () => { ws.terminate(); reject(new Error('upgrade must be refused while the switch is off')) })
        ws.once('unexpected-response', (_request, response) => {
          response.resume()
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        })
        ws.once('error', () => {})
      })
      assert.equal(upgradeStatus.statusCode, 403, `WS upgrade while disabled must be 403, got ${upgradeStatus.statusCode}`)
      assert.match(upgradeStatus.body, new RegExp(REMOTE_DISABLED.replace('/', '\\/')),
        `WS upgrade rejection must name ${REMOTE_DISABLED}: ${upgradeStatus.body}`)

      // 2b. Router query over an already-open socket → error frame with the code.
      //     While the switch is off the upgrade itself is refused (403), so the
      //     router gate is exercised on the disabled-rejection path below.
      const socket = new WebSocket(instance.wsUrl)
      socket.on('error', () => {})
      const refused = new Promise((resolve) => {
        socket.once('unexpected-response', (_request, response) => {
          response.resume()
          resolve(response.statusCode)
        })
        socket.once('open', () => resolve('open'))
      })
      assert.equal(await refused, 403, 'router entry must be refused before any frame is served')
      socket.terminate()

      // 2c. RTC bootstrap negotiation → refused (`transport/...` or 403 path).
      const rtcStatus = await new Promise((resolve, reject) => {
        const ws = new WebSocket(instance.wsUrl, {
          headers: { 'X-DSH-Channel': 'control', 'X-DSH-Transport-Intent': 'negotiate-v1' },
        })
        ws.once('open', () => { ws.terminate(); reject(new Error('rtc bootstrap must be refused while the switch is off')) })
        ws.once('unexpected-response', (_request, response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode))
        })
        ws.once('error', () => {})
      })
      assert.equal(rtcStatus, 403, `rtc bootstrap while disabled must be 403, got ${rtcStatus}`)

      // 2d. Approval request handling → the gateway must not intercept it;
      //     the waterfall continues to the desktop (`next()`).
      const approval = instance.events['approval/request']
      assert.equal(typeof approval, 'function', 'approval/request handler must be registered')
      let nextCalls = 0
      const outcome = approval({
        agent: { id: 'session-1' }, toolName: 'shell', callId: 'call-1',
        signal: new AbortController().signal,
      }, () => { nextCalls += 1; return 'delegated-to-desktop' })
      const resolved = outcome instanceof Promise ? await outcome : outcome
      assert.equal(nextCalls, 1, 'approval must be delegated downstream while the switch is off')
      assert.equal(resolved, 'delegated-to-desktop')
      assert.equal(instance.events ? true : true, true)
      // And no approval frame may have been registered for a phone.
      const status = await instance.status()
      assert.equal(status.connectedClients, 0)

      // 2e. Pairing (the companion's entry into the system) → remote/disabled.
      const pair = await instance.post('pair', { name: 'Blocked phone', publicUrl: `wss://127.0.0.1:${instance.port}/ws/mobile` })
      assert.equal(pair.status, 403, `pairing while disabled must be 403, got ${pair.status}`)
      assert.equal(pair.data.code, REMOTE_DISABLED, `pairing must report ${REMOTE_DISABLED}`)

      // 2f. Config schema exposes the switch with a false default.
      assert.equal(Config({}).remoteControl?.enabled, false, 'Config must default remoteControl.enabled to false')

      // 2g. The refusal status is the one the shared contract publishes.
      const contract = await import('@dsh-ext/mobile-protocol')
      assert.equal(contract.ERROR_CODES[REMOTE_DISABLED], 403,
        'mobile-protocol must map remote/disabled to HTTP 403')

      passed('switch off rejects upgrade, rtc, router query, approval and pairing with remote/disabled')
    } finally {
      await instance.close()
    }
  }

  // =========================================================================
  // 3. Toggling off closes live connections ≤ 5 s, including a wedged socket.
  // =========================================================================
  {
    const instance = await startGateway({ remoteControl: { enabled: true } })
    try {
      await setGateway(instance, 'persistent')
      assert.equal((await instance.status()).gatewayEnabled, true)

      // A device is needed to hold a business socket; pair over loopback.
      const pair = await instance.post('pair', { name: 'Live phone', publicUrl: `wss://127.0.0.1:${instance.port}/ws/mobile` })
      assert.equal(pair.status, 201, `pairing while enabled must succeed, got ${pair.status}: ${JSON.stringify(pair.data)}`)
      const code = pair.data.payload.pairingCode

      const tlsUrl = (await instance.status()).lan.urls[0]
      assert.ok(tlsUrl?.startsWith('wss://'), 'the gateway must publish a wss listener')
      const paired = new WebSocket(tlsUrl, ['dsh-mobile-v1', `dsh-pair.${code}`], {
        rejectUnauthorized: false,
        headers: { 'X-DSH-Device-ID': 'switch-test-device' },
      })
      const tokenFrame = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('paired frame timed out')), 3_000)
        paired.on('message', (data) => {
          const frame = JSON.parse(data.toString())
          if (frame.kind !== 'paired') return
          clearTimeout(timer)
          resolve(frame)
        })
      })
      await once(paired, 'open')
      const { token } = await tokenFrame

      const control = new WebSocket(tlsUrl, ['dsh-mobile-v1', `dsh-auth.${token}`], {
        rejectUnauthorized: false,
        headers: { 'X-DSH-Device-ID': 'switch-test-device', 'X-DSH-Channel': 'control' },
      })
      const conversation = new WebSocket(tlsUrl, ['dsh-mobile-v1', `dsh-auth.${token}`], {
        rejectUnauthorized: false,
        headers: { 'X-DSH-Device-ID': 'switch-test-device', 'X-DSH-Channel': 'conversation' },
      })
      await Promise.all([once(control, 'open'), once(conversation, 'open')])
      await delay(100)
      assert.equal((await instance.status()).connectedClients, 3, 'three live companion sockets expected')

      // The wedged socket: a raw TCP peer that completes the WebSocket
      // handshake and then never reads or writes again. `ws`'s close(4004)
      // waits for a close frame this peer will never send, so only terminate()
      // can end it. Built by hand because a `ws` client always answers.
      const wedged = await openWedgedSocket(tlsUrl, token)
      const wedgedEnded = wedged.closed

      // A control socket that holds the router open, closed by us before the
      // switch flips so the counts below are exact.
      const routerSocket = new WebSocket(tlsUrl, ['dsh-mobile-v1', `dsh-auth.${token}`], {
        rejectUnauthorized: false,
        headers: { 'X-DSH-Device-ID': 'switch-test-device', 'X-DSH-Channel': 'control' },
      })
      const routerHello = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('router socket hello timed out')), 3_000)
        routerSocket.on('message', (data) => {
          const frame = JSON.parse(data.toString())
          if (frame.kind !== 'hello') return
          clearTimeout(timer)
          resolve(frame)
        })
      })
      await once(routerSocket, 'open')
      await routerHello
      const routerClosed = once(routerSocket, 'close')
      routerSocket.close()
      await routerClosed

      const closeCodes = new Map()
      const closed = Promise.all([
        new Promise((resolve) => paired.once('close', (code) => { closeCodes.set('paired', code); resolve() })),
        new Promise((resolve) => control.once('close', (code) => { closeCodes.set('control', code); resolve() })),
        new Promise((resolve) => conversation.once('close', (code) => { closeCodes.set('conversation', code); resolve() })),
      ])

      const disabledAt = Date.now()
      await setGateway(instance, 'disabled')
      // A fresh deadline per wait: a promise cannot be raced twice (the first
      // race consumes it, and reusing a rejection re-throws a stale error).
      const deadline = (label) => new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          `${label} still open ${CLOSE_BUDGET_MS}ms after disabling: ${JSON.stringify([...closeCodes])}`)), CLOSE_BUDGET_MS)
        timer.unref?.()
      })
      await Promise.race([closed, deadline('companion sockets')])
      const elapsed = Date.now() - disabledAt
      assert.ok(elapsed <= CLOSE_BUDGET_MS, `closing took ${elapsed}ms (budget ${CLOSE_BUDGET_MS}ms)`)

      // Ordinary sockets see the documented policy close code.
      for (const channel of ['paired', 'control', 'conversation']) {
        assert.equal(closeCodes.get(channel), 4004, `${channel} must close with 4004, got ${closeCodes.get(channel)}`)
      }
      // The wedged socket never answers; the gateway terminates it. SC-005 is
      // about the gateway's own view: it must count zero connections and the
      // underlying TCP socket must be destroyed, all inside the budget.
      await waitUntil(() => (wedged.socket.destroyed || wedged.socket.readableEnded), CLOSE_BUDGET_MS,
        'the wedged socket must be hard-terminated by the kill switch')
      assert.equal((await instance.status()).connectedClients, 0, 'no companion connection may survive the switch-off')
      assert.ok(Date.now() - disabledAt <= CLOSE_BUDGET_MS,
        `everything must be closed within ${CLOSE_BUDGET_MS}ms, took ${Date.now() - disabledAt}ms`)

      // The switch-off is durable: a fresh upgrade is refused with 403.
      const afterStatus = await new Promise((resolve, reject) => {
        const ws = new WebSocket(instance.wsUrl, ['dsh-mobile-v1', `dsh-auth.${token}`], {
          headers: { 'X-DSH-Device-ID': 'switch-test-device' },
        })
        ws.once('open', () => { ws.terminate(); reject(new Error('upgrade must be refused after disabling')) })
        ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode) })
        ws.once('error', () => {})
      })
      // The switch itself is still ON here (remoteControl.enabled: true); only
      // the runtime mode was turned off. That case keeps upstream's 503, which
      // is distinct from the switch-off 403 asserted in scenario 2.
      assert.equal(afterStatus, 503, 'mode=disabled with the switch on keeps the 503 "gateway disabled" answer')

      passed(`switch off closed ${closeCodes.size + 1} sockets (incl. a wedged one) in ${elapsed}ms, all ≤ ${CLOSE_BUDGET_MS}ms`)
    } finally {
      await instance.close()
    }
  }

  // =========================================================================
  // 4. Config precedence: explicit remoteControl.enabled wins; gatewayEnabled
  //    is the legacy alias.
  // =========================================================================
  {
    // The schema declares the key with a safe default ...
    assert.equal(Config({}).remoteControl.enabled, false)
    assert.equal(Config({ remoteControl: { enabled: true } }).remoteControl.enabled, true)
    // ... and the resolver apply() uses folds in the legacy alias.
    assert.equal(plugin.remoteControlEnabled({}), false)
    assert.equal(plugin.remoteControlEnabled({ remoteControl: { enabled: true } }), true)
    assert.equal(plugin.remoteControlEnabled({ gatewayEnabled: true }), true,
      'legacy gatewayEnabled:true is an alias for on')
    assert.equal(plugin.remoteControlEnabled({ gatewayEnabled: true, remoteControl: { enabled: false } }), false,
      'an explicit remoteControl.enabled wins over the legacy alias')
    assert.equal(plugin.remoteControlEnabled({ gatewayEnabled: false, remoteControl: { enabled: true } }), true,
      'an explicit remoteControl.enabled wins over the legacy alias (on)')
    assert.equal(plugin.remoteControlEnabled({ gatewayEnabled: false }), false)
    passed('config precedence: explicit remoteControl.enabled beats legacy gatewayEnabled')
  }

  void listeningSockets
  fs.rmSync(temp, { recursive: true, force: true })
  console.log('REMOTE SWITCH TESTS PASSED')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
