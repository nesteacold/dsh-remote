// Multi-host routing for the CONTROLLER machine (spec 008 P2a).
//
// One DSH Desktop UI owns exactly one `typertGateway` instance, and the official
// client attaches no session context to a call. Remote hosts therefore become
// addressable by tagging every routable id with its host: `h:<hostId>:<id>`.
// This module is the only place that knows the tag:
//
//  - a call whose payload carries a tagged id travels to that remote
//    (`remote-call` / `remote-stream-open` over the pinned WSS connection of
//    lib/remote-client.mjs) and its result comes back renamed;
//  - a call with no tagged id stays Local, unless the client passed the host hint
//    `__dshHost` (needed for global endpoints such as llm/*, which have no id);
//  - `session/list` and `workspace/follow` are merged: Local plus every connected
//    remote, so the native sidebar shows one list.
//
// The invariants are the interesting part, not the routing:
//  - a namespaced id never leaves this machine (`#assertNoNamespace`, asserted on
//    the transport stubs by the tests);
//  - a raw id from a remote never reaches the local UI (every field in ID_FIELDS
//    is rewritten on the way back, recursively, including `$events` payloads);
//  - an id that comes FROM a remote is opaque: it is wrapped in that host's
//    namespace unconditionally, and a payload whose id already carries a namespace
//    tag is refused with `remote/id-leak`. Without that, a compromised Host B could
//    send `h:A:<id>` and have its row or card land in host A's namespace, where
//    every later decision would route to the wrong Host. The tag is minted here and
//    nowhere else;
//  - a remote approval decision always carries the `argsHash` of the card the
//    Host issued, because the bridge refuses an unbound decision.
//
// Two slices ride on top of the routing (spec 008 P2c):
//  - interaction cards: the remote Host pushes its approval/question cards to a
//    connected device (they are the only frames that carry `rpcId`, `approvalId`
//    and `argsHash`). They are rebuilt as the native `$events` waterfall frames
//    the controller's own UI answers, with every id namespaced, so the native
//    approval/question card appears inside a remote conversation. The answer
//    travels back to the Host that issued the card with its original ids: an
//    approval through the bridge's hash-bound `$events/result`, a question through
//    the bridge's `userQuestions/answer` (the companion channel's `question-answer`
//    is ADMIN_ONLY and must never be used for a device).
//  - offline transcript cache: every frame of a remote `session/follow` is
//    appended to `deps.cache` (lib/session-cache.mjs) and replayed read-only
//    when that host is offline, so a conversation survives a dead Host.
//
// Adapted from liguobao/ds-harness-remote (MIT): packages/plugin/src/
// typert-gateway-switch.ts (install/restore, commands-free self-test, rc.1
// local-open arity probe) and owner-peer.ts (the local carrier needs the caller's
// Peer). See NOTICE-ds-harness-remote in this folder.

/** Prefix that marks an id as belonging to a remote host. */
export const HOST_PREFIX = 'h:'
/** Payload field the client uses to name a host for a call that carries no id. */
export const HOST_HINT = '__dshHost'

/**
 * The ONE rename table (spec 008 P2a). Keys are field names that occur in the
 * DSH wire payloads; the value says how to rewrite what sits under that key.
 *   `id`      a single id string
 *   `ids`     an array of id strings
 *   `items:id` an array of records whose own `id` field is a session id
 *   `id@<key>` a record whose own `id` field is a session id, but only when the
 *             record also carries `<key>` (used for the `session/follow` opening
 *             frame `{type:'snapshot', header:{version, id}}`, so a payload that
 *             merely happens to call something a `header` is left alone)
 * Anything not listed here is copied structurally and kept verbatim, so an
 * unknown payload field keeps its value (never invent a rename for a field that
 * might not be an id: `callId`, `attachmentId`, `provider` … are opaque).
 */
export const ID_FIELDS = Object.freeze({
  sessionId: 'id',
  workspaceId: 'id',
  agentId: 'id',
  parentSessionId: 'id',
  childSessionId: 'id',
  // Approval/question correlation ids: the card the local UI decides on carries
  // the same id, so tagging it is what lets `$events/result` route to the host
  // that issued it (and keeps two hosts' ids from colliding in one UI).
  rpcId: 'id',
  eventId: 'id',
  approvalId: 'id',
  sessionIds: 'ids',
  archivedSessionIds: 'ids',
  pinnedSessionIds: 'ids',
  workspaceIds: 'ids',
  // `projections.values.subagentCatalog` — one record per direct child session.
  subagentCatalog: 'items:id',
  // `session/follow` / `session/events` opening frame.
  header: 'id@version',
})

/** Endpoints the wrapper answers with a merged view instead of routing. */
export const MERGED_ENDPOINTS = Object.freeze(['session/list', 'workspace/follow'])

/** The endpoints whose cards carry an approval hash the bridge requires. */
const APPROVAL_RESULT_ENDPOINT = '$events/result'
const APPROVAL_HASH = /^[a-f0-9]{64}$/

/** The bridge call that answers a question card on rc.1 (`approval:respond`). */
const QUESTION_ANSWER_ENDPOINT = 'userQuestions/answer'

/** The pinned DSH release this wrapper was self-tested against (constitution A1.1). */
export const PINNED_DSH_VERSION = '0.2.2-rc.1'

/**
 * Marks one of our carrier wrappers with the function it replaced, so a router
 * installed later (a reload) finds the TRUE DSH original instead of wrapping a
 * wrapper. Without this, an `uninstall()` between the two left the inner
 * wrapper reading a nulled `#originals` and every call died with
 * "Cannot read properties of null (reading 'dispatchRpc')" (measured live).
 */
const ORIGINAL = Symbol.for('@dsh-ext/devices.carrierOriginal')

/** The DSH original underneath any number of our wrappers. */
function rootOriginal(fn) {
  let current = fn
  for (let depth = 0; depth < 8; depth += 1) {
    const next = current?.[ORIGINAL]
    if (typeof next !== 'function') return current
    current = next
  }
  return current
}

/** How deep an id-bearing payload may nest; anything deeper is refused. */
const MAX_ID_DEPTH = 32
/**
 * Keys a payload may never carry. `JSON.parse` turns them into own properties, and
 * one plain assignment of `__proto__` rebuilds the prototype of the renamed copy
 * instead of copying a field. No DSH wire payload has a field with these names.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** The forwarded-event stream the controller's own UI consumes (rc.1 `$events`). */
const EVENTS_ENDPOINT = '$events'
/** The per-session history stream: one opening snapshot, then increments. */
const SESSION_FOLLOW_ENDPOINT = 'session/follow'
/** The two waterfall events whose cards the native UI renders and answers. */
const APPROVAL_EVENT = 'approval/request'
const QUESTION_EVENT = 'user-questions/request'
/** How many remote cards one controller keeps addressable (bounded like the buffer). */
const MAX_TRACKED_CARDS = 128
/** How many per-host refusals the status keeps for the Devices page (bounded). */
const MAX_HOST_ERRORS = 32

/** A refusal this module produced; `code` rides the Gateway failure vocabulary. */
export class HostRouterError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'HostRouterError'
    this.code = code
    this.details = details
  }
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** `h:<hostId>:<rawId>` -> `<hostId>`, anything else -> null. */
export function hostIdOfId(value) {
  if (typeof value !== 'string' || !value.startsWith(HOST_PREFIX)) return null
  const rest = value.slice(HOST_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0) return null
  return rest.slice(0, separator)
}

/**
 * `<rawId>` -> `h:<hostId>:<rawId>`.
 *
 * An id that arrives from a remote Host is OPAQUE: it is always wrapped in the
 * authenticated source host's namespace, so a compromised Host cannot make its own
 * row or card look like another host's by sending an id that is already tagged. An
 * already-tagged id therefore never reaches this function; when one does (a second
 * pass, a replayed cache, a hostile frame) it is refused instead of trusted.
 */
