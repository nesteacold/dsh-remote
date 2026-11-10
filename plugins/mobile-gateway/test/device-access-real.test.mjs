// T022a — the Host-side wall, proven against the REAL DSH services.
//
// Loads the actual `RemoteAccessService`, `TypertGatewayService`,
// `TypertRegistry` and `HostConnectionService.createPeer` from an installed DSH
// 0.2.2-rc.1 and the REAL generated session descriptors, and drives them with the
// plugin's own policy (companion-access.mjs), principal (device-peers.mjs) and
// positive adapter guard. Only the business services are fixtures (a session
// controller double that filters its list through the real `allows()`), so no
// Host, session store or user data is touched.
//
//   DSH_INSTALL_ROOT=/path/to/@deepseek-ai/dsh node test/device-access-real.test.mjs
//
// Without DSH_INSTALL_ROOT this file prints UNVERIFIED and exits 0: it must NOT
// be read as a pass. `npm test` therefore also runs the fake-harness suite
// (device-access-policy.test.mjs) that never claims Host enforcement.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

if (!process.env.DSH_INSTALL_ROOT) {
  // `npm run test:security-real` sets DSH_REAL_REQUIRED=1: the required proof must
  // FAIL (exit 1) when it cannot run, never skip. The default `npm test` keeps the
  // explicit UNVERIFIED skip, which is not a pass.
  if (process.env.DSH_REAL_REQUIRED === '1') {
    console.error('DEVICE ACCESS REAL-SERVICE TEST: FAILED (DSH_REAL_REQUIRED=1 but DSH_INSTALL_ROOT is not set; the real-policy proof did not run)')
    process.exit(1)
  }
  console.log('DEVICE ACCESS REAL-SERVICE TEST: UNVERIFIED (set DSH_INSTALL_ROOT to an installed DSH 0.2.2-rc.1; nothing was exercised)')
  process.exit(0)
}

const require = createRequire(path.join(process.env.DSH_INSTALL_ROOT, 'package.json'))
const load = (spec) => import(pathToFileURL(require.resolve(spec)).href)
const { Context, Service } = await load('@deepseek-ai/cordis')
const { HostConnectionService } = await load('@deepseek-ai/dsh-client-connection')
const { TypertGatewayService } = await load('@deepseek-ai/dsh-api-gateway')
const { RemoteAccessService } = await load('@deepseek-ai/dsh-api-remote-access')
const { TypertRegistry } = await load('@deepseek-ai/dsh-typert-registry')
const { TYPERT } = await load('@deepseek-ai/dsh-api-session-controller/typert')
assert.equal(require('@deepseek-ai/dsh-api-gateway/package.json').version, '0.2.2-rc.1')

const { createDeviceAccess, devicePrincipal } = await import('../lib/device-peers.mjs')
const { createDshHostAdapter } = await import('../lib/dsh-host-adapter.mjs')
const { COMPANION_PRINCIPAL_KIND } = await import('../lib/companion-access.mjs')

const ctx = new Context()
new TypertRegistry(ctx)
new RemoteAccessService(ctx)
// The real session resource resolver, copied from the installed controller
// (`resolveSessionResource`), so per-session bindings resolve exactly as in the Host.
ctx.typert.resources.register('session', {
  resolve: ({ args, parameters }) => {
    const sessionParameter = parameters.find((parameter) => parameter.name === 'sessionId' || parameter.wire === 'sessionId')
    if (sessionParameter !== undefined) return args[sessionParameter.wire]
    for (const parameter of parameters) {
      const value = args[parameter.wire]
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const address = value.address
      return value.sessionId ?? (address === undefined ? undefined : address.kind === 'session' ? address.sessionId : address.childSessionId)
    }
  },
})
ctx.typert.register({ ...TYPERT })

