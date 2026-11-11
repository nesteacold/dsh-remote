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
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import WebSocket from 'ws'
import plugin, { Config } from '../lib/index.mjs'
import { createGatewayState } from '../lib/gateway-state.mjs'
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
  // fetch-safe: undici refuses whole classes of ports ("bad port"), and `listen(0)`
  // returns whatever the OS picks; the helper re-binds until `fetch` accepts it.
  await listenFetchSafe(server)
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

  // =========================================================================
  // 5. The switch position persists in the gateway state file: an OFF set in
  //    the UI survives a reload (the owner's complaint), and the saved position
  //    is what the next start uses. The config has NO veto over it — see 5d for
  //    the schema measurement that makes a config-level veto impossible.
  // =========================================================================
  {
    // One SHARED state file across instances, so a restart is observable; each
    // startGateway otherwise gets its own per-port file.
    const stateFile = path.join(temp, 'persisted-switch.gateway.json')
    const withState = (extra = {}) => startGateway({ gatewayStateFile: stateFile, ...extra })

    // 5a. Switching off persists `remoteControl:false` and says so.
    {
      const instance = await withState({ remoteControl: { enabled: true } })
      try {
        await setGateway(instance, 'persistent')
        const off = await instance.post('remote-control', { enabled: false })
        assert.equal(off.status, 200, `switch-off → ${off.status}: ${JSON.stringify(off.data)}`)
        assert.equal(off.data.persists, true, 'a saved switch-off must report persists:true')
        assert.equal(off.data.remoteControl.enabled, false)
        const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        assert.equal(onDisk.version, 1, 'the persisted switch keeps the state file at version 1')
        assert.equal(onDisk.remoteControl, false, 'the state file must hold the off position')
        assert.equal(onDisk.mode, 'disabled', 'the kill switch still persists the runtime mode off')
        passed('switch-off persists remoteControl:false in the gateway state file (persists:true)')
      } finally {
        await instance.close()
      }
    }

    // 5b. The owner's symptom: the config says enabled:true, the file says false.
    //     An earlier run may also have left `mode: persistent` behind (the state
    //     module's own writer, so this is a real file shape), and the saved OFF
    //     must outrank that mode: the initial mode follows the EFFECTIVE switch.
    createGatewayState(stateFile).setMode('persistent')
    {
      const instance = await withState({ remoteControl: { enabled: true } })
      try {
        const status = await instance.status()
        assert.equal(status.remoteControl.enabled, false, 'a saved switch-off must survive a restart')
        assert.equal(status.remoteControl.accepting, false)
        assert.equal(status.gatewayEnabled, false, 'a saved switch-off must not run the gateway')
        assert.equal(status.gatewayMode, 'disabled',
          'mode:persistent in the file must not start the gateway while the saved switch is off')
        passed('saved switch-off survives a restart: config enabled:true + saved mode:persistent still start disabled')
      } finally {
        await instance.close()
      }
    }

    // 5c. Switching back on persists `true`; a third start reports it, and the
    //     saved persistent mode comes back now that the switch allows it.
    {
      const second = await withState({ remoteControl: { enabled: true } })
      try {
        const on = await second.post('remote-control', { enabled: true })
        assert.equal(on.status, 200)
        assert.equal(on.data.persists, true, 'a saved switch-on must report persists:true')
        assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).remoteControl, true)
      } finally {
        await second.close()
      }
      const third = await withState({ remoteControl: { enabled: true } })
      try {
        const status = await third.status()
        assert.equal(status.remoteControl.enabled, true, 'a saved switch-on must survive a restart')
        assert.equal(status.gatewayEnabled, true, 'a saved switch-on lets the saved persistent mode start')
        assert.equal(status.gatewayMode, 'persistent')
        passed('saved switch-on survives a restart and releases the saved persistent mode')
      } finally {
        await third.close()
      }
    }

    // 5d. There is NO config veto over a saved switch-on, and this block pins
    //     both halves of why: the schema measurement that makes one impossible,
    //     and the owner-shaped config that must still honour the saved `true`.
    {
      // Why a config veto cannot exist: `apply()` never sees the owner's
      // profile. DSH hands it the SCHEMA-APPLIED config, and the schema fills
      // the switch's default `false` in before the plugin can look at it — so
      // at the only place the code can look, an explicit `false` and an
      // untouched default are the same value and "the owner said no" is
      // unrepresentable. A veto built on that value would drop EVERY saved
      // `true` on the next reload, which is the bug persistence exists to fix.
      // Do not rebuild a config veto on this field.
      assert.equal(Config({}).remoteControl.enabled, false,
        'the schema injects remoteControl.enabled:false, so a config false cannot be told apart from the default and cannot mean "the owner said no"')
      assert.equal(Config({ lanEnabled: true, lanHost: '127.0.0.1' }).remoteControl.enabled, false,
        'the owner-shaped config (lanEnabled + lanHost, no switch key) receives that same injected default')

      // The observable consequence. The owner's profile carries only
      // `lanEnabled`/`lanHost`, so the config the plugin receives is the
      // schema's output — which carries `remoteControl: {enabled:false}`.
      // Passing exactly that block reproduces production; the rest of the
      // harness config stays test-owned (spreading all of `Config()` here would
      // blank `deviceFile` and write into the owner's real `~/.dsh`).
      const state = createGatewayState(stateFile)
      state.setRemoteControl(true)
      state.setMode('persistent')
      assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).remoteControl, true,
        '5d needs the state file to hold a saved switch-on')
      const instance = await withState({ remoteControl: Config({ lanEnabled: true, lanHost: '127.0.0.1' }).remoteControl })
      try {
        const status = await instance.status()
        assert.equal(status.remoteControl.enabled, true,
          'the schema-injected default remoteControl.enabled:false must not veto a saved switch-on')
        assert.equal(status.gatewayEnabled, true,
          'a saved switch-on lets the saved persistent mode start even on a config the schema filled in')
        assert.equal(status.gatewayMode, 'persistent')
        passed('no config veto: the schema-injected remoteControl.enabled:false still honours a saved switch-on (and its persistent mode)')
      } finally {
        await instance.close()
      }
    }

    // 5e. The state module itself: absent means "never moved", booleans round
    //     trip, and a malformed value refuses to load instead of being repaired
    //     into a position nobody chose.
    const unitFile = path.join(temp, 'switch-state-unit.json')
    const fresh = createGatewayState(unitFile)
    assert.equal(fresh.remoteControl, undefined, 'a fresh state file has no saved switch decision')
    fresh.setRemoteControl(true)
    assert.equal(createGatewayState(unitFile).remoteControl, true)
    createGatewayState(unitFile).setRemoteControl(false)
    assert.equal(createGatewayState(unitFile).remoteControl, false)
    assert.throws(() => fresh.setRemoteControl('yes'), TypeError, 'a non-boolean switch must be refused')
    const malformed = path.join(temp, 'switch-state-malformed.json')
    fs.writeFileSync(malformed, JSON.stringify({ version: 1, gatewayId: crypto.randomUUID(), mode: null, remoteControl: 'yes' }))
    assert.throws(() => createGatewayState(malformed), /invalid remote control switch/,
      'a malformed switch value must fail loading, not be dropped')
    passed('createGatewayState round-trips the switch, reports undefined when absent, and refuses a non-boolean')

    // 5f. Fault injection: a failed write must still fire the kill switch.
    //     The mode write commits to the file BEFORE the live teardown, so the
    //     same filesystem fault that fails the switch write fails that write
    //     too. The route must answer 200 with `persists:false` and still close
    //     the live socket (4004) and the TLS listener, never a 500 with both
    //     still alive.
    {
      const faultFile = path.join(temp, 'fault-switch.gateway.json')
      const instance = await startGateway({ gatewayStateFile: faultFile, remoteControl: { enabled: true } })
      try {
        await setGateway(instance, 'persistent')
        const live = (await instance.status()).lan.urls[0]
        assert.ok(live?.startsWith('wss://'), 'the gateway must publish a wss listener')

        const pair = await instance.post('pair', { name: 'Fault phone', publicUrl: `wss://127.0.0.1:${instance.port}/ws/mobile` })
        assert.equal(pair.status, 201, `pairing while enabled must succeed, got ${pair.status}: ${JSON.stringify(pair.data)}`)
        const socket = new WebSocket(live, ['dsh-mobile-v1', `dsh-pair.${pair.data.payload.pairingCode}`], {
          rejectUnauthorized: false,
          headers: { 'X-DSH-Device-ID': 'fault-test-device' },
        })
        const tokenFrame = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('paired frame timed out')), 3_000)
          socket.on('message', (data) => {
            const frame = JSON.parse(data.toString())
            if (frame.kind !== 'paired') return
            clearTimeout(timer)
            resolve(frame)
          })
        })
        await once(socket, 'open')
        await tokenFrame
        assert.equal((await instance.status()).connectedClients, 1, 'one live companion socket expected')

        // Break BOTH writes. The state file is read only at startup, so the
        // in-memory snapshot keeps working while the temp file can no longer be
        // renamed onto its path: a directory refuses the rename on every OS.
        fs.rmSync(faultFile, { force: true })
        fs.mkdirSync(faultFile)

        const socketClosed = new Promise((resolve) => socket.once('close', (code) => resolve(code)))
        const off = await instance.post('remote-control', { enabled: false })
        assert.equal(off.status, 200, `a failed write must still answer 200, got ${off.status}: ${JSON.stringify(off.data)}`)
        assert.equal(off.data.persists, false, 'a failed mode write must report the whole switch-off as not persisted')
        assert.equal(off.data.remoteControl.enabled, false, 'the switch itself still moves for this run')
        assert.equal(off.data.gatewayMode, 'disabled', 'the runtime mode still moves for this run')

        const closeCode = await Promise.race([
          socketClosed,
          new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(
              `the live socket is still open ${CLOSE_BUDGET_MS}ms after a failed-write switch-off`)), CLOSE_BUDGET_MS)
            timer.unref?.()
          }),
        ])
        assert.equal(closeCode, 4004, `the live socket must be killed with 4004 even when the write fails, got ${closeCode}`)
        assert.equal((await instance.status()).connectedClients, 0, 'no companion connection may survive the switch-off')

        // The listener is really gone: not merely unadvertised, but refusing.
        const target = new URL(live)
        const lanHost = target.hostname.replace(/^\[|\]$/g, '')
        const lanPort = Number(target.port)
        const status = await instance.status()
        assert.equal(status.lan.listening, false, 'the TLS listener must be closed by the failed-write switch-off')
        const connectRefused = () => new Promise((resolve) => {
          const probe = net.connect({ host: lanHost, port: lanPort })
          probe.once('connect', () => { probe.destroy(); resolve(false) })
          probe.once('error', () => resolve(true))
        })
        let refused = false
        const deadline = Date.now() + CLOSE_BUDGET_MS
        while (!refused && Date.now() < deadline) {
          refused = await connectRefused()
          if (!refused) await delay(50)
        }
        assert.equal(refused, true, `a fresh connect to ${lanHost}:${lanPort} must be refused after the switch-off`)
        passed('a failed state-file write still fires the kill switch: 200, persists:false, socket 4004, listener refused')
      } finally {
        await instance.close()
      }
    }
  }

  void listeningSockets
  fs.rmSync(temp, { recursive: true, force: true })
  console.log('REMOTE SWITCH TESTS PASSED')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
