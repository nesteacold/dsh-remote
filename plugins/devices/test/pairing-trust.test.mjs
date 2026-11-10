// Regression for spec 008 pairing through the plugin's own route (POST
// /devices/pairings): the trust decision is the pin, never the platform's CA
// store.
//
// The defect: `openPinnedSocket` used to give `tls` the pinned leaf as `ca` and
// re-check the pin in `checkServerIdentity`. That makes chain building the trust
// decision, and implementations disagree about the gateway's cert (self-signed,
// basicConstraints CA:FALSE): plain Node's OpenSSL accepts it as its own trust
// anchor, Electron's BoringSSL answers UNABLE_TO_VERIFY_LEAF_SIGNATURE and Node
// then skips `checkServerIdentity` altogether — so the pin was never compared.
// Inside the DSH Host (Electron) every dial ended as 'unreachable' and no
// pairing-proof ever reached the gateway, while the same call from a plain Node
// script paired fine.
//
// A self-signed anchor only differs per TLS implementation, so this test pins
// the leaf of a listener whose issuer the client does not have: no trust store
// can build a chain to it on any runtime, and the leaf is the pinned one. The
// route must still pair — the certificate it reads on the socket is the pin.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import tls from 'node:tls'

import { check, delay, finish, mountPlugin, pinOf, tempDir } from './helpers.mjs'

const gatewayPlugin = (await import('../../mobile-gateway/lib/index.mjs')).default
const { createTestConnection, createTestRemoteAccess } = await import('../../mobile-gateway/test/helpers/peer.mjs')

console.log('pairing-trust')

