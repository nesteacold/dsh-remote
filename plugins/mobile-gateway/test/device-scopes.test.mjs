// Spec 005 FR1/FR3 — the device record carries `kind` and `scopes`, and a record
// written before they existed still loads as a mobile device with the historical
// mobile grant (T3), so an already-paired phone keeps working after the upgrade.
//
// Security review (D006): that migration is the ONLY thing a restart may widen.
// A scope list the owner did write is read literally (empty and unknown-only stay
// empty), a malformed record is unusable instead of full-grant, and `scopeDenial`
// refuses a device with no live scope list instead of treating it as unrestricted.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createRegistry, digest } from '../lib/devices.js'
import { scopeDenial } from '../lib/allowlist.mjs'
import {
  DESKTOP_DEFAULT_SCOPES, DESKTOP_ONLY_SCOPES, DEVICE_KINDS, NEVER_DEFAULT_SCOPES, REMOTE_CLIENT_TYPES,
  SCOPES as CONTRACT_SCOPES, SCOPE_BY_TYPE,
} from '@dsh-ext/mobile-protocol'

// "Every scope" of a mobile device / a migrated pre-005 record is the seven spec
// 005/011 scopes. The spec 008 scopes (`harness:remote` and the full-control
// families) are explicit-only and desktop-only, so they are never part of that
// full grant (asserted below). The migration grant is narrower than that list: see
// MOBILE_DEFAULT_SCOPES.
const SCOPES = CONTRACT_SCOPES.filter((scope) => !DESKTOP_ONLY_SCOPES.includes(scope))
// Spec 011 FR-006: `sessions:author` is grantable to a mobile device but is never
// part of a DEFAULT grant (offer or migration); the contract's own list decides.
const MOBILE_DEFAULT_SCOPES = SCOPES.filter((scope) => !NEVER_DEFAULT_SCOPES.includes(scope))

function tempRegistry(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-005-devices-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { file: path.join(directory, 'devices.json'), directory, options }
}

/** One stored device row; `overrides` shape the record the restart has to read. */
function storedRecord(overrides = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Stored device',
    clientDeviceId: 'stored-install-0001',
    tokenHash: digest('stored-token'),
    createdAt: 1,
    lastSeenAt: null,
    revokedAt: null,
    ...overrides,
  }
}

test('a pairing defaults to a mobile device with every scope the defaults allow', (t) => {
  const { file, options } = tempRegistry(t)
  const registry = createRegistry(file, options)
  const pairing = registry.createPairing('Phone A')
  assert.equal(pairing.kind, 'mobile')
  assert.deepEqual(pairing.scopes, [...MOBILE_DEFAULT_SCOPES])
  // Spec 011 FR-006: the author scope is grantable here, but never by default.
  assert.equal(pairing.scopes.includes('sessions:author'), false, 'sessions:author must be an explicit tick')
  for (const scope of NEVER_DEFAULT_SCOPES) assert.equal(pairing.scopes.includes(scope), false, scope)
  const claimed = registry.claimPairing(pairing.code, 'phone-0001')
  assert.equal(claimed.device.kind, 'mobile')
  assert.deepEqual(claimed.device.scopes, [...MOBILE_DEFAULT_SCOPES])
  assert.deepEqual(registry.list()[0].scopes, [...MOBILE_DEFAULT_SCOPES])
  assert.equal(registry.list()[0].kind, 'mobile')
  // An explicit offer naming it is taken literally (the defaults narrow only defaults).
  const explicit = registry.createPairing('Phone B', { scopes: ['sessions:read', 'sessions:author'] })
  assert.deepEqual(explicit.scopes, ['sessions:read', 'sessions:author'])
})

