// Per-connection non-owner Peers for paired devices (spec 001 T022a, research V3).
//
// Until now every phone ran as the shared `{ kind: 'owner' }` Peer, so DSH's
// `remoteAccess.decide()` (which skips owners) never applied. A paired device
// now gets ITS OWN Peer, `{ kind: 'dsh-ext-mobile-device', deviceId }`, created
// when its connection activates and disposed when that connection closes. The
// Host-side policy (companion-access.mjs) is then the real enforcement and the
// plugin's allowlists are defense in depth, not the only wall.
//
// Verified on the installed DSH 0.2.2-rc.1 (source read AND a loaded run with the
// real RemoteAccessService + TypertGatewayService, see test/device-access-real):
//  - `ctx.connection.createPeer({ principal, interactions })` returns a Peer
//    whose `dispose()` aborts `peer.signal`; the Gateway then refuses every call
//    with `gateway/peer-disposed` and cancels open streams of that Peer.
//  - `ctx.remoteAccess.registerPolicy(kind, policy)` is effect-scoped (removed
//    with the registering fiber) and THROWS on a duplicate kind, so it is
//    registered exactly once per plugin activation.
//  - `remoteAccess.invalidate(principal?)` makes the next decision re-read
//    `bindings()`; bindings are never cached, so the invalidate is only needed to
//    refresh open `remoteAccess/follow` snapshots, not to make a change apply.
//
// Nothing here knows the wire protocol or the router: it only builds principals,
// peers and adapters, and keeps the registry <-> policy facts in step.
import { createCompanionAccessPolicy, COMPANION_PRINCIPAL_KIND, hostEndpointAllowedForDevice } from './companion-access.mjs'
import { createPositiveDeviceGuard } from './allowlist.mjs'

/** The principal a paired device's Peer speaks for. `deviceId` comes from the registry, never from the client. */
export function devicePrincipal(deviceId) {
  if (typeof deviceId !== 'string' || deviceId.length === 0) throw new TypeError('a device principal requires a deviceId')
  return { kind: COMPANION_PRINCIPAL_KIND, deviceId }
}

/**
 * Whether the host provides everything the non-owner path needs. When this is
 * false the gateway must NOT fall back to the owner Peer for a device: the
 * caller refuses the connection (fail closed).
 * @param {object} ctx the plugin Context
 */
export function deviceAccessAvailable(ctx) {
  return typeof ctx?.connection?.createPeer === 'function'
    && typeof ctx?.remoteAccess?.registerPolicy === 'function'
    && typeof ctx?.remoteAccess?.invalidate === 'function'
}

/**
 * Create the device-access controller. Call once in `apply()`.
 *
 * @param {object} deps
 * @param {object} deps.ctx plugin Context with `connection` and `remoteAccess`
 * @param {(deviceId: string) => (object|undefined)} deps.getDevice live registry record (undefined once revoked)
 * @param {() => Iterable<string>} deps.getVisibleSessionIds EXACT ids a device may see (snapshot, see `refreshSessions`)
 * @param {() => Iterable<string>} [deps.getWorkspaceIds] EXACT workspace ids of this Host: DSH filters the
 *   `workspace/follow` baseline per item, so this is what makes a workspace visible to a device at all
 * @param {(message: string) => void} [deps.log]
 * @throws when the Host lacks `remoteAccess` (the plugin must not start a device path without it)
 */
