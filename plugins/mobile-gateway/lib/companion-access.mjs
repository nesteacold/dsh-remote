// Companion device access (spec 001 T022a, research V3): the positive Host
// endpoint mapping and the DSH `remoteAccess` policy for a paired phone.
//
// The gateway used to run every phone as the owner Peer, so DSH's own
// `remoteAccess.decide()` (which only evaluates NON-owner Peers) never applied.
// A phone now runs as `{ kind: 'dsh-ext-mobile-device', deviceId }`; this module
// is the pure, dependency-free half of that change:
//
//  - `COMPANION_ENDPOINTS`: the ONLY Host `namespace/method` actions a paired
//    device (mobile or desktop, see below) may reach, each with the scope it needs and the resource it touches.
//    Anything not listed is refused (positive list; the older denied-list in
//    allowlist.mjs stays as an independent layer).
//  - `hostEndpointAllowedForDevice()`: the same mapping as a boolean for the
//    adapter guard.
//  - `createCompanionAccessPolicy()`: the `{ bindings, explain }` object for
//    `ctx.remoteAccess.registerPolicy(COMPANION_PRINCIPAL_KIND, policy)`.
//
// Verified against the installed DSH 0.2.2-rc.1 (source read, not a live Host):
//  - `registerPolicy(kind, { bindings(principal), explain?(request) })`; a
//    binding is `{ role: { name, resource, actions }, resource, condition? }`
//    and resources match by exact `kind` + `id`; `global` carries no id.
//  - A call that names no resource touches `global` only. The `session` kind
//    resolves from a top-level `sessionId`, else the first object argument's
//    `sessionId` or `address` (a subagent address resolves to the CHILD id).
//  - `session/list` and `session/search` filter every item through
//    `remoteAccess.allows({kind:'session', id})` for that same action, so those
//    two actions are listed on BOTH the global role (to call it) and the session
//    role (to see an item).
//  - `subagents/prompt` and `subagents/interruptByParent` declare no resource
//    resolver for `childSessionId`/`parentSessionId`, so the Gateway would see
//    them as `global`. They are deliberately NOT mapped here (fail closed) until
//    that resolution is verified on a live Host.
//  - `session/control` is a global call returning a whole-Host live stream. A
//    positive grant would be safe only if DSH filtered every streamed item per
//    session, and that stream-level filter is NOT proven (`itemFilter: true` on
//    list/search is a property of those two RPCs, not of a stream). It is NOT
//    mapped (fail closed); a device sees sessions through `session/list` /
//    `session/search` plus per-session `session/follow` instead.
//
// Device kinds: `mobile` and `desktop` (spec 005) get the IDENTICAL scope and
// resource restrictions here: a desktop paired with the default scopes
// (`DESKTOP_DEFAULT_SCOPES`) is served exactly like a phone with the same
// scopes. What a desktop additionally has (`harness:remote`, the 008 bridge) is
// outside this policy and grants nothing in it: a record holding only
// `harness:remote` gets no bindings.
//
// Nothing here touches a real ctx, peer or the network: the factory receives
// its facts through injected functions, so it is unit-testable and the
// integrator decides when to register it.
// Generated copy of the contract (see scripts/sync-mobile-protocol.mjs): the
// bare package specifier would not resolve in an installed tarball.
import * as contract from './vendor/mobile-protocol.mjs'

/** Principal kind a paired companion device runs as (never `owner`). */
export const COMPANION_PRINCIPAL_KIND = 'dsh-ext-mobile-device'

/**
 * The `device.kind` values the policy serves, with identical restrictions
 * (contract `DEVICE_KINDS`). A desktop's extra `harness:remote` bridge (008) is
 * not part of this policy.
 */
export const COMPANION_DEVICE_KINDS = Object.freeze(['mobile', 'desktop'])

/** @deprecated kept for existing importers: the original single-kind constant. */
export const COMPANION_DEVICE_KIND = 'mobile'

/** Resource kind DSH's session controller registers for Session ids. */
export const SESSION_RESOURCE_KIND = 'session'
/**
 * DSH filters a `workspace/follow` baseline item-by-item through
 * `remoteAccess.allows({ kind: 'workspace', id })` (`dsh-api-workspace-controller`,
 * `follow()`), so a Workspace is visible ONLY when this policy carries a binding
 * for that exact kind and id — `sameResource()` has no wildcard. Without such a
 * binding a device receives an empty `items` list while the call itself succeeds,
 * which is what "This computer has no workspaces" was.
 */