// -- a leaf certificate no trust store can chain to -------------------------
// Minimal X.509 v3 built by hand (Node cannot create certificates and `openssl`
// is not guaranteed on a Windows Host); EC P-256 + ecdsa-with-SHA256, the same
// shape as the certificate the gateway generates for itself.
const encode = (tag, ...parts) => {
  const content = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content])
}
const encodeLength = (length) => {
  if (length < 0x80) return Buffer.from([length])
  const bytes = []
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const integer = (value) => encode(0x02, Buffer.from([value]))
const oid = (bytes) => encode(0x06, Buffer.from(bytes))
const utf8 = (text) => encode(0x0c, Buffer.from(text, 'utf8'))
const utcTime = (date) => encode(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`))
const name = (cn) => encode(0x30, encode(0x31, encode(0x30, oid([0x55, 0x04, 0x03]), utf8(cn))))
const ecdsaWithSha256 = encode(0x30, oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]))
const extension = (id, critical, value) => encode(0x30, oid(id), ...(critical ? [encode(0x01, Buffer.from([0xff]))] : []), encode(0x04, value))
const basicConstraints = (ca) => extension([0x55, 0x1d, 0x13], true,
  ca ? encode(0x30, encode(0x01, Buffer.from([0xff]))) : encode(0x30))
const subjectAltName = (sans) => extension([0x55, 0x1d, 0x11], false, encode(0x30,
  ...sans.map((san) => (san.ip ? encode(0x87, Buffer.from(san.ip.split('.').map(Number))) : encode(0x82, Buffer.from(san.dns, 'ascii'))))))
const extKeyUsageServerAuth = () => extension([0x55, 0x1d, 0x25], false, encode(0x30, oid([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01])))
const derToPem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`

/** A TLS identity whose leaf was issued by a CA the client is never given. */
function untrustedLeaf() {
  const leafKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const issuerKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const notBefore = new Date(Date.now() - 60_000)
  const notAfter = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
  const tbs = encode(0x30,
    encode(0xa0, integer(2)),
    integer(1),
    ecdsaWithSha256,
    // issuer ≠ subject: the chain ends nowhere the client can trust.
    name('devices pairing-trust untrusted issuer'),
    encode(0x30, utcTime(notBefore), utcTime(notAfter)),
    name('localhost'),
    leafKeys.publicKey.export({ type: 'spki', format: 'der' }),
    encode(0xa3, encode(0x30,
      basicConstraints(false),
      subjectAltName([{ dns: 'localhost' }, { ip: '127.0.0.1' }]),
      extKeyUsageServerAuth())))
  const signature = crypto.sign('sha256', tbs, issuerKeys.privateKey)
  const pem = derToPem(encode(0x30, tbs, ecdsaWithSha256, encode(0x03, Buffer.concat([Buffer.from([0]), signature]))))
  return { certificate: pem, key: leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

const identity = untrustedLeaf()
const leafPin = pinOf(identity.certificate)

// The gateway loads this instead of generating one, so the listener presents the
// leaf above (same JSON the plugin writes: `loadOrCreateTlsIdentity`).
function seedTlsIdentity(directory) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'mobile-gateway-tls.json'), `${JSON.stringify({
    version: 1, certificate: identity.certificate, createdAt: new Date().toISOString(),
    notAfter: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    sans: ['localhost', '127.0.0.1'], commonName: 'localhost',
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(directory, 'mobile-gateway-tls.key'), identity.key)
}

async function startGateway() {
  const directory = tempDir('dsh-devices-trust-gw-')
  const tlsDirectory = path.join(directory, 'tls')
  seedTlsIdentity(tlsDirectory)
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
  await gatewayPlugin.apply(ctx, {
    remoteControl: { enabled: true }, gatewayMode: 'persistent', gatewayWaitTimeoutMs: 60_000, gatewayName: `pairing-trust-${port}`,
    deviceFile: path.join(directory, 'devices.json'), tlsCertificateDir: tlsDirectory,
    publicUrlFile: path.join(directory, 'no-public-url'),
    pairingTtlMs: 60_000, lanEnabled: true, lanHost: '127.0.0.1', lanPort: 0,
  })
  const base = `http://127.0.0.1:${port}`
  const api = {
    base,
    async post(route, body) {
      const response = await fetch(`${base}/mgw/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body ?? {}) })
      return { status: response.status, data: await response.json() }
    },
    async get(route) { return (await fetch(`${base}/mgw/${route}`)).json() },
    async close() { dispose(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }) },
  }
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const status = await api.get('status')
    if (status.lan?.listening && status.lan.urls.length > 0) {
      api.lanUrl = status.lan.urls[0]; api.address = new URL(status.lan.urls[0]).host; api.pin = status.lan.certSha256
      api.port = Number(new URL(status.lan.urls[0]).port)
      return api
    }
    if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

const gateway = await startGateway()
const mounted = await mountPlugin({ requestTimeoutMs: 6000 })
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

// The same bound the client itself uses for a handshake (remote-client.mjs).
const CONTROL_TIMEOUT_MS = 8000
const CONTROL_TIMEOUT_CODE = 'CONTROL_CONNECT_TIMEOUT'

await check('the pinned leaf cannot be chain-verified: the old ca-based trust path must fail', async () => {
  // What the client used to do: hand the pinned certificate to `tls` as its own
  // trust anchor and let chain building decide. It must fail on every runtime —
  // this is the state the DSH Host (BoringSSL) was in all along.
  //
  // Bounded like the client's own handshake (remote-client.mjs): a listener that
  // accepts TCP and then stalls TLS must fail this check, not hang the run.
  let socket
  let timer
  let settled = false
  const refused = await new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn(value)
    }
    socket = tls.connect({ host: '127.0.0.1', port: gateway.port, rejectUnauthorized: true, ca: identity.certificate },
      () => settle(resolve, null))
    socket.on('error', (error) => settle(resolve, error))
    // Distinct from every TLS error code: a stall is a broken test setup and must
    // reject (fail the check), never be read as the chain rejection under test.
    timer = setTimeout(() => settle(reject, Object.assign(
      new Error(`control connection stalled: no TLS handshake within ${CONTROL_TIMEOUT_MS} ms (test setup failure, not a certificate verdict)`),
      { code: CONTROL_TIMEOUT_CODE })), CONTROL_TIMEOUT_MS)
  })
  assert.ok(refused, 'chain verification must not succeed for this leaf')
  assert.match(String(refused.code), /UNABLE_TO|SELF_SIGNED|CERT/, String(refused.code))
  assert.equal(gateway.pin, leafPin, 'the listener presents exactly the pinned leaf')
})

await check('POST /devices/pairings pairs through the route even though the chain cannot be verified', async () => {
  const SCOPES = ['sessions:read', 'prompt:send', 'harness:remote']
  const created = await gateway.post('pair', { mode: 'otp', kind: 'desktop', scopes: SCOPES })
  assert.equal(created.status, 201, JSON.stringify(created.data))

  const started = await mounted.call('POST', '/devices/pairings', { body: { address: gateway.address, otp: created.data.otp, name: 'Self' } })
  assert.equal(started.status, 201, started.text)
  const waiting = await poll(started.json.pairing.id, (view) => view.state === 'pending')
  assert.match(waiting.verificationCode, /^\d{3} \d{3}$/)
  const [request] = await waitPending(1)
  assert.equal(request.verificationCode, waiting.verificationCode.replace(' ', ''), 'the pairing-proof reached the Host')

  assert.equal((await gateway.post(`pending/${request.id}/approve`, { scopes: SCOPES })).status, 200)
  const done = await poll(started.json.pairing.id, (view) => view.state === 'approved')
  assert.ok(done.remoteId)
  const remote = (await mounted.call('GET', `/devices/remotes/${done.remoteId}`)).json.remote
  assert.equal(remote.certSha256, leafPin, 'the TOFU pin is the untrusted leaf')
  assert.equal(JSON.stringify(remote).includes('token'), false)
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if ((await mounted.call('GET', `/devices/remotes/${done.remoteId}`)).json.remote.status === 'online') break
    await delay(20)
  }
  assert.equal((await mounted.call('GET', `/devices/remotes/${done.remoteId}`)).json.remote.status, 'online',
    'the live connection is pinned to the same leaf')
})

mounted.close()
await gateway.close()
finish('pairing-trust')
