// End-to-end (spec 008 P1b): the devices plugin pairs with the REAL in-process
// mobile-gateway through the Host-approval flow.
//   - OTP -> pending (verification code on both sides) -> Host approves -> connected, token stored 0600
//   - the Host narrows scopes on Approve and the stored device reflects it
//   - Host rejects -> the pairing ends "rejected", nothing is stored
//   - wrong OTP -> "wrong or expired", nothing is stored; a burned code stays burned
//   - cancel while waiting removes the pending request on the Host
//   - the advanced long pairing string also waits for approval
// The gateway is imported read-only; nothing in it is edited.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { check, delay, finish, mountPlugin, tempDir } from './helpers.mjs'
import { requestJson } from './fixture-http.mjs'

const gatewayPlugin = (await import('../../mobile-gateway/lib/index.mjs')).default
const { createTestConnection, createTestRemoteAccess } = await import('../../mobile-gateway/test/helpers/peer.mjs')

console.log('e2e-otp')

async function startGateway() {
  const directory = tempDir('dsh-devices-otp-gw-')
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
    // The gateway runs paired devices as non-owner peers and requires DSH remoteAccess (T022a).
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke() { return { items: [] } },
      async stream(request) {
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
  // requireHostApproval is left at its default (true): that is what is under test.
  await gatewayPlugin.apply(ctx, {
    remoteControl: { enabled: true }, gatewayMode: 'persistent', gatewayWaitTimeoutMs: 60_000, gatewayName: `e2e-otp-${port}`,
    deviceFile: path.join(directory, 'devices.json'), publicUrlFile: path.join(directory, 'no-public-url'),
    pairingTtlMs: 60_000, lanEnabled: true, lanHost: '127.0.0.1', lanPort: 0,
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
    if (status.lan?.listening && status.lan.urls.length > 0) { api.lanUrl = status.lan.urls[0]; api.address = new URL(status.lan.urls[0]).host; api.pin = status.lan.certSha256; return api }
    if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

const gateway = await startGateway()
const mounted = await mountPlugin({ requestTimeoutMs: 6000 })

const startPairing = (body) => mounted.call('POST', '/devices/pairings', { body })
const poll = async (id, predicate, attempts = 300) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const view = (await mounted.call('GET', `/devices/pairings/${id}`)).json.pairing
    if (predicate(view)) return view
    await delay(20)
  }
  throw new Error(`pairing ${id} never reached the expected state`)
}
const waitPending = async (count) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const { pending } = await gateway.get('pending')
    if (pending.length === count) return pending
    await delay(20)
  }
  throw new Error(`expected ${count} pending requests on the host`)
}
const newOtp = async (body = {}) => {
  const created = await gateway.post('pair', { mode: 'otp', kind: 'desktop', ...body })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  return created.data.otp
}

let remoteId