test('a desktop offer keeps DESKTOP_DEFAULT_SCOPES unless the owner picks some', (t) => {
  const { file, options } = tempRegistry(t)
  const registry = createRegistry(file, options)
  const desktop = registry.createPairing('Desktop', { kind: 'desktop' })
  assert.equal(desktop.kind, 'desktop')
  assert.deepEqual(desktop.scopes, [...DESKTOP_DEFAULT_SCOPES])
  // Unknown and repeated scopes are dropped, contract order is kept.
  const custom = registry.createPairing('Desktop 2', {
    kind: 'desktop', scopes: ['approval:respond', 'approval:respond', 'not-a-scope', 'sessions:read'],
  })
  assert.deepEqual(custom.scopes, ['sessions:read', 'approval:respond'])
  // An unknown kind is never an upgrade: it falls back to mobile.
  assert.equal(registry.createPairing('x', { kind: 'tablet' }).kind, 'mobile')
  const narrow = registry.claimPairing(custom.code, 'desktop-0001')
  assert.equal(narrow.device.kind, 'desktop')
  assert.deepEqual(narrow.device.scopes, ['sessions:read', 'approval:respond'])
})

test('spec 008: harness:remote is granted only to a desktop offered it explicitly', (t) => {
  const { file, options } = tempRegistry(t)
  const registry = createRegistry(file, options)
  // Never a default: not for a desktop, not for "every scope" of a mobile.
  assert.equal(registry.createPairing('d', { kind: 'desktop' }).scopes.includes('harness:remote'), false)
  assert.equal(registry.createPairing('m').scopes.includes('harness:remote'), false)
  // Explicit on a desktop: kept.
  const chosen = registry.createPairing('d2', { kind: 'desktop', scopes: ['sessions:read', 'harness:remote'] })
  assert.deepEqual(chosen.scopes, ['sessions:read', 'harness:remote'])
  assert.deepEqual(registry.claimPairing(chosen.code, 'desk-remote-01').device.scopes, ['sessions:read', 'harness:remote'])
  // Explicit on a mobile (or an unknown kind, which falls back to mobile): dropped.
  assert.deepEqual(registry.createPairing('m2', { kind: 'mobile', scopes: ['harness:remote', 'sessions:read'] }).scopes, ['sessions:read'])
  assert.deepEqual(registry.createPairing('m3', { kind: 'tablet', scopes: ['harness:remote'] }).scopes, [])
  // A stored mobile record that lists it (hand-edited) loses it on load; a desktop keeps it.
  fs.writeFileSync(file, JSON.stringify({ version: 3, devices: [
    storedRecord({ id: '77777777-7777-4777-8777-777777777777', tokenHash: digest('mob'), kind: 'mobile', scopes: ['sessions:read', 'harness:remote'] }),
    storedRecord({ id: '88888888-8888-4888-8888-888888888888', tokenHash: digest('desk'), clientDeviceId: 'stored-install-0002', kind: 'desktop', scopes: ['harness:remote'] }),
  ] }))
  const reopened = createRegistry(file, options)
  const byId = new Map(reopened.list().map((device) => [device.id, device]))
  assert.deepEqual(byId.get('77777777-7777-4777-8777-777777777777').scopes, ['sessions:read'])
  assert.deepEqual(byId.get('88888888-8888-4888-8888-888888888888').scopes, ['harness:remote'])
})

test('re-pairing the same installation replaces kind and scopes with the new grant', (t) => {
  const { file, options } = tempRegistry(t)
  const registry = createRegistry(file, options)
  const phone = registry.claimPairing(registry.createPairing('Phone A').code, 'same-install-01')
  assert.equal(phone.repaired, false, 'the first pairing of an installation creates the record')
  assert.equal(phone.generation, 0)
  const narrowed = registry.claimPairing(
    registry.createPairing('Phone A', { scopes: ['sessions:read'] }).code, 'same-install-01', 'Phone A')
  assert.equal(narrowed.device.id, phone.device.id, 'the server-side row is reused')
  assert.deepEqual(narrowed.device.scopes, ['sessions:read'], 'the newest grant wins')
  assert.equal(registry.list().length, 1)
  // Spec 005 review: the replacement is a new credential generation, so the
  // sockets opened under the old grant can tell that they are stale.
  assert.equal(narrowed.repaired, true)
  assert.equal(narrowed.generation, 1, 'a re-pair starts a new credential generation')
  assert.equal(registry.generation(phone.device.id), 1)
  // A plain reconnect does not rotate anything.
  assert.equal(registry.authenticate(narrowed.token).id, phone.device.id)
  assert.equal(registry.generation(phone.device.id), 1, 'authenticating keeps the generation')
  registry.revoke(phone.device.id)
  assert.equal(registry.generation(phone.device.id), undefined, 'a revoked device has no generation')
})

