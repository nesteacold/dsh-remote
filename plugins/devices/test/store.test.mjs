// FR3: tokens are stored per remote in an owner-only file, never logged or
// returned, and wiped when the remote closes with 4401 (device revoked).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'

import { WebSocketServer, check, delay, finish, mountPlugin, pinOf, selfsigned, skip } from './helpers.mjs'
import { icaclsArgs, setSecureFileTestHooks } from '../lib/secure-file.mjs'

console.log('store')
const generated = await selfsigned.generate([{ name: 'commonName', value: 'fake-remote' }], { days: 1, keySize: 2048, algorithm: 'sha256',
  extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] })
const TOKEN = 'S'.repeat(43)
const CODE = 'B'.repeat(43)
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'

/** Fake remote: pairing hands out TOKEN; an authenticated connection can be closed with any code on demand. */
async function fakeRemote() {
  const server = https.createServer({ cert: generated.cert, key: generated.private })
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (set) => (set.has('dsh-mobile-v1') ? 'dsh-mobile-v1' : false) })
  const state = { authenticated: [], connections: 0, rejectToken: false }
  server.on('upgrade', (req, socket, head) => {
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (bearer && bearer !== TOKEN) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.connections += 1
      if (protocols.includes('dsh-pair.')) {
        ws.send(JSON.stringify({ kind: 'paired', token: TOKEN, device: { id: 'dev-1', kind: 'desktop', scopes: ['sessions:read'] }, gatewayId: GATEWAY_ID }))
      } else state.authenticated.push(ws)
      ws.send(JSON.stringify({ kind: 'hello', authenticated: true, device: { id: 'dev-1', kind: 'desktop', scopes: ['sessions:read'] } }))
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString())
        if (frame.type === 'sessions') ws.send(JSON.stringify({ kind: 'sessions', requestId: frame.requestId, items: [{ sessionId: 's1' }] }))
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return { state, address: `127.0.0.1:${port}`, url: `wss://127.0.0.1:${port}/ws/mobile`,
    close: () => { wss.close(); server.closeAllConnections?.(); server.close() } }
}
const pairingFor = (remote) => Buffer.from(JSON.stringify({ version: 3, publicUrl: remote.url, pairingCode: CODE,
  expiresAt: Date.now() + 120_000, certSha256: pinOf(generated.cert), gatewayId: GATEWAY_ID, gatewayName: 'fake', endpoints: [remote.url] })).toString('base64url')

const mounted = await mountPlugin({ requestTimeoutMs: 4000 })
const remote = await fakeRemote()
const tokensDir = path.join(mounted.dataDir, 'tokens')
let remoteId

await check('pairing stores the token in tokens/<id>.token, outside remotes.json, never in a response or log', async () => {
  const answer = await mounted.call('POST', '/devices/remotes', { body: { address: remote.address, pairingString: pairingFor(remote) } })
  assert.equal(answer.status, 201, answer.text)
  remoteId = answer.json.remote.id
  const file = path.join(tokensDir, `${remoteId}.token`)
  assert.equal(fs.readFileSync(file, 'utf8'), TOKEN)
  assert.ok(!fs.readFileSync(path.join(mounted.dataDir, 'remotes.json'), 'utf8').includes(TOKEN), 'remotes.json holds no secret')
  assert.ok(!answer.text.includes(TOKEN))
  assert.ok(!mounted.logs.some((line) => line.includes(TOKEN) || line.includes(CODE)))
  assert.equal(answer.json.remote.device.kind, 'desktop')
})

