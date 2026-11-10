// T022a groundwork — unit tests for `lib/companion-access.mjs` (pure module).
//
// Run directly (package.json is owned elsewhere and does not list this file):
//
//   node --test test/companion-access.test.mjs
//
// DSH's real `RemoteAccessService.decide()` is not loadable here (it lives in the
// installed app's asar and needs a Host). `decide` below is a line-for-line copy
// of its evaluation rules, read from the installed 0.2.2-rc.1 source:
//   owner / `remoteAccess/follow` -> allow; no policy for the principal kind ->
//   deny `no-allow`; for EVERY resource the call touches, some binding with the
//   exact same resource (kind + id) whose role lists the action (and whose
//   condition, if any, allows) must exist; a throwing bindings() -> `policy-failed`;
//   otherwise deny with `explain()`'s reason, else `no-allow`.
// The tests therefore prove what DSH would decide for the policy this module
// builds, not merely the shape of the bindings.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as contract from '@dsh-ext/mobile-protocol'
import {
  COMPANION_DEVICE_KIND, COMPANION_DEVICE_KINDS, COMPANION_ENDPOINTS, COMPANION_EVENT_ACTIONS, COMPANION_PRINCIPAL_KIND,
  COMPANION_UNSUPPORTED_ENDPOINTS, SESSION_RESOURCE_KIND, createCompanionAccessPolicy,
  hostEndpointAllowedForDevice, isCompanionEndpoint,
} from '../lib/companion-access.mjs'

const sameResource = (a, b) => a.kind === b.kind && a.id === b.id

/** Copy of RemoteAccessService.decide/evaluate (installed DSH 0.2.2-rc.1). */
function decide(policy, request) {
  const { principal, action } = request
  if (principal.kind === 'owner' || action === 'remoteAccess/follow') return { kind: 'allow' }
  if (principal.kind !== COMPANION_PRINCIPAL_KIND) return { kind: 'deny', reason: 'no-allow' }
  let bindings
  try { bindings = policy.bindings(principal) } catch { return { kind: 'deny', reason: 'policy-failed' } }
  for (const resource of request.resources) {
    const hit = bindings.some((binding) => sameResource(binding.resource, resource)
      && binding.role.actions.includes(action)
      && (binding.condition === undefined || binding.condition({ action, resource, args: request.args }).kind === 'allow'))
    if (hit) continue
    let reason
    try { reason = policy.explain?.(request) } catch { return { kind: 'deny', reason: 'policy-failed' } }
    return { kind: 'deny', reason: reason ?? 'no-allow' }
  }
  return { kind: 'allow' }
}

/** `allows(resource)` used by session/list filtering: the call's action, no args. */
const allows = (policy, principal, action, resource) => decide(policy, { principal, action, resources: [resource] }).kind === 'allow'

const GLOBAL = { kind: 'global' }
const session = (id) => ({ kind: SESSION_RESOURCE_KIND, id })
const principalOf = (deviceId = 'dev-1') => ({ kind: COMPANION_PRINCIPAL_KIND, deviceId })
const ALL_MOBILE_SCOPES = [...contract.SCOPES].filter((scope) => scope !== 'harness:remote')
const { DESKTOP_DEFAULT_SCOPES } = contract

function makePolicy({ devices = {}, sessions = {} } = {}) {
  const calls = { getDevice: 0, getSessionIds: 0 }
  const policy = createCompanionAccessPolicy({
    getDevice(id) { calls.getDevice += 1; return devices[id] },
    getSessionIds(id) { calls.getSessionIds += 1; return sessions[id] ?? [] },
  })
  return { policy, calls }
}

const mobile = (scopes, extra = {}) => ({ kind: 'mobile', scopes, revokedAt: null, ...extra })
const FULL = mobile(['sessions:read', 'prompt:send', 'approval:respond'])

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