export function namespaceId(hostId, value) {
  if (typeof value !== 'string' || value === '') return value
  if (value.startsWith(HOST_PREFIX)) {
    throw new HostRouterError('remote/id-leak',
      `refusing a pre-tagged id (${value.length} chars): only this controller may name a host namespace`,
      { hostId })
  }
  return `${HOST_PREFIX}${hostId}:${value}`
}

/**
 * Rewrite every id in the table, recursively, into a fresh value.
 *
 * Prototype-safe: an own `__proto__`/`constructor`/`prototype` key is dropped
 * instead of being assigned. Bounded: a payload nested deeper than MAX_ID_DEPTH is
 * refused — returning the original subtree would hand back an unrenamed id, i.e. a
 * raw remote id in the local UI.
 */
function rewriteIds(value, transform, seen = new Map(), depth = 0) {
  if (depth > MAX_ID_DEPTH) {
    throw new HostRouterError('remote/payload-too-deep',
      `refusing a payload nested deeper than ${MAX_ID_DEPTH} levels`, { depth: MAX_ID_DEPTH })
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value)
    const out = []
    seen.set(value, out)
    for (const item of value) out.push(rewriteIds(item, transform, seen, depth + 1))
    return out
  }
  // Buffers, typed arrays, dates … are values, not structures: never touch them
  // (a binary result must stay byte-exact).
  if (!isPlainObject(value)) return value
  if (seen.has(value)) return seen.get(value)
  const out = {}
  seen.set(value, out)
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) continue
    const rule = ID_FIELDS[key]
    if (rule === 'id') {
      out[key] = typeof item === 'string' ? transform(item) : item
    } else if (rule === 'ids') {
      out[key] = Array.isArray(item) ? item.map((entry) => (typeof entry === 'string' ? transform(entry) : entry)) : item
    } else if (rule === 'items:id') {
      out[key] = Array.isArray(item)
        ? item.map((entry) => (isPlainObject(entry) && typeof entry.id === 'string'
          ? { ...rewriteIds(entry, transform, seen, depth + 1), id: transform(entry.id) }
          : rewriteIds(entry, transform, seen, depth + 1)))
        : item
    } else if (typeof rule === 'string' && rule.startsWith('id@')) {
      const guard = rule.slice('id@'.length)
      out[key] = isPlainObject(item) && typeof item.id === 'string' && Object.hasOwn(item, guard)
        ? { ...rewriteIds(item, transform, seen, depth + 1), id: transform(item.id) }
        : rewriteIds(item, transform, seen, depth + 1)
    } else {
      out[key] = rewriteIds(item, transform, seen, depth + 1)
    }
  }
  return out
}

/** Local ids -> `h:<hostId>:<id>` (a remote result on its way to the local UI). */
export function namespaceIds(value, hostId) {
  if (typeof hostId !== 'string' || hostId === '') return value
  return rewriteIds(value, (id) => namespaceId(hostId, id))
}

/** `h:<hostId>:<id>` -> `<id>` (a local call on its way to that remote). */
export function stripHostIds(value, hostId) {
  if (typeof hostId !== 'string' || hostId === '') return value
  const prefix = `${HOST_PREFIX}${hostId}:`
  return rewriteIds(value, (id) => (id.startsWith(prefix) ? id.slice(prefix.length) : id))
}

/** Every id string the rename table covers, at any depth (bounded like the walker). */
function visitIds(value, visit, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object' || depth > MAX_ID_DEPTH || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) visitIds(item, visit, seen, depth + 1)
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, item] of Object.entries(value)) {
    const rule = ID_FIELDS[key]
    if (rule === 'id') {
      if (typeof item === 'string') visit(item)
    } else if (rule === 'ids') {
      if (Array.isArray(item)) for (const entry of item) if (typeof entry === 'string') visit(entry)
    } else if (rule === 'items:id') {
      if (Array.isArray(item)) {
        for (const entry of item) {
          if (isPlainObject(entry) && typeof entry.id === 'string') visit(entry.id)
          visitIds(entry, visit, seen, depth + 1)
        }
      }
    } else if (typeof rule === 'string' && rule.startsWith('id@')) {
      if (isPlainObject(item) && Object.hasOwn(item, rule.slice('id@'.length)) && typeof item.id === 'string') visit(item.id)
      visitIds(item, visit, seen, depth + 1)
    } else {
      visitIds(item, visit, seen, depth + 1)
    }
  }
}

/** Every host id named by a table field anywhere in `value`. */
export function hostIdsIn(value) {
  const out = new Set()
  visitIds(value, (id) => {
    const hostId = hostIdOfId(id)
    if (hostId) out.add(hostId)
  })
  return out
}

/**
 * Every id in `value` that already carries a namespace tag. A remote Host may not
 * send one (`#ingress` refuses the payload); this is the check that catches it.
 */
export function taggedIdsIn(value) {
  const out = new Set()
  visitIds(value, (id) => { if (id.startsWith(HOST_PREFIX)) out.add(id) })
  return out
}

/**
 * Refuse an interaction card whose ids are not opaque (spec 008 review fix).
 *
 * A card is remote data like every other frame, but it is the ONE payload this
 * module rebuilds field by field instead of renaming a copy, so the rename table
 * alone does not protect it: `rpcId`/`sessionId` were checked, `approvalId` and
 * `callId` were copied straight out of the frame. A compromised Host could send
 * `approvalId: 'h:<anotherHost>:<id>'`, have the value parked in the controller's
 * card table and approval buffer, and be handed it back on the decision. The WHOLE
 * card is therefore validated against the rename table (every id-bearing field,
 * nested ones included) before either buffer is touched.
 *
 * `callId` is opaque to the table (it is the Host's own tool-call id and is
 * forwarded unchanged), so the table walk cannot see it; it must still never
 * impersonate a tag this controller minted. The value itself is never logged.
 *
 * @param {string} hostId the host the card arrived from
 * @param {unknown} frame the card as the Host pushed it
 * @returns {unknown} the same frame, when every id on it is opaque
 */
export function assertCleanCard(hostId, frame) {
  const callId = isPlainObject(frame) ? frame.callId : undefined
  const pseudoTag = typeof callId === 'string' && callId.startsWith(HOST_PREFIX)
  if (taggedIdsIn(frame).size === 0 && !pseudoTag) return frame
  throw new HostRouterError('remote/id-leak',
    'an interaction card carried an id that already names a host namespace; the card was refused',
    { hostId })
}

/** The host hint a payload carries, at `args.__dshHost` or top level. */
export function hostHintOf(payload) {
  if (!isPlainObject(payload)) return null
  const sources = [isPlainObject(payload.args) ? payload.args : null, payload]
  for (const source of sources) {
    if (source && typeof source[HOST_HINT] === 'string' && source[HOST_HINT] !== '') return source[HOST_HINT]
  }
  return null
}

/** A payload's `args`, the only field the Gateway carrier forwards. */
const payloadArgs = (payload) => (isPlainObject(payload) && isPlainObject(payload.args) ? payload.args : {})

/** Drop the client-side hint before anything is sent to a remote. */
function withoutHint(args) {
  if (!isPlainObject(args) || !Object.hasOwn(args, HOST_HINT)) return args
  const { [HOST_HINT]: _hint, ...rest } = args
  return rest
}

/**
 * The single session a `session/follow` request is about (its `request.address`),
 * or null for anything else (a subagent address names two sessions, so it is not
 * cached: the cache is keyed by exactly one id).
 */