await check('token file permissions: 0600 on POSIX; owner-only ACL requested on Windows', async () => {
  const file = path.join(tokensDir, `${remoteId}.token`)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'token file')
    assert.equal(fs.statSync(tokensDir).mode & 0o777, 0o700, 'tokens dir')
    assert.equal(fs.statSync(path.join(mounted.dataDir, 'remotes.json')).mode & 0o777, 0o600, 'remotes.json')
    return
  }
  // NTFS ignores POSIX modes (Node reports 0666), so the guarantee is the ACL.
  // Assert the exact icacls invocation the plugin makes, through the runner seam.
  const calls = []
  const restore = setSecureFileTestHooks({ run: (command, args) => { calls.push([command, args]) } })
  try {
    const fresh = await mountPlugin({ requestTimeoutMs: 4000 })
    const other = await fakeRemote()
    try {
      const answer = await fresh.call('POST', '/devices/remotes', { body: { address: other.address, pairingString: pairingFor(other) } })
      assert.equal(answer.status, 201, answer.text)
      const tokenCall = calls.find(([, args]) => args[0].endsWith('.token'))
      assert.ok(tokenCall, `no icacls call for the token file: ${JSON.stringify(calls.map((call) => call[1][0]))}`)
      assert.equal(tokenCall[0], 'icacls')
      const user = (await import('node:os')).userInfo().username
      assert.deepEqual(tokenCall[1].slice(1), ['/inheritance:r', '/grant:r', `${user}:F`, '/c'])
      assert.ok(calls.some(([, args]) => args[0] === path.join(fresh.dataDir, 'tokens') && args[3].endsWith(':(OI)(CI)F')), 'tokens dir restricted too')
    } finally { other.close(); fresh.close() }
  } finally { restore() }
  assert.deepEqual(icaclsArgs('C:\\x', 'file', 'neste'), ['C:\\x', '/inheritance:r', '/grant:r', 'neste:F', '/c'])
  // Real ACL check where the sandbox lets us spawn; otherwise say so instead of passing silently.
  const real = spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true })
  if (real.error) skip('real icacls ACL read-back', `spawn unavailable: ${real.error.code}`)
  else {
    const user = (await import('node:os')).userInfo().username
    const lines = real.stdout.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('Successfully'))
    assert.ok(lines.length >= 1 && lines.every((line, index) => index === 0 || line.includes(user)), `ACL not owner-only:\n${real.stdout}`)
  }
})

await check('the live connection works with the stored token (sessions round trip)', async () => {
  const answer = await mounted.call('GET', `/devices/remotes/${remoteId}/sessions`)
  assert.equal(answer.status, 200, answer.text)
  assert.deepEqual(answer.json.sessions, [{ sessionId: 's1' }])
  assert.equal((await mounted.call('GET', `/devices/remotes/${remoteId}`)).json.remote.status, 'online')
  assert.equal(remote.state.authenticated.length, 1, 'one live connection per remote')
  await mounted.call('GET', `/devices/remotes/${remoteId}/sessions`)
  assert.equal(remote.state.authenticated.length, 1, 'a second request reuses it')
})

await check('close 4401 wipes the token, marks the remote revoked and does not reconnect', async () => {
  const file = path.join(tokensDir, `${remoteId}.token`)
  assert.ok(fs.existsSync(file))
  const before = remote.state.connections
  for (const ws of remote.state.authenticated) ws.close(4401, 'device revoked')
  for (let attempt = 0; attempt < 100 && fs.existsSync(file); attempt += 1) await delay(20)
  assert.equal(fs.existsSync(file), false, 'token file deleted')
  const listed = (await mounted.call('GET', '/devices/remotes')).json.remotes[0]
  assert.equal(listed.status, 'revoked')
  assert.deepEqual(listed.approvals, [])
  assert.match(mounted.logs.join('\n'), /revoked this device \(4401\); token wiped/)
  // Persisted: survives a restart, and requests are refused without dialing again.
  const persisted = JSON.parse(fs.readFileSync(path.join(mounted.dataDir, 'remotes.json'), 'utf8'))
  assert.equal(persisted.remotes[0].revoked, true)
  const refused = await mounted.call('GET', `/devices/remotes/${remoteId}/sessions`)
  assert.equal(refused.status, 401)
  assert.equal(refused.json.error, 'auth/revoked')
  await delay(150)
  assert.equal(remote.state.connections, before, 'no reconnect attempt after 4401')
  assert.ok(!mounted.logs.some((line) => line.includes(TOKEN)))
})

await check('removing a remote deletes its token file and record', async () => {
  const other = await fakeRemote()
  try {
    const answer = await mounted.call('POST', '/devices/remotes', { body: { address: other.address, pairingString: pairingFor(other) } })
    assert.equal(answer.status, 201, answer.text)
    const id = answer.json.remote.id
    const file = path.join(tokensDir, `${id}.token`)
    assert.ok(fs.existsSync(file))
    assert.equal((await mounted.call('DELETE', `/devices/remotes/${id}`)).status, 200)
    assert.equal(fs.existsSync(file), false)
    assert.equal((await mounted.call('GET', `/devices/remotes/${id}`)).status, 404)
  } finally { other.close() }
})

remote.close()
mounted.close()
finish('store')
