// Spec 008 P2b (client): the native remote-session surfaces.
//  - the grouped sidebar replaces `sidebar.workspaces` ONLY while multi-host
//    routing is live and a host is connected, otherwise the stock browser stays;
//  - the composer chip exists only for a tagged session and its popover drives
//    Reconnect / Forget host (no Settings navigation exists on rc.1);
//  - the offline and model-status banners;
//  - the remote terminal entry, hidden without the `terminal` grant.
// Loads lib/client.js in a vm with a fake __ModuleLoader__ + a fake slot host, the
// way test/client.test.mjs does. Run with `node --test --test-isolation=none` or
// as a plain script.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const React = require('../../mobile-gateway/node_modules/react')
const { create, act } = require('../../mobile-gateway/node_modules/react-test-renderer')
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const source = fs.readFileSync(path.join(here, '../lib/client.js'), 'utf8')

console.log('client-p2b')

const REMOTE = { id: 'r1', name: 'Qoder-Sigma', address: '192.168.1.40:3081', status: 'online', createdAt: Date.parse('2026-11-01T08:30:00Z'),
  device: { kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'harness:remote'] } }
const ROUTING = { remote: true, reason: null, hosts: [{ hostId: 'r1', hostName: 'Qoder-Sigma', online: true }], merged: ['session/list', 'workspace/follow'] }