const hostCalls = []
const sessions = new Map([['s1', {}], ['s2', {}]])
class SessionFixture extends Service {
  constructor(parent) {
    super(parent, 'sessionController')
    this.typertRemote = { service: this, serviceKey: 'sessionController', namespace: 'session' }
  }
  list() {
    hostCalls.push('session/list')
    return { items: [...sessions.keys()].map((sessionId) => ({ sessionId })).filter((item) => this.ctx.remoteAccess.allows({ kind: 'session', id: item.sessionId })) }
  }
  search() { hostCalls.push('session/search'); return { items: [], hasMore: false } }
  prompt(request) { hostCalls.push(`session/prompt:${request.sessionId}`); return { accepted: true } }
  cancel(request) { hostCalls.push(`session/cancel:${request.sessionId}`); return { accepted: true } }
  create() { hostCalls.push('session/create'); return { sessionId: 'new' } }
  rename() { hostCalls.push('session/rename'); return {} }
  async *control() { hostCalls.push('session/control'); yield { type: 'baseline', value: { projections: { s1: {}, s2: {} } } } }
  async *follow(request, signal) {
    hostCalls.push(`session/follow:${request.address.sessionId}`)
    yield { type: 'snapshot', header: { id: request.address.sessionId, version: 4 }, cursor: 0, records: [], hasMore: false,
      projections: { asOfSeq: 0, values: {} } }
    await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); if (signal.aborted) resolve() })
  }
}
new SessionFixture(ctx)
const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}))

// The plugin's `ctx.connection.createPeer` is the REAL HostConnectionService
// method bound to this Context (as the official tests do), not a fake.
const connection = { createPeer: (options) => HostConnectionService.prototype.createPeer.call({ ctx }, options) }
const pluginCtx = { connection, remoteAccess: ctx.remoteAccess }

const devices = new Map()
const addDevice = (id, over = {}) => devices.set(id, { id, kind: 'mobile', scopes: ['sessions:read', 'prompt:send'], revokedAt: null, ...over })
let visible = ['s1']
const logs = []
const access = createDeviceAccess({
  ctx: pluginCtx,
  getDevice: (id) => { const d = devices.get(id); return d && !d.revokedAt ? d : undefined },
  getVisibleSessionIds: () => visible,
  log: (line) => logs.push(line),
})

// The adapter guard throws synchronously, DSH rejects asynchronously: accept either.
const codeOf = async (promise) => { try { await (typeof promise === 'function' ? promise() : promise); return 'ok' } catch (error) { return `${error.code}${error.details?.reason ? `:${error.details.reason}` : ''}` } }
const promptArgs = (sessionId) => ({ requestId: 'r', sessionId, mode: 'queue', content: [{ type: 'text', text: 'hi' }] })
const results = []
const check = async (name, fn) => { results.push(name); try { return await fn() } catch (e) { console.error('FAILED CHECK:', name); throw e } }

