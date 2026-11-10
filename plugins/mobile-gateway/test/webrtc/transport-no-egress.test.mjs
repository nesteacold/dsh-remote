import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_STUN_SERVERS,
  TRANSPORT_DEFAULTS,
  managedStunServers,
  normalizeTransportConfig,
} from '../../lib/transport-config.mjs'

// FR-010: WebRTC 默认只使用 host candidate；不得自动注入任何第三方 STUN/TURN。
// 外部服务器仅来自 owner 显式配置，本次改动不做 TURN 支持。
test('no STUN server is injected by default', () => {
  assert.deepEqual(DEFAULT_STUN_SERVERS, [])
  assert.deepEqual(TRANSPORT_DEFAULTS.stunServers, [])
  assert.deepEqual(normalizeTransportConfig().stunServers, [])
})

test('default config carries no third-party provider endpoint', () => {
  const serialized = JSON.stringify([...DEFAULT_STUN_SERVERS, ...normalizeTransportConfig().stunServers]).toLowerCase()
  assert.equal(serialized.includes('cloudflare'), false)
  assert.equal(serialized.includes('google'), false)
  assert.equal(serialized.includes('stun:'), false)
})

test('an explicitly supplied empty list stays empty', () => {
  assert.deepEqual(normalizeTransportConfig({ stunServers: [] }).stunServers, [])
  assert.deepEqual(managedStunServers([]), [])
  assert.deepEqual(managedStunServers(undefined), [])
})

test('an owner-configured server list is preserved verbatim', () => {
  const configured = ['stun:stun.trusted.test:3478']
  assert.deepEqual(managedStunServers(configured), configured)
  assert.deepEqual(normalizeTransportConfig({ stunServers: configured }).stunServers, configured)
})

test('defaults and normalized results remain immutable', () => {
  assert.throws(() => DEFAULT_STUN_SERVERS.push('stun:wrong.test'))
  assert.throws(() => normalizeTransportConfig().stunServers.push('stun:wrong.test'))
})

test('validation still refuses TURN and placeholder hosts (no relabel)', () => {
  for (const invalid of [null, 'stun:trusted.test', ['turn:trusted.test:3478'], ['stun:stun.example.com:3478']]) {
    assert.throws(() => normalizeTransportConfig({ stunServers: managedStunServers(invalid) }))
  }
})
