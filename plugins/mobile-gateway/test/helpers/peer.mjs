import assert from 'node:assert/strict'
import crypto from 'node:crypto'

export function createTestPeer(options = { principal: { kind: 'owner' }, interactions: 'none' }) {
  const abort = new AbortController()
  return {
    id: crypto.randomUUID(), ctx: {}, ...options, signal: abort.signal,
    async dispose() { abort.abort() },
  }
}

// T022a: the gateway now also opens ONE non-owner Peer per device connection
// (principal `dsh-ext-mobile-device`), so this fake accepts exactly the two
// principal shapes the plugin may create and nothing else. Spec 008: the
// remote-bridge Peer of a device holding `approval:respond` declares
// `interactions: 'answer'` (rc.1 refuses `$events` for 'none'), so an owner Peer
// may carry either value; a device Peer always stays 'none'.
export function createTestConnection() {
  return {
    peers: [],
    createPeer(options) {
      const kind = options.principal?.kind
      if (kind === 'owner') {
        assert.deepEqual(Object.keys(options).sort(), ['interactions', 'principal'])
        assert.deepEqual(options.principal, { kind: 'owner' })
        assert.ok(options.interactions === 'none' || options.interactions === 'answer',
          `owner Peer interactions must be none or answer, got ${String(options.interactions)}`)
      } else {
        assert.equal(options.interactions, 'none')
        assert.equal(kind, 'dsh-ext-mobile-device')
        assert.deepEqual(Object.keys(options.principal).sort(), ['deviceId', 'kind'])
        assert.equal(typeof options.principal.deviceId, 'string')
      }
      const peer = createTestPeer(options)
      this.peers.push(peer)
      return peer
    },
  }
}

/**
 * Minimal stand-in for DSH's `ctx.remoteAccess` for harnesses that do not run the
 * real service: it records the registered policy so a test can assert it was
 * registered once, and rejects a duplicate kind exactly like the real one.
 * It does NOT evaluate decisions: tests that need enforcement use the real
 * RemoteAccessService (test/device-access-real.test.mjs).
 */
export function createTestRemoteAccess() {
  const policies = new Map()
  return {
    policies,
    invalidations: [],
    registerPolicy(kind, policy) {
      if (policies.has(kind)) throw new Error(`remote access: principal kind ${JSON.stringify(kind)} already has a policy`)
      policies.set(kind, policy)
      return () => { policies.delete(kind) }
    },
    invalidate(principal) { this.invalidations.push(principal) },
  }
}