try {
  addDevice('d1')
  addDevice('dDesktop', { kind: 'desktop', scopes: ['sessions:read', 'harness:remote'] })
  addDevice('dReadOnly', { scopes: ['sessions:read'] })

  // 1. The policy registers once, through the real ctx.remoteAccess API.
  await check('policy registered once on the real RemoteAccessService; a second registration throws', () => {
    assert.ok(ctx.remoteAccess.policies.has(COMPANION_PRINCIPAL_KIND))
    assert.throws(() => ctx.remoteAccess.registerPolicy(COMPANION_PRINCIPAL_KIND, { bindings: () => [] }), /already has a policy/)
  })

  const lease = access.open('d1')
  assert.ok(lease, 'a live device gets a Peer')
  assert.deepEqual(lease.peer.principal, devicePrincipal('d1'))
  assert.equal(lease.peer.principal.kind, COMPANION_PRINCIPAL_KIND)
  const api = createDshHostAdapter(gateway, lease.peer, { createSharedFetchHandler: () => null }, { guard: access.guard })
  // The same adapter WITHOUT the plugin guard: the bypass case. Only DSH can stop it.
  const bypass = createDshHostAdapter(gateway, lease.peer, { createSharedFetchHandler: () => null })

  await check('positive: a visible session reads, prompts and cancels through the real Gateway', async () => {
    assert.deepEqual((await api.sessions.list({})).items, [{ sessionId: 's1' }], 'list is filtered by the real allows()')
    assert.equal((await api.sessions.prompt({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] })).accepted, true)
    assert.equal((await api.sessions.cancel({ sessionId: 's1' })).accepted, true)
    const snapshot = await api.sessions.history({ sessionId: 's1' })
    assert.equal(snapshot.cursor, 0, 'session/follow for a granted session opens through the device Peer')
  })

  await check('DSH denies a session the device cannot see (resource-not-allowed), even through an unguarded adapter', async () => {
    hostCalls.length = 0
    assert.equal(await codeOf(bypass.sessions.prompt({ sessionId: 's2', mode: 'queue', content: [{ type: 'text', text: 'x' }] })),
      'remote-access/denied:resource-not-allowed')
    assert.equal(await codeOf(bypass.sessions.history({ sessionId: 's2' })), 'remote-access/denied:resource-not-allowed')
    assert.deepEqual(hostCalls, [], 'the Host service was never reached')
  })

  await check('adapter bypass: an unknown/unlisted Host endpoint is denied by DSH itself (endpoint-not-allowed)', async () => {
    hostCalls.length = 0
    // session/create, rename and control are NOT in the positive table. The
    // unguarded adapter reaches DSH; DSH refuses with the policy's explain().
    assert.equal(await codeOf(bypass.sessions.create({})), 'remote-access/denied:endpoint-not-allowed')
    assert.equal(await codeOf(bypass.sessions.rename({ sessionId: 's1', title: 'x' })), 'remote-access/denied:endpoint-not-allowed')
    assert.equal(await codeOf((async () => { for await (const frame of await bypass.openControlStream()) return frame })()),
      'remote-access/denied:endpoint-not-allowed', 'session/control (owner-internal global stream) is never granted to a device')
    assert.deepEqual(hostCalls, [])
  })

  await check('adapter guard (layer 2): the same endpoints are refused BEFORE any Gateway call', async () => {
    hostCalls.length = 0
    const denied = []
    const guarded = createDshHostAdapter(gateway, lease.peer, { createSharedFetchHandler: () => null }, {
      guard: access.guard, onDenied: (endpoint) => denied.push(endpoint),
    })
    for (const call of [() => guarded.sessions.create({}), () => guarded.sessions.rename({ sessionId: 's1', title: 'x' }),
      () => guarded.settings.describe(), () => guarded.plugins.listPlugins(), () => guarded.workspace.create({ path: '/x' }),
      () => guarded.commands.execute('s1', '/x', []), () => guarded.schedule.create({}), () => guarded.speech.catalog(),
      () => guarded.llm.models(), () => guarded.workspace.list(), () => guarded.openWorkspaceStream()]) {
      assert.equal(await codeOf(call), 'op/forbidden')
    }
    await assert.rejects(async () => { for await (const frame of guarded.openControlStream()) return frame }, { code: 'op/forbidden' })
    // `llm.models()` went through `session/modelCatalog` (unmapped): refused too.
    assert.deepEqual([...hostCalls], [], 'no endpoint call reached the Host')
    assert.ok(denied.includes('session/modelCatalog'), denied.join(','))
    assert.ok(denied.includes('session/create') && denied.includes('session/control') && denied.includes('workspace/follow'), denied.join(','))
    assert.equal(guarded.files.available(), false)
    await assert.rejects(guarded.files.upload({ sessionId: 's1', name: 'x', data: Buffer.alloc(1) }), { code: 'op/forbidden' })
  })

  await check('scopes: sessions:read without prompt:send cannot prompt/cancel (scope-not-granted)', async () => {
    const ro = access.open('dReadOnly')
    const roBypass = createDshHostAdapter(gateway, ro.peer, { createSharedFetchHandler: () => null })
    visible = ['s1']; access.invalidate('dReadOnly')
    assert.deepEqual((await roBypass.sessions.list({})).items, [{ sessionId: 's1' }])
    assert.equal(await codeOf(roBypass.sessions.prompt({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'x' }] })),
      'remote-access/denied:scope-not-granted')
    assert.equal(await codeOf(roBypass.sessions.cancel({ sessionId: 's1' })), 'remote-access/denied:scope-not-granted')
    await ro.release()
  })

  await check('desktop device: identical narrow policy; harness:remote grants nothing here (008 bridge is separate)', async () => {
    const lease2 = access.open('dDesktop')
    const desktop = createDshHostAdapter(gateway, lease2.peer, { createSharedFetchHandler: () => null })
    assert.deepEqual((await desktop.sessions.list({})).items, [{ sessionId: 's1' }])
    assert.equal(await codeOf(desktop.sessions.prompt({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'x' }] })),
      'remote-access/denied:scope-not-granted', 'a desktop without prompt:send cannot prompt')
    assert.equal(await codeOf(desktop.sessions.create({})), 'remote-access/denied:endpoint-not-allowed')
    await lease2.release()
  })

  await check('visible snapshot refreshed: a session added becomes grantable after invalidate; removal revokes at once', async () => {
    visible = ['s1', 's2']; access.invalidate('d1')
    assert.equal(await codeOf(bypass.sessions.prompt(promptWith('s2'))), 'ok')
    visible = ['s1']; access.invalidate('d1')
    assert.equal(await codeOf(bypass.sessions.prompt(promptWith('s2'))), 'remote-access/denied:resource-not-allowed')
  })

  await check('an unknown principal kind and the owner-less Peer are denied (no policy)', async () => {
    const stranger = HostConnectionService.prototype.createPeer.call({ ctx }, { principal: { kind: 'someone-else', deviceId: 'd1' }, interactions: 'none' })
    const strangerApi = createDshHostAdapter(gateway, stranger, { createSharedFetchHandler: () => null })
    assert.equal(await codeOf(strangerApi.sessions.list({})), 'remote-access/denied:no-allow')
    await stranger.dispose()
  })

  await check('revoke: the device record is gone => denied at once; revoke() disposes its Peers; calls then fail peer-disposed', async () => {
    const another = access.open('d1')
    assert.equal(access.openPeerCount(), 2)
    devices.get('d1').revokedAt = Date.now()
    // The real registry's `get()` returns undefined for a revoked device, hence
    // `device-unknown` (a revoked record that still resolved would say `device-revoked`).
    assert.equal(await codeOf(bypass.sessions.cancel({ sessionId: 's1' })), 'remote-access/denied:device-unknown')
    assert.equal(access.open('d1'), undefined, 'no Peer is created for a revoked device')
    await access.revoke('d1')
    assert.equal(access.openPeerCount(), 0)
    assert.equal(lease.peer.signal.aborted, true)
    assert.equal(another.peer.signal.aborted, true)
    assert.equal(await codeOf(bypass.sessions.cancel({ sessionId: 's1' })), 'gateway/peer-disposed')
    await lease.release()
    await another.release()
  })

  await check('disconnect: release() disposes the Peer, cancels its open follow stream, other devices are untouched', async () => {
    addDevice('d3'); addDevice('d4'); visible = ['s1']
    const a = access.open('d3'); const b = access.open('d4')
    const aApi = createDshHostAdapter(gateway, a.peer, { createSharedFetchHandler: () => null }, { guard: access.guard })
    const bApi = createDshHostAdapter(gateway, b.peer, { createSharedFetchHandler: () => null }, { guard: access.guard })
    const stream = await aApi.openSessionStream('s1', new AbortController().signal)
    const iterator = stream[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.type, 'snapshot')
    const pending = iterator.next()
    const ended = assert.rejects(pending, { code: 'gateway/cancelled' })
    await a.release()
    await ended
    assert.equal(a.peer.signal.aborted, true)
    assert.equal(b.peer.signal.aborted, false)
    assert.equal((await bApi.sessions.list({})).items.length, 1, 'the other device keeps working')
    await b.release()
  })

  await check('teardown: close() disposes every open Peer, removes the policy and refuses new Peers', async () => {
    addDevice('d5')
    const c = access.open('d5')
    await access.close()
    assert.equal(c.peer.signal.aborted, true)
    assert.equal(access.open('d5'), undefined)
    assert.equal(ctx.remoteAccess.policies.has(COMPANION_PRINCIPAL_KIND), false)
  })

  console.log(`DEVICE ACCESS REAL-SERVICE TESTS PASSED (${results.length} checks, DSH 0.2.2-rc.1: real RemoteAccessService + TypertGatewayService + generated session descriptors; business services are fixtures)`)
} finally {
  await ctx.fiber.dispose()
}

function promptWith(sessionId) { return { sessionId, mode: 'queue', content: [{ type: 'text', text: 'hi' }] } }