function followSessionId(args) {
  if (!isPlainObject(args)) return null
  const address = isPlainObject(args.request) ? args.request.address : undefined
  const id = isPlainObject(address) ? address.sessionId : args.sessionId
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * Can this Gateway object be wrapped at all? The switch patches the two private
 * carrier methods DSH calls with `this`; when a release renames or re-signs them,
 * remote mode must switch itself off instead of corrupting every call.
 *
 * Constitution A1.1: the wrap is allowed only while the self-test matches the
 * pinned `engines.dsh`. An unknown or different running version means no wrap at
 * all and a reason the Devices page shows — never a guess.
 *
 * Order matters: the gateway itself and its two carrier methods are checked
 * BEFORE the version, because that is the more fundamental failure. A Host that
 * composes no `typertGateway` reports `no-gateway` whatever version it runs, and
 * only a present carrier with both methods can report a version reason.
 * @param {object} gateway
 * @param {{dshVersion?: string}} [options] the running DSH version (detected by the plugin)
 * @returns {string|null} a short reason, or null when the carrier matches
 */
export function selfTest(gateway, { dshVersion } = {}) {
  if (!gateway || (typeof gateway !== 'object' && typeof gateway !== 'function')) return 'no-gateway'
  if (typeof gateway.dispatchRpc !== 'function') return 'dispatchRpc-missing'
  if (typeof gateway.openWireStream !== 'function') return 'openWireStream-missing'
  if (typeof dshVersion !== 'string' || dshVersion === '') return 'dsh-version-unknown'
  if (dshVersion !== PINNED_DSH_VERSION) return 'dsh-version-mismatch'
  // rc.1: (endpoint, payload, uplink, peer, signal, control, uplinkWindow).
  if (gateway.openWireStream.length < 5) return 'openWireStream-signature'
  return null
}

/** Gateway-call failure -> the `{code, message, details}` shape DSH consumes. */
function failureOf(error) {
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message, details: isPlainObject(error.details) ? error.details : {} }
  }
  return { code: 'internal', message: error instanceof Error ? error.message : 'the remote call failed', details: {} }
}

/** Bounded FIFO the merged streams deliver through. */
class ValueQueue {
  constructor(max = 4096) {
    this.max = max
    this.items = []
    this.waiters = []
    this.closed = false
    this.error = null
  }

  push(value) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) { waiter({ value, done: false }); return }
    if (this.items.length >= this.max) {
      this.fail(new Error('the merged workspace stream is not being read'))
      return
    }
    this.items.push(value)
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  fail(error) {
    if (this.closed) return
    this.error = error
    this.close()
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.items.length > 0) { yield this.items.shift(); continue }
      if (this.closed) { if (this.error) throw this.error; return }
      const next = await new Promise((resolve) => this.waiters.push(resolve))
      if (next.done) { if (this.error) throw this.error; return }
      yield next.value
    }
  }
}

/**
 * The merged workspace map. Local workspaces keep their ids; a remote workspace
 * is stored already renamed (`hostId` + `hostName` added) so the baseline, an
 * upsert and the sidebar group all agree on identity.
 */
class MergeState {
  constructor() {
    this.ready = false
    this.local = { items: new Map(), order: [], archived: [], pinned: [] }
    /** @type {Map<string, {hostId: string, hostName: string, items: Map<string, object>, order: string[], archived: string[], pinned: string[]}>} */
    this.hosts = new Map()
  }

  #emit(frames) {
    return this.ready ? frames : []
  }

  setLocal(value) {
    this.local = { items: new Map(), order: [], archived: [], pinned: [] }
    for (const item of Array.isArray(value?.items) ? value.items : []) {
      if (!isPlainObject(item) || typeof item.workspaceId !== 'string') continue
      this.local.items.set(item.workspaceId, item)
      this.local.order.push(item.workspaceId)
    }
    this.local.archived = Array.isArray(value?.archivedSessionIds) ? [...value.archivedSessionIds] : []
    this.local.pinned = Array.isArray(value?.pinnedSessionIds) ? [...value.pinnedSessionIds] : []
  }

  applyLocal(type, frame) {
    if (type === 'upsert' && isPlainObject(frame.workspace) && typeof frame.workspace.workspaceId === 'string') {
      this.local.items.set(frame.workspace.workspaceId, frame.workspace)
      if (!this.local.order.includes(frame.workspace.workspaceId)) this.local.order.push(frame.workspace.workspaceId)
      return this.#emit([frame])
    }
    if (type === 'remove' && typeof frame.workspaceId === 'string') {
      this.local.items.delete(frame.workspaceId)
      this.local.order = this.local.order.filter((id) => id !== frame.workspaceId)
      return this.#emit([frame])
    }
    if (type === 'order' && Array.isArray(frame.workspaceIds)) {
      this.local.order = [...frame.workspaceIds]
      return this.#emit([{ type: 'order', workspaceIds: this.order() }])
    }
    if (type === 'archived' && Array.isArray(frame.archivedSessionIds)) {
      this.local.archived = [...frame.archivedSessionIds]
      return this.#emit([{ type: 'archived', archivedSessionIds: this.#union('archived') }])
    }
    if (type === 'pinned' && Array.isArray(frame.pinnedSessionIds)) {
      this.local.pinned = [...frame.pinnedSessionIds]
      return this.#emit([{ type: 'pinned', pinnedSessionIds: this.#union('pinned') }])
    }
    return []
  }

  /** A remote baseline (initial or after a re-subscribe) replaces that host only. */
  setHost(host, value) {
    const items = new Map()
    const order = []
    for (const item of Array.isArray(value?.items) ? value.items : []) {
      if (!isPlainObject(item) || typeof item.workspaceId !== 'string') continue
      const renamed = this.#renameWorkspace(host, item)
      items.set(renamed.workspaceId, renamed)
      order.push(renamed.workspaceId)
    }
    this.hosts.set(host.hostId, {
      hostId: host.hostId,
      hostName: host.hostName,
      items,
      order,
      archived: this.#renameList(host, value?.archivedSessionIds),
      pinned: this.#renameList(host, value?.pinnedSessionIds),
    })
    // A (re)connected host changes the merged picture: republish the whole state.
    return this.#emit([{ type: 'replace', value: this.baseline() }])
  }

  applyHost(host, frame) {
    const type = frame?.type
    const entry = this.hosts.get(host.hostId)
    if (!entry) return []
    if (type === 'upsert' && isPlainObject(frame.workspace) && typeof frame.workspace.workspaceId === 'string') {
      const renamed = this.#renameWorkspace(host, frame.workspace)
      entry.items.set(renamed.workspaceId, renamed)
      if (!entry.order.includes(renamed.workspaceId)) entry.order.push(renamed.workspaceId)
      return this.#emit([{ type: 'upsert', workspace: renamed }])
    }
    if (type === 'remove' && typeof frame.workspaceId === 'string') {
      const workspaceId = namespaceId(host.hostId, frame.workspaceId)
      entry.items.delete(workspaceId)
      entry.order = entry.order.filter((id) => id !== workspaceId)
      return this.#emit([{ type: 'remove', workspaceId }])
    }
    if (type === 'order' && Array.isArray(frame.workspaceIds)) {
      entry.order = frame.workspaceIds.filter((id) => typeof id === 'string').map((id) => namespaceId(host.hostId, id))
      return this.#emit([{ type: 'order', workspaceIds: this.order() }])
    }
    if (type === 'archived' && Array.isArray(frame.archivedSessionIds)) {
      entry.archived = this.#renameList(host, frame.archivedSessionIds)
      return this.#emit([{ type: 'archived', archivedSessionIds: this.#union('archived') }])
    }
    if (type === 'pinned' && Array.isArray(frame.pinnedSessionIds)) {
      entry.pinned = this.#renameList(host, frame.pinnedSessionIds)
      return this.#emit([{ type: 'pinned', pinnedSessionIds: this.#union('pinned') }])
    }
    return []
  }

  dropHost(hostId) {
    if (!this.hosts.delete(hostId)) return []
    return this.#emit([{ type: 'replace', value: this.baseline() }])
  }

  #renameWorkspace(host, item) {
    const renamed = namespaceIds(item, host.hostId)
    return { ...renamed, hostId: host.hostId, hostName: host.hostName ?? host.hostId }
  }

  #renameList(host, value) {
    return Array.isArray(value)
      ? value.filter((id) => typeof id === 'string').map((id) => namespaceId(host.hostId, id))
      : []
  }

  #union(key) {
    const out = [...this.local[key]]
    for (const host of this.hosts.values()) out.push(...host[key])
    return [...new Set(out)]
  }

  /** Local order first (the sidebar's "Local workspaces" group), then each host. */
  order() {
    const ids = [...this.local.order]
    for (const host of this.hosts.values()) ids.push(...host.order)
    return ids
  }

  baseline() {
    const items = []
    for (const id of this.local.order) {
      const item = this.local.items.get(id)
      if (item) items.push(item)
    }
    for (const host of this.hosts.values()) {
      for (const id of host.order) {
        const item = host.items.get(id)
        if (item) items.push(item)
      }
    }
    return { items, archivedSessionIds: this.#union('archived'), pinnedSessionIds: this.#union('pinned') }
  }
}

