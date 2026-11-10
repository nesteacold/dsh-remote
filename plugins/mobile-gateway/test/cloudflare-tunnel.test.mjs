import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { CLOUDFLARED_DISABLED, CLOUDFLARED_DISABLED_STATUS } from '../lib/cloudflared-binary.mjs'
import {
  CLOUDFLARE_TUNNEL_ENABLED,
  CLOUDFLARE_TUNNEL_PLATFORMS,
  createCloudflareTunnel,
  isCloudflareTunnelSupported,
} from '../lib/cloudflare-tunnel.mjs'

// FR-011 / R9 (T031): the Cloudflare Tunnel is hard-disabled in v1. This file
// used to drive a real tunnel lifecycle (named + quick mode, child process
// restart, config persistence, public WebSocket upgrade). None of that may run
// any more, so the coverage is now the refusal: no listener, no download, no
// spawn, no probe, no state file, and a typed `cloudflare/disabled` error whose
// code/status `index.mjs` turns into a 403 on the /mgw routes.

assert.equal(CLOUDFLARE_TUNNEL_ENABLED, false)
// The kept implementation still names the platforms it targets; v1 serves none.
assert.deepEqual([...CLOUDFLARE_TUNNEL_PLATFORMS], ['darwin', 'win32', 'linux'])
for (const platform of ['darwin', 'win32', 'linux', 'android', 'freebsd']) {
  assert.equal(isCloudflareTunnelSupported(platform), false, `${platform} must not be supported in v1`)
}

function assertDisabled(error) {
  assert.equal(error.code, CLOUDFLARED_DISABLED)
  assert.equal(error.status, CLOUDFLARED_DISABLED_STATUS)
  assert.equal(error.security, true)
  assert.match(error.message, /disabled in this release \(FR-011\/R9\)/)
  return true
}

// A closed loopback port: proves the origin listener was never opened.
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

const probe = net.createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = probe.address().port
probe.close()
await once(probe, 'close')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cloudflare-disabled-'))
const stateFile = path.join(temp, 'cloudflare.json')
const token = 'eyJ.test-token'
let children = 0
let preparations = 0
let probes = 0
let upgrades = 0
const tunnel = createCloudflareTunnel({
  file: stateFile,
  port,
  wsPath: '/ws/mobile',
  executable: 'cloudflared',
  spawnProcess: () => { children += 1; throw new Error('cloudflared must not be spawned') },
  prepareExecutable: async () => { preparations += 1; throw new Error('cloudflared must not be prepared') },
  probeEndpoint: async () => { probes += 1; throw new Error('no public probe may run') },
  isGatewayEnabled: () => true,
  onUpgrade: () => { upgrades += 1 },
})

// The snapshot keeps the shape the /mgw/status consumer reads, in the existing
// `disabled` state (T002c) with a reason instead of a silent no-op.
const initial = tunnel.snapshot()
assert.equal(initial.state, 'disabled')
assert.equal(initial.enabled, false)
assert.equal(initial.supported, false)
assert.equal(initial.hardDisabled, true)
assert.equal(initial.configured, false)
assert.equal(initial.publicUrl, null)
assert.equal(initial.publicReady, false)
assert.equal(initial.port, port)
assert.equal(initial.endpointHealth.state, 'unchecked')
assert.match(String(initial.error), /disabled in this release \(FR-011\/R9\)/)
assert.equal(JSON.stringify(initial).includes(token), false)

// Every configuration request is refused, including "turn it off": the module
// must not write settings, not start, and not take a token.
const messages = new Set()
for (const body of [
  { enabled: true, mode: 'named', hostname: 'gateway.example.com', token },
  { enabled: true, mode: 'quick' },
  { enabled: false },
  { enabled: true, hostname: 'bad/url', token },
  {},
]) {
  await assert.rejects(tunnel.configure(body), (error) => {
    assertDisabled(error)
    messages.add(error.message)
    return true
  }, `configure ${JSON.stringify(body)}`)
}
assert.equal(messages.size, 1, 'the refusal must be deterministic')
await assert.rejects(tunnel.restart(), assertDisabled)
await assert.rejects(tunnel.checkEndpoint(), assertDisabled)

// reconcile() is called from startup, mode changes and teardown in index.mjs, so
// it must resolve (a rejection would be unhandled) while staying inert.
const reconciled = await tunnel.reconcile()
assert.equal(reconciled.state, 'disabled')
await tunnel.reconcile()
assert.equal(await portOpen(port), false, 'no origin listener may be opened')
assert.equal(children, 0, 'no cloudflared process may be spawned')
assert.equal(preparations, 0, 'no binary may be prepared')
assert.equal(probes, 0, 'no public endpoint probe may run')
assert.equal(upgrades, 0)
assert.equal(fs.existsSync(stateFile), false, 'no tunnel state file may be written')
assert.deepEqual(fs.readdirSync(temp), [])
assert.equal(tunnel.snapshot().state, 'disabled')

tunnel.dispose()
tunnel.dispose()
assert.equal(tunnel.snapshot().state, 'disabled')
assert.equal(fs.existsSync(stateFile), false)
fs.rmSync(temp, { recursive: true, force: true })
console.log('CLOUDFLARE TUNNEL TESTS PASSED (hard-disabled refusal)')
