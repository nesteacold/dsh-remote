// Spec 011 FR-001/FR-006 — `sessions:author` must never arrive granted by a default.
//
// WHY this file exists (and why it is not test/device-authoring.test.mjs): that
// suite proves the positive matrix (a device holding the scope may do the four
// ops) and the negative matrix (a device without it is refused before any Host
// call). It does not test the default grant, which is the defect this file pins:
// `sessions:author` is NOT desktop-only on purpose (a `mobile` device may hold
// it), so it falls into BOTH default computations — the gateway's pairing-offer
// default (`lib/index.mjs`, "every scope except the bridge") and the registry's
// mobile default (`lib/devices.js`, "every non-desktop scope"). Creating sessions
// and choosing models starts agent work on the owner's machine, so it has to be a
// deliberate tick, never a default. Contract `NEVER_DEFAULT_SCOPES` is the one
// list both sites read; this file proves all three levels agree.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

import plugin from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import * as contract from '../lib/vendor/mobile-protocol.mjs'

const AUTHOR = 'sessions:author'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// Level 1 — the contract states the rule, and keeps the scope grantable
// ---------------------------------------------------------------------------

test('D-1 contract: NEVER_DEFAULT_SCOPES names sessions:author and keeps it explicitly grantable', () => {
  assert.deepEqual([...contract.NEVER_DEFAULT_SCOPES], [AUTHOR])
  assert.equal(Object.isFrozen(contract.NEVER_DEFAULT_SCOPES), true)
  // Every entry is a real scope, so a default filter can never hide a typo.
  for (const scope of contract.NEVER_DEFAULT_SCOPES) assert.ok(contract.SCOPES.includes(scope), `${scope} must be a scope`)
  // "Never defaulted" must not degenerate into "never granted".
  assert.equal(contract.DESKTOP_DEFAULT_SCOPES.includes(AUTHOR), false)
  assert.equal(contract.DESKTOP_ONLY_SCOPES.includes(AUTHOR), false, 'a mobile device may hold it (spec 011 FR-001)')
  assert.ok(contract.SCOPE_PRESETS.full.includes(AUTHOR), 'the explicit "full" preset still offers it')
  assert.equal(contract.SCOPE_PRESETS.standard.includes(AUTHOR), false, 'the conservative preset does not')
  // The authoring types are mapped to it, so the gate is real (spec 011 FR-002).
  for (const type of contract.AUTHORING_CLIENT_TYPES) assert.equal(contract.SCOPE_BY_TYPE[type], AUTHOR)
})

// ---------------------------------------------------------------------------
// Level 2 — the registry default (`lib/devices.js` `defaultScopes`)
// ---------------------------------------------------------------------------

test('D-2 registry: a pairing that names no scopes never grants sessions:author, but an explicit list does', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-author-defaults-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const devices = require('../lib/devices.js')
  const registry = devices.createRegistry(path.join(directory, 'devices.json'), { pairingTtlMs: 60_000 })

  const mobile = registry.createPairing('no-scope-mobile')
  assert.equal(mobile.scopes.includes(AUTHOR), false, `a mobile default must not grant ${AUTHOR}: ${mobile.scopes.join(',')}`)
  // No over-narrowing: the default is still the pre-011 mobile grant.
  for (const scope of ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'files:write', 'settings:write']) {
    assert.ok(mobile.scopes.includes(scope), `the mobile default must keep ${scope}`)
  }

  const desktop = registry.createPairing('no-scope-desktop', { kind: 'desktop' })
  assert.equal(desktop.scopes.includes(AUTHOR), false)
  assert.deepEqual([...desktop.scopes], [...contract.DESKTOP_DEFAULT_SCOPES])

  // FR-006: what the owner ticks IS granted, on a mobile device too.
  const explicit = registry.createPairing('explicit-mobile', { scopes: ['sessions:read', AUTHOR] })
  assert.ok(explicit.scopes.includes(AUTHOR), 'an explicit grant must survive')
  registry.close?.()
})

// ---------------------------------------------------------------------------
// Level 3 — the live route defaults (`lib/index.mjs` pairing-offer default)
// ---------------------------------------------------------------------------

async function startGateway(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-author-route-'))
  let management
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management) management.handler(req, res)
    else res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket) => socket.destroy())
  await listenFetchSafe(server)
  const port = server.address().port
  t.after(async () => {
    try { dispose() } catch { /* already disposed */ }
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  await plugin.apply({
    webServer: { port, register(route) { management = route; return () => {} }, registerUpgrade() { return () => {} } },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke() { return {} },
      async stream(request) {
        return (async function* () {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
          // Stop when the caller aborts: an unbounded generator keeps the test
          // process alive after the assertions are done.
          while (!request.signal?.aborted) await delay(10)
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(fn) { dispose = fn() },
  }, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayName: `author-defaults-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: false,
  })
  const base = `http://127.0.0.1:${port}`
  const post = async (route, body) => {
    const response = await fetch(`${base}/mgw/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body ?? {}),
    })
    return { status: response.status, data: await response.json() }
  }
  // Two listeners can be slower than the plugin's first tick; wait for the
  // management route to answer before asserting on it.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { if ((await fetch(`${base}/mgw/status`)).ok) return { post, base } } catch { /* not up yet */ }
    await delay(20)
  }
  throw new Error('management route did not become ready')
}

test('D-3 gateway: an OTP offer that names no scopes omits sessions:author, and an explicit one keeps it', async (t) => {
  const instance = await startGateway(t)

  const mobile = await instance.post('pair', { mode: 'otp', kind: 'mobile' })
  assert.equal(mobile.status, 201, JSON.stringify(mobile.data).slice(0, 300))
  assert.equal(mobile.data.pairing.scopes.includes(AUTHOR), false,
    `a default mobile offer must not include ${AUTHOR}: ${mobile.data.pairing.scopes.join(',')}`)
  // The pre-011 mobile offer is unchanged: every scope except the desktop-only
  // families and the bridge, minus the never-default list.
  for (const scope of contract.SCOPES) {
    if (contract.DESKTOP_ONLY_SCOPES.includes(scope) || contract.NEVER_DEFAULT_SCOPES.includes(scope)) continue
    assert.ok(mobile.data.pairing.scopes.includes(scope), `a default mobile offer must still include ${scope}`)
  }

  const desktop = await instance.post('pair', { mode: 'otp', kind: 'desktop' })
  assert.equal(desktop.data.pairing.scopes.includes(AUTHOR), false)
  assert.deepEqual([...desktop.data.pairing.scopes], [...contract.DESKTOP_DEFAULT_SCOPES])

  // FR-006: ticking it in the pairing dialog is what grants it.
  const explicit = await instance.post('pair', { mode: 'otp', kind: 'mobile', scopes: ['sessions:read', AUTHOR] })
  assert.equal(explicit.status, 201, JSON.stringify(explicit.data).slice(0, 300))
  assert.ok(explicit.data.pairing.scopes.includes(AUTHOR), 'an explicitly offered scope must survive')

  // And an explicit EMPTY list stays empty — never "no choice, so take the default".
  const empty = await instance.post('pair', { mode: 'otp', kind: 'mobile', scopes: [] })
  assert.deepEqual([...empty.data.pairing.scopes], [])
})
