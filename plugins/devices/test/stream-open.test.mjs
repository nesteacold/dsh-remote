// Spec 008 defect fix (live finding a): a remote stream that cannot open must
// FAIL FAST, never keep the consumer waiting. The REAL plugins/mobile-gateway
// runs in-process (fake Host carrier, as e2e.test.mjs does) and acts as the
// remote Host; only the fake carrier's `openWireStream` behaviour changes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { test } from 'node:test'

import { delay, mountPlugin, tempDir } from './helpers.mjs'
import { requestJson } from './fixture-http.mjs'

const gatewayPlugin = (await import('../../mobile-gateway/lib/index.mjs')).default
const { createTestConnection, createTestRemoteAccess } = await import('../../mobile-gateway/test/helpers/peer.mjs')

// The connection's request timeout doubles as the bounded stream-open wait.
const OPEN_TIMEOUT_MS = 400

/** The Host's own workspace follow fails: its workspaceController Service is not there. */
const hostUnavailable = () => Object.assign(
  new Error('workspace/follow: active Service "workspaceController" is unavailable'),
  { code: 'gateway/service-unavailable' })

async function startGateway() {
  const directory = tempDir('dsh-devices-stream-')
  let management
  let upgrade
  let dispose = () => {}
  // The Host carrier. `open` is what each test installs as the current behaviour;
  // `openWireStream` keeps the rc.1 arity (>= 5) the bridge probes for.
  const host = {
    async invoke() { return {} },
    async stream() { return (async function* () {})() },
    async dispatchRpc() { return { ok: true, value: {} } },
    open: async () => { throw hostUnavailable() },
    async openWireStream(endpoint, payload, uplink, peer, signal, control) {
      return host.open(endpoint, payload, uplink, peer, signal, control)
    },
  }
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) { management.handler(req, res); return }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: host,
    agentDefaultModel: {},
    on() { return () => {} },
    effect(fn) { dispose = fn() },
  }
  await gatewayPlugin.apply(ctx, {
    remoteControl: { enabled: true }, gatewayMode: 'persistent', gatewayWaitTimeoutMs: 60_000, gatewayName: `stream-${port}`,
    deviceFile: path.join(directory, 'devices.json'), publicUrlFile: path.join(directory, 'no-public-url'),
    pairingTtlMs: 60_000, lanEnabled: true, lanHost: '127.0.0.1', lanPort: 0,
    requireHostApproval: false,
  })
  const base = `http://127.0.0.1:${port}`
  const api = {
    base, host,
    post(route, body) { return requestJson(base, 'POST', `/mgw/${route}`, { body: body ?? {}, headers: { Origin: base } }) },
    async get(route) { return (await requestJson(base, 'GET', `/mgw/${route}`)).data },
    async close() { dispose(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }) },
  }
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const status = await api.get('status')
    if (status.lan?.listening && status.lan.urls.length > 0) { api.lanUrl = status.lan.urls[0]; return api }
    if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

const gateway = await startGateway()
const mounted = await mountPlugin({ requestTimeoutMs: OPEN_TIMEOUT_MS })
const created = await gateway.post('pair', { kind: 'desktop', scopes: ['sessions:read', 'harness:remote'], publicUrl: gateway.lanUrl })
const paired = await mounted.call('POST', '/devices/remotes', {
  body: { address: new URL(gateway.lanUrl).host, pairingString: created.data.pairingString },
})
assert.equal(paired.status, 201, paired.text)
const connection = mounted.instance.live.get(paired.json.remote.id).connection
await connection.connect()

// Every frame this device sends, so the cancel can be asserted, not assumed.
const sent = []
const wsSend = connection.ws.send
connection.ws.send = function record(data, callback) {
  try { sent.push(JSON.parse(String(data))) } catch { /* binary frames are never ours */ }
  return wsSend.call(this, data, callback)
}

/** Drain a stream, returning the frames; a hang fails the test instead of pausing it. */
async function drain(source, ms = OPEN_TIMEOUT_MS * 4) {
  const values = []
  const walk = (async () => { for await (const frame of source) values.push(frame) })()
  walk.catch(() => {})
  await Promise.race([walk, delay(ms).then(() => { throw new Error(`the stream neither yielded nor ended within ${ms} ms`) })])
  return values
}

test.after(async () => {
  connection.close()
  mounted.close()
  await gateway.close()
})

test('a refused stream open rejects with the Host code, well before the open timeout', async () => {
  gateway.host.open = async () => { throw hostUnavailable() }
  const started = Date.now()
  const source = await connection.openStream('workspace/follow', {})
  await assert.rejects(() => drain(source), (error) => error.code === 'gateway/service-unavailable'
    && /workspaceController/.test(error.message))
  const elapsed = Date.now() - started
  assert.ok(elapsed < OPEN_TIMEOUT_MS, `the refusal must not wait for the open timeout (took ${elapsed} ms)`)
  assert.equal(connection.wireStreams.size, 0, 'the failed stream is released')
})

test('a remote-stream-closed that lands before the consumer iterates still rejects', async () => {
  gateway.host.open = async () => { throw hostUnavailable() }
  const source = await connection.openStream('workspace/follow', {})
  // The refusal arrives while nobody iterates: it must be kept for the reader,
  // not dropped (a dropped close would look like a silently empty stream).
  await delay(150)
  await assert.rejects(() => drain(source), (error) => error.code === 'gateway/service-unavailable')
})

test('a Host that answers the open with nothing rejects with remote/stream-open-timeout and is cancelled', async () => {
  let hostSignal
  // The carrier open never settles and no frame is ever sent: the silent Host.
  gateway.host.open = (endpoint, payload, uplink, peer, signal) => {
    hostSignal = signal
    return new Promise(() => {})
  }
  const started = Date.now()
  const source = await connection.openStream('workspace/follow', {})
  const streamId = [...connection.wireStreams.keys()].at(-1)
  // A busy stream has one id; the open must be on it.
  assert.match(streamId, /^dev-s-[A-Za-z0-9._-]+$/)
  await assert.rejects(() => drain(source), (error) => error.code === 'remote/stream-open-timeout')
  const elapsed = Date.now() - started
  assert.ok(elapsed >= OPEN_TIMEOUT_MS - 25, `the bounded wait must be honoured (rejected after ${elapsed} ms)`)
  assert.deepEqual(sent.filter((frame) => frame.type === 'remote-stream-cancel').map((frame) => frame.streamId), [streamId],
    'exactly one cancel names the silent stream')
  // The cancel reached the Host: the bridge aborted the carrier signal it passed on.
  for (let attempt = 0; attempt < 100 && !hostSignal?.aborted; attempt += 1) await delay(10)
  assert.equal(hostSignal?.aborted, true, 'the Host-side carrier was cancelled')
  assert.equal(connection.wireStreams.size, 0, 'the timed-out stream is released')
})

test('a normal stream still streams and closes cleanly', async () => {
  gateway.host.open = async () => (async function* () {
    yield { type: 'baseline', value: { items: [{ workspaceId: 'w1' }], archivedSessionIds: [] } }
    yield { type: 'upsert', value: { workspaceId: 'w2' } }
  })()
  const frames = await drain(await connection.openStream('workspace/follow', {}))
  assert.deepEqual(frames.map((frame) => frame.type), ['baseline', 'upsert'])
  await delay(50) // a late close must not resurrect anything
  assert.equal(connection.wireStreams.size, 0)
})