function load({ locale = 'en-US', routing = ROUTING, remotes = [REMOTE], cached = true, fail = {} } = {}) {
  let api
  const calls = []
  const state = { routing, remotes, cached }
  const fetch = async (url, options = {}) => {
    const target = new URL(url)
    const route = target.pathname + target.search
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ method: options.method ?? 'GET', route, body, origin: target.origin, credentials: options.credentials })
    const reply = (data, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => data })
    if (fail[route]) return reply({ message: fail[route] }, false)
    if (route === '/devices/remotes') return reply({ remotes: state.remotes, routing: state.routing })
    if (/^\/devices\/remotes\/[^/]+\/connect$/.test(route) && options.method === 'POST') {
      state.routing = { ...state.routing, hosts: [{ hostId: 'r1', hostName: 'Qoder-Sigma', online: true }] }
      return reply({ remote: state.remotes[0], state: 'online' })
    }
    if (/^\/devices\/remotes\/[^/]+\/sessions\/[^/]+$/.test(route) && options.method === 'DELETE') {
      const removed = state.cached
      state.cached = false
      return reply({ removed, sessionId: decodeURIComponent(route.split('/').at(-1)) })
    }
    if (/^\/devices\/remotes\/[^/]+$/.test(route) && options.method === 'DELETE') {
      state.remotes = []
      state.routing = { ...state.routing, hosts: [] }
      return reply({ removed: true })
    }
    return reply({ message: 'not found' }, false)
  }
  const entries = []
  // The shell's slot ledger, as rc.1's SlotCore.register implements it: a `single`
  // slot refuses a second registration at an already-taken priority and accepts a
  // lower one ("lowest renders"). `sidebar.workspaces` ships occupied by the stock
  // browser (`tk`) at priority 0 — the collision that made spec 008 never render on
  // a live Host while a permissive fake let it pass. Modelling the rule here is the
  // point: a same-priority replacement must fail the suite, not a user's session.
  const SLOT_KINDS = {
    'sidebar.workspaces': 'single',
    'settings.section': 'keyed',
    'settings.section.icon': 'keyed',
    'conversation.input.left': 'list',
    'conversation.input.dock': 'list',
    'conversation.input.right': 'list',
  }
  const occupants = new Map(Object.keys(SLOT_KINDS).map((slot) => [slot, []]))
  // The stock sidebar browser, registered by the shell itself before any plugin runs.
  occupants.get('sidebar.workspaces').push({ slot: 'sidebar.workspaces', meta: { name: 'sidebar.workspaces', priority: 0, registrant: 'tk' } })
  const disposers = []
  const intervals = new Map()
  let sequence = 0
  let confirmations = 0
  let answers = true
  const services = {
    uiWorkspace: {
      opened: [], started: [], pinned: [], unpinned: [],
      openSession(id) { this.opened.push(id) },
      startSession(id) { this.started.push(id) },
      pinSession(id) { this.pinned.push(id) },
      unpinSession(id) { this.unpinned.push(id) },
    },
    workspaces: {
      archived: [], unarchived: [],
      archiveSession(id) { this.archived.push(id) },
      unarchiveSession(id) { this.unarchived.push(id) },
    },
  }
  let sidebarRight = { tabs: [] }
  services.sidebarRight = sidebarRight
  sidebarRight.openTab = (kind, options) => { sidebarRight.tabs.push([kind, options]) }
  const window = {
    __ModuleLoader__: { load: ({ id, factory }) => { api = { id, ...factory((name) => { assert.equal(name, 'react'); return React }) } } },
    setInterval: (fn) => { intervals.set(++sequence, fn); return sequence },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { fn(); return 0 },
    confirm: () => { confirmations += 1; return answers },
  }
  const document = { baseURI: 'http://127.0.0.1:3080/', head: { appendChild() {} }, createElement: () => ({ remove() {} }) }
  vm.runInNewContext(source, { window, document, fetch, URL, console, setTimeout, clearTimeout, Date,
    navigator: { language: locale, clipboard: { writeText: async () => {} } } })
  // Fake host: the slot ledger (inject waits for a declaration, register returns a
  // disposer), the optional Cordis services P2b asks for, and the locale face.
  const localeListeners = new Set()
  let snapshot = { active: locale }
  const ctx = {
    locale: { getSnapshot: () => snapshot, subscribe: (listener) => { localeListeners.add(listener); return () => localeListeners.delete(listener) } },
    effect(fn) { disposers.push(fn()) },
    get(name) { return services[name] },
    inject(deps, fn) {
      const scope = {}
      for (const dep of deps) scope[dep] = services[dep]
      const out = fn(scope)
      return typeof out === 'function' ? out : () => {}
    },
    slots: {
      inject(slot, factory) {
        const registration = factory()
        const entry = { slot, meta: registration.meta, component: registration.component }
        entries.push(entry)
        return () => {
          const at = entries.indexOf(entry)
          if (at >= 0) entries.splice(at, 1)
          const held = occupants.get(slot) ?? []
          const seat = held.findIndex((occupant) => occupant.meta === entry.meta)
          if (seat >= 0) held.splice(seat, 1)
        }
      },
      register(meta, component) {
        const kind = SLOT_KINDS[meta.name]
        if (!kind) throw new Error(`slot "${meta.name}" is not declared (a parent entry's children table must declare it)`)
        const priority = meta.priority ?? 0
        const sameSeat = (occupant) => (occupant.meta.priority ?? 0) === priority
          && (kind === 'single' || occupant.meta.id === meta.id)
        const taken = occupants.get(meta.name).find(sameSeat)
        if (taken) {
          const by = taken.meta.registrant !== undefined ? ` (registered by ${taken.meta.registrant})` : ''
          const what = kind === 'single' ? 'a registration' : kind === 'keyed' ? `an entry for key "${meta.id}"` : `an entry with id "${meta.id}"`
          throw new Error(`${kind} slot "${meta.name}" already has ${what} at priority ${priority}${by} — register at a different priority to shadow it (lowest renders)`)
        }
        occupants.get(meta.name).push({ slot: meta.name, meta, component })
        return { meta, component }
      },
    },
  }
  api.apply(ctx)
  const entryOf = (slot) => entries.find((entry) => entry.slot === slot)
  // Which occupant actually renders: the lowest priority in the slot (the shell's
  // rule), so a test can prove the replacement wins over the shipped one.
  const winnerOf = (slot) => (occupants.get(slot) ?? []).reduce((best, occupant) =>
    !best || (occupant.meta.priority ?? 0) < (best.meta.priority ?? 0) ? occupant : best, undefined)
  return {
    api, calls, entries, entryOf, winnerOf, occupants, services, state, intervals, disposers,
    setLocale(active) { snapshot = { active }; for (const listener of localeListeners) listener() },
    setAnswer(value) { answers = value },
    confirmations: () => confirmations,
    dispose() { for (const dispose of disposers.splice(0)) dispose?.() },
  }
}