await check('OTP -> pending (same verification code on both sides) -> Host approves -> connected, token stored', async () => {
  const otp = await newOtp({ scopes: ['sessions:read', 'prompt:send', 'harness:remote'] })
  const started = await startPairing({ address: gateway.address, otp: `${otp.slice(0, 4)} ${otp.slice(4)}`, name: 'My laptop' })
  assert.equal(started.status, 201, started.text)
  assert.ok(!JSON.stringify(started.json).includes(otp), 'the OTP never appears in the session view')
  const waiting = await poll(started.json.pairing.id, (view) => view.state === 'pending')
  assert.match(waiting.verificationCode, /^\d{3} \d{3}$/)
  const [request] = await waitPending(1)
  assert.equal(request.verificationCode, waiting.verificationCode.replace(' ', ''), 'both sides show the same code')
  assert.deepEqual(request.requestedScopes, ['sessions:read', 'prompt:send', 'harness:remote'])
  assert.equal((await mounted.call('GET', '/devices/remotes')).json.remotes.length, 0, 'nothing is stored before the Host approves')

  // The Host user drops prompt:send and approves.
  const approved = await gateway.post(`pending/${request.id}/approve`, { scopes: ['sessions:read', 'harness:remote'] })
  assert.equal(approved.status, 200, JSON.stringify(approved.data))
  const done = await poll(started.json.pairing.id, (view) => view.state === 'approved')
  assert.ok(done.remoteId)
  remoteId = done.remoteId
  const remote = (await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote
  assert.equal(remote.name, 'My laptop')
  assert.equal(remote.certSha256, gateway.pin, 'the TOFU-recorded pin is stored')
  assert.deepEqual(remote.device.scopes, ['sessions:read', 'harness:remote'], 'the narrowed grant')
  assert.equal(JSON.stringify(remote).includes('token'), false)
  const tokenFile = path.join(mounted.dataDir, 'tokens', `${remoteId}.token`)
  assert.ok(fs.existsSync(tokenFile), 'the token is on disk, never in a response')
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if ((await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote.status === 'online') break
    await delay(20)
  }
  assert.equal((await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote.status, 'online', 'connected with the issued token')
  // The session view is poll-safe after completion and holds no secret.
  assert.ok(!JSON.stringify(done).includes(fs.readFileSync(tokenFile, 'utf8').trim()))
})

await check('Host rejects -> the pairing ends "rejected" and nothing is stored', async () => {
  const before = (await mounted.call('GET', '/devices/remotes')).json.remotes.length
  const otp = await newOtp()
  const started = await startPairing({ address: gateway.address, otp })
  await poll(started.json.pairing.id, (view) => view.state === 'pending')
  const [request] = await waitPending(1)
  assert.equal((await gateway.post(`pending/${request.id}/reject`, {})).status, 200)
  const done = await poll(started.json.pairing.id, (view) => view.state === 'rejected')
  assert.match(done.error, /rejected/)
  assert.equal((await mounted.call('GET', '/devices/remotes')).json.remotes.length, before)
  assert.equal((await gateway.get('devices')).devices.length, 1, 'only the first, approved device exists')
})

await check('wrong OTP -> "wrong or expired", nothing stored; three wrong tries burn the code', async () => {
  const otp = await newOtp()
  const wrong = otp === '00000000' ? '11111111' : '00000000'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = await startPairing({ address: gateway.address, otp: wrong })
    const done = await poll(started.json.pairing.id, (view) => view.state === 'failed')
    assert.match(done.error, /wrong or expired|closed the connection/)
  }
  const late = await startPairing({ address: gateway.address, otp })
  const done = await poll(late.json.pairing.id, (view) => view.state === 'failed')
  assert.match(done.error, /wrong or expired|closed the connection/, 'the burned code is refused even when right')
  assert.equal((await gateway.get('pending')).pending.length, 0)
  assert.equal((await mounted.call('GET', '/devices/remotes')).json.remotes.length, 1)
})

await check('bad input is refused before anything is dialled', async () => {
  assert.equal((await startPairing({ address: gateway.address, otp: '1234' })).status, 400)
  assert.equal((await startPairing({ address: gateway.address })).status, 400)
  assert.equal((await startPairing({ address: gateway.address, otp: '12345678', pairingString: 'x'.repeat(40) })).status, 400)
  assert.equal((await startPairing({ address: '8.8.8.8:3081', otp: '12345678' })).status, 403, 'public addresses are off by default')
  assert.equal((await mounted.call('GET', '/devices/pairings/00000000-0000-4000-8000-000000000000')).status, 404)
})

await check('cancelling while waiting removes the pending request on the Host', async () => {
  const otp = await newOtp()
  const started = await startPairing({ address: gateway.address, otp })
  await poll(started.json.pairing.id, (view) => view.state === 'pending')
  await waitPending(1)
  const cancelled = await mounted.call('DELETE', `/devices/pairings/${started.json.pairing.id}`)
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.json.pairing.state, 'cancelled')
  await waitPending(0)
  assert.equal((await mounted.call('GET', '/devices/remotes')).json.remotes.length, 1, 'a cancelled pairing stores nothing')
})

await check('the advanced pairing string also waits for approval, then pairs', async () => {
  const created = await gateway.post('pair', { kind: 'desktop', publicUrl: gateway.lanUrl })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const started = await startPairing({ address: gateway.address, pairingString: created.data.pairingString })
  assert.equal(started.status, 201, started.text)
  const waiting = await poll(started.json.pairing.id, (view) => view.state === 'pending')
  assert.match(waiting.verificationCode, /^\d{3} \d{3}$/)
  const [request] = await waitPending(1)
  assert.equal((await gateway.get('devices')).devices.length, 1, 'no token before approval')
  assert.equal((await gateway.post(`pending/${request.id}/approve`, {})).status, 200)
  const done = await poll(started.json.pairing.id, (view) => view.state === 'approved')
  assert.equal(done.remoteId, remoteId, 're-pairing the same gateway reuses the remote row')
  assert.equal((await mounted.call('GET', '/devices/remotes')).json.remotes.length, 1)
})

mounted.close()
await gateway.close()
finish('e2e-otp')