test('endpoint mapping: exactly the companion reads and prompt/cancel', () => {
  assert.deepEqual(Object.keys(COMPANION_ENDPOINTS).sort(), [
    'session/cancel', 'session/events', 'session/follow', 'session/list',
    'session/page', 'session/projections', 'session/prompt', 'session/search',
  ])
  for (const key of Object.keys(COMPANION_ENDPOINTS)) {
    const [namespace, method] = key.split('/')
    assert.equal(hostEndpointAllowedForDevice(namespace, method), true, key)
    assert.equal(isCompanionEndpoint(namespace, method), true, key)
  }
})

test('endpoint mapping: every scope used is a contract scope and never harness:remote', () => {
  for (const [action, entry] of Object.entries(COMPANION_ENDPOINTS)) {
    assert.ok(contract.SCOPES.includes(entry.scope), `${action} scope ${entry.scope}`)
    assert.notEqual(entry.scope, 'harness:remote', action)
  }
  // Same scope assignment as the wire contract: reads -> sessions:read, input -> prompt:send.
  assert.equal(COMPANION_ENDPOINTS['session/list'].scope, contract.SCOPE_BY_TYPE.sessions)
  assert.equal(COMPANION_ENDPOINTS['session/search'].scope, contract.SCOPE_BY_TYPE.search)
  assert.equal(COMPANION_ENDPOINTS['session/follow'].scope, contract.SCOPE_BY_TYPE.subscribe)
  assert.equal(COMPANION_ENDPOINTS['session/page'].scope, contract.SCOPE_BY_TYPE.history)
  assert.equal(COMPANION_ENDPOINTS['session/prompt'].scope, contract.SCOPE_BY_TYPE.message)
  assert.equal(COMPANION_ENDPOINTS['session/cancel'].scope, contract.SCOPE_BY_TYPE['session-cancel'])
})

test('unknown and dangerous endpoints are denied by the positive guard', () => {
  for (const [namespace, method] of [
    ['session', 'create'], ['session', 'fork'], ['session', 'rename'], ['session', 'updateQueue'],
    ['session', 'selectModel'], ['session', 'attachment'], ['session', 'canOpenWorkspacePath'],
    ['session', 'openWorkspacePath'], ['session', 'modelCatalog'], ['session', 'state'],
    ['settings', 'mutate'], ['pluginManager', 'installBundle'], ['commands', 'execute'],
    ['permissions', 'set'], ['schedule', 'create'], ['workspace', 'create'], ['workspace', 'follow'],
    ['speech', 'transcribe'], ['fileUploads', 'upload'], ['goals', 'clear'], ['userQuestions', 'answer'],
    ['subagents', 'prompt'], ['subagents', 'interruptByParent'], ['remoteAccess', 'follow'], ['session', 'control'],
    ['*', '*'], ['session', '*'], ['session', ''], ['', 'list'], ['Session', 'list'], ['session', 'LIST'],
    ['session', '__proto__'], ['constructor', 'prototype'], ['session', 'toString'],
    [undefined, 'list'], ['session', undefined], [null, null], [1, 2],
  ]) {
    assert.equal(hostEndpointAllowedForDevice(namespace, method), false, `${namespace}/${method}`)
  }
})

test('subagent endpoints stay unsupported (resource resolution unverified) and are documented', () => {
  assert.ok(Object.hasOwn(COMPANION_UNSUPPORTED_ENDPOINTS, 'subagents/prompt'))
  assert.ok(Object.hasOwn(COMPANION_UNSUPPORTED_ENDPOINTS, 'subagents/interruptByParent'))
  assert.equal(Object.hasOwn(COMPANION_ENDPOINTS, 'subagents/prompt'), false)
  assert.equal(Object.hasOwn(COMPANION_ENDPOINTS, 'subagents/interruptByParent'), false)
  // And the policy never grants them, whatever the resource.
  const { policy } = makePolicy({ devices: { 'dev-1': FULL }, sessions: { 'dev-1': ['s1'] } })
  for (const action of ['subagents/prompt', 'subagents/interruptByParent']) {
    for (const resources of [[GLOBAL], [session('s1')]]) {
      assert.equal(decide(policy, { principal: principalOf(), action, resources }).kind, 'deny', action)
    }
  }
})