test('T3: a legacy record (no kind/scopes) loads as mobile with the historical mobile grant and is persisted', (t) => {
  const { file, options } = tempRegistry(t)
  const legacy = {
    version: 3,
    devices: [{
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Old iPhone',
      clientDeviceId: 'old-install-0001',
      tokenHash: digest('legacy-token'),
      createdAt: 1,
      lastSeenAt: null,
      revokedAt: null,
    }],
  }
  fs.writeFileSync(file, JSON.stringify(legacy))

  const registry = createRegistry(file, options)
  const [device] = registry.list()
  assert.equal(device.kind, 'mobile')
  // Spec 011 FR-006: the migration restores the pre-011 mobile grant — the exact
  // scopes such a record had before the upgrade — and not every non-desktop scope,
  // because `sessions:author` is never-default and must be an owner's tick.
  assert.deepEqual(device.scopes, [...MOBILE_DEFAULT_SCOPES],
    'a pre-005 migration must not widen a record with a NEVER_DEFAULT_SCOPES scope')
  assert.equal(device.scopes.includes('sessions:author'), false,
    'sessions:author must not arrive through a record written before spec 011 existed')
  // The old credential still authenticates, carrying the migrated grant.
  const authenticated = registry.authenticate('legacy-token')
  assert.equal(authenticated.id, device.id)
  assert.deepEqual(authenticated.scopes, [...MOBILE_DEFAULT_SCOPES])
  // Every companion type the gateway can scope is allowed to it (the pre-005
  // behaviour). The spec 008 remote-bridge types are not companion ops and need
  // `harness:remote`, which a migrated mobile record never holds; the spec 011
  // authoring types need `sessions:author`, which the migration must not grant.
  for (const [type, scope] of Object.entries(SCOPE_BY_TYPE)) {
    if (REMOTE_CLIENT_TYPES.includes(type)) {
      assert.equal(authenticated.scopes.includes(scope), false, `${type} must stay closed to a migrated mobile`)
    } else if (MOBILE_DEFAULT_SCOPES.includes(scope)) {
      assert.ok(authenticated.scopes.includes(scope), `${type} (${scope}) must keep working after the migration`)
    } else {
      assert.equal(authenticated.scopes.includes(scope), false, `${type} (${scope}) is not part of the migrated grant`)
    }
  }

  // One save (any connection, pairing or revoke) persists the fields.
  registry.connected(device.id)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).devices[0]
  assert.equal(stored.kind, 'mobile')
  assert.deepEqual(stored.scopes, [...MOBILE_DEFAULT_SCOPES])
  const reopened = createRegistry(file, options)
  assert.deepEqual(reopened.list()[0].scopes, [...MOBILE_DEFAULT_SCOPES])
})