/**
 * The multi-host wrapper. `deps.hosts()` is read fresh on every call (a host can
 * go offline mid-session), `deps.onHostsChanged` is the only subscription.
 *
 * @param {object} deps
 * @param {object} deps.gateway the Host `typertGateway` instance to patch
 * @param {() => Array<{hostId: string, hostName?: string, connection: object, online?: boolean}>} [deps.hosts]
 * @param {(listener: () => void) => (() => void)} [deps.onHostsChanged]
 * @param {{card?: (hostId: string, ids: object) => object|undefined,
 *   pending?: (hostId: string) => object[]}} [deps.approvals]
 * @param {{append: Function, read: Function}} [deps.cache] offline transcript cache
 * @param {(line: string) => void} [deps.log]
 * @param {number} [deps.mergeBaselineTimeoutMs] how long the merged baseline waits for remotes
 * @param {string} [deps.dshVersion] the running DSH version (constitution A1.1 self-test)
 */
export class HostRouter {
  #gateway
  #hosts
  #onHostsChanged
  #approvals
  #cache
  #log
  #baselineTimeoutMs
  #dshVersion
  #originals = null
      #root = null
      #wrapped = null
  #installed = false
  #reason = null
  /** Stop functions of the merged streams currently being consumed. */
  #merges = new Set()
  /** Push functions of the `$events` streams currently open in the native UI. */
  #eventSinks = new Set()
  /**
   * Remote cards the native stream knows about, keyed `hostId\u0000<rpcId>`, with
   * the original ids and the Host's `argsHash`: the answer is routed back with
   * these, never with an id or hash invented here.
   * @type {Map<string, {hostId: string, sessionId: string, rpcId: string,
   *   approvalId?: string, argsHash?: string, kind: 'approval'|'question'}>}
   */
  #cards = new Map()
  /**
   * The last call a host refused, per host (`{code, scope?, at}`), so the Devices
   * page can show it on that host's row. A failing remote contributes no rows to
   * a merged answer, which otherwise looks exactly like a host with nothing in it
   * (spec 008: a short grant showed as a connected host with an empty sidebar).
   * @type {Map<string, {code: string, scope?: string, at: number}>}
   */
  #hostErrors = new Map()

  constructor(deps = {}) {
    this.#gateway = deps.gateway
    this.#hosts = typeof deps.hosts === 'function' ? deps.hosts : () => []
    this.#onHostsChanged = typeof deps.onHostsChanged === 'function' ? deps.onHostsChanged : () => () => {}
    this.#approvals = deps.approvals ?? null
    this.#cache = deps.cache ?? null
    this.#log = typeof deps.log === 'function' ? deps.log : () => {}
    this.#baselineTimeoutMs = Number.isFinite(deps.mergeBaselineTimeoutMs) ? deps.mergeBaselineTimeoutMs : 3000
    // A1.1: the wrap is gated on the pinned `engines.dsh`, so the running version is
    // part of the self-test. A caller that cannot detect it gets no wrap.
    this.#dshVersion = typeof deps.dshVersion === 'string' ? deps.dshVersion : undefined
  }

  /** Wrap the carrier; on a carrier mismatch nothing is patched and status says why. */
  install() {
    if (this.#installed) return this.status()
    const reason = selfTest(this.#gateway, { dshVersion: this.#dshVersion })
    if (reason !== null) {
      this.#reason = reason
      this.#log(`multi-host routing disabled: ${reason} (running DSH ${this.#dshVersion ?? 'unknown'}, pinned ${PINNED_DSH_VERSION})`)
      return this.status()
    }
    const gateway = this.#gateway
    // Restore target: exactly what was there before us (another router's
    // wrapper, on a reload). Local calls target the ROOT DSH original instead,
    // so a stacked wrapper can never route our own local call back into us.
    const dispatchRpc = gateway.dispatchRpc
    const openWireStream = gateway.openWireStream
    const rootDispatchRpc = rootOriginal(dispatchRpc)
    const rootOpenWireStream = rootOriginal(openWireStream)
    // rc.1 moved the signal out of the third slot; keep the probe in one place.
    const rc1 = rootOpenWireStream.length >= 5
    this.#originals = { dispatchRpc, openWireStream, rc1 }
    this.#root = { dispatchRpc: rootDispatchRpc, openWireStream: rootOpenWireStream }
    const router = this
    // Explicit parameter lists, not (...args): the bridge and the upstream switch
    // detect the rc.1 opener by `openWireStream.length >= 5`.
    const wrappedDispatch = function (endpoint, payload, signal, peer) {
      return router.#dispatchRpc(endpoint, payload, signal, peer)
    }
    const wrappedOpen = function (endpoint, payload, uplink, peer, signal, control, uplinkWindow) {
      return router.#openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow)
    }
    this.#wrapped = { dispatchRpc: wrappedDispatch, openWireStream: wrappedOpen }
    // A wrapper is discoverable from anywhere, so a reload that stacks a second
    // router still finds the TRUE DSH original instead of wrapping a wrapper.
    Object.defineProperty(wrappedDispatch, ORIGINAL, { value: rootDispatchRpc })
    Object.defineProperty(wrappedOpen, ORIGINAL, { value: rootOpenWireStream })
    gateway.dispatchRpc = wrappedDispatch
    gateway.openWireStream = wrappedOpen
    this.#installed = true
    this.#reason = null
    this.#log(`multi-host routing installed (opens: ${rc1 ? 'rc1' : 'legacy'} arity)`)
    return this.status()
  }

  /** Restore the original carrier methods (a later wrapper is never clobbered). */
  uninstall() {
    for (const stop of [...this.#merges]) stop()
    this.#merges.clear()
    this.#eventSinks.clear()
    this.#cards.clear()
    this.#hostErrors.clear()
    if (!this.#installed) return
    const gateway = this.#gateway
    const dispatchOurs = gateway.dispatchRpc === this.#wrapped.dispatchRpc
    const openOurs = gateway.openWireStream === this.#wrapped.openWireStream
    if (dispatchOurs) gateway.dispatchRpc = this.#originals.dispatchRpc
    else this.#log('dispatchRpc is no longer ours; left in place')
    if (openOurs) gateway.openWireStream = this.#originals.openWireStream
    else this.#log('openWireStream is no longer ours; left in place')
    this.#installed = false
    // The originals are never nulled. A reload can stack a new router on top of
    // ours, and Cordis disposes the old one first; that old wrapper is then
    // still in the call chain and must keep working. Nulling these made every
    // such call die with "Cannot read properties of null (reading
    // 'dispatchRpc')" (measured live on 0.2.2-rc.1, spec 008). The retained
    // references are two functions and a flag — the cost is negligible.
  }

  /**
   * What the Devices page shows: whether remote routing is live, and why not.
   * A host whose last call was refused also carries that refusal (`error`), so the
   * page never presents an empty-but-connected host as a healthy one.
   * @returns {{remote: boolean, reason: string|null, hosts: object[], merged: string[]}}
   */
  status() {
    let hosts = []
    try {
      hosts = this.#hosts().map((host) => {
        const hostId = String(host?.hostId ?? '')
        const error = this.#hostErrors.get(hostId)
        return {
          hostId,
          hostName: String(host?.hostName ?? host?.hostId ?? ''),
          online: host?.online !== false,
          // Only when there is something to say: an entry stays exactly as before
          // for a host that never refused a call.
          ...(error ? { error } : {}),
        }
      })
    } catch { hosts = [] }
    return { remote: this.#installed, reason: this.#installed ? null : this.#reason, hosts, merged: [...MERGED_ENDPOINTS] }
  }

  /** Remember the last refusal of one host (the log line stays the audit trail). */
  #noteHostError(hostId, error) {
    if (typeof hostId !== 'string' || hostId === '') return
    this.#hostErrors.delete(hostId)
    this.#hostErrors.set(hostId, {
      code: typeof error?.code === 'string' ? error.code : 'error',
      // `auth/forbidden-scope` names the permission the caller lacked.
      ...(typeof error?.scope === 'string' ? { scope: error.scope } : {}),
      at: Date.now(),
    })
    while (this.#hostErrors.size > MAX_HOST_ERRORS) this.#hostErrors.delete(this.#hostErrors.keys().next().value)
  }

  // -- the carrier wrappers -------------------------------------------------

  #connectedHosts() {
    let hosts
    try { hosts = this.#hosts() } catch { return [] }
    return (Array.isArray(hosts) ? hosts : []).filter((host) => host && typeof host.hostId === 'string' && host.online !== false)
  }

  #hostById(hostId) {
    return this.#connectedHosts().find((host) => host.hostId === hostId)
  }

  /** Strip the hint (and any id tag), then check that no tag survives. */
  #forwardArgs(payload, hostId) {
    return stripHostIds(withoutHint(payloadArgs(payload)), hostId)
  }