test('session/control is NOT granted: global stream item filtering is unproven (explicit negative control)', () => {
  // `itemFilter: true` is not a stream filter; until a live Host proves per-session
  // filtering of the whole-Host control stream, no device may hold this action.
  assert.equal(Object.hasOwn(COMPANION_ENDPOINTS, 'session/control'), false)
  assert.equal(hostEndpointAllowedForDevice('session', 'control'), false)
  assert.equal(isCompanionEndpoint('session', 'control'), false)
  assert.ok(Object.hasOwn(COMPANION_UNSUPPORTED_ENDPOINTS, 'session/control'))
  for (const kind of COMPANION_DEVICE_KINDS) {
    for (const scopes of [['sessions:read'], ALL_MOBILE_SCOPES, [...DESKTOP_DEFAULT_SCOPES]]) {
      const { policy } = makePolicy({ devices: { 'dev-1': { kind, scopes, revokedAt: null } }, sessions: { 'dev-1': ['s1'] } })
      for (const binding of policy.bindings(principalOf())) {
        assert.equal(binding.role.actions.includes('session/control'), false, `${kind} ${binding.role.name}`)
      }
      for (const resources of [[GLOBAL], [session('s1')]]) {
        assert.equal(decide(policy, { principal: principalOf(), action: 'session/control', resources }).kind, 'deny', `${kind} ${resources[0].kind}`)
      }
      assert.equal(allows(policy, principalOf(), 'session/control', session('s1')), false)
    }
  }
})

test('role/endpoint tables carry no plugin-owned or workspace/global wildcard action', () => {
  const { policy } = makePolicy({ devices: { 'dev-1': FULL }, sessions: { 'dev-1': ['s1'] } })
  for (const binding of policy.bindings(principalOf())) {
    for (const action of binding.role.actions) {
      assert.equal(action.includes('*'), false, action)
      assert.ok(Object.hasOwn(COMPANION_ENDPOINTS, action) || COMPANION_EVENT_ACTIONS.includes(action), action)
    }
  }
})

// ---------------------------------------------------------------------------
// Factory validation
// ---------------------------------------------------------------------------

test('factory requires injected getDevice and getSessionIds', () => {
  for (const facts of [undefined, null, {}, { getDevice() {} }, { getSessionIds() {} }, { getDevice: 1, getSessionIds: 2 }, []]) {
    assert.throws(() => createCompanionAccessPolicy(facts), TypeError)
  }
  const policy = createCompanionAccessPolicy({ getDevice() {}, getSessionIds() {} })
  assert.equal(typeof policy.bindings, 'function')
  assert.equal(typeof policy.explain, 'function')
})

// ---------------------------------------------------------------------------
// Known-allowed
// ---------------------------------------------------------------------------

test('known-allowed: full mobile device reads, prompts and cancels its sessions only', () => {
  const { policy } = makePolicy({ devices: { 'dev-1': FULL }, sessions: { 'dev-1': ['s1', 's2'] } })
  const p = principalOf()
  // Global calls (list/search touch `global`).
  for (const action of ['session/list', 'session/search']) {
    assert.equal(decide(policy, { principal: p, action, resources: [GLOBAL] }).kind, 'allow', action)
  }
  // Per-session reads and writes.
  for (const id of ['s1', 's2']) {
    for (const action of ['session/follow', 'session/page', 'session/events', 'session/projections', 'session/prompt', 'session/cancel']) {
      assert.equal(decide(policy, { principal: p, action, resources: [session(id)] }).kind, 'allow', `${action} ${id}`)
    }
  }
  // Item filter used by session/list and session/search.
  assert.equal(allows(policy, p, 'session/list', session('s1')), true)
  assert.equal(allows(policy, p, 'session/search', session('s2')), true)
  // Forwarded session notifications for visible sessions.
  for (const action of COMPANION_EVENT_ACTIONS) {
    assert.equal(decide(policy, { principal: p, action, resources: [session('s1')] }).kind, 'allow', action)
  }
  // DSH always allows every Peer its own snapshot.
  assert.equal(decide(policy, { principal: p, action: 'remoteAccess/follow', resources: [GLOBAL] }).kind, 'allow')
})