// Spec 011 FR-006 regression: the pre-005 migration used to copy the whole
// non-desktop list, so a record written before spec 011 existed silently acquired
// `sessions:author` on the first load after the upgrade — a privilege grant the
// owner never ticked.
test('T3b: a legacy record never acquires sessions:author through the migration', (t) => {
  const { file, options } = tempRegistry(t)
  fs.writeFileSync(file, JSON.stringify({
    version: 3,
    // `storedRecord` writes no `kind` and no `scopes`: exactly the legacy shape.
    devices: [storedRecord({ tokenHash: digest('legacy-no-author') })],
  }))

  const registry = createRegistry(file, options)
  const [device] = registry.list()
  assert.equal(device.kind, 'mobile')
  for (const scope of NEVER_DEFAULT_SCOPES) {
    assert.equal(device.scopes.includes(scope), false, `${scope} must not be granted by the migration`)
  }
  assert.deepEqual(registry.authenticate('legacy-no-author').scopes, [...MOBILE_DEFAULT_SCOPES])
  // The narrowing is persisted, so a reload cannot resurrect the scope either.
  registry.connected(device.id)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).devices[0].scopes, [...MOBILE_DEFAULT_SCOPES])
  assert.deepEqual(createRegistry(file, options).list()[0].scopes, [...MOBILE_DEFAULT_SCOPES])
})

// The never-default rule narrows DEFAULTS only: a record that names the scope was
// written by an owner decision (or by an explicit offer) and keeps it.
test('T3c: a record that explicitly lists sessions:author keeps it', (t) => {
  const { file, options } = tempRegistry(t)
  fs.writeFileSync(file, JSON.stringify({
    version: 3,
    devices: [storedRecord({ kind: 'mobile', scopes: ['sessions:read', 'sessions:author'] })],
  }))

  const registry = createRegistry(file, options)
  const [device] = registry.list()
  assert.equal(device.kind, 'mobile')
  assert.deepEqual(device.scopes, ['sessions:read', 'sessions:author'],
    'an explicit grant is read literally; NEVER_DEFAULT_SCOPES only filters defaults')
  const authenticated = registry.authenticate('stored-token')
  assert.equal(authenticated.scopes.includes('sessions:author'), true,
    'the explicit path must still grant the author scope')
  assert.equal(scopeDenial(authenticated, 'session-create'), undefined)
})

test('T7: an expired pairing code no longer redeems, and a desktop code keeps the offer TTL', async (t) => {
  const { file } = tempRegistry(t)
  // `pairingTtlMs` has a 30 s floor at the plugin boundary; the registry enforces
  // its own TTL, which is what redemption checks (spec 005 FR3: same TTL).
  const registry = createRegistry(file, { pairingTtlMs: 30 })
  const desktop = registry.createPairing('Desktop', { kind: 'desktop' })
  assert.equal(desktop.expiresAt - Date.now() <= 100, true)
  assert.equal(registry.hasPairing(desktop.code), true)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(registry.hasPairing(desktop.code), false, 'an expired code is forgotten')
  assert.equal(registry.claimPairing(desktop.code, 'desktop-late'), undefined, 'an expired code cannot be redeemed')
  assert.deepEqual(registry.list(), [])
})

test('T7b: a pairing TTL above the contract window is clamped to five minutes at the registry', async (t) => {
  const { file } = tempRegistry(t)
  // Contract §2: `expiresAt` is at most 5 min ahead. The plugin config schema is
  // capped too, but a caller that mounts the plugin with an object skips schema
  // validation, so the registry itself must refuse to mint a longer code.
  const clamped = createRegistry(file, { pairingTtlMs: 900_000 }).createPairing('Clamped')
  const clampedTtl = clamped.expiresAt - Date.now()
  assert.ok(clampedTtl > 290_000 && clampedTtl <= 300_000, `900000 must be clamped to 300000ms, got ${clampedTtl}`)
  // A value inside the window is untouched: no behaviour change for 5 min or less.
  const normal = createRegistry(file, { pairingTtlMs: 300_000 }).createPairing('Normal')
  const normalTtl = normal.expiresAt - Date.now()
  assert.ok(normalTtl > 290_000 && normalTtl <= 300_000, `300000 must be offered unchanged, got ${normalTtl}`)
  // And the clamp is a clamp, not a reset to the default: below the window the
  // requested value still decides.
  const short = createRegistry(file, { pairingTtlMs: 120_000 }).createPairing('Short')
  assert.ok(short.expiresAt - Date.now() <= 120_000 && short.expiresAt - Date.now() > 110_000)
})