const text = (renderer) => JSON.stringify(renderer.toJSON())
async function mount(element) {
  let renderer
  await act(async () => { renderer = create(element) })
  return renderer
}
const flush = async () => { await act(async () => { await new Promise((resolve) => setImmediate(resolve)) }) }
const find = (node, predicate) => (node.root ?? node).findAll((child) => typeof child.type === 'string' && predicate(child))
const byTestId = (renderer, id) => find(renderer, (node) => node.props['data-testid'] === id)
const button = (renderer, label) => find(renderer, (node) => node.type === 'button' && node.children.join('') === label)[0]
const click = async (node) => { await act(async () => { await node.props.onClick({ preventDefault() {}, target: {} }) }) }
const tick = async (ui) => { for (const fn of [...ui.intervals.values()]) await act(async () => { await fn() }); await flush() }

// The fake shell's standard hooks, as the root bindings hand them over.
const WORKSPACES = {
  items: [
    { workspaceId: 'w-local', title: 'Local project', path: '/tmp/local', sessionIds: ['s-local'] },
    { workspaceId: 'h:r1:w-remote', title: 'AutoAoW', path: '/home/x/AutoAoW', sessionIds: ['h:r1:s-remote'] },
  ],
  pinnedSessionIds: ['h:r1:s-remote'],
  archivedSessionIds: [],
  phase: 'ready',
  state: 'live',
}
const SESSIONS = {
  ids: ['s-local', 'h:r1:s-remote'],
  byId: {
    's-local': { id: 's-local', displayTitle: 'Local work', updatedAt: Date.parse('2026-11-02T09:00:00Z') },
    'h:r1:s-remote': { id: 'h:r1:s-remote', displayTitle: 'Fix the build', updatedAt: Date.parse('2026-11-09T10:00:00Z') },
  },
  phase: 'ready',
}
const STATUSES = new Map([['h:r1:s-remote', { running: false, completionUnread: true }]])

function sidebarProps(overrides = {}) {
  const opened = []
  const started = []
  const props = {
    wide: true,
    useWorkspaces: (selector) => selector(WORKSPACES),
    useSessions: (selector) => selector(SESSIONS),
    useSessionStatus: (selector) => selector(STATUSES),
    openSession: (id) => opened.push(id),
    startSession: (id) => started.push(id),
    pinSession: () => {}, unpinSession: () => {}, archiveSession: () => {}, unarchiveSession: () => {},
    opened, started,
    ...overrides,
  }
  return props
}

test('stock sidebar untouched without a remote: no replacement while routing is off or nothing is connected', async () => {
  const off = load({ routing: { remote: false, reason: 'disabled', hosts: [] } })
  await flush()
  assert.equal(off.entryOf('sidebar.workspaces'), undefined, 'config off → the stock browser keeps the slot')
  const noHost = load({ routing: { ...ROUTING, hosts: [] }, remotes: [] })
  await flush()
  assert.equal(noHost.entryOf('sidebar.workspaces'), undefined)
  assert.match(noHost.api.testing.remoteUI.getSnapshot().reason, /no remote host is connected/)
  // The additive surfaces are installed regardless: they render nothing for a
  // local session, so they cannot shadow anything.
  for (const slot of ['conversation.input.left', 'conversation.input.dock', 'conversation.input.right']) {
    assert.ok(noHost.entryOf(slot), `${slot} is registered`)
  }
})

test('with a connected host the grouped browser shadows sidebar.workspaces at a lower priority than the shipped 0, and leaves again when the host drops', async () => {
  const ui = load()
  await flush()
  const entry = ui.entryOf('sidebar.workspaces')
  assert.ok(entry, 'the replacement took the slot')
  assert.equal(entry.meta.name, 'sidebar.workspaces')
  // Measured on a live Host: the shipped browser `tk` holds this single slot at
  // priority 0, and a second registration at 0 is refused — so the replacement must
  // sit strictly below it, or the stock sidebar stays and the feature never renders.
  const shippedSeat = ui.occupants.get('sidebar.workspaces').find((seat) => seat.meta.registrant === 'tk')
  assert.equal(shippedSeat.meta.priority, 0, 'the stock browser still holds its seat')
  assert.ok(entry.meta.priority < shippedSeat.meta.priority, `replacement priority ${entry.meta.priority} must be below the shipped 0`)
  assert.equal(ui.winnerOf('sidebar.workspaces').meta, entry.meta, 'lowest priority renders: the replacement won the slot')
  assert.equal(ui.api.testing.remoteUI.getSnapshot().grouped, true)
  assert.equal(ui.api.testing.remoteUI.getSnapshot().hosts, 1)
  // The host drops: unregister, so the shipped browser renders again.
  ui.state.routing = { ...ROUTING, hosts: [] }
  await tick(ui)
  assert.equal(ui.entryOf('sidebar.workspaces'), undefined, 'no connected host → stock sidebar')
  assert.equal(ui.winnerOf('sidebar.workspaces').meta.registrant, 'tk', 'the shipped browser is the only occupant again')
  assert.equal(ui.api.testing.remoteUI.getSnapshot().grouped, false)
})