export const WORKSPACE_RESOURCE_KIND = 'workspace'

const SCOPE_SESSIONS = 'sessions:read'
const SCOPE_PROMPT = 'prompt:send'
/** Spec 011: list workspaces/models, create a session, pick its model. Read from
 * the contract's own authoring mapping so the name is never a second literal. */
const SCOPE_AUTHOR = contract.AUTHORING_SCOPE

/**
 * The positive endpoint table. `resource` says what the Gateway resolves for
 * the call: `global` (names no session) or `session` (one session id).
 * `scope` is the pairing scope that unlocks it (spec 005, contract SCOPES).
 * `harness:remote` is intentionally absent: it belongs to the 008 bridge.
 *
 * Spec 011 (FR-003) added the four authoring endpoints. They are the exact Host
 * endpoints the mobile message handlers reach through `lib/dsh-host-adapter.mjs`
 * — `workspace/follow` is how that adapter lists workspaces (the Host publishes
 * its workspace baseline as a stream), and both `models` forms read
 * `session/modelCatalog`. Nothing else about a workspace or a session was opened:
 * `workspace/create|rename|archiveSession`, `session/fork|rename|updateQueue`,
 * `session/attachment`, `session/canOpenWorkspacePath`, `session/control` and the
 * plugin/schedule/settings families stay unmapped (FR-004).
 */
export const COMPANION_ENDPOINTS = Object.freeze({
  // Session list / search: global call, then each row filtered per session.
  'session/list': Object.freeze({ scope: SCOPE_SESSIONS, resource: 'global', itemFilter: true }),
  'session/search': Object.freeze({ scope: SCOPE_SESSIONS, resource: 'global', itemFilter: true }),
  // Opening-window/live reads of one session.
  'session/follow': Object.freeze({ scope: SCOPE_SESSIONS, resource: SESSION_RESOURCE_KIND }),
  'session/page': Object.freeze({ scope: SCOPE_SESSIONS, resource: SESSION_RESOURCE_KIND }),
  'session/events': Object.freeze({ scope: SCOPE_SESSIONS, resource: SESSION_RESOURCE_KIND }),
  'session/projections': Object.freeze({ scope: SCOPE_SESSIONS, resource: SESSION_RESOURCE_KIND }),
  // Sending input and stopping a turn.
  'session/prompt': Object.freeze({ scope: SCOPE_PROMPT, resource: SESSION_RESOURCE_KIND }),
  'session/cancel': Object.freeze({ scope: SCOPE_PROMPT, resource: SESSION_RESOURCE_KIND }),
  // Spec 011: the authoring surface. `workspace/follow` is the reason the
  // workspace list needs no new Host endpoint — the adapter reads the baseline.
  'workspace/follow': Object.freeze({ scope: SCOPE_AUTHOR, resource: 'global', itemFilter: true, itemKind: WORKSPACE_RESOURCE_KIND }),
  'session/create': Object.freeze({ scope: SCOPE_AUTHOR, resource: 'global' }),
  // Both `models` forms (Host-wide and per-session) read this one catalog;
  // the per-session form also opens `session/follow`, so addressing is enforced.
  'session/modelCatalog': Object.freeze({ scope: SCOPE_AUTHOR, resource: 'global' }),
  // A session resource, exactly like `session/prompt`: a session the device
  // cannot address is refused by DSH itself, before the Host service runs.
  'session/selectModel': Object.freeze({ scope: SCOPE_AUTHOR, resource: SESSION_RESOURCE_KIND }),
})

/**
 * Endpoints deliberately NOT mapped, with the reason. Documentation and a test
 * anchor: nothing consults this at runtime (unlisted == refused).
 */
export const COMPANION_UNSUPPORTED_ENDPOINTS = Object.freeze({
  'subagents/prompt': 'resource resolution of childSessionId/parentSessionId not verified (would resolve to global)',
  'subagents/interruptByParent': 'resource resolution of childSessionId/parentSessionId not verified (would resolve to global)',
  'session/control': 'global whole-Host live stream; per-item session filtering of a stream is not proven (itemFilter applies to list/search only)',
  'remoteAccess/follow': 'always allowed by DSH for every Peer; not part of this mapping',
  'workspace/create': 'spec 011 FR-004: creating a workspace is not part of session authoring',
  'workspace/rename': 'spec 011 FR-004: renaming a workspace is not part of session authoring',
  'workspace/archiveSession': 'spec 011 FR-004: archiving a session into a workspace is not part of session authoring',
  'session/fork': 'spec 011 FR-004: forking is not part of session authoring',
  'session/rename': 'spec 011 FR-004: renaming is not part of session authoring',
  'session/updateQueue': 'spec 011 FR-004: queue control is not part of session authoring',
  'session/canOpenWorkspacePath': 'spec 011 FR-004: probing Host paths is not part of session authoring',
})

