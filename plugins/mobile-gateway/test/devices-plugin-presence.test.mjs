// Owner rule 2026-11-10: the gateway's own "Mobile Devices" Settings section is
// hidden while `@dsh-ext/devices` is loaded in the same profile, because that
// plugin's Settings → Devices page drives the same `/mgw/*` admin routes; with
// the gateway installed standalone the section shows, as before.
//
// The browser half cannot answer this (its `slots` service exposes only
// register / registerFactory / inject), so the Host decides here and reports the
// answer on /mgw/status.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import plugin, { devicesPluginActive } from '../lib/index.mjs'

// The exact `configEditor.Entry` shape was NOT inspectable from this workspace
// (the DSH build is an unreadable asar here), so each case below is one shape a
// Loader row plausibly uses and the matcher must accept or refuse.
const withEntries = entries => ({ get: name => (name === 'configEditor' ? { entries: () => entries } : undefined) })

test('an active devices row is detected by name, package field, row id or nested descriptor', () => {
  for (const entry of [
    { name: '@dsh-ext/devices' },
    { package: '@dsh-ext/devices' },
    { id: 'dsh-ext.devices' },
    { id: 'dsh-ext.devices.hosts' },
    { name: 'devices', config: { name: '@dsh-ext/devices' } },
    { name: 'devices', plugin: '@dsh-ext/devices' },
    { name: 'devices', options: { package: '@dsh-ext/devices' } },
  ]) assert.equal(devicesPluginActive(withEntries([entry])), true, JSON.stringify(entry))
})

test('unrelated rows and an explicitly disabled devices row do not count', () => {
  assert.equal(devicesPluginActive(withEntries([
    { name: '@dsh-ext/mobile-gateway' },
    { id: 'dsh-ext.mobile-gateway-devices' },
    { id: 'dsh-ext.dsh-wiki' },
  ])), false)
  assert.equal(devicesPluginActive(withEntries([{ id: 'dsh-ext.devices', disabled: true }])), false)
  assert.equal(devicesPluginActive(withEntries([{ name: '@dsh-ext/devices', disabled: true }])), false)
  assert.equal(devicesPluginActive(withEntries([{ disabled: true, config: { name: '@dsh-ext/devices' } }])), false)
})

test('a missing, surprising or failing configEditor reads as unknown, never as an error', () => {
  assert.equal(devicesPluginActive(), false)
  assert.equal(devicesPluginActive({}), false)
  assert.equal(devicesPluginActive({ get: () => undefined }), false)
  assert.equal(devicesPluginActive({ get: () => ({}) }), false)
  assert.equal(devicesPluginActive({ get: () => ({ entries: () => null }) }), false)
  assert.equal(devicesPluginActive({ get: () => ({ entries: () => { throw new Error('entries failed') } }) }), false)
  assert.equal(devicesPluginActive({ get: () => { throw new Error('service not available') } }), false)
})

// (c): the answer on the wire. The fixture drives the real `apply()` against a
// fake web server and calls the registered `/mgw` handler, so the payload read
// here is the one the browser half actually receives.
async function startStatusFixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-presence-'))
  const state = { entries: [] }
  const effects = []
  let route
  const webServer = {
    // The real server assigns its port after apply, exactly like this fixture
    // (measured in test/lan.test.mjs): apply must not need a bound port.
    port: 0,
    register(registered) { route = registered; return () => { route = undefined } },
    registerUpgrade() { return () => {} },
  }
  const ctx = {
    webServer,
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke() { throw new Error('unexpected Remote invocation') },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'workspace' && request.method === 'follow') {
            yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
            while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
          }
          if (request.namespace === 'session' && request.method === 'control') {
            yield { type: 'baseline', value: { projections: {} } }
            while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
          }
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    // `profileContext` is absent, as on a loopback-only web profile where web
    // restart is unavailable; `configEditor` is the optional service under test.
    get(name) { return name === 'configEditor' ? { entries: () => state.entries } : undefined },
  }
  await plugin.apply(ctx, {
    gatewayEnabled: false,
    lanEnabled: false,
    adminLoopbackOnly: true,
    pairingTtlMs: 60_000,
    // Both files stay in this fixture's temp directory: apply() must never fall
    // back to the real ~/.dsh device registry.
    deviceFile: path.join(temp, 'devices.json'),
    tlsCertificateDir: path.join(temp, 'tls'),
  })
  return {
    state,
    async status() {
      assert.ok(route, 'the management routes were never registered')
      const captured = {}
      const res = {
        writeHead(status, headers) { captured.status = status; captured.headers = headers },
        end(body) { captured.body = body },
      }
      await route.handler({
        method: 'GET',
        url: '/mgw/status',
        headers: { host: '127.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' },
      }, res)
      assert.equal(captured.status, 200)
      return JSON.parse(captured.body)
    },
    async dispose() {
      for (const dispose of effects.reverse()) dispose()
      fs.rmSync(temp, { recursive: true, force: true })
    },
  }
}

test('/mgw/status carries devicesPluginPresent and keeps every existing field', async () => {
  const fixture = await startStatusFixture()
  try {
    const standalone = await fixture.status()
    assert.equal(standalone.devicesPluginPresent, false, 'standalone: the section must show')
    for (const field of ['version', 'requireAuth', 'gatewayEnabled', 'remoteControl', 'wsPath', 'tools', 'lan', 'tls']) {
      assert.ok(field in standalone, `status lost its ${field} field`)
    }
    fixture.state.entries = [{ name: '@dsh-ext/devices' }]
    assert.equal((await fixture.status()).devicesPluginPresent, true,
      'devices plugin loaded: the section must stay hidden')
    fixture.state.entries = [{ id: 'dsh-ext.devices' }]
    assert.equal((await fixture.status()).devicesPluginPresent, true)
    fixture.state.entries = []
    assert.equal((await fixture.status()).devicesPluginPresent, false)
  } finally {
    await fixture.dispose()
  }
})