test('grouped rendering: "Local workspaces" first, then one group per host with its workspaces and nested sessions', async () => {
  const ui = load()
  await flush()
  const props = sidebarProps()
  // Render the occupant that actually wins the slot, not merely our registration:
  // the priority check above is what makes that the grouped browser.
  const page = await mount(React.createElement(ui.winnerOf('sidebar.workspaces').component, props))
  assert.ok(byTestId(page, 'grouped-sidebar').length, 'the grouped browser rendered')
  const groups = byTestId(page, 'host-group')
  assert.deepEqual(groups.map((node) => node.props['data-host']), ['local', 'r1'], 'local group first, then the host')
  const rendered = text(page)
  assert.match(rendered, /Local workspaces/)
  assert.match(rendered, /Qoder-Sigma/)
  assert.match(rendered, /Local project/)
  assert.match(rendered, /AutoAoW/, 'a remote workspace is nested under its host group')
  // Nested session rows: unread dot, last-activity stamp, pin + archive affordances.
  const rows = byTestId(page, 'session-row')
  assert.equal(rows.length, 2)
  const remoteRow = rows[1]
  assert.equal(byTestId(remoteRow, 'session-open')[0].children.join(''), 'Fix the build')
  assert.equal(byTestId(remoteRow, 'unread-dot').length, 1, 'completionUnread shows the dot')
  assert.equal(byTestId(remoteRow, 'pinned-mark').length, 1, 'a pinned session shows its mark')
  assert.equal(byTestId(remoteRow, 'pin-toggle').length, 1)
  assert.equal(byTestId(remoteRow, 'archive-toggle').length, 1)
  assert.equal(byTestId(remoteRow, 'last-activity')[0].children.join(''), '2026-11-09 10:00')
  // The online dot belongs to the host header, not the local group.
  assert.equal(byTestId(groups[0], 'host-dot').length, 0)
  assert.equal(byTestId(groups[1], 'host-dot').length, 1)
  // Clicking a session opens it by its TAGGED id, so the call routes to that host.
  await click(byTestId(remoteRow, 'session-open')[0])
  assert.deepEqual(props.opened, ['h:r1:s-remote'])
  // A session is created in the workspace it belongs to; for a remote group that
  // is the tagged workspaceId, which the router turns into session/create there.
  await click(byTestId(page, 'workspace-new-session')[1])
  assert.deepEqual(props.started, ['h:r1:w-remote'])
  // The group's "+" falls back to the group's first workspace.
  await click(byTestId(page, 'group-new-session')[1])
  assert.deepEqual(props.started, ['h:r1:w-remote', 'h:r1:w-remote'])
  // The archive affordance joins the workspace service (documented API).
  await click(byTestId(remoteRow, 'archive-toggle')[0])
  page.unmount()
})