test('T2: the scope gate fails closed for a companion op with no mapping', () => {
  // FR2: a companion-v1 type with no entry in SCOPE_BY_TYPE must not run.
  // `scopeDenial` is what the router asks before any Host call.
  const desktop = { scopes: ['sessions:read', 'prompt:send', 'approval:respond'] }
  for (const [type, scope] of Object.entries(SCOPE_BY_TYPE)) {
    const denial = scopeDenial(desktop, type)
    assert.equal(denial === undefined, desktop.scopes.includes(scope), `${type} (${scope})`)
    if (denial) assert.equal(denial.code, 'auth/forbidden-scope')
  }
  // An unmapped companion op is refused rather than served.
  assert.equal(scopeDenial(desktop, 'push-register').code, 'auth/forbidden-scope')
  // Self-revocation is never gated on a scope (contract §4).
  assert.equal(scopeDenial(desktop, 'device-forget'), undefined)
  // A type outside the companion vocabulary is the allowlist's business.
  assert.equal(scopeDenial(desktop, 'plugin-catalog'), undefined)
  // Spec 005 review (was fail-open): a device with no live scope list is not
  // "unrestricted" any more. The legacy migration happens at load in devices.js
  // (T3 above), so a caller arriving here with a missing record, a revoked one
  // or a malformed `scopes` value is denied instead of being served everything.
  for (const missing of [undefined, {}, { scopes: undefined }, { scopes: null }, { scopes: 'sessions:read' }]) {
    const denial = scopeDenial(missing, 'message')
    assert.equal(denial?.code, 'auth/forbidden-scope', `no live scope list must deny: ${JSON.stringify(missing)}`)
    assert.equal(denial.requestType, 'message')
  }
})

// ---------------------------------------------------------------------------
// Spec 005 review: what a restart does with a stored grant. Only a record that
// predates `kind`/`scopes` migrates; everything else is read as written, and a
// malformed record is unusable rather than a full-grant device.
// ---------------------------------------------------------------------------

test('restart: an explicit empty scope list stays empty', (t) => {
  const { file, options } = tempRegistry(t)
  fs.writeFileSync(file, JSON.stringify({ version: 3, devices: [storedRecord({ kind: 'desktop', scopes: [] })] }))
  const registry = createRegistry(file, options)
  assert.deepEqual(registry.list()[0].scopes, [])
  // The credential still works; the grant is just empty, so every scoped op is refused.
  const authenticated = registry.authenticate('stored-token')
  assert.deepEqual(authenticated.scopes, [])
  assert.equal(scopeDenial(authenticated, 'message').code, 'auth/forbidden-scope')
  // And it survives a second restart unchanged.
  const reopened = createRegistry(file, options)
  assert.deepEqual(reopened.list()[0].scopes, [])
})

test('restart: a list of only unknown scopes stays empty', (t) => {
  const { file, options } = tempRegistry(t)
  fs.writeFileSync(file, JSON.stringify({
    version: 3,
    devices: [storedRecord({ kind: 'mobile', scopes: ['root', 'not-a-scope', 'root'] })],
  }))
  const registry = createRegistry(file, options)
  assert.deepEqual(registry.list()[0].scopes, [], 'unknown names grant nothing')
  const authenticated = registry.authenticate('stored-token')
  assert.equal(scopeDenial(authenticated, 'sessions').code, 'auth/forbidden-scope')
})

test('restart: malformed records are unusable, never full-grant devices', (t) => {
  const { file, options } = tempRegistry(t)
  fs.writeFileSync(file, JSON.stringify({
    version: 3,
    devices: [
      storedRecord({ id: '33333333-3333-4333-8333-333333333333', scopes: 'sessions:read' }),
      storedRecord({ id: '44444444-4444-4444-8444-444444444444', kind: 'tablet', scopes: ['sessions:read'] }),
    ],
  }))
  const registry = createRegistry(file, options)
  assert.deepEqual(registry.list(), [], 'a malformed record is not served')
  assert.equal(registry.authenticate('stored-token'), undefined, 'a malformed record cannot authenticate')
})

