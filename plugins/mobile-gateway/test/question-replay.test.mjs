import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import plugin from '../lib/index.mjs'


// T019/T023: the v3 pairing offer is redeemed on the plugin TLS listener; the
// token then authenticates the loopback route the suite drives.
async function pairDevice(server) {
  const base = `http://127.0.0.1:${server.address().port}`
  const created = await (await fetch(`${base}/mgw/pair`, { method: 'POST' })).json()
  const status = await (await fetch(`${base}/mgw/status`)).json()
  const socket = new WebSocket(status.lan.urls[0], ['dsh-mobile-v1', `dsh-pair.${created.payload.pairingCode}`], {
    rejectUnauthorized: false, headers: { 'X-DSH-Device-ID': 'question-suite-device-01' },
  })
  const paired = await new Promise((resolve, reject) => {
    socket.on('message', (data) => { const frame = JSON.parse(data.toString()); if (frame.kind === 'paired') resolve(frame) })
    socket.on('error', reject)
  })
  socket.close()
  return paired.token
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitUntil(predicate) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, '等待网关事件超时')
    await delay(5)
  }
}

const ANSWER = { answers: [{ id: 'choice', selected: ['Desktop'] }] }

async function gateway(t, enabled = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-question-replay-'))
  const listeners = {}
  const sockets = []
  let upgrade, dispose
  let management
  const server = http.createServer((req, res) => {
    if (management && req.url.startsWith('/mgw')) management.handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  server.on('upgrade', (req, socket, head) => upgrade.handler(req, socket, head))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const ctx = {
    webServer: {
      port: server.address().port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => {} },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      // 36d9: a device only receives cards for sessions the Host lists to it.
      async invoke() { return { items: [{ sessionId: 'question-session' }] } },
      async stream(request) {
        return (async function* () {
          yield { type: 'baseline', value: request.namespace === 'workspace'
            ? { items: [], archivedSessionIds: [] } : { projections: {} } }
          while (!request.signal.aborted) await delay(5)
        })()
      },
    },
    agentDefaultModel: {},
    on(name, handler) { listeners[name] = handler; return () => {} },
    effect(factory) { dispose = factory() },
  }
  await plugin.apply(ctx, {
    gatewayEnabled: enabled,
    legacyAdmin: true,
    deviceFile: path.join(directory, 'devices.json'),
    tlsCertificateDir: path.join(directory, 'tls'),
    lanEnabled: true,
    requireHostApproval: false, // spec 008 P1b: these tests exercise the direct claim path; pairing-approval.test.mjs covers the default
    lanHost: '127.0.0.1',
    lanPort: 0,
  })
  const token = enabled ? await pairDevice(server) : null
  t.after(async () => {
    sockets.forEach(socket => socket.terminate())
    dispose()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return {
    request(next, signal) {
      return listeners['user-questions/request']({
        agent: { id: 'question-session' },
        questions: [{ id: 'choice', question: '后台提问重放', options: [{ label: 'Desktop' }, { label: 'Mobile' }] }],
        signal,
      }, next)
    },
    async connect() {
      const frames = []
      // Device credentials are accepted only on the plugin-owned TLS listener.
      const status = await (await fetch(`http://127.0.0.1:${server.address().port}/mgw/status`)).json()
      const socket = new WebSocket(status.lan.urls[0], ['dsh-mobile-v1'], {
        rejectUnauthorized: false,
        headers: { Authorization: `Bearer ${token}` },
      })
      sockets.push(socket)
      socket.on('message', data => frames.push(JSON.parse(data.toString())))
      await waitUntil(() => frames.some(frame => frame.kind === 'hello'))
      socket.send(JSON.stringify({ type: 'client-hello', requestId: 'question-hello', companionProtocol: 1, appVersion: 'test', platform: 'ios' }))
      await waitUntil(() => frames.some(frame => frame.kind === 'client-hello' && frame.requestId === 'question-hello'))
      await waitUntil(() => frames.some(frame => frame.kind === 'projection-baseline'))
      return { socket, frames }
    },
    async subscribe(socket, frames, sessionId) {
      socket.send(JSON.stringify({ type: 'subscribe', sessionId, legacyAdmin: true }))
      await waitUntil(() => frames.some(frame => frame.kind === 'subscribed' && frame.sessionId === sessionId))
    },
  }
}

test('首次手机连接也能收到桌面端仍在等待的提问', async t => {
  const host = await gateway(t)
  let resolveDesktop
  const pending = host.request(() => new Promise(resolve => { resolveDesktop = resolve }))
  const { frames } = await host.connect()
  try {
    const replay = frames.find(frame => frame.kind === 'question-requested')
    assert.equal(replay?.sessionId, 'question-session')
    assert.equal(replay.replay, true)
  } finally {
    resolveDesktop(ANSWER)
    await pending
  }
})

test('后台会话的提问在打开该会话时重放', async t => {
  const host = await gateway(t)
  const { socket, frames } = await host.connect()
  await host.subscribe(socket, frames, 'another-session')
  let resolveDesktop
  const pending = host.request(() => new Promise(resolve => { resolveDesktop = resolve }))
  try {
    assert.equal(frames.some(frame => frame.kind === 'question-requested'), false)
    await host.subscribe(socket, frames, 'question-session')
    const replay = frames.find(frame => frame.kind === 'question-requested' && frame.sessionId === 'question-session')
    assert.equal(replay?.replay, true)
  } finally {
    resolveDesktop(ANSWER)
    await pending
  }
})

test('没有手机连接时，桌面端已完成的提问不会再次重放', async t => {
  const host = await gateway(t)
  assert.deepEqual(await host.request(() => ANSWER), ANSWER)
  const { frames } = await host.connect()
  assert.equal(frames.some(frame => frame.kind === 'question-requested'), false)
})

test('没有手机也没有桌面答复时保持回退，不挂住请求', async t => {
  const host = await gateway(t)
  assert.equal(await host.request(() => undefined), undefined)
  const { frames } = await host.connect()
  assert.equal(frames.some(frame => frame.kind === 'question-requested'), false)
})

test('停用网关时仍直接交给桌面端处理提问', async t => {
  const host = await gateway(t, false)
  assert.deepEqual(await host.request(() => ANSWER), ANSWER)
})