  #assertNoNamespace(args, hostId) {
    const leaked = hostIdsIn(args)
    if (leaked.size === 0) return
    throw new HostRouterError('remote/id-leak',
      `refusing to send a namespaced id to ${hostId}; this would expose another host's namespace`,
      { hosts: [...leaked] })
  }

  /**
   * EVERYTHING a remote Host sends passes through here: results, merged rows,
   * stream frames, cache replays and interaction cards.
   *
   * The ids are opaque, so they are wrapped in the authenticated source host's
   * namespace unconditionally — never trusted as already tagged. A payload that
   * already carries a tag is refused (`remote/id-leak`, logged without the value)
   * and a payload nested past MAX_ID_DEPTH is refused (`remote/payload-too-deep`).
   * @param {string} hostId the host the payload actually arrived from
   * @param {unknown} value the payload
   * @param {string} what endpoint or frame name, for the log line
   */
  #ingress(hostId, value, what) {
    this.#refuseTagged(hostId, value, what)
    try {
      return namespaceIds(value, hostId)
    } catch (error) {
      if (error?.code === 'remote/payload-too-deep') this.#log(`${what} from ${hostId} refused: ${error.code}`)
      throw error
    }
  }

  /**
   * Refuse a remote payload whose id already carries a namespace tag, without
   * renaming anything (the merged workspace map renames as it stores).
   * @returns {unknown} the same value, when it is clean
   */
  #refuseTagged(hostId, value, what) {
    if (taggedIdsIn(value).size === 0) return value
    this.#log(`${what} from ${hostId} refused: remote/id-leak`)
    throw new HostRouterError('remote/id-leak',
      `${what} from ${hostId} carried an id that already names a host namespace; the payload was refused`,
      { hostId })
  }

  /**
   * Decide where one call goes, from the ids in its payload.
   * @returns {{kind: 'local'} | {kind: 'remote', hostId: string, hostName: string, connection: object}}
   */
  #route(payload) {
    const named = hostIdsIn(payload)
    if (named.size > 1) {
      throw new HostRouterError('remote/host-conflict',
        'this call names more than one remote host; a call must belong to one host', { hosts: [...named] })
    }
    let hostId = named.size === 1 ? [...named][0] : null
    // Global endpoints (llm/*, skills/list, settings/…) have no id to route by,
    // so the client names the host explicitly; the tag always wins over the hint.
    if (hostId === null) hostId = hostHintOf(payload)
    if (hostId === null) return { kind: 'local' }
    const host = this.#hostById(hostId)
    if (!host || typeof host.connection !== 'object' || host.connection === null) {
      throw new HostRouterError('remote/host-offline',
        `remote host ${hostId} is not connected; reconnect it in Settings → Devices`, { hostId })
    }
    return { kind: 'remote', hostId, hostName: host.hostName ?? hostId, connection: host.connection }
  }

  #localDispatch(endpoint, payload, signal, peer) {
    const target = this.#root?.dispatchRpc ?? rootOriginal(this.#gateway.dispatchRpc)
    if (typeof target !== 'function') {
      throw new HostRouterError('remote/unavailable',
        'this Host does not expose the Gateway carrier (dispatchRpc); the remote bridge is unavailable')
    }
    return Reflect.apply(target, this.#gateway, [endpoint, payload, signal, peer])
  }

  #localOpen(endpoint, payload, uplink, peer, signal, control, uplinkWindow) {
    const openWireStream = this.#root?.openWireStream ?? rootOriginal(this.#gateway.openWireStream)
    const { rc1 } = this.#originals ?? { rc1: true }
    return rc1
      ? Reflect.apply(openWireStream, this.#gateway, [endpoint, payload, uplink, peer, signal, control, uplinkWindow])
      : Reflect.apply(openWireStream, this.#gateway, [endpoint, payload, signal])
  }

  async #dispatchRpc(endpoint, payload, signal, peer) {
    // A merged endpoint answers for Local plus every connected host at once; the
    // client-side hint does not narrow it (each row carries its own hostId, the
    // page filters there). Only a tagged id could name one host — a list request
    // never carries one.
    if (endpoint === 'session/list' && hostIdsIn(payload).size === 0) return this.#mergeSessionList(payload, signal, peer)
    let target
    try {
      target = this.#route(payload)
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
    if (target.kind === 'local') {
      // Unchanged for Local.
      return this.#localDispatch(endpoint, payload, signal, peer)
    }
    try {
      if (endpoint === APPROVAL_RESULT_ENDPOINT) return { ok: true, value: await this.#answerCard(target, payload, signal) }
      const args = this.#forwardArgs(payload, target.hostId)
      this.#assertNoNamespace(args, target.hostId)
      const value = await target.connection.call(endpoint, args, { signal })
      return { ok: true, value: this.#ingress(target.hostId, value, endpoint) }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }

  /**
   * The card we injected for these ids (by any of its correlation ids), or null.
   * The table is small and bounded, so a scan is the simple honest lookup.
   */
  #card(hostId, ids) {
    const wanted = [ids?.rpcId, ids?.eventId, ids?.approvalId].filter((id) => typeof id === 'string' && id !== '')
    if (wanted.length === 0) return null
    for (const entry of this.#cards.values()) {
      if (entry.hostId !== hostId) continue
      if (wanted.includes(entry.rpcId) || (entry.approvalId !== undefined && wanted.includes(entry.approvalId))) return entry
    }
    return null
  }

  /**
   * `$events/result` for a remote `$events` card: an approval goes through the
   * bridge's hash-bound decision path, a question through the bridge's
   * `userQuestions/answer`. Both carry the original ids of the card the Host issued.
   */
  async #answerCard(target, payload, signal) {
    const args = this.#forwardArgs(payload, target.hostId)
    this.#assertNoNamespace(args, target.hostId)
    const card = this.#card(target.hostId, args)
    if (card?.kind === 'question') return this.#answerQuestion(target, card, args, signal)
    return this.#decideRemote(target, args, card, signal)
  }

  /**
   * The bridge never forwards `$events/result` raw: it maps the call onto its
   * hash-bound approval decision. The hash must be the one the Host issued for
   * that card — a decision the UI cannot bind is refused here, not silently
   * applied (the request stays pending on the Host, which is what a mismatching
   * hash gets from the bridge as a normal `accepted:false` receipt).
   *
   * @param {object} args the decision with local ids already stripped
   * @param {object|null} card the card this router injected, when it knows it
   */
  async #decideRemote(target, args, card, signal) {
    let decision = args
    if (!(typeof args.argsHash === 'string' && APPROVAL_HASH.test(args.argsHash))) {
      const buffered = this.#approvals?.card?.(target.hostId, args)
      const binding = card ?? buffered
      if (!binding || typeof binding.argsHash !== 'string' || !APPROVAL_HASH.test(binding.argsHash)) {
        throw new HostRouterError('remote/approval-unbound',
          'the approval card for this decision is not available on this host; the decision was not sent')
      }
      decision = { ...args, argsHash: binding.argsHash }
      if (decision.eventId === undefined && binding.rpcId !== undefined) decision.eventId = binding.rpcId
      if (decision.rpcId === undefined && binding.rpcId !== undefined) decision.rpcId = binding.rpcId
      if (decision.approvalId === undefined && binding.approvalId !== undefined) decision.approvalId = binding.approvalId
      if (decision.sessionId === undefined && binding.sessionId !== undefined) decision.sessionId = binding.sessionId
    } else if (card) {
      // The UI echoed a hash: keep it verbatim (the Host is the authority on
      // whether it still matches) but complete the ids the Host needs.
      decision = { ...args }
      if (decision.rpcId === undefined) decision.rpcId = card.rpcId
      if (decision.sessionId === undefined) decision.sessionId = card.sessionId
      if (decision.approvalId === undefined && card.approvalId !== undefined) decision.approvalId = card.approvalId
    }
    const receipt = await target.connection.call(APPROVAL_RESULT_ENDPOINT, decision, { signal })
    // A decided card is no longer addressable; the native UI already closed it.
    if (card && receipt?.accepted === true) this.#forgetCard(card, false)
    return this.#ingress(target.hostId, receipt, APPROVAL_RESULT_ENDPOINT)
  }

  /**
   * A question card is answered on the Host through the bridge's scope-gated
   * `userQuestions/answer` call (`approval:respond`), with the rc.1 argument shape
   * `{ agentId, callId, answer: { answers } }` (dsh-user-questions typert remote).
   *
   * The companion channel's `question-answer` frame is ADMIN_ONLY and is never used
   * for a device; the bridge forwards the same answer through the Host's own
   * question service, which refuses one that is not continuable (`false`). A
   * `next`-style outcome means the native UI declined to answer: nothing is applied
   * and the card stays with the Host.
   */
  async #answerQuestion(target, card, args, signal) {
    const outcome = isPlainObject(args.outcome) ? args.outcome : {}
    const value = isPlainObject(outcome.value) ? outcome.value : {}
    const answers = Array.isArray(value.answers) ? value.answers : (Array.isArray(outcome.answers) ? outcome.answers : null)
    if (outcome.kind !== 'result' || answers === null) {
      return this.#ingress(target.hostId, { kind: 'question-response', rpcId: card.rpcId, sessionId: card.sessionId,
        action: 'answer', accepted: false, reason: 'no-answer' }, QUESTION_ANSWER_ENDPOINT)
    }
    // The tool-call id the Host's question service keys the question by. It comes
    // from the card the Host pushed; without it nothing can be answered.
    if (typeof card.callId !== 'string' || card.callId === '') {
      throw new HostRouterError('remote/question-unbound',
        'the question card carries no tool-call id on this controller; the answer was not sent')
    }
    const answered = await target.connection.call(QUESTION_ANSWER_ENDPOINT, {
      agentId: card.sessionId, callId: card.callId, answer: { answers },
    }, { signal })
    const accepted = answered === true
    if (accepted) this.#forgetCard(card, false)
    else this.#log(`question answer for ${target.hostId} not accepted by the Host`)
    return this.#ingress(target.hostId, { kind: 'question-response', rpcId: card.rpcId, sessionId: card.sessionId,
      action: 'answer', accepted, ...(accepted ? {} : { reason: 'not-accepted' }) }, QUESTION_ANSWER_ENDPOINT)
  }

  /**
   * `session/list`: Local plus every connected host, newest activity first. The
   * client-side host hint does not narrow it (each row carries its own hostId).
   *
   * The merged list is not paginated — the rc.1 `session/list` result carries no
   * cursor and a page cursor minted by one Host cannot be resumed against the
   * merged view, so the request's `cursor` is dropped for both sides and the
   * complete merged list is returned. A failing remote contributes nothing (a
   * dead host must not break the local list); it is logged and shown by `status()`.
   */
  async #mergeSessionList(payload, signal, peer) {
    const raw = { ...payloadArgs(payload) }
    delete raw.cursor
    const args = withoutHint(raw)
    // The Gateway carrier forwards exactly one `args` field; a client-side hint
    // (or any other top-level key) must not travel with the merged request.
    const local = await this.#localDispatch('session/list', { args }, signal, peer)
    if (!local || local.ok !== true) return local
    const items = Array.isArray(local.value?.items) ? [...local.value.items] : []
    const hosts = this.#connectedHosts()
    const remote = await Promise.all(hosts.map(async (host) => {
      try {
        const value = await host.connection.call('session/list', args, { signal })
        const rows = Array.isArray(value?.items) ? value.items : []
        // Each row is remote data: a row that names a host namespace is refused
        // and takes that host's whole contribution with it.
        const renamed = rows.map((row) => this.#ingress(host.hostId, row, 'session/list row'))
        this.#hostErrors.delete(host.hostId)
        return renamed
      } catch (error) {
        this.#noteHostError(host.hostId, error)
        this.#log(`session/list from ${host.hostId} failed: ${error?.code ?? 'error'}`)
        return []
      }
    }))
    for (const rows of remote) items.push(...rows)
    // Stable sort: equal `updatedAt` keeps Local first, then host order.
    items.sort((a, b) => Number(b?.updatedAt ?? 0) - Number(a?.updatedAt ?? 0))
    return { ...local, value: { ...(isPlainObject(local.value) ? local.value : {}), items } }
  }

  #openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow) {
    // Every branch returns a promise, like the rc.1 opener the caller probed.
    if (endpoint === 'workspace/follow') {
      return Promise.resolve(this.#mergeFollow({ payload, uplink, peer, signal, control, uplinkWindow }))
    }
    // `$events` names no host: it stays the Local stream, with the connected
    // remotes' interaction cards merged into it (spec 008 P2c).
    if (endpoint === EVENTS_ENDPOINT) {
      return Promise.resolve(this.#mergeEvents({ payload, uplink, peer, signal, control, uplinkWindow }))
    }
    let target
    try {
      target = this.#route(payload)
    } catch (error) {
      // A session the user already opened stays readable while its host is
      // offline: replay the local copy instead of failing the whole stream.
      const replay = endpoint === SESSION_FOLLOW_ENDPOINT
        ? this.#replayCachedFollow(payload, error?.details?.hostId)
        : null
      if (replay) return Promise.resolve(replay)
      return Promise.reject(error)
    }
    if (target.kind === 'local') return this.#localOpen(endpoint, payload, uplink, peer, signal, control, uplinkWindow)
    return this.#openRemote(target, endpoint, payload, uplink, signal)
  }

  /**
   * One stream opened on a remote Host. The bridge has no uplink channel, so an
   * uplink (client -> Host items) is not forwarded; every rc.1 endpoint the
   * native UI streams from is a read stream.
   *
   * A `session/follow` is also the session follower of the offline cache: its
   * frames are the transcript the user is looking at, so they are appended here
   * (raw, host-relative) for the moment that host goes away.
   */
  async #openRemote(target, endpoint, payload, uplink, signal) {
    if (uplink !== undefined && uplink !== null) this.#log(`remote stream ${endpoint}: the uplink is not forwarded`)
    const args = this.#forwardArgs(payload, target.hostId)
    this.#assertNoNamespace(args, target.hostId)
    const source = await target.connection.openStream(endpoint, args, { signal })
    const cache = this.#cache
    const sessionId = endpoint === SESSION_FOLLOW_ENDPOINT && cache ? followSessionId(args) : null
    const router = this
    return (async function* renamed() {
      for await (const value of source) {
        // Refuse before anything is cached: a frame that names a namespace must
        // never reach the UI, and it must not survive in the local copy either.
        const frame = router.#ingress(target.hostId, value, endpoint)
        if (sessionId) cache.append(target.hostId, sessionId, value)
        yield frame
      }
    })()
  }

  /** The local copy of a session whose host is offline, as a read-only stream. */
  #replayCachedFollow(payload, hostId) {
    const cache = this.#cache
    if (!cache || typeof hostId !== 'string') return null
    const sessionId = followSessionId(this.#forwardArgs(payload, hostId))
    if (!sessionId) return null
    let frames
    try { frames = cache.read(hostId, sessionId) } catch { return null }
    if (!Array.isArray(frames) || frames.length === 0) return null
    this.#log(`session ${sessionId} of ${hostId} is offline: replaying the cached transcript`)
    // Read-only by construction: no request reaches the Host, and the stream ends
    // where the cache ends (the UI shows it behind the offline banner).
    const router = this
    return (async function* replay() {
      for (const frame of frames) yield router.#ingress(hostId, frame, 'cached transcript')
    })()
  }

  // -- interaction cards -> the native `$events` stream ----------------------
  //
  // The Host pushes its approval/question cards to every connected device that
  // may answer them (`approval-requested`, `question-requested`). Those are the
  // only frames that carry the card's own `rpcId`/`approvalId`/`argsHash`, so
  // they are the ones rebuilt as native `$events` waterfall frames. The native
  // UI then answers through `$events/result`, which comes back here.

  #cardKey(hostId, rpcId) {
    return `${hostId}\u0000${rpcId}`
  }

  /** Rebuild one device card as the native waterfall frame, and remember its ids. */
  #injectCard(host, frame) {
    const kind = frame?.kind
    const approval = kind === 'approval-requested'
    const question = kind === 'question-requested'
    if (!approval && !question) return null
    const rpcId = typeof frame.rpcId === 'string' && frame.rpcId !== '' ? frame.rpcId : null
    const sessionId = typeof frame.sessionId === 'string' && frame.sessionId !== '' ? frame.sessionId : null
    if (!rpcId || !sessionId) return null
    // The card's ids are remote data like any other: a card that names a host
    // namespace (its own or another host's) is refused, never renamed into it. The
    // WHOLE card is checked first — `approvalId`/`callId` are copied verbatim — so
    // a hostile one can never be stored in `#cards` (or reach the approval buffer).
    let eventId
    let agentId
    try {
      assertCleanCard(host.hostId, frame)
      eventId = namespaceId(host.hostId, rpcId)
      agentId = namespaceId(host.hostId, sessionId)
    } catch (error) {
      this.#log(`interaction card from ${host.hostId} refused: ${error?.code ?? 'error'}`)
      return null
    }
    /** @type {{hostId: string, sessionId: string, rpcId: string, callId?: string,
     *   approvalId?: string, argsHash?: string, kind: 'approval'|'question'}} */
    const card = { hostId: host.hostId, sessionId, rpcId, kind: approval ? 'approval' : 'question' }
    // The tool-call id identifies a question for the Host's question service; it is
    // what `userQuestions/answer` needs (the gateway publishes it with the card).
    if (typeof frame.callId === 'string' && frame.callId !== '') card.callId = frame.callId
    if (typeof frame.approvalId === 'string' && frame.approvalId !== '') card.approvalId = frame.approvalId
    if (typeof frame.argsHash === 'string' && APPROVAL_HASH.test(frame.argsHash)) card.argsHash = frame.argsHash
    const key = this.#cardKey(host.hostId, rpcId)
    this.#cards.delete(key)
    this.#cards.set(key, card)
    while (this.#cards.size > MAX_TRACKED_CARDS) this.#cards.delete(this.#cards.keys().next().value)
    // The waterfall request carries no `agent`/`signal` (the client rejects it);
    // every field below comes from the card the Host issued, verbatim.
    const request = approval
      ? {
        ...(typeof frame.toolName === 'string' ? { toolName: frame.toolName } : {}),
        ...(frame.callId !== undefined ? { callId: frame.callId } : {}),
        ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
        ...(frame.displayReason !== undefined ? { displayReason: frame.displayReason } : {}),
        ...(typeof frame.argsPreview === 'string' ? { argsPreview: frame.argsPreview } : {}),
      }
      : { questions: Array.isArray(frame.questions) ? frame.questions : [] }
    return {
      type: 'waterfall',
      event: approval ? APPROVAL_EVENT : QUESTION_EVENT,
      eventId,
      agentId,
      request,
    }
  }

  /** Drop one tracked card; `withdraw` also tells the native stream it is gone. */
  #forgetCard(card, withdraw = true) {
    const key = this.#cardKey(card.hostId, card.rpcId)
    if (!this.#cards.delete(key)) return
    if (!withdraw) return
    // The native stream closes a pending card with `{type:'cancel', eventId}`:
    // without it the UI would keep showing an approval nobody can decide.
    this.#publishEvent({ type: 'cancel', eventId: namespaceId(card.hostId, card.rpcId) })
  }

  /** Withdraw every pending card of one host (disconnect, revoke, resolve). */
  #withdrawHost(hostId) {
    for (const card of [...this.#cards.values()]) if (card.hostId === hostId) this.#forgetCard(card, true)
  }

  #publishEvent(frame) {
    for (const sink of [...this.#eventSinks]) {
      try { sink(frame) } catch { /* one broken consumer must not stop the others */ }
    }
  }

  /**
   * `$events` merged: the Local stream unchanged, plus the interaction cards of
   * every connected Host, renamed into that Host's namespace. A disconnecting
   * Host withdraws its cards, so the native UI never shows a dead approval.
   */
  async *#mergeEvents(call) {
    const { payload, uplink, peer, signal, control, uplinkWindow } = call
    const queue = new ValueQueue()
    const lifetime = new AbortController()
    const stop = () => { lifetime.abort(); queue.close() }
    this.#merges.add(stop)
    const sink = (frame) => queue.push(frame)
    this.#eventSinks.add(sink)
    /** @type {Map<string, () => void>} hostId -> detach its card listeners */
    const watching = new Map()

    const watch = (host) => {
      if (watching.has(host.hostId)) return
      const connection = host.connection
      // Only a live connection object can be listened to (a stub is not a source).
      if (!connection || typeof connection.on !== 'function' || typeof connection.off !== 'function') return
      const onCard = (frame) => {
        const injected = this.#injectCard(host, frame)
        if (injected) this.#publishEvent(injected)
      }
      const onResolved = (frame) => {
        for (const card of [...this.#cards.values()]) {
          if (card.hostId !== host.hostId) continue
          if (frame?.rpcId !== undefined && card.rpcId !== frame.rpcId) continue
          this.#forgetCard(card, true)
        }
      }
      const onState = (state) => { if (state !== 'online') this.#withdrawHost(host.hostId) }
      connection.on('approval', onCard)
      connection.on('question', onCard)
      connection.on('resolved', onResolved)
      connection.on('questionResolved', onResolved)
      connection.on('state', onState)
      watching.set(host.hostId, () => {
        connection.off('approval', onCard)
        connection.off('question', onCard)
        connection.off('resolved', onResolved)
        connection.off('questionResolved', onResolved)
        connection.off('state', onState)
      })
      // Cards the Host pushed before this stream opened (a reload, a second
      // window) are still answerable: seed them in the order they arrived.
      for (const card of this.#approvals?.pending?.(host.hostId) ?? []) onCard(card)
    }

    const onAbort = () => stop()
    const watched = [signal, control?.signal].filter(Boolean)
    for (const source of watched) {
      if (source.aborted) onAbort()
      else source.addEventListener('abort', onAbort, { once: true })
    }
    let unsubscribe = null
    try {
      const localSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      const localControl = control ?? new AbortController()
      const localSource = await this.#localOpen(EVENTS_ENDPOINT, payload, uplink, peer, localSignal, localControl, uplinkWindow)
      const iterator = localSource[Symbol.asyncIterator]()
      // The stream must begin with the Local `ready` frame (the client rejects a
      // card that arrives before it), so it is read before any card is queued.
      const first = await iterator.next()
      if (!first.done) queue.push(first.value)
      void (async () => {
        try {
          for (;;) {
            const next = await iterator.next()
            if (next.done) break
            if (lifetime.signal.aborted) break
            queue.push(next.value)
          }
        } catch (error) {
          if (lifetime.signal.aborted) return
          queue.fail(error)
        }
      })()
      for (const host of this.#connectedHosts()) watch(host)
      unsubscribe = this.#onHostsChanged(() => {
        const hosts = this.#connectedHosts()
        const connected = new Set(hosts.map((host) => host.hostId))
        for (const host of hosts) watch(host)
        for (const hostId of [...watching.keys()]) {
          if (connected.has(hostId)) continue
          this.#withdrawHost(hostId)
          watching.get(hostId)?.()
          watching.delete(hostId)
        }
      })
      for await (const frame of queue) yield frame
    } finally {
      for (const source of watched) source.removeEventListener?.('abort', onAbort)
      unsubscribe?.()
      this.#eventSinks.delete(sink)
      for (const detach of watching.values()) detach()
      this.#merges.delete(stop)
      stop()
    }
  }

  /**
   * `workspace/follow` merged: one Local stream plus one per connected remote.
   * Emits a merged baseline, then renamed increments; a remote (re)connect or
   * disconnect emits a `replace` of the whole merged state.
   */
  async *#mergeFollow(call) {
    const { payload, uplink, peer, signal, control, uplinkWindow } = call
    const queue = new ValueQueue()
    const state = new MergeState()
    const lifetime = new AbortController()
    const stop = () => { lifetime.abort(); queue.close() }
    this.#merges.add(stop)
    const forward = (frames) => { for (const frame of frames) queue.push(frame) }
    /** @type {Map<string, AbortController>} */
    const pumps = new Map()
    const drop = (hostId) => {
      pumps.get(hostId)?.abort()
      pumps.delete(hostId)
      forward(state.dropHost(hostId))
    }

    const start = (host) => {
      if (pumps.has(host.hostId)) return
      const hostControl = new AbortController()
      pumps.set(host.hostId, hostControl)
      void (async () => {
        try {
          const source = await host.connection.openStream('workspace/follow', {},
            { signal: AbortSignal.any([hostControl.signal, lifetime.signal]) })
          for await (const frame of source) {
            if (hostControl.signal.aborted) break
            const type = frame?.type
            // Refuse a frame that names host namespaces BEFORE the merged map
            // stores it: the map renames as it stores, so a pre-checked frame is
            // the only way to refuse one without writing half of it.
            if (type === 'baseline' || type === 'replace') {
              forward(state.setHost(host, this.#refuseTagged(host.hostId, frame.value, 'workspace/follow baseline')))
              continue
            }
            forward(state.applyHost(host, this.#refuseTagged(host.hostId, frame, 'workspace/follow')))
          }
        } catch (error) {
          if (hostControl.signal.aborted || lifetime.signal.aborted) return
          // A broken follow stream is a dead host as far as the sidebar cares.
          this.#noteHostError(host.hostId, error)
          this.#log(`workspace/follow from ${host.hostId} stopped: ${error?.code ?? 'error'}`)
          if (pumps.get(host.hostId) === hostControl) drop(host.hostId)
        }
      })()
    }

    const onAbort = () => stop()
    const watched = [signal, control?.signal].filter(Boolean)
    for (const source of watched) {
      if (source.aborted) onAbort()
      else source.addEventListener('abort', onAbort, { once: true })
    }
    let unsubscribe = null
    try {
      const localSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      const localControl = control ?? new AbortController()
      const localSource = await this.#localOpen('workspace/follow', payload, uplink, peer, localSignal, localControl, uplinkWindow)
      let settleLocal = { resolve: () => {}, reject: () => {} }
      const localReady = new Promise((resolve, reject) => { settleLocal = { resolve, reject } })
      // The failure is also reported through the queue; this keeps a late
      // rejection from becoming an unhandled one after the baseline race settled.
      localReady.catch(() => {})
      void (async () => {
        try {
          for await (const frame of localSource) {
            if (lifetime.signal.aborted) break
            const type = frame?.type
            if (type === 'baseline' || type === 'replace') { state.setLocal(frame.value); settleLocal.resolve(); continue }
            forward(state.applyLocal(type, frame))
          }
        } catch (error) {
          if (lifetime.signal.aborted) return
          // Local is the spine of the merged view: without it nothing is credible.
          settleLocal.reject(error)
          queue.fail(error)
        }
      })()

      for (const host of this.#connectedHosts()) start(host)
      unsubscribe = this.#onHostsChanged(() => {
        const hosts = this.#connectedHosts()
        const connected = new Set(hosts.map((host) => host.hostId))
        for (const host of hosts) start(host)
        for (const hostId of [...pumps.keys()]) if (!connected.has(hostId)) drop(hostId)
      })

      // One merged baseline: wait briefly for the remotes so the first paint is
      // complete, then fold a late host in as a `replace`.
      await Promise.race([localReady, this.#delay(this.#baselineTimeoutMs)])
      state.ready = true
      queue.push({ type: 'baseline', value: state.baseline() })
      for await (const frame of queue) yield frame
    } finally {
      for (const source of watched) source.removeEventListener?.('abort', onAbort)
      unsubscribe?.()
      this.#merges.delete(stop)
      stop()
    }
  }

  #delay(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  }
}

/** @param {ConstructorParameters<typeof HostRouter>[0]} deps */
export function createHostRouter(deps) {
  return new HostRouter(deps)
}

export default createHostRouter