test('known-allowed uses exact session ids: no wildcard, no foreign session', () => {
  const { policy } = makePolicy({ devices: { 'dev-1': FULL }, sessions: { 'dev-1': ['s1'] } })
  const p = principalOf()
  const bindings = policy.bindings(p)
  const sessionBindings = bindings.filter((binding) => binding.resource.kind === SESSION_RESOURCE_KIND)
  assert.deepEqual(sessionBindings.map((binding) => binding.resource.id), ['s1'])
  for (const binding of bindings) assert.equal(Object.hasOwn(binding.resource, 'id') ? binding.resource.id !== '*' : true, true)
  for (const id of ['s2', 'S1', 's1 ', '*', '', 'other']) {
    assert.equal(decide(policy, { principal: p, action: 'session/prompt', resources: [session(id)] }).kind, 'deny', `[${id}]`)
    assert.equal(allows(policy, p, 'session/list', session(id)), false, `list [${id}]`)
  }
  // A call touching one visible and one foreign session is denied (every resource must be allowed).
  assert.equal(decide(policy, { principal: p, action: 'session/follow', resources: [session('s1'), session('s2')] }).kind, 'deny')
})

test('global-only role: session/prompt on `global` is denied (no global session wildcard)', () => {
  const { policy } = makePolicy({ devices: { 'dev-1': FULL }, sessions: { 'dev-1': ['s1'] } })
  for (const action of ['session/prompt', 'session/cancel', 'session/follow', 'session/page', 'session/events', 'session/projections']) {
    assert.equal(decide(policy, { principal: principalOf(), action, resources: [GLOBAL] }).kind, 'deny', action)
  }
})

test('per-device isolation: another device\'s sessions are not visible', () => {
  const { policy } = makePolicy({
    devices: { 'dev-1': FULL, 'dev-2': FULL },
    sessions: { 'dev-1': ['a'], 'dev-2': ['b'] },
  })
  assert.equal(decide(policy, { principal: principalOf('dev-1'), action: 'session/prompt', resources: [session('a')] }).kind, 'allow')
  assert.equal(decide(policy, { principal: principalOf('dev-1'), action: 'session/prompt', resources: [session('b')] }).kind, 'deny')
  assert.equal(decide(policy, { principal: principalOf('dev-2'), action: 'session/prompt', resources: [session('b')] }).kind, 'allow')
  assert.equal(decide(policy, { principal: principalOf('dev-2'), action: 'session/prompt', resources: [session('a')] }).kind, 'deny')
})

// ---------------------------------------------------------------------------
// Unknown endpoint / principal
// ---------------------------------------------------------------------------

test('unknown endpoint is denied even with full scopes and a visible session', () => {
  const { policy } = makePolicy({ devices: { 'dev-1': mobile(ALL_MOBILE_SCOPES) }, sessions: { 'dev-1': ['s1'] } })
  for (const action of ['session/create', 'session/fork', 'settings/mutate', 'commands/execute', 'fileUploads/upload',
    'subagents/prompt', 'session/attachment', 'workspace/follow', 'goals/get', 'event:api-session/unknown', 'nonsense']) {
    for (const resources of [[GLOBAL], [session('s1')]]) {
      const result = decide(policy, { principal: principalOf(), action, resources })
      assert.equal(result.kind, 'deny', `${action} ${resources[0].kind}`)
    }
  }
})