export function createDeviceAccess({ ctx, getDevice, getVisibleSessionIds, getWorkspaceIds, log = () => {} }) {
  if (!deviceAccessAvailable(ctx)) {
    throw new Error('mobile-gateway requires DSH remoteAccess (ctx.remoteAccess.registerPolicy) to run paired devices as non-owner Peers')
  }
  const policy = createCompanionAccessPolicy({
    getDevice,
    getSessionIds: () => getVisibleSessionIds(),
    ...(getWorkspaceIds === undefined ? {} : { getWorkspaceIds }),
  })
  // Registered exactly once; DSH throws on a duplicate kind and removes the
  // policy with the plugin's fiber, so no manual teardown is needed for it.
  const unregister = ctx.remoteAccess.registerPolicy(COMPANION_PRINCIPAL_KIND, policy)
  const guard = createPositiveDeviceGuard(hostEndpointAllowedForDevice)

  /** deviceId -> Set of open per-connection peers (several sockets per device are legal). */
  const peers = new Map()
  let closed = false

  const track = (deviceId, peer) => {
    let set = peers.get(deviceId)
    if (!set) { set = new Set(); peers.set(deviceId, set) }
    set.add(peer)
  }
  const untrack = (deviceId, peer) => {
    const set = peers.get(deviceId)
    if (!set) return
    set.delete(peer)
    if (set.size === 0) peers.delete(deviceId)
  }
  const disposePeer = async (deviceId, peer) => {
    untrack(deviceId, peer)
    try { await peer.dispose() } catch (error) {
      log(`device peer disposal failed: device=${deviceId} ${error && error.message ? error.message : String(error)}`)
    }
  }

  return {
    /** Principal kind registered with DSH (for tests and logs). */
    kind: COMPANION_PRINCIPAL_KIND,
    guard,

    /**
     * One Peer for one device connection. The caller owns it and must call
     * `release()` when the connection closes. Returns `undefined` when the
     * controller is closed or the device is not live: no Peer is created for a
     * revoked/unknown device, so a stale activation cannot get one.
     */
    open(deviceId) {
      if (closed) return undefined
      if (!getDevice(deviceId)) return undefined
      const peer = ctx.connection.createPeer({ principal: devicePrincipal(deviceId), interactions: 'none' })
      track(deviceId, peer)
      let released = false
      return {
        peer,
        release: () => {
          if (released) return Promise.resolve()
          released = true
          return disposePeer(deviceId, peer)
        },
      }
    },

    /**
     * Dispose every open Peer of one device (revoke, re-pair). The Gateway
     * refuses the Peer's next call and aborts its open streams. Also
     * invalidates the device's snapshot so any `remoteAccess/follow` ends.
     */
    async revoke(deviceId) {
      const set = peers.get(deviceId)
      const open = set ? [...set] : []
      for (const peer of open) untrack(deviceId, peer)
      await Promise.all(open.map(async (peer) => {
        try { await peer.dispose() } catch (error) {
          log(`device peer disposal failed: device=${deviceId} ${error && error.message ? error.message : String(error)}`)
        }
      }))
      ctx.remoteAccess.invalidate(devicePrincipal(deviceId))
    },

    /**
     * A device's grants or the visible-session snapshot changed (pairing,
     * scope change, session added/removed). Reported to DSH so open snapshots
     * re-push; decisions themselves already re-read the facts every time.
     */
    invalidate(deviceId) {
      if (closed) return
      ctx.remoteAccess.invalidate(deviceId === undefined ? undefined : devicePrincipal(deviceId))
    },

    /** Number of open device Peers (diagnostics/tests). */
    openPeerCount() {
      let total = 0
      for (const set of peers.values()) total += set.size
      return total
    },

    /** Plugin teardown: dispose every device Peer and drop the policy. Idempotent. */
    async close() {
      if (closed) return
      closed = true
      // The policy goes FIRST and synchronously: a restart re-registers the same
      // principal kind right after teardown, and DSH throws on a duplicate. With
      // no policy a device call is denied (`no-allow`), so nothing is exposed
      // while the Peers below are still being disposed.
      try { unregister() } catch { /* the owning fiber is already gone */ }
      const all = [...peers.entries()].flatMap(([deviceId, set]) => [...set].map((peer) => [deviceId, peer]))
      peers.clear()
      await Promise.all(all.map(([deviceId, peer]) => disposePeer(deviceId, peer)))
    },
  }
}