test('one search box filters across every group; a group with no match disappears', async () => {
  const ui = load()
  await flush()
  const page = await mount(React.createElement(ui.entryOf('sidebar.workspaces').component, sidebarProps()))
  const search = byTestId(page, 'group-search')[0]
  assert.equal(search.props.placeholder, 'Search workspaces and sessions')
  await act(async () => { search.props.onChange({ target: { value: 'Fix' } }) })
  assert.deepEqual(byTestId(page, 'host-group').map((node) => node.props['data-host']), ['r1'], 'only the matching host group')
  assert.equal(byTestId(page, 'session-row').length, 1)
  assert.doesNotMatch(text(page), /Local project/)
  await act(async () => { search.props.onChange({ target: { value: 'local' } }) })
  assert.deepEqual(byTestId(page, 'host-group').map((node) => node.props['data-host']), ['local'], 'a local title matches too')
  await act(async () => { search.props.onChange({ target: { value: 'Qoder' } }) })
  assert.deepEqual(byTestId(page, 'host-group').map((node) => node.props['data-host']), ['r1'], 'a host name match keeps the whole group')
  await act(async () => { search.props.onChange({ target: { value: 'nothing-here' } }) })
  assert.equal(byTestId(page, 'host-group').length, 0)
  assert.ok(byTestId(page, 'group-no-matches').length)
  page.unmount()
})

test('subagent rows nest under their parent inside the host group, an orphan stays a root row, and search still finds a nested one', async () => {
  const ui = load()
  await flush()
  // A remote workspace whose list holds the parent, two subagent children and one
  // orphan child (its parent is not in the list). DSH's own sidebar nests by
  // `origin`+`parentSessionId` (flattenLineage) and never drops the orphan; a remote
  // parent arrives TAGGED by the router (`h:<hostId>:<id>`), so nesting must work on
  // tagged ids too.
  const workspaces = {
    items: [{ workspaceId: 'h:r1:w-remote', title: 'AutoAoW', path: '/home/x/AutoAoW',
      sessionIds: ['h:r1:p1', 'h:r1:c1', 'h:r1:c2', 'h:r1:orphan'] }],
    pinnedSessionIds: [], archivedSessionIds: [], phase: 'ready', state: 'live',
  }
  const sessions = {
    ids: ['h:r1:p1', 'h:r1:c1', 'h:r1:c2', 'h:r1:orphan'],
    byId: {
      'h:r1:p1': { id: 'h:r1:p1', displayTitle: 'Parent task', updatedAt: Date.parse('2026-11-09T10:00:00Z') },
      'h:r1:c1': { id: 'h:r1:c1', displayTitle: 'Child one', origin: 'subagent', parentSessionId: 'h:r1:p1', updatedAt: Date.parse('2026-11-09T10:05:00Z') },
      'h:r1:c2': { id: 'h:r1:c2', displayTitle: 'Child two', origin: 'subagent', parentSessionId: 'h:r1:p1', updatedAt: Date.parse('2026-11-09T10:06:00Z') },
      'h:r1:orphan': { id: 'h:r1:orphan', displayTitle: 'Orphan child', origin: 'subagent', parentSessionId: 'h:r1:absent', updatedAt: Date.parse('2026-11-09T10:07:00Z') },
    },
    phase: 'ready',
  }
  const props = sidebarProps({
    useWorkspaces: (selector) => selector(workspaces),
    useSessions: (selector) => selector(sessions),
  })
  const page = await mount(React.createElement(ui.entryOf('sidebar.workspaces').component, props))
  const titles = (rows) => rows.map((row) => byTestId(row, 'session-open')[0].children.join(''))
  const rows = byTestId(page, 'session-row')
  assert.deepEqual(titles(rows), ['Parent task', 'Child one', 'Child two', 'Orphan child'])
  assert.deepEqual(rows.map((row) => row.props['data-depth']), [0, 1, 1, 0],
    'both children sit one level under their parent; the orphan keeps depth 0')
  // A nested row is still a real row: its own affordances, and its TAGGED id on click.
  assert.equal(byTestId(rows[1], 'last-activity').length, 1)
  await click(byTestId(rows[1], 'session-open')[0])
  assert.deepEqual(props.opened, ['h:r1:c1'])
  // Search still reaches a nested row (and, with its parent filtered out, it renders
  // as a root rather than vanishing).
  const search = byTestId(page, 'group-search')[0]
  await act(async () => { search.props.onChange({ target: { value: 'Child two' } }) })
  assert.deepEqual(byTestId(page, 'host-group').map((node) => node.props['data-host']), ['r1'])
  assert.deepEqual(titles(byTestId(page, 'session-row')), ['Child two'])
  await act(async () => { search.props.onChange({ target: { value: 'nothing-here' } }) })
  assert.equal(byTestId(page, 'host-group').length, 0, 'a group with no match still disappears')
  page.unmount()
})