test('restart: a partial record (only one of kind/scopes) grants no default', (t) => {
  const { file, options } = tempRegistry(t)
  fs.writeFileSync(file, JSON.stringify({
    version: 3,
    devices: [
      // `kind` written, `scopes` never written: NOT the legacy shape, so no migration.
      storedRecord({ id: '55555555-5555-4555-8555-555555555555', tokenHash: digest('kind-only'), kind: 'desktop' }),
      // `scopes` written, no `kind`: the list is the whole grant, `mobile` is just the label.
      storedRecord({ id: '66666666-6666-4666-8666-666666666666', tokenHash: digest('scopes-only'), scopes: ['prompt:send'] }),
    ],
  }))
  const registry = createRegistry(file, options)
  const byId = new Map(registry.list().map((device) => [device.id, device]))
  assert.deepEqual(byId.get('55555555-5555-4555-8555-555555555555').scopes, [],
    'a kind without scopes is not the legacy migration')
  const scopesOnly = byId.get('66666666-6666-4666-8666-666666666666')
  assert.equal(scopesOnly.kind, 'mobile')
  assert.deepEqual(scopesOnly.scopes, ['prompt:send'], 'the stored list is the grant, not a default')
})

test('the shared vocabulary is what the record uses', () => {
  assert.deepEqual([...DEVICE_KINDS], ['mobile', 'desktop'])
  // Seven spec 005 scopes + the spec 011 author scope + seven spec 008 scopes
  // (`harness:remote` and the six full-control scopes; explicit-only, desktop-only).
  assert.equal(CONTRACT_SCOPES.length, 14)
  assert.equal(DESKTOP_ONLY_SCOPES.length, 7)
  assert.equal(SCOPES.length, 7)
  assert.deepEqual(SCOPES.filter((scope) => NEVER_DEFAULT_SCOPES.includes(scope)), ['sessions:author'])
})

test('spec 008 full control: a desktop can be granted every desktop-only scope; a mobile or legacy record never holds one', (t) => {
  const { file, options } = tempRegistry(t)
  const registry = createRegistry(file, options)
  const all = [...CONTRACT_SCOPES]
  const desktop = registry.createPairing('d', { kind: 'desktop', scopes: all })
  assert.deepEqual(desktop.scopes, all, 'a desktop keeps every scope it was offered')
  assert.deepEqual(registry.claimPairing(desktop.code, 'desk-full-0001').device.scopes, all)
  // A mobile offer drops every desktop-only scope.
  const mobile = registry.createPairing('m', { kind: 'mobile', scopes: all })
  assert.deepEqual(mobile.scopes, [...SCOPES])
  for (const scope of DESKTOP_ONLY_SCOPES) assert.equal(mobile.scopes.includes(scope), false, scope)
  // No default (desktop, mobile, or "all scopes") ever includes one.
  for (const offer of [registry.createPairing('d2', { kind: 'desktop' }), registry.createPairing('m2')]) {
    for (const scope of DESKTOP_ONLY_SCOPES) assert.equal(offer.scopes.includes(scope), false, scope)
  }
  // A stored mobile record that lists them loses them on load; a stored desktop keeps them.
  fs.writeFileSync(file, JSON.stringify({ version: 3, devices: [
    storedRecord({ id: '99999999-9999-4999-8999-999999999999', tokenHash: digest('m-full'), kind: 'mobile', scopes: [...all] }),
    storedRecord({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tokenHash: digest('d-full'), clientDeviceId: 'stored-install-0003', kind: 'desktop', scopes: [...all] }),
  ] }))
  const byId = new Map(createRegistry(file, options).list().map((device) => [device.id, device]))
  assert.deepEqual(byId.get('99999999-9999-4999-8999-999999999999').scopes, [...SCOPES])
  assert.deepEqual(byId.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').scopes, all)
})