test('wrong principal kind / malformed principal gets no bindings', () => {
  const { policy, calls } = makePolicy({ devices: { 'dev-1': FULL }, sessions: { 'dev-1': ['s1'] } })
  for (const principal of [
    { kind: 'owner' }, { kind: 'share-viewer', deviceId: 'dev-1' }, { kind: COMPANION_PRINCIPAL_KIND },
    { kind: COMPANION_PRINCIPAL_KIND, deviceId: '' }, { kind: COMPANION_PRINCIPAL_KIND, deviceId: 7 },
    { kind: COMPANION_PRINCIPAL_KIND, deviceId: null }, undefined, null, 'dsh-ext-mobile-device', [],
  ]) {
    assert.deepEqual(policy.bindings(principal), [], JSON.stringify(principal))
  }
  assert.equal(calls.getDevice, 0, 'facts are not consulted for a malformed principal')
})

// ---------------------------------------------------------------------------
// Missing / revoked / malformed scopes
// ---------------------------------------------------------------------------

test('missing device or revoked device: no access at all', () => {
  const { policy } = makePolicy({
    devices: {
      revoked: mobile(['sessions:read', 'prompt:send'], { revokedAt: Date.now() }),
      alsoRevoked: mobile(['sessions:read'], { revokedAt: 1 }),
      nullish: null,
    },
    sessions: { revoked: ['s1'], alsoRevoked: ['s1'], nullish: ['s1'], ghost: ['s1'] },
  })
  for (const deviceId of ['revoked', 'alsoRevoked', 'nullish', 'ghost', 'never-paired']) {
    assert.deepEqual(policy.bindings(principalOf(deviceId)), [], deviceId)
    for (const action of ['session/list', 'session/prompt', 'session/follow']) {
      for (const resources of [[GLOBAL], [session('s1')]]) {
        assert.equal(decide(policy, { principal: principalOf(deviceId), action, resources }).kind, 'deny', `${deviceId} ${action}`)
      }
    }
  }
})

test('revocation takes effect on the very next decision (bindings is never cached)', () => {
  const devices = { 'dev-1': { ...FULL } }
  const { policy } = makePolicy({ devices, sessions: { 'dev-1': ['s1'] } })
  const request = { principal: principalOf(), action: 'session/prompt', resources: [session('s1')] }
  assert.equal(decide(policy, request).kind, 'allow')
  devices['dev-1'].revokedAt = Date.now()
  assert.equal(decide(policy, request).kind, 'deny')
  delete devices['dev-1']
  assert.equal(decide(policy, request).kind, 'deny')
})

test('missing / malformed scopes fail closed (never a default grant)', () => {
  for (const scopes of [
    undefined, null, 'sessions:read', 'prompt:send', {}, 42, true, { 0: 'sessions:read', length: 1 },
    [1], [null], [{}], [['sessions:read']], ['sessions:read', 7], ['sessions:read', 'bogus:scope'], ['bogus:scope'],
    ['SESSIONS:READ'], ['sessions:read '], [''], new Set(['sessions:read']),
  ]) {
    const { policy } = makePolicy({ devices: { 'dev-1': { kind: 'mobile', scopes, revokedAt: null } }, sessions: { 'dev-1': ['s1'] } })
    assert.deepEqual(policy.bindings(principalOf()), [], `scopes=${JSON.stringify(scopes)}`)
    assert.equal(decide(policy, { principal: principalOf(), action: 'session/list', resources: [GLOBAL] }).kind, 'deny')
    assert.equal(decide(policy, { principal: principalOf(), action: 'session/prompt', resources: [session('s1')] }).kind, 'deny')
  }
})

test('malformed device record or kind fails closed', () => {
  for (const device of [
    'dev', 5, [], true,
    { scopes: ['sessions:read'] },
    { kind: 'robot', scopes: ['sessions:read'] },
    { kind: 'MOBILE', scopes: ['sessions:read'] },
  ]) {
    const { policy } = makePolicy({ devices: { 'dev-1': device }, sessions: { 'dev-1': ['s1'] } })
    assert.deepEqual(policy.bindings(principalOf()), [], JSON.stringify(device))
  }
})