test('composer chip: only a tagged session shows it; host name + online dot; click toggles the popover', async () => {
  const local = load()
  await flush()
  const localPage = await mount(React.createElement(local.entryOf('conversation.input.left').component, { sessionId: 's-local' }))
  assert.equal(localPage.toJSON(), null, 'a local session has no host chip')
  localPage.unmount()
  const ui = load()
  await flush()
  const page = await mount(React.createElement(ui.entryOf('conversation.input.left').component, { sessionId: 'h:r1:s-remote' }))
  const chip = byTestId(page, 'host-chip')[0]
  assert.ok(chip, 'the chip is rendered')
  assert.match(text(page), /Qoder-Sigma/)
  assert.match(byTestId(page, 'host-chip-dot')[0].props.className, /ok/)
  assert.equal(chip.props['aria-expanded'], false)
  assert.equal(byTestId(page, 'host-popover').length, 0, 'closed until clicked')
  await click(chip)
  assert.equal(byTestId(page, 'host-popover').length, 1)
  assert.equal(byTestId(page, 'host-chip')[0].props['aria-expanded'], true)
  await click(byTestId(page, 'host-chip')[0])
  assert.equal(byTestId(page, 'host-popover').length, 0, 'clicking again closes it')
  page.unmount()
})

test('popover shows host facts and its actions hit the right routes (Reconnect, Forget host); no Settings navigation', async () => {
  const ui = load()
  await flush()
  const page = await mount(React.createElement(ui.entryOf('conversation.input.left').component, { sessionId: 'h:r1:s-remote' }))
  await click(byTestId(page, 'host-chip')[0])
  const rendered = text(page)
  assert.match(rendered, /Qoder-Sigma/)
  assert.match(rendered, /Online/)
  assert.match(rendered, /desktop/, 'kind summary')
  assert.match(rendered, /See sessions and history/, 'scopes summary uses the scope labels')
  assert.equal(byTestId(page, 'popover-paired')[0].children.join(''), '2026-11-01 08:30')
  assert.match(rendered, /Manage all devices in Settings → Devices/)
  assert.ok(byTestId(page, 'terminal-hint').length, 'no terminal grant → the hint is offered here')
  // Reconnect: POST /devices/remotes/:id/connect
  await click(byTestId(page, 'reconnect')[0])
  await flush()
  const connect = ui.calls.find((call) => call.route === '/devices/remotes/r1/connect')
  assert.ok(connect, 'reconnect posted')
  assert.equal(connect.method, 'POST')
  // Forget host: DELETE /devices/remotes/:id, behind the confirm.
  await click(byTestId(page, 'forget-host')[0])
  await flush()
  assert.equal(ui.confirmations(), 1, 'asked first')
  const forget = ui.calls.find((call) => call.method === 'DELETE' && call.route === '/devices/remotes/r1')
  assert.ok(forget, 'the host was deleted')
  // Nothing anywhere tries to navigate to a Settings page (rc.1 has no such API).
  assert.equal(ui.calls.some((call) => /settings|navigate|location/i.test(call.route)), false)
  page.unmount()
})

test('offline host: read-only banner naming the host; "Remove local copy" deletes our cached copy', async () => {
  const ui = load({ routing: { ...ROUTING, hosts: [] } })
  await flush()
  const page = await mount(React.createElement(ui.entryOf('conversation.input.dock').component, { sessionId: 'h:r1:s-remote' }))
  const banner = byTestId(page, 'offline-banner')[0]
  assert.ok(banner, 'the offline banner is shown')
  const rendered = text(page)
  assert.match(rendered, /This task is no longer available on Qoder-Sigma/)
  assert.match(rendered, /Read-only/)
  assert.match(rendered, /local copy/)
  await click(byTestId(page, 'remove-local-copy')[0])
  await flush()
  const removed = ui.calls.find((call) => call.method === 'DELETE' && call.route === '/devices/remotes/r1/sessions/s-remote')
  assert.ok(removed, 'the raw (untagged) session id is used on the wire')
  assert.match(text(page), /Local copy removed/)
  page.unmount()
  // Already gone: the same click reports it instead of failing.
  const second = load({ routing: { ...ROUTING, hosts: [] }, cached: false })
  await flush()
  const page2 = await mount(React.createElement(second.entryOf('conversation.input.dock').component, { sessionId: 'h:r1:s-remote' }))
  await click(byTestId(page2, 'remove-local-copy')[0])
  await flush()
  assert.match(text(page2), /There was no local copy to remove/)
  page2.unmount()
  // A local session has no remote banner at all.
  const local = load({ routing: { ...ROUTING, hosts: [] } })
  await flush()
  const page3 = await mount(React.createElement(local.entryOf('conversation.input.dock').component, { sessionId: 's-local' }))
  assert.equal(page3.toJSON(), null)
  page3.unmount()
})

