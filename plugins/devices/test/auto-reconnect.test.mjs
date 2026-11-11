// Spec 008 link supervisor (lib/index.mjs): a paired remote Host is re-dialled by
// itself — once when the plugin applies, then with a bounded backoff after an
// unexpected drop — so the remote workspace group returns without a human pressing
// Reconnect. The REAL plugins/mobile-gateway runs in-process as the remote (as
// e2e.test.mjs does); nothing in it is edited. This file imports no `fetch`: the
// fixture servers listen on an OS-chosen port, and undici refuses some of them.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { check, delay, finish, mountPlugin, tempDir } from './helpers.mjs'
import { requestJson } from './fixture-http.mjs'

const gatewayPlugin = (await import('../../mobile-gateway/lib/index.mjs')).default
const { createTestConnection, createTestRemoteAccess } = await import('../../mobile-gateway/test/helpers/peer.mjs')

console.log('auto-reconnect')

// Tens of milliseconds, so the whole 4-step sequence runs inside a check without
// wall-clock sleeps longer than it needs. `attempt` must not exceed its length.
const DELAYS = [60, 120, 200, 300]
const BACKOFF = [100, 150, 250, 400]

async function startGateway() {
  const directory = tempDir('dsh-devices-gw-')
  let management
  let upgrade
  let dispose = () => {}
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
    typertGateway: {
      async invoke() { return {} },
      async stream() {
        return (async function* () {
          while (true) await delay(10)
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(fn) { dispose = fn() },
  }
  await gatewayPlugin.apply(ctx, {
    remoteControl: { enabled: true }, gatewayMode: 'persistent', gatewayWaitTimeoutMs: 60_000, gatewayName: `auto-reconnect-${port}`,
    deviceFile: path.join(directory, 'devices.json'), publicUrlFile: path.join(directory, 'no-public-url'),
    pairingTtlMs: 60_000, lanEnabled: true, lanHost: '127.0.0.1', lanPort: 0,
    requireHostApproval: false,
  })
  const base = `http://127.0.0.1:${port}`
  const api = {
    base,
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

/** Pair the fixture gateway from `mounted`; returns the plugin's remote view. */
async function pair(mounted) {
  const created = await gateway.post('pair', { kind: 'desktop', publicUrl: gateway.lanUrl })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const answer = await mounted.call('POST', '/devices/remotes',
    { body: { address: new URL(gateway.lanUrl).host, pairingString: created.data.pairingString } })
  assert.equal(answer.status, 201, answer.text)
  return answer.json.remote
}

async function setGateway(mode) {
  const answer = await gateway.post('gateway', { mode })
  assert.equal(answer.status, 200, JSON.stringify(answer.data))
}

async function waitLan(listening) {
  await until(async () => {
    const status = await gateway.get('status')
    return listening ? status.lan?.listening === true && status.lan.urls[0] === gateway.lanUrl : status.lan?.listening !== true
  }, `gateway TLS listener ${listening ? 'up' : 'down'}`)
}

/** Whatever a failed check left behind must not leak into the next one. */
async function ensureGatewayOn() {
  try {
    const status = await gateway.get('status')
    if (status.lan?.listening !== true) { await gateway.post('gateway', { mode: 'persistent' }); await waitLan(true) }
  } catch { /* the next check reports it */ }
}

const routedHosts = async (mounted) => (await mounted.call('GET', '/devices/remotes')).json.routing.hosts.map((host) => host.hostId)
const redialLines = (logs, from) => logs.slice(from).filter((line) => line.includes('redialling'))

await check('start-up: a stored pairing reaches its host with no Reconnect request', async () => {
  const dataDir = tempDir()
  let remoteId
  const first = await mountPlugin({ dataDir, requestTimeoutMs: 6000 })
  try {
    remoteId = (await pair(first)).id
    await until(async () => (await viewOf(first, remoteId)).status === 'online', 'the first mount online')
  } finally { first.instance.teardown() } // stop the plugin, keep the paired data dir

  const second = await mountPlugin({ dataDir, requestTimeoutMs: 6000, reconnectDelaysMs: DELAYS })
  try {
    // This mount made no route call at all: only the supervisor dialled.
    const online = await until(async () => {
      const remote = await viewOf(second, remoteId)
      return remote.status === 'online' ? remote : null
    }, 'online again from start-up dial')
    assert.equal(online.retry, null)
    assert.ok((await routedHosts(second)).includes(remoteId), 'the host is routable without a manual connect')
  } finally { second.close() }
})

await check('an unexpected drop goes offline with a scheduled retry, then returns by itself and is routed again', async () => {
  const mounted = await mountPlugin({ dataDir: tempDir(), requestTimeoutMs: 6000, reconnectDelaysMs: DELAYS })
  try {
    const remoteId = (await pair(mounted)).id
    await until(async () => (await viewOf(mounted, remoteId)).status === 'online', 'online after pairing')
    assert.ok((await routedHosts(mounted)).includes(remoteId))

    await setGateway('disabled')
    const offline = await until(async () => {
      const remote = await viewOf(mounted, remoteId)
      return remote.status === 'offline' && remote.retry ? remote : null
    }, 'offline with a scheduled retry')
    assert.equal(typeof offline.retry.attempt, 'number')
    assert.equal(typeof offline.retry.nextAt, 'number')
    assert.equal((await routedHosts(mounted)).includes(remoteId), false, 'a dropped host is not routable while it is down')

    await setGateway('persistent')
    await waitLan(true)
    const back = await until(async () => {
      const remote = await viewOf(mounted, remoteId)
      return remote.status === 'online' ? remote : null
    }, 'online again after the gateway came back')
    assert.equal(back.retry, null)
    assert.ok((await routedHosts(mounted)).includes(remoteId), 'routing.hosts lists it again')
    assert.ok(mounted.logs.some((line) => /redial in \d+ ms \(attempt 1\)/.test(line)), 'the schedule was logged')
    assert.ok(mounted.logs.some((line) => /link back online \(attempt \d+\)/.test(line)), 'the recovery was logged')
  } finally { await ensureGatewayOn(); mounted.close() }
})

await check('backoff is bounded by reconnectDelaysMs and starts over after a successful reconnect', async () => {
  // A short stability window (clamped up to the 100 ms floor): the sequence starts
  // over only after the link has stayed online that long, so the wait below is part
  // of what this check proves, not a slack.
  const mounted = await mountPlugin({ dataDir: tempDir(), requestTimeoutMs: 6000, reconnectDelaysMs: BACKOFF, reconnectStableMs: 100 })
  try {
    const remoteId = (await pair(mounted)).id
    await until(async () => (await viewOf(mounted, remoteId)).status === 'online', 'online after pairing')

    await setGateway('disabled')
    const seen = []
    let last = null
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const remote = await viewOf(mounted, remoteId)
      if (remote.retry && remote.retry.attempt !== last) { last = remote.retry.attempt; seen.push(last) }
      if (last === BACKOFF.length) break
      await delay(5)
    }
    assert.deepEqual(seen, [1, 2, 3, 4], `the sequence was ${JSON.stringify(seen)}`)

    // The tail repeats the last delay instead of growing without bound.
    const tail = new Set()
    for (let tick = 0; tick < 70; tick += 1) {
      const remote = await viewOf(mounted, remoteId)
      if (remote.retry) tail.add(remote.retry.attempt)
      await delay(10)
    }
    assert.deepEqual([...tail], [BACKOFF.length], 'the attempt number stops at the last step')

    await setGateway('persistent')
    await waitLan(true)
    await until(async () => (await viewOf(mounted, remoteId)).status === 'online', 'online after the gateway came back')
    // The link must stay up for the stability window before the sequence resets.
    await delay(250)
    assert.ok(mounted.logs.some((line) => /link stable, retry sequence reset \(was attempt \d+\)/.test(line)),
      'the reset is logged only once the link proved itself')

    // A successful link resets the sequence: the next drop starts at the first delay.
    await setGateway('disabled')
    const restarted = await until(async () => {
      const remote = await viewOf(mounted, remoteId)
      return remote.retry ? remote.retry.attempt : 0
    }, 'attempt 1 after the reset')
    assert.equal(restarted, 1, 'the backoff started over after success')
    await setGateway('persistent')
    await waitLan(true)
    await until(async () => (await viewOf(mounted, remoteId)).status === 'online', 'online at the end')
  } finally { await ensureGatewayOn(); mounted.close() }
})

await check('4401 revocation wipes the token and never schedules a redial', async () => {
  const mounted = await mountPlugin({ dataDir: tempDir(), requestTimeoutMs: 6000, reconnectDelaysMs: DELAYS })
  try {
    const paired = await pair(mounted)
    const remoteId = paired.id
    await until(async () => (await viewOf(mounted, remoteId)).status === 'online', 'online after pairing')
    const tokenFile = path.join(mounted.dataDir, 'tokens', `${remoteId}.token`)
    assert.ok(fs.existsSync(tokenFile), 'the token file exists while paired')

    assert.equal((await gateway.post(`devices/${paired.device.id}/revoke`)).status, 200)
    await until(async () => !fs.existsSync(tokenFile), 'the token wiped after 4401')
    const revoked = await until(async () => {
      const remote = await viewOf(mounted, remoteId)
      return remote.status === 'revoked' ? remote : null
    }, 'revoked')
    assert.equal(revoked.retry, null)

    const mark = mounted.logs.length
    await delay(700) // longer than every configured delay: a redial would have happened
    const settled = await viewOf(mounted, remoteId)
    assert.equal(settled.status, 'revoked')
    assert.equal(settled.retry, null)
    assert.equal(redialLines(mounted.logs, mark).length, 0, '4401 is never retried')
  } finally { mounted.close() }
})

await check('DELETE cancels a pending retry: nothing is dialled after the removal', async () => {
  const mounted = await mountPlugin({ dataDir: tempDir(), requestTimeoutMs: 6000, reconnectDelaysMs: DELAYS })
  try {
    const remoteId = (await pair(mounted)).id
    await until(async () => (await viewOf(mounted, remoteId)).status === 'online', 'online after pairing')
    await setGateway('disabled')
    await until(async () => (await viewOf(mounted, remoteId)).retry, 'a pending retry')

    const mark = mounted.logs.length
    const removed = await mounted.call('DELETE', `/devices/remotes/${remoteId}`)
    assert.equal(removed.status, 200, removed.text)
    assert.equal((await mounted.call('GET', `/devices/remotes/${remoteId}`)).status, 404)
    await delay(600) // longer than the last configured delay
    assert.equal(redialLines(mounted.logs, mark).length, 0, 'a removed remote is never dialled')
    assert.deepEqual((await mounted.call('GET', '/devices/remotes')).json.remotes, [])
  } finally { await ensureGatewayOn(); mounted.close() }
})

await check('teardown clears the pending retry: no dial and no timer left behind', async () => {
  const mounted = await mountPlugin({ dataDir: tempDir(), requestTimeoutMs: 6000, reconnectDelaysMs: DELAYS })
  const remoteId = (await pair(mounted)).id
  await until(async () => (await viewOf(mounted, remoteId)).status === 'online', 'online after pairing')
  await setGateway('disabled')
  await until(async () => (await viewOf(mounted, remoteId)).retry, 'a pending retry')

  const mark = mounted.logs.length
  try {
    mounted.close()
    await delay(600) // longer than the last configured delay
    assert.equal(redialLines(mounted.logs, mark).length, 0, 'teardown stops the supervisor')
  } finally { await ensureGatewayOn() }
})

await check('autoReconnect: false restores explicit-only dialling: no start-up dial and no redial after a drop', async () => {
  const dataDir = tempDir()
  let remoteId
  const first = await mountPlugin({ dataDir, requestTimeoutMs: 6000 })
  try {
    remoteId = (await pair(first)).id
    await until(async () => (await viewOf(first, remoteId)).status === 'online', 'online after pairing')
  } finally { first.instance.teardown() } // stop the plugin, keep the paired data dir

  const mounted = await mountPlugin({ dataDir, requestTimeoutMs: 6000, autoReconnect: false, reconnectDelaysMs: DELAYS })
  try {
    await delay(300)
    const idle = await viewOf(mounted, remoteId)
    assert.equal(idle.status, 'offline', 'no start-up dial')
    assert.equal(idle.retry, null)
    assert.equal(mounted.logs.filter((line) => line.includes('redial')).length, 0)

    // An explicit dial still works with the option off; its own drop is not retried.
    const up = await mounted.call('POST', `/devices/remotes/${remoteId}/connect`)
    assert.equal(up.status, 200, up.text)
    assert.equal(up.json.state, 'online')
    const mark = mounted.logs.length
    await setGateway('disabled')
    await until(async () => (await viewOf(mounted, remoteId)).status === 'offline', 'offline after the drop')
    await delay(600)
    const down = await viewOf(mounted, remoteId)
    assert.equal(down.status, 'offline')
    assert.equal(down.retry, null)
    assert.equal(redialLines(mounted.logs, mark).length, 0, 'no redial with autoReconnect: false')
  } finally { await ensureGatewayOn(); mounted.close() }
})

await gateway.close()
finish('auto-reconnect')