test('explicit empty scope list grants nothing', () => {
  const { policy } = makePolicy({ devices: { 'dev-1': mobile([]) }, sessions: { 'dev-1': ['s1'] } })
  assert.deepEqual(policy.bindings(principalOf()), [])
  for (const action of Object.keys(COMPANION_ENDPOINTS)) {
    assert.equal(decide(policy, { principal: principalOf(), action, resources: [GLOBAL] }).kind, 'deny', action)
    assert.equal(decide(policy, { principal: principalOf(), action, resources: [session('s1')] }).kind, 'deny', action)
  }
})

test('desktop-kind device gets the SAME narrow restrictions as mobile (default scopes positive)', () => {
  assert.deepEqual([...COMPANION_DEVICE_KINDS].sort(), [...contract.DEVICE_KINDS].sort())
  const shape = (device) => {
    const { policy } = makePolicy({ devices: { 'dev-1': device }, sessions: { 'dev-1': ['s1', 's2'] } })
    return policy.bindings(principalOf()).map((b) => ({ role: b.role.name, actions: [...b.role.actions], resource: b.resource }))
  }
  // Positive: desktop default scopes work like a phone with the same scopes.
  const desktop = { kind: 'desktop', scopes: [...DESKTOP_DEFAULT_SCOPES], revokedAt: null }
  assert.deepEqual(shape(desktop), shape({ ...desktop, kind: 'mobile' }))
  const { policy } = makePolicy({ devices: { 'dev-1': desktop }, sessions: { 'dev-1': ['s1'] } })
  for (const action of ['session/list', 'session/search']) {
    assert.equal(decide(policy, { principal: principalOf(), action, resources: [GLOBAL] }).kind, 'allow', action)
  }
  for (const action of ['session/follow', 'session/page', 'session/events', 'session/projections', 'session/prompt', 'session/cancel']) {
    assert.equal(decide(policy, { principal: principalOf(), action, resources: [session('s1')] }).kind, 'allow', action)
    assert.equal(decide(policy, { principal: principalOf(), action, resources: [session('s9')] }).kind, 'deny', `${action} foreign`)
  }
  // Same scope narrowing as mobile.
  assert.deepEqual(shape({ kind: 'desktop', scopes: ['sessions:read'], revokedAt: null }), shape(mobile(['sessions:read'])))
  assert.deepEqual(shape({ kind: 'desktop', scopes: ['prompt:send'], revokedAt: null }), shape(mobile(['prompt:send'])))
  assert.deepEqual(shape({ kind: 'desktop', scopes: [], revokedAt: null }), [])
  // Same fail-closed behaviour for malformed scopes and revocation.
  for (const scopes of [undefined, 'sessions:read', ['bogus:scope'], ['sessions:read', 7]]) {
    assert.deepEqual(shape({ kind: 'desktop', scopes, revokedAt: null }), [], JSON.stringify(scopes))
  }
  assert.deepEqual(shape({ ...desktop, revokedAt: 1 }), [])
})

test('harness:remote-only desktop gets nothing; harness:remote adds nothing to a desktop grant (008 bridge is separate)', () => {
  const only = makePolicy({
    devices: { 'dev-1': { kind: 'desktop', scopes: ['harness:remote'], revokedAt: null } },
    sessions: { 'dev-1': ['s1'] },
  })
  assert.deepEqual(only.policy.bindings(principalOf()), [])
  const withDefaults = (scopes) => makePolicy({
    devices: { 'dev-1': { kind: 'desktop', scopes, revokedAt: null } },
    sessions: { 'dev-1': ['s1'] },
  }).policy.bindings(principalOf()).map((b) => [b.role.name, [...b.role.actions]])
  assert.deepEqual(withDefaults([...DESKTOP_DEFAULT_SCOPES, 'harness:remote']), withDefaults([...DESKTOP_DEFAULT_SCOPES]))
})

test('harness:remote scope grants nothing in this policy', () => {
  // Not even a (mis)configured mobile record holding it may widen the mapping.
  const { policy } = makePolicy({ devices: { 'dev-1': mobile(['harness:remote']) }, sessions: { 'dev-1': ['s1'] } })
  assert.deepEqual(policy.bindings(principalOf()), [])
})

