// Regression (measured 2026-11-10): reading a remote Host's transcript through this
// plugin failed for every subagent-origin session —
//   GET /devices/remotes/<id>/sessions/<sid>/history
//   -> 502 {"error":"session/agent-busy","message":"the remote refused history: session/agent-busy"}
// — 0/15 subagent sessions readable against 15/15 ordinary ones, even with
// `running:false` (491 of 517 sessions on the test Host are subagent children).
//
// DSH's session-history `validateAddress` refuses an address of `kind:'session'`
// with `session/agent-busy` ("subagent Sessions require their durable parent
// address") for every header whose `origin` is `subagent`, running or not. Such a
// session must be addressed as
//   { kind: 'subagent', parentSessionId, childSessionId, mode: 'one-shot'|'continuable'|'unknown' }
// where `unknown` is accepted and skips the mode comparison.
//
// The REAL plugins/mobile-gateway runs in-process (the pattern of test/e2e.test.mjs)
// and the fake Host it talks to reproduces that validateAddress rule exactly, so
// this file fails on the old request shape (`{ type:'history', sessionId }`) and
// passes on the new one. The gateway package is imported read-only; nothing in it
// is edited.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { check, delay, finish, mountPlugin, tempDir } from './helpers.mjs'
import { requestJson } from './fixture-http.mjs'

const gatewayPlugin = (await import('../../mobile-gateway/lib/index.mjs')).default
const { createTestConnection, createTestRemoteAccess } = await import('../../mobile-gateway/test/helpers/peer.mjs')

console.log('subagent-history')

// The Host's session headers. `sub-3` is a subagent child the Host does NOT list
// (archived, or created while the list was cached): a fallback must never guess it.
const HEADERS = {
  s1: { origin: 'main' },
  p1: { origin: 'main' },
  'sub-1': { origin: 'subagent', parentSessionId: 'p1' },
  'sub-2': { origin: 'subagent', parentSessionId: 'p1' },
  'sub-3': { origin: 'subagent', parentSessionId: 'p1' },
}
const LISTED = ['s1', 'p1', 'sub-1', 'sub-2']
const TITLES = { s1: 'Ordinary session', p1: 'Parent', 'sub-1': 'Child one', 'sub-2': 'Child two' }

const snapshot = (sessionId) => ({
  type: 'snapshot', header: { version: 4, id: sessionId }, cursor: 1,
  records: [{ type: 'event', event: { seq: 1, type: 'user/message', time: 1,
    data: { content: [{ type: 'text', text: `hello ${sessionId}` }] } } }],
  hasMore: false, projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 },
})