/** Forwarded session notifications a device may receive, per visible session (read roles). */
export const COMPANION_EVENT_ACTIONS = Object.freeze([
  'event:api-session/activity',
  'event:api-session/added',
  'event:api-session/error',
  'event:api-session/removed',
  'event:api-session/status',
])

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const knownScopes = new Set(contract.SCOPES)

/** Whether `namespace/method` is in the positive companion mapping. */
export function isCompanionEndpoint(namespace, method) {
  if (typeof namespace !== 'string' || typeof method !== 'string') return false
  return Object.hasOwn(COMPANION_ENDPOINTS, `${namespace}/${method}`)
}

/**
 * Positive Host endpoint guard for a companion device: `true` only for a mapped
 * endpoint. Same signature as `hostEndpointAllowedForCompanion` in allowlist.mjs
 * (the denied-list layer); both must pass.
 */
export function hostEndpointAllowedForDevice(namespace, method) {
  return isCompanionEndpoint(namespace, method)
}

/**
 * The device's scope list as a Set, or `undefined` when it is not trustworthy:
 * not an array, or holding anything but known string scopes. A malformed list
 * is never repaired into a grant (fail closed).
 */
function validScopes(scopes) {
  if (!Array.isArray(scopes)) return undefined
  for (const scope of scopes) if (typeof scope !== 'string' || !knownScopes.has(scope)) return undefined
  return new Set(scopes)
}

/** A session id the Gateway can name: a non-empty string. */
const usableSessionId = (id) => typeof id === 'string' && id.length > 0

/** Actions of the endpoint table granted by `scopes`, split by resource kind. */
function actionsFor(scopes, resource) {
  const actions = []
  for (const [action, entry] of Object.entries(COMPANION_ENDPOINTS)) {
    if (!scopes.has(entry.scope)) continue
    if (entry.resource === resource) { actions.push(action); continue }
    // An endpoint whose result is filtered PER ITEM also needs its action on the
    // item's own resource, because DSH asks `allows({kind, id})` for every item and
    // matches the action of the invocation (`workspace/follow`, `session/list`).
    if (entry.itemFilter) {
      const itemKind = entry.itemKind ?? SESSION_RESOURCE_KIND
      if (itemKind === resource) actions.push(action)
    }
  }
  return actions
}

/**
 * Build the policy for `registerPolicy(COMPANION_PRINCIPAL_KIND, policy)`.
 *
 * @param {object} facts injected, synchronous, in-memory state (DSH calls
 *   `bindings()` on every decision, so nothing here may await or fetch):
 *   - `getDevice(deviceId)`: the live device record `{ kind, scopes, revokedAt? }`
 *     or `undefined`/`null` once it is revoked or unknown;
 *   - `getSessionIds(deviceId)`: the EXACT session ids this device may see
 *     (an iterable of strings). No wildcard exists in DSH bindings, so the
 *     integrator must enumerate; an empty list means no session access.
 *   - `getWorkspaceIds()`: optionally, the EXACT workspace ids of this Host (an
 *     iterable of strings), for the same no-wildcard reason. DSH filters the
 *     `workspace/follow` baseline through `allows({kind:'workspace', id})`, so a
 *     device holding `sessions:author` sees only the workspaces bound here; an
 *     omitted fact means no workspace is visible.
 * @returns {{ bindings(principal): object[], explain(request): string }}
 */