// ---------------------------------------------------------------------------
// Scope -> action restrictions
// ---------------------------------------------------------------------------

test('scopes narrow actions: sessions:read only cannot prompt or cancel', () => {
  const { policy } = makePolicy({ devices: { 'dev-1': mobile(['sessions:read']) }, sessions: { 'dev-1': ['s1'] } })
  const p = principalOf()
  for (const action of ['session/follow', 'session/page', 'session/events', 'session/projections']) {
    assert.equal(decide(policy, { principal: p, action, resources: [session('s1')] }).kind, 'allow', action)
  }
  for (const action of ['session/list', 'session/search']) {
    assert.equal(decide(policy, { principal: p, action, resources: [GLOBAL] }).kind, 'allow', action)
  }
  for (const action of ['session/prompt', 'session/cancel']) {
    const result = decide(policy, { principal: p, action, resources: [session('s1')] })
    assert.equal(result.kind, 'deny', action)
    assert.equal(result.reason, 'scope-not-granted', action)
  }
})

test('scopes narrow actions: prompt:send only cannot read or list', () => {
  const { policy } = makePolicy({ devices: { 'dev-1': mobile(['prompt:send']) }, sessions: { 'dev-1': ['s1'] } })
  const p = principalOf()
  for (const action of ['session/prompt', 'session/cancel']) {
    assert.equal(decide(policy, { principal: p, action, resources: [session('s1')] }).kind, 'allow', action)
  }
  for (const action of ['session/follow', 'session/page', 'session/events', 'session/projections']) {
    assert.equal(decide(policy, { principal: p, action, resources: [session('s1')] }).kind, 'deny', action)
  }
  for (const action of ['session/list', 'session/search']) {
    assert.equal(decide(policy, { principal: p, action, resources: [GLOBAL] }).kind, 'deny', action)
  }
  // No read scope -> no forwarded notifications either.
  for (const action of COMPANION_EVENT_ACTIONS) {
    assert.equal(decide(policy, { principal: p, action, resources: [session('s1')] }).kind, 'deny', action)
  }
})

test('unrelated scopes (approval:respond, files, settings) unlock no Host endpoint here', () => {
  for (const scope of ['approval:respond', 'files:read', 'files:write', 'settings:write']) {
    const { policy } = makePolicy({ devices: { 'dev-1': mobile([scope]) }, sessions: { 'dev-1': ['s1'] } })
    assert.deepEqual(policy.bindings(principalOf()), [], scope)
  }
})

test('duplicate scopes in a stored record do not change the grant', () => {
  const { policy } = makePolicy({ devices: { 'dev-1': mobile(['sessions:read', 'sessions:read']) }, sessions: { 'dev-1': ['s1'] } })
  assert.equal(decide(policy, { principal: principalOf(), action: 'session/follow', resources: [session('s1')] }).kind, 'allow')
})

// ---------------------------------------------------------------------------
// Session id handling
// ---------------------------------------------------------------------------

test('no sessions visible: only the global calls remain, no session resource is bound', () => {
  for (const ids of [[], undefined, null]) {
    const { policy } = makePolicy({ devices: { 'dev-1': FULL }, sessions: { 'dev-1': ids } })
    const bindings = policy.bindings(principalOf())
    assert.equal(bindings.some((binding) => binding.resource.kind === SESSION_RESOURCE_KIND), false)
    assert.equal(decide(policy, { principal: principalOf(), action: 'session/list', resources: [GLOBAL] }).kind, 'allow')
    assert.equal(decide(policy, { principal: principalOf(), action: 'session/prompt', resources: [session('s1')] }).kind, 'deny')
    assert.equal(allows(policy, principalOf(), 'session/list', session('s1')), false)
  }
})