async function startGateway() {
  const directory = tempDir('dsh-devices-sub-gw-')
  let management
  let upgrade
  let dispose = () => {}
  const hostCalls = []
  /** Every `session/follow` address the Host was asked to open, in order. */
  const addresses = []
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
      async invoke(request) {
        hostCalls.push(`${request.namespace}/${request.method}`)
        if (request.namespace === 'session' && request.method === 'list') {
          return { items: LISTED.map((sessionId) => ({
            sessionId, running: false, ...(HEADERS[sessionId].parentSessionId ? { parentSessionId: HEADERS[sessionId].parentSessionId } : {}),
            origin: HEADERS[sessionId].origin, projections: { values: { title: TITLES[sessionId] } },
          })) }
        }
        return {}
      },
      async stream(request) {
        if (request.namespace === 'session' && request.method === 'follow') {
          const address = request.args.request.address
          addresses.push(address)
          const sessionId = address.kind === 'subagent' ? address.childSessionId : address.sessionId
          const header = HEADERS[sessionId]
          if (!header) throw Object.assign(new Error(`no such session ${sessionId}`), { code: 'session/not-found' })
          // DSH's validateAddress, reproduced: a subagent header is addressable ONLY
          // through its durable parent (the mode is not compared for `unknown`).
          if (header.origin === 'subagent') {
            if (address.kind !== 'subagent' || address.parentSessionId !== header.parentSessionId) {
              throw Object.assign(new Error('subagent Sessions require their durable parent address'), { code: 'session/agent-busy' })
            }
          }
          return (async function* () {
            yield snapshot(sessionId)
            while (!request.signal.aborted) await delay(10)
          })()
        }
        return (async function* () {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
          while (!request.signal.aborted) await delay(10)
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(fn) { dispose = fn() },
  }
  await gatewayPlugin.apply(ctx, {
    remoteControl: { enabled: true }, gatewayMode: 'persistent', gatewayWaitTimeoutMs: 60_000, gatewayName: `subagent-history-${port}`,
    deviceFile: path.join(directory, 'devices.json'), publicUrlFile: path.join(directory, 'no-public-url'),
    pairingTtlMs: 60_000, lanEnabled: true, lanHost: '127.0.0.1', lanPort: 0,
    requireHostApproval: false,
  })
  const base = `http://127.0.0.1:${port}`
  const api = {
    base, hostCalls, addresses, ctx,
    post(route, body) { return requestJson(base, 'POST', `/mgw/${route}`, { body: body ?? {}, headers: { Origin: base } }) },
    async get(route) { return (await requestJson(base, 'GET', `/mgw/${route}`)).data },
    async close() { dispose(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }) },
  }
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const status = await api.get('status')
    if (status.lan?.listening && status.lan.urls.length > 0) { api.lanUrl = status.lan.urls[0]; api.address = new URL(status.lan.urls[0]).host; return api }
    if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

const gateway = await startGateway()
const mounted = await mountPlugin({ requestTimeoutMs: 6000 })
let remoteId
/** Every frame this plugin actually put on the wire, as the fake Host received it. */
const sent = []
const historyFrames = () => sent.filter((frame) => frame.type === 'history')

await check('pairs with the in-process gateway as a desktop device', async () => {
  const created = await gateway.post('pair', { kind: 'desktop', publicUrl: gateway.lanUrl })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const answer = await mounted.call('POST', '/devices/remotes', { body: { address: gateway.address, pairingString: created.data.pairingString } })
  assert.equal(answer.status, 201, answer.text)
  remoteId = answer.json.remote.id
  const connection = mounted.instance.live.get(remoteId).connection
  await connection.connect()
  // Record outgoing frames: what the Host really receives, not how the source reads.
  const ws = connection.ws
  const send = ws.send.bind(ws)
  ws.send = (data, callback) => {
    try { sent.push(JSON.parse(String(data))) } catch { /* frames are JSON; ignore anything else */ }
    return send(data, callback)
  }
})

await check('address mapping: a subagent child travels as a subagent address, an ordinary row carries neither field', async () => {
  const child = await mounted.call('GET', `/devices/remotes/${remoteId}/history?sessionId=sub-1&parentSessionId=p1`)
  assert.equal(child.status, 200, child.text)
  const childFrame = historyFrames().at(-1)
  assert.equal(childFrame.sessionId, 'sub-1')
  assert.equal(childFrame.parentSessionId, 'p1')
  assert.equal(childFrame.subagentMode, 'unknown')
  // And what the Host's own dispatch received, i.e. the address it must validate.
  assert.deepEqual(gateway.addresses.at(-1),
    { kind: 'subagent', parentSessionId: 'p1', childSessionId: 'sub-1', mode: 'unknown' })

  const normal = await mounted.call('GET', `/devices/remotes/${remoteId}/history?sessionId=s1`)
  assert.equal(normal.status, 200, normal.text)
  const normalFrame = historyFrames().at(-1)
  assert.equal(normalFrame.sessionId, 's1')
  assert.equal('parentSessionId' in normalFrame, false, 'no parent field on an ordinary row')
  assert.equal('subagentMode' in normalFrame, false, 'no mode without a parent (the gateway refuses that)')
  assert.deepEqual(gateway.addresses.at(-1), { kind: 'session', sessionId: 's1' })
})

await check('end to end: the plain route reads a subagent child from the Host list; an unlisted child still surfaces the Host refusal', async () => {
  // No parent given: the plugin must find it in this Host's own session list. This is
  // the regression that matters — the old code sent `{ type:'history', sessionId }`
  // and the Host answered `session/agent-busy`.
  const child = await mounted.call('GET', `/devices/remotes/${remoteId}/sessions/sub-2/history`)
  assert.equal(child.status, 200, child.text)
  assert.equal(child.json.history.kind, 'history')
  assert.ok(Array.isArray(child.json.history.events) && child.json.history.events.length >= 1, 'events came back')
  assert.equal(historyFrames().at(-1).parentSessionId, 'p1')
  assert.deepEqual(gateway.addresses.at(-1),
    { kind: 'subagent', parentSessionId: 'p1', childSessionId: 'sub-2', mode: 'unknown' })

  // `sub-3` is a subagent child its Host does not list: never guess a parent. The
  // Host then refuses exactly as before, with its own code, verbatim.
  const unlisted = await mounted.call('GET', `/devices/remotes/${remoteId}/sessions/sub-3/history`)
  assert.equal(unlisted.status, 502, unlisted.text)
  assert.equal(unlisted.json.error, 'session/agent-busy')
  assert.equal(unlisted.json.message, 'the remote refused history: session/agent-busy')
  assert.equal('parentSessionId' in historyFrames().at(-1), false, 'no invented parent')
  assert.deepEqual(gateway.addresses.at(-1), { kind: 'session', sessionId: 'sub-3' })
})

await check('explicit query parameters: a valid address is forwarded; malformed ones are a 400 and never dial', async () => {
  const before = historyFrames().length
  const explicit = await mounted.call('GET', `/devices/remotes/${remoteId}/history?sessionId=sub-1&parentSessionId=p1&subagentMode=one-shot`)
  assert.equal(explicit.status, 200, explicit.text)
  assert.equal(historyFrames().at(-1).subagentMode, 'one-shot', 'the mode the caller named is carried')

  const sentBeforeRefusals = historyFrames().length
  const same = await mounted.call('GET', `/devices/remotes/${remoteId}/history?sessionId=s1&parentSessionId=s1`)
  assert.equal(same.status, 400, same.text)
  assert.equal(same.json.error, 'bad-request')
  const badMode = await mounted.call('GET', `/devices/remotes/${remoteId}/history?sessionId=s1&parentSessionId=p1&subagentMode=bogus`)
  assert.equal(badMode.status, 400, badMode.text)
  assert.equal(badMode.json.error, 'bad-request')
  const orphanMode = await mounted.call('GET', `/devices/remotes/${remoteId}/history?sessionId=s1&subagentMode=unknown`)
  assert.equal(orphanMode.status, 400, orphanMode.text)
  const badId = await mounted.call('GET', `/devices/remotes/${remoteId}/history?sessionId=s1&parentSessionId=${encodeURIComponent('../etc/passwd')}`)
  assert.equal(badId.status, 400, badId.text)
  const pathForm = await mounted.call('GET', `/devices/remotes/${remoteId}/sessions/s1/history?parentSessionId=s1`)
  assert.equal(pathForm.status, 400, 'the path route answers the same refusal')
  assert.equal(historyFrames().length, sentBeforeRefusals, 'not one history frame left for a refused address')
  assert.equal(before, sentBeforeRefusals - 1)
})

await check('no dial for a refused address: the same input is a 400 with the Host down, where a valid read is remote/host-offline', async () => {
  // With the Host gone a dial would end as 409 `remote/host-offline`; a 400 here can
  // only come from validation that ran before anything was dialled.
  await gateway.close()
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if ((await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote.status !== 'online') break
    await delay(20)
  }
  const refused = await mounted.call('GET', `/devices/remotes/${remoteId}/sessions/sub-2/history?parentSessionId=sub-2`)
  assert.equal(refused.status, 400, refused.text)
  assert.equal(refused.json.error, 'bad-request')
  const offline = await mounted.call('GET', `/devices/remotes/${remoteId}/sessions/sub-2/history`)
  assert.equal(offline.status, 409, offline.text)
  assert.equal(offline.json.error, 'remote/host-offline')
})

mounted.close()
finish('subagent-history')
