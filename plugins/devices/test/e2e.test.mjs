// End-to-end (spec 008): the REAL plugins/mobile-gateway runs in-process (fake
// Host, as plugins/mobile-gateway/test/scope-kind.test.mjs does) and acts as the
// remote. The devices plugin pairs with it as a `desktop` device over pinned
// TLS, lists sessions, reads history, sends a prompt and decides an approval.
// The gateway is imported read-only; nothing in it is edited.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'

import { check, delay, finish, mountPlugin, tempDir } from './helpers.mjs'

const require = createRequire(import.meta.url)
const gatewayPlugin = (await import('../../mobile-gateway/lib/index.mjs')).default
const { createTestConnection, createTestRemoteAccess } = await import('../../mobile-gateway/test/helpers/peer.mjs')
void require

console.log('e2e')

async function startGateway() {
  const directory = tempDir('dsh-devices-gw-')
  const listeners = {}
  let management
  let upgrade
  let dispose = () => {}
  const hostCalls = []
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
      async invoke(request) {
        hostCalls.push(`${request.namespace}/${request.method}`)
        if (request.namespace === 'session' && request.method === 'list') return { items: [{ sessionId: 's1', running: false, projections: { values: { title: 'Fix the build' } } }] }
        if (request.namespace === 'session' && request.method === 'prompt') return { accepted: true }
        return {}
      },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'session' && request.method === 'follow') {
            // The adapter serves `history` from the follow snapshot (dsh-host-adapter sessionSnapshot).
            yield { type: 'snapshot', header: { version: 4, id: request.args.request.address.sessionId }, cursor: 1,
              records: [], hasMore: false, projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } }
          } else {
            yield { type: 'baseline', value: request.namespace === 'workspace' ? { items: [], archivedSessionIds: [] } : { projections: {} } }
          }
          while (!request.signal.aborted) await delay(10)
        })()
      },
    },
    agentDefaultModel: {},
    on(name, handler) { listeners[name] = handler; return () => {} },
    effect(fn) { dispose = fn() },
  }
  await gatewayPlugin.apply(ctx, {
    remoteControl: { enabled: true }, gatewayMode: 'persistent', gatewayWaitTimeoutMs: 60_000, gatewayName: `e2e-${port}`,
    deviceFile: path.join(directory, 'devices.json'), publicUrlFile: path.join(directory, 'no-public-url'),
    pairingTtlMs: 60_000, lanEnabled: true, lanHost: '127.0.0.1', lanPort: 0,
    // The direct long-string claim; the Host-approval flow is covered by e2e-otp.test.mjs.
    requireHostApproval: false,
    // The schema floor (1 MiB): a ~1.2 MB result does not fit one frame and must be streamed.
    maxPayloadBytes: 1024 * 1024,
  })
  const base = `http://127.0.0.1:${port}`
  const api = {
    base, hostCalls, listeners, typertGateway: ctx.typertGateway,
    async post(route, body) {
      const response = await fetch(`${base}/mgw/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body ?? {}) })
      return { status: response.status, data: await response.json() }
    },
    async get(route) { return (await fetch(`${base}/mgw/${route}`)).json() },
    async close() { dispose(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }) },
  }
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const status = await api.get('status')
    if (status.lan?.listening && status.lan.urls.length > 0) { api.lanUrl = status.lan.urls[0]; api.pin = status.lan.certSha256; return api }
    if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

const gateway = await startGateway()
const mounted = await mountPlugin({ requestTimeoutMs: 6000 })
let remoteId
let pairingString

await check('gateway issues a desktop pairing string; devices plugin pairs over pinned TLS', async () => {
  const created = await gateway.post('pair', { kind: 'desktop', publicUrl: gateway.lanUrl })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  pairingString = created.data.pairingString
  assert.equal(created.data.payload.certSha256, gateway.pin)
  const address = new URL(gateway.lanUrl).host
  const answer = await mounted.call('POST', '/devices/remotes', { body: { address, pairingString } })
  assert.equal(answer.status, 201, answer.text)
  remoteId = answer.json.remote.id
  assert.equal(answer.json.remote.device.kind, 'desktop')
  assert.deepEqual(answer.json.remote.device.scopes, ['sessions:read', 'prompt:send', 'approval:respond'])
  const registered = (await gateway.get('devices')).devices
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'desktop')
  // The one-time code is spent: replaying the same string is refused.
  const replay = await mounted.call('POST', '/devices/remotes', { body: { address, pairingString } })
  assert.ok(replay.status >= 400, `replayed pairing string must fail, got ${replay.status}`)
})

await check('lists sessions of the remote host', async () => {
  const answer = await mounted.call('GET', `/devices/remotes/${remoteId}/sessions`)
  assert.equal(answer.status, 200, answer.text)
  assert.equal(answer.json.sessions.length, 1)
  assert.equal(answer.json.sessions[0].sessionId, 's1')
  assert.equal(answer.json.sessions[0].projections.values.title, 'Fix the build')
  const detail = (await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote
  assert.equal(detail.status, 'online')
})

await check('reads history and sends a prompt (idempotent clientMsgId)', async () => {
  const history = await mounted.call('GET', `/devices/remotes/${remoteId}/history?sessionId=s1`)
  assert.equal(history.status, 200, history.text)
  assert.equal(history.json.history.kind, 'history')
  const body = { sessionId: 's1', text: 'run the tests', clientMsgId: 'e2e-msg-0001' }
  const first = await mounted.call('POST', `/devices/remotes/${remoteId}/prompt`, { body })
  assert.equal(first.status, 200, first.text)
  assert.equal(first.json.sent.kind, 'sent')
  const again = await mounted.call('POST', `/devices/remotes/${remoteId}/prompt`, { body })
  assert.equal(again.status, 200, again.text)
  assert.equal(gateway.hostCalls.filter((call) => call === 'session/prompt').length, 1, 'the retry did not reach the Host twice')
  assert.equal((await mounted.call('POST', `/devices/remotes/${remoteId}/prompt`, { body: { sessionId: 's1' } })).status, 400)
})

await check('approval round trip: buffered for the UI, decided with the echoed argsHash, resolved on the Host', async () => {
  const desktopAnswer = Promise.withResolvers()
  gateway.listeners['session/event']({ id: 's1' }, { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 0, callId: 'e2e-call-1', name: 'bash', arguments: '{"command":"ls"}' } })
  const pending = gateway.listeners['approval/request']({ agent: { id: 's1' }, toolName: 'bash', callId: 'e2e-call-1', reason: 'spec 008 e2e', signal: new AbortController().signal }, () => desktopAnswer.promise)
  let card
  for (let attempt = 0; attempt < 200 && !card; attempt += 1) {
    card = (await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote.approvals[0]
    if (!card) await delay(25)
  }
  assert.ok(card, 'the approval-requested frame must be buffered for the page')
  assert.equal(card.toolName, 'bash')
  assert.match(card.argsHash, /^[a-f0-9]{64}$/)
  // The list view carries the count the Remote hosts list shows.
  assert.equal((await mounted.call('GET', '/devices/remotes')).json.remotes[0].approvals.length, 1)

  // A page cannot bind the decision to a different content than the buffered card.
  const forged = await mounted.call('POST', `/devices/remotes/${remoteId}/approval`, {
    body: { rpcId: card.rpcId, sessionId: card.sessionId, approvalId: card.approvalId, argsHash: 'f'.repeat(64), outcome: 'allowed-once' } })
  assert.equal(forged.status, 409, forged.text)
  assert.equal(forged.json.error, 'hash-mismatch')
  assert.equal((await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote.approvals.length, 1, 'still pending after a refused decision')

  const decided = await mounted.call('POST', `/devices/remotes/${remoteId}/approval`, {
    body: { rpcId: card.rpcId, sessionId: card.sessionId, approvalId: card.approvalId, argsHash: card.argsHash, outcome: 'allowed-once' } })
  assert.equal(decided.status, 200, decided.text)
  assert.equal(decided.json.receipt.accepted, true, JSON.stringify(decided.json))
  assert.equal(await pending, 'allowed-once')
  desktopAnswer.resolve('rejected')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote.approvals.length === 0) break
    await delay(20)
  }
  assert.equal((await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote.approvals.length, 0)
  // Decided at most once: replaying the decision is refused (not pending anymore).
  const twice = await mounted.call('POST', `/devices/remotes/${remoteId}/approval`, {
    body: { rpcId: card.rpcId, sessionId: card.sessionId, approvalId: card.approvalId, argsHash: card.argsHash, outcome: 'rejected' } })
  assert.equal(twice.status, 409)
})

await check('a card whose approvalId names another host namespace is never buffered, and the value is not logged', async () => {
  // The card's ids are remote data: `approvalId` is copied verbatim (unlike the
  // validated rpcId/sessionId), so a compromised Host could park a tag in the
  // buffer and get it echoed back on the decision. The listener validates the WHOLE
  // frame before storing it — simulated here on the connection the Host talks to.
  const entry = mounted.instance.live.get(remoteId)
  assert.ok(entry, 'the remote is attached')
  const forged = { kind: 'approval-requested', rpcId: 'forged-1', sessionId: 's1', approvalId: 'h:hostA:approval',
    toolName: 'bash', argsHash: 'a'.repeat(64), argsPreview: '{}' }
  entry.connection.emit('approval', forged)
  const listed = (await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote.approvals
  assert.equal(listed.some((approval) => approval.rpcId === 'forged-1'), false, 'the tag-carrying card was buffered')
  assert.equal(JSON.stringify(listed).includes('h:hostA:'), false)
  assert.ok(mounted.logs.some((line) => line.includes('remote/id-leak')), 'the refusal is logged with its code')
  assert.equal(mounted.logs.some((line) => line.includes('h:hostA:')), false, 'the refused id never reaches the log')
  // The refusal is per card: a clean frame from the same Host is still buffered.
  entry.connection.emit('approval', { ...forged, rpcId: 'clean-1', approvalId: 'a-clean' })
  assert.ok((await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote.approvals
    .some((approval) => approval.rpcId === 'clean-1'), 'a clean card is still buffered')
  entry.connection.emit('resolved', { kind: 'approval-resolved', rpcId: 'clean-1' })
})

// Spec 008 (owner decision 2026-11-09): a remote-call result too big for one WS frame is
// delivered as a stream; RemoteConnection.call reassembles it. This device was paired
// without harness:remote, so a second desktop with the bridge scopes is paired here.
await check('remote-call: a small result is inline; a big one arrives streamed (streamed:true) and is reassembled byte-exact', async () => {
  const BIG = { blob: 'é漢😀x'.repeat(120_000), list: Array.from({ length: 50 }, (_, i) => ({ i, t: `row-${i}` })) }
  const BINARY = new Uint8Array(300_000).map((_, i) => i % 251)
  gateway.typertGateway.dispatchRpc = async (endpoint) => {
    if (endpoint === 'session/page') return { ok: true, value: { small: true } }
    if (endpoint === 'session/events') return { ok: true, value: BIG }
    if (endpoint === 'session/attachment') return { ok: true, value: { name: 'blob.bin', data: BINARY } }
    if (endpoint === 'session/search') return { ok: false, error: { code: 'nope', message: 'refused by the Host' } }
    return { ok: true, value: {} }
  }
  gateway.typertGateway.openWireStream = async () => ({ [Symbol.asyncIterator]() { return { async next() { return { done: true } }, async return() { return { done: true } } } } })
  // A second devices-plugin instance (own client id): pairing from the same instance
  // would be a re-pair of the same gateway device and replace the main remote's token.
  const bridgeMounted = await mountPlugin({ requestTimeoutMs: 6000 })
  const created = await gateway.post('pair', { kind: 'desktop', scopes: ['sessions:read', 'harness:remote'], publicUrl: gateway.lanUrl })
  const paired = await bridgeMounted.call('POST', '/devices/remotes', { body: { address: new URL(gateway.lanUrl).host, pairingString: created.data.pairingString } })
  assert.equal(paired.status, 201, paired.text)
  const connection = bridgeMounted.instance.live.get(paired.json.remote.id).connection
  await connection.connect()

  const frames = []
  const ws = connection.ws
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ } })

  assert.deepEqual(await connection.call('session/page', {}), { small: true })
  assert.equal(frames.filter((f) => f.kind === 'remote-result').at(-1).streamed, undefined, 'a small result stays inline')

  const big = await connection.call('session/events', {})
  assert.deepEqual(big, BIG, 'reassembled value equals the Host value')
  assert.equal(JSON.stringify(big), JSON.stringify(BIG), 'byte-exact')
  const bigReply = frames.filter((f) => f.kind === 'remote-result' && f.streamed === true).at(-1)
  assert.ok(bigReply && /^res\.\d+$/.test(bigReply.streamId), 'the reply announced a stream')
  assert.equal(bigReply.value, undefined)
  assert.ok(frames.filter((f) => f.kind === 'remote-frame' && f.streamId === bigReply.streamId).length >= 2, 'several chunks')
  assert.equal(connection.streams.size, 0, 'no collector left behind')

  const binary = await connection.call('session/attachment', {})
  assert.equal(binary.name, 'blob.bin')
  assert.ok(Buffer.isBuffer(binary.data))
  assert.deepEqual(new Uint8Array(binary.data), BINARY, 'binary reassembled byte-exact')

  // A Host error is a rejection with the Host's code, not a hang.
  await assert.rejects(() => connection.call('session/search', {}), (error) => error.code === 'nope')
  // A scope the device lacks is refused with the scope named.
  await assert.rejects(() => connection.call('session/prompt', { text: 'x' }), (error) => error.code === 'auth/forbidden-scope' && error.scope === 'prompt:send')
  bridgeMounted.close()
  // Leave the gateway with the one main device the later checks count on.
  const bridgeDevice = (await gateway.get('devices')).devices.find((d) => d.scopes?.includes('harness:remote'))
  assert.ok(bridgeDevice, 'the bridge device is registered')
  assert.equal((await gateway.post(`devices/${bridgeDevice.id}/revoke`)).status, 200)
})

await check('gateway revokes the device: 4401 wipes the token and marks the remote revoked', async () => {
  const tokenFile = path.join(mounted.dataDir, 'tokens', `${remoteId}.token`)
  assert.ok(fs.existsSync(tokenFile))
  const [device] = (await gateway.get('devices')).devices
  assert.equal((await gateway.post(`devices/${device.id}/revoke`)).status, 200)
  for (let attempt = 0; attempt < 150 && fs.existsSync(tokenFile); attempt += 1) await delay(20)
  assert.equal(fs.existsSync(tokenFile), false, 'token wiped after 4401')
  assert.equal((await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote.status, 'revoked')
  assert.equal((await mounted.call('GET', `/devices/remotes/${remoteId}/sessions`)).status, 401)
})

await check('re-pairing the same gateway reuses the remote row and one device row on the gateway', async () => {
  const created = await gateway.post('pair', { kind: 'desktop', scopes: ['sessions:read'], publicUrl: gateway.lanUrl })
  const answer = await mounted.call('POST', '/devices/remotes', { body: { address: new URL(gateway.lanUrl).host, pairingString: created.data.pairingString } })
  assert.equal(answer.status, 201, answer.text)
  assert.equal(answer.json.remote.id, remoteId, 'same remote record')
  assert.equal((await mounted.call('GET', '/devices/remotes')).json.remotes.length, 1)
  assert.deepEqual(answer.json.remote.device.scopes, ['sessions:read'])
  assert.equal((await gateway.get('devices')).devices.length, 1)
  // Scope enforcement is the gateway's: a read-only desktop cannot prompt.
  const refused = await mounted.call('POST', `/devices/remotes/${remoteId}/prompt`, { body: { sessionId: 's1', text: 'x' } })
  assert.equal(refused.status, 403, refused.text)
  assert.equal(refused.json.error, 'auth/forbidden-scope')
})

mounted.close()
await gateway.close()
finish('e2e')