test('model error from the host: "Model status" banner, no local fallback; nothing without an error', async () => {
  const ui = load()
  await flush()
  const withError = (state) => (selector) => selector(state)
  const page = await mount(React.createElement(ui.entryOf('conversation.input.dock').component, {
    sessionId: 'h:r1:s-remote',
    useSession: withError({ projections: { values: { model: { error: 'provider key rejected on the host' } } } }),
  }))
  const banner = byTestId(page, 'model-status-banner')[0]
  assert.ok(banner, 'the model-status banner is shown')
  const rendered = text(page)
  assert.match(rendered, /Model status/)
  assert.match(rendered, /provider key rejected on the host/, 'the host answer is quoted')
  assert.match(rendered, /no local model is used instead/)
  page.unmount()
  const clean = load()
  await flush()
  const page2 = await mount(React.createElement(clean.entryOf('conversation.input.dock').component, {
    sessionId: 'h:r1:s-remote',
    useSession: withError({ projections: { values: {} } }),
  }))
  assert.equal(byTestId(page2, 'model-status-banner').length, 0, 'a healthy session shows no notice')
  assert.equal(byTestId(page2, 'offline-banner').length, 0)
  page2.unmount()
})

test('remote terminal: hidden without the terminal grant, an entry with it, and it opens the host tab', async () => {
  const ui = load()
  await flush()
  const page = await mount(React.createElement(ui.entryOf('conversation.input.right').component, { sessionId: 'h:r1:s-remote' }))
  assert.equal(page.toJSON(), null, 'no terminal scope → no entry')
  page.unmount()
  // Grant it, then the entry appears and asks the right column to open the tab.
  const granted = load({ remotes: [{ ...REMOTE, device: { kind: 'desktop', scopes: [...REMOTE.device.scopes, 'terminal'] } }] })
  await flush()
  const entry = granted.entryOf('conversation.input.right')
  const page2 = await mount(React.createElement(entry.component, { sessionId: 'h:r1:s-remote', ...entry.meta.inject() }))
  const terminal = byTestId(page2, 'remote-terminal')[0]
  assert.ok(terminal, 'the terminal entry is rendered')
  assert.equal(terminal.props.disabled, false)
  await click(terminal)
  assert.deepEqual(JSON.parse(JSON.stringify(granted.services.sidebarRight.tabs)), [['terminal', { params: { sessionId: 'h:r1:s-remote' } }]])
  page2.unmount()
  // A local session never gets one.
  const localPage = await mount(React.createElement(entry.component, { sessionId: 's-local', ...entry.meta.inject() }))
  assert.equal(localPage.toJSON(), null)
  localPage.unmount()
})

test('an error in the replacement unregisters it (stock fallback) and the Devices page reports it', async () => {
  const ui = load()
  await flush()
  const entry = ui.entryOf('sidebar.workspaces')
  assert.ok(entry)
  entry.meta.inject().onError('grouped sidebar blew up')
  assert.equal(ui.entryOf('sidebar.workspaces'), undefined, 'the slot is released at once')
  assert.equal(ui.winnerOf('sidebar.workspaces').meta.registrant, 'tk', 'the shipped browser renders again')
  const status = ui.api.testing.remoteUI.getSnapshot()
  assert.equal(status.grouped, false)
  assert.equal(status.reason, 'grouped sidebar blew up')
  // The status line is part of the Devices page, so the reason is visible in the UI.
  const page = await mount(React.createElement(ui.api.testing.RemoteGroupingStatus))
  assert.match(text(page), /Sidebar grouping/)
  assert.match(text(page), /grouped sidebar blew up/)
  page.unmount()
})