test('malformed session ids are dropped, duplicates collapse, iterables are accepted', () => {
  const { policy } = makePolicy({
    devices: { 'dev-1': FULL },
    sessions: { 'dev-1': new Set(['ok', '', 5, null, undefined, {}, ['x'], 'ok', 'two']) },
  })
  const ids = policy.bindings(principalOf())
    .filter((binding) => binding.resource.kind === SESSION_RESOURCE_KIND)
    .map((binding) => binding.resource.id)
  assert.deepEqual(ids, ['ok', 'two'])
})

test('a throwing fact propagates (DSH turns it into policy-failed, never a partial grant)', () => {
  const policy = createCompanionAccessPolicy({
    getDevice() { throw new Error('boom') },
    getSessionIds() { return ['s1'] },
  })
  assert.throws(() => policy.bindings(principalOf()), /boom/)
  assert.equal(decide(policy, { principal: principalOf(), action: 'session/list', resources: [GLOBAL] }).reason, 'policy-failed')
  const failingIds = createCompanionAccessPolicy({
    getDevice() { return FULL },
    getSessionIds() { throw new Error('ids') },
  })
  assert.throws(() => failingIds.bindings(principalOf()), /ids/)
})

test('bindings reads only the injected facts, once per call, with the principal device id', () => {
  const { policy, calls } = makePolicy({ devices: { 'dev-1': FULL }, sessions: { 'dev-1': ['s1'] } })
  policy.bindings(principalOf('dev-1'))
  assert.deepEqual(calls, { getDevice: 1, getSessionIds: 1 })
})

test('role actions are frozen and the bindings do not alias shared mutable state', () => {
  const { policy } = makePolicy({ devices: { 'dev-1': FULL }, sessions: { 'dev-1': ['s1'] } })
  const first = policy.bindings(principalOf())
  for (const binding of first) {
    assert.equal(Object.isFrozen(binding.role.actions), true)
    assert.throws(() => { binding.role.actions.push('session/create') }, TypeError)
  }
  const second = policy.bindings(principalOf())
  assert.notEqual(first, second)
  assert.deepEqual(first.map((b) => b.role.actions), second.map((b) => b.role.actions))
})

// ---------------------------------------------------------------------------
// explain()
// ---------------------------------------------------------------------------

test('explain names a specific refusal and never throws on hostile requests', () => {
  const { policy } = makePolicy({
    devices: { 'dev-1': mobile(['sessions:read']), gone: mobile([], { revokedAt: 1 }), odd: { kind: 'mobile', scopes: 'x' } },
    sessions: { 'dev-1': ['s1'] },
  })
  const explain = (request) => policy.explain(request)
  assert.equal(explain({ principal: principalOf(), action: 'session/create', resources: [GLOBAL] }), 'endpoint-not-allowed')
  assert.equal(explain({ principal: principalOf(), action: 'session/prompt', resources: [session('s1')] }), 'scope-not-granted')
  assert.equal(explain({ principal: principalOf(), action: 'session/follow', resources: [session('zzz')] }), 'resource-not-allowed')
  assert.equal(explain({ principal: principalOf('gone'), action: 'session/list', resources: [GLOBAL] }), 'device-revoked')
  assert.equal(explain({ principal: principalOf('missing'), action: 'session/list', resources: [GLOBAL] }), 'device-unknown')
  assert.equal(explain({ principal: principalOf('odd'), action: 'session/list', resources: [GLOBAL] }), 'scopes-invalid')
  assert.equal(explain({ principal: { kind: 'owner' }, action: 'session/list', resources: [GLOBAL] }), 'wrong-principal')
  for (const hostile of [undefined, null, {}, { principal: null }, { principal: principalOf(), action: '__proto__' }]) {
    assert.equal(typeof explain(hostile), 'string')
  }
})

test('contract: policy kind constants are stable', () => {
  assert.equal(COMPANION_PRINCIPAL_KIND, 'dsh-ext-mobile-device')
  assert.equal(COMPANION_DEVICE_KIND, 'mobile')
  assert.deepEqual([...COMPANION_DEVICE_KINDS], ['mobile', 'desktop'])
  assert.equal(SESSION_RESOURCE_KIND, 'session')
})
