// FR2/FR3: the certificate pin is verified BEFORE any credential is sent.
// A fake remote presents certificate A while the pairing string pins B: the
// plugin must refuse, and the remote must have received zero application bytes
// (so the one-time pairing code never left this host). A matching pin is the
// control: the same fake remote then does see the `dsh-pair.` credential.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { once } from 'node:events'

import { WebSocketServer, check, finish, mountPlugin, pinOf, selfsigned } from './helpers.mjs'
import { decodePairingString, isPrivateAddress, resolveDialUrl } from '../lib/remote-client.mjs'

console.log('pin')
const mk = async (cn) => {
  const result = await selfsigned.generate([{ name: 'commonName', value: cn }], { days: 1, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] })
  return { cert: result.cert, key: result.private }
}
const served = await mk('served')
const other = await mk('pinned-elsewhere')
assert.notEqual(pinOf(served.cert), pinOf(other.cert))

const PAIRING_CODE = 'A'.repeat(43)
const pairingString = (url, certSha256) => Buffer.from(JSON.stringify({
  version: 3, publicUrl: url, pairingCode: PAIRING_CODE, expiresAt: Date.now() + 120_000, certSha256,
  gatewayId: '11111111-1111-4111-8111-111111111111', gatewayName: 'fake-remote', endpoints: [url],
}), 'utf8').toString('base64url')

/** A TLS+WebSocket server that records every byte of application data it is sent. */
async function fakeRemote() {
  const seen = { upgrades: 0, appBytes: 0, credentialSeen: false, protocols: [] }
  const server = https.createServer({ cert: served.cert, key: served.key })
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (set) => (set.has('dsh-mobile-v1') ? 'dsh-mobile-v1' : false) })
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      seen.appBytes += chunk.length
      if (chunk.includes(PAIRING_CODE)) seen.credentialSeen = true
    })
    // `data` on the raw TLS socket is decrypted application data (the HTTP request).
  })
  server.on('upgrade', (req, socket, head) => {
    seen.upgrades += 1
    seen.protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((value) => value.trim())
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ kind: 'paired', token: 'T'.repeat(43), device: { id: 'dev-1', kind: 'desktop', scopes: ['sessions:read'] }, gatewayId: '11111111-1111-4111-8111-111111111111' }))
      ws.send(JSON.stringify({ kind: 'hello', authenticated: true }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return { seen, port, url: `wss://127.0.0.1:${port}/ws/mobile`, address: `127.0.0.1:${port}`,
    close: () => { wss.close(); server.closeAllConnections?.(); server.close() } }
}

const mounted = await mountPlugin()
const add = (address, string) => mounted.call('POST', '/devices/remotes', { body: { address, pairingString: string } })
const tokenFiles = () => {
  try { return fs.readdirSync(path.join(mounted.dataDir, 'tokens')) } catch { return [] }
}

await check('pin mismatch: refused, zero application bytes reach the remote, no credential, no token file', async () => {
  const remote = await fakeRemote()
  try {
    const answer = await add(remote.address, pairingString(remote.url, pinOf(other.cert)))
    assert.equal(answer.status, 502, answer.text)
    assert.equal(answer.json.error, 'pin-mismatch')
    assert.match(answer.json.message, /no credential was sent/)
    assert.equal(remote.seen.upgrades, 0, 'no WebSocket upgrade may happen')
    assert.equal(remote.seen.appBytes, 0, 'not one application byte (so not the pairing code) may be sent')
    assert.equal(remote.seen.credentialSeen, false)
    assert.deepEqual(tokenFiles(), [])
    assert.deepEqual((await mounted.call('GET', '/devices/remotes')).json.remotes, [])
    // The refusal is logged without the code or the pin's full value.
    assert.ok(mounted.logs.some((line) => /pin mismatch/.test(line)))
    assert.ok(!mounted.logs.some((line) => line.includes(PAIRING_CODE)))
  } finally { remote.close() }
})

await check('matching pin (control): the credential is sent only now, and a token is stored', async () => {
  const remote = await fakeRemote()
  try {
    const answer = await add(remote.address, pairingString(remote.url, pinOf(served.cert)))
    assert.equal(answer.status, 201, answer.text)
    assert.equal(remote.seen.upgrades, 1)
    assert.ok(remote.seen.protocols.includes(`dsh-pair.${PAIRING_CODE}`), 'the code travels in the subprotocol')
    assert.equal(remote.seen.protocols[0], 'dsh-mobile-v1')
    assert.equal(tokenFiles().length, 1)
    // The token and the pairing code never appear in the answer or in any log line.
    assert.ok(!answer.text.includes('T'.repeat(43)))
    assert.ok(!answer.text.includes(PAIRING_CODE))
    assert.ok(!mounted.logs.some((line) => line.includes('T'.repeat(43)) || line.includes(PAIRING_CODE)))
    const listed = JSON.stringify((await mounted.call('GET', '/devices/remotes')).json)
    assert.ok(!listed.includes('T'.repeat(43)))
  } finally { remote.close() }
})

await check('a pin that is not 64 hex chars, an expired code and wrong versions are refused before any dial', async () => {
  const remote = await fakeRemote()
  try {
    const bad = (patch) => Buffer.from(JSON.stringify({ version: 3, publicUrl: remote.url, pairingCode: PAIRING_CODE,
      expiresAt: Date.now() + 60_000, certSha256: pinOf(served.cert), endpoints: [remote.url], ...patch })).toString('base64url')
    for (const patch of [{ certSha256: 'abc' }, { certSha256: undefined }, { expiresAt: Date.now() - 1 }, { version: 2 },
      { publicUrl: 'ws://127.0.0.1:1/ws/mobile' }, { pairingCode: 'short' }]) {
      const answer = await add(remote.address, bad(patch))
      assert.ok(answer.status >= 400 && answer.status < 500, `${JSON.stringify(patch)} -> ${answer.status} ${answer.text}`)
    }
    assert.equal(remote.seen.appBytes, 0)
  } finally { remote.close() }
})

await check('address must match the pairing string; public addresses are refused by default (FR2)', async () => {
  const payload = decodePairingString(pairingString('wss://203.0.113.9:3081/ws/mobile', pinOf(served.cert)))
  assert.throws(() => resolveDialUrl('10.0.0.5:3081', payload), /does not match/)
  assert.throws(() => resolveDialUrl('203.0.113.9:3081', payload), /private-network/)
  assert.equal(resolveDialUrl('203.0.113.9:3081', payload, { allowPublic: true }), 'wss://203.0.113.9:3081/ws/mobile')
  assert.throws(() => resolveDialUrl('', payload), /required/)
  assert.throws(() => resolveDialUrl('user:pw@203.0.113.9:3081', payload), /look like/)
  for (const host of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '100.64.0.1', '169.254.1.1', 'fd00::1', 'fe80::1', '::1', 'nas.local']) {
    assert.equal(isPrivateAddress(host), true, host)
  }
  for (const host of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '203.0.113.9', '2001:db8::1', 'example.com']) {
    assert.equal(isPrivateAddress(host), false, host)
  }
})

mounted.close()
finish('pin')