export function createCompanionAccessPolicy(facts) {
  if (!isRecord(facts) || typeof facts.getDevice !== 'function' || typeof facts.getSessionIds !== 'function') {
    throw new TypeError('createCompanionAccessPolicy requires { getDevice, getSessionIds } functions')
  }
  if (facts.getWorkspaceIds !== undefined && typeof facts.getWorkspaceIds !== 'function') {
    throw new TypeError('createCompanionAccessPolicy: getWorkspaceIds must be a function when provided')
  }

  // Roles are plain values; one per resource kind. They carry every action the
  // device's scopes unlock; `bindings()` only emits the roles for granted scopes.
  const roleFor = (resource, actions) => Object.freeze({
    name: `dsh-ext:companion-${resource}`,
    resource,
    actions: Object.freeze(actions),
  })

  /** The device record when the principal is a live, mobile/desktop, non-revoked device; else a refusal code. */
  const resolve = (principal) => {
    if (!isRecord(principal) || principal.kind !== COMPANION_PRINCIPAL_KIND) return { refusal: 'wrong-principal' }
    if (typeof principal.deviceId !== 'string' || principal.deviceId.length === 0) return { refusal: 'bad-principal' }
    const device = facts.getDevice(principal.deviceId)
    if (!isRecord(device)) return { refusal: 'device-unknown' }
    if (device.revokedAt) return { refusal: 'device-revoked' }
    if (!COMPANION_DEVICE_KINDS.includes(device.kind)) return { refusal: 'device-kind' }
    const scopes = validScopes(device.scopes)
    if (scopes === undefined) return { refusal: 'scopes-invalid' }
    return { scopes }
  }

  return {
    bindings(principal) {
      // Any throw from an injected fact is turned into "no grants" by DSH
      // (`policy-failed`); never swallow it into a partial grant here.
      const live = resolve(principal)
      if (live.refusal !== undefined) return []
      const { scopes } = live
      const bindings = []

      const globalActions = actionsFor(scopes, 'global')
      if (globalActions.length > 0) {
        bindings.push({ role: roleFor('global', globalActions), resource: { kind: 'global' } })
      }

      const sessionActions = actionsFor(scopes, SESSION_RESOURCE_KIND)
      if (sessionActions.length > 0) {
        // Forwarded notifications only for sessions the device can read.
        const readable = scopes.has(SCOPE_SESSIONS)
        const role = roleFor(SESSION_RESOURCE_KIND, readable ? [...sessionActions, ...COMPANION_EVENT_ACTIONS] : sessionActions)
        const seen = new Set()
        for (const id of facts.getSessionIds(principal.deviceId) ?? []) {
          if (!usableSessionId(id) || seen.has(id)) continue
          seen.add(id)
          bindings.push({ role, resource: { kind: SESSION_RESOURCE_KIND, id } })
        }
      }

      // `workspace/follow` is filtered item by item: one binding per workspace id
      // of this Host, otherwise DSH's baseline arrives with `items: []`.
      const workspaceActions = actionsFor(scopes, WORKSPACE_RESOURCE_KIND)
      if (workspaceActions.length > 0 && facts.getWorkspaceIds !== undefined) {
        // `session/create` is decided against the TARGET WORKSPACE, not only the
        // global resource: the gateway's `callResources()` collects one resource per
        // REGISTERED kind (dsh-api-gateway `lib/index.js:36-58`, via
        // `defaultFieldId`), and the workspace controller registers the field kind
        // `{ field: 'workspaceId' }` (dsh-api-workspace-controller `lib/index.js:858`).
        // A `session/create` request carries `workspaceId`, so the workspace resource
        // must carry this action too — otherwise creation is refused with
        // `session/create: access denied (resource-not-allowed)` even though the
        // global action is granted (measured live 2026-11-10).
        //
        // Scoped to `sessions:author` on purpose: a workspace binding only exists for
        // a device that holds it, and nothing else is added, so a device without the
        // scope still creates nothing.
        const actions = scopes.has(SCOPE_AUTHOR) ? [...workspaceActions, 'session/create'] : workspaceActions
        const role = roleFor(WORKSPACE_RESOURCE_KIND, actions)
        const seen = new Set()
        for (const id of facts.getWorkspaceIds() ?? []) {
          if (!usableSessionId(id) || seen.has(id)) continue
          seen.add(id)
          bindings.push({ role, resource: { kind: WORKSPACE_RESOURCE_KIND, id } })
        }
      }
      return bindings
    },

    explain(request) {
      const live = resolve(request?.principal)
      if (live.refusal !== undefined) return live.refusal
      const entry = Object.hasOwn(COMPANION_ENDPOINTS, request?.action) ? COMPANION_ENDPOINTS[request.action] : undefined
      if (entry === undefined) return 'endpoint-not-allowed'
      if (!live.scopes.has(entry.scope)) return 'scope-not-granted'
      return 'resource-not-allowed'
    },
  }
}
