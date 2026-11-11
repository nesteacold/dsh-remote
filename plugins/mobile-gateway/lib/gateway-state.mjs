import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { normalizeTransportConfig } from './transport-config.mjs'
import { restrictToOwnerSync } from './secure-file.mjs'

export const PAIRING_ROUTES = ['p2p', 'auto-lan', 'auto', 'lan', 'cloudflare', 'custom', 'tailscale']

export const GATEWAY_MODES = ['disabled', 'temporary', 'persistent']

// A dedicated file keeps installation identity independent of device revocation.
// A malformed file must fail startup rather than silently replace that identity.
export function createGatewayState(file) {
  const validate = (value) => {
    if (!value || value.version !== 1 ||
        typeof value.gatewayId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.gatewayId) ||
        (value.mode !== null && !GATEWAY_MODES.includes(value.mode))) {
      throw new Error('invalid gateway identity or mode')
    }
    if (value.pairingRoute !== undefined && !PAIRING_ROUTES.includes(value.pairingRoute)) throw new Error('invalid pairing route')
    if (value.webrtc !== undefined) normalizeTransportConfig(value.webrtc)
    if (value.tailscaleUrl !== undefined && typeof value.tailscaleUrl !== 'string') throw new Error('invalid Tailscale address')
    if (value.p2pUrl !== undefined && typeof value.p2pUrl !== 'string') throw new Error('invalid P2P address')
    // Optional, so `version` stays 1: a file written before the Devices page could
    // pick a listen address still validates, and a file carrying one stays
    // readable by the older shape. The address itself is validated by the caller
    // (the same loopback/private/IP rule the config enforces).
    if (value.listenHost !== undefined
      && (typeof value.listenHost !== 'string' || value.listenHost === '' || value.listenHost.length > 255)) {
      throw new Error('invalid listen host')
    }
    // Optional for the same reason as `listenHost`: a file written before the
    // owner switch was persisted still validates. Absent means "never moved",
    // which the caller must tell apart from an explicit `false`.
    if (value.remoteControl !== undefined && typeof value.remoteControl !== 'boolean') {
      throw new Error('invalid remote control switch')
    }
    return value
  }
  const read = () => validate(JSON.parse(fs.readFileSync(file, 'utf8')))
  // Single writer by design: every createGatewayState() instance keeps its OWN
  // snapshot and replaces the file wholesale, so two instances (or two
  // processes) on one file can drop each other's fields. The atomic replacement
  // only prevents a torn read; it does not prevent a lost update. Locking is
  // deliberately out of scope.
  const write = (value, initial = false) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      restrictToOwnerSync(tmp, 'file')
      if (initial) fs.linkSync(tmp, file) // Never overwrite a concurrently created identity.
      else fs.renameSync(tmp, file)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }
  let state
  try {
    try {
      state = read()
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      state = { version: 1, gatewayId: crypto.randomUUID(), mode: null }
      try { write(state, true) } catch (cause) {
        if (cause.code !== 'EEXIST') throw cause
        state = read()
      }
    }
    restrictToOwnerSync(file, 'file')
  } catch (error) {
    throw new Error(`failed to load gateway state ${file}: ${error.message}`, { cause: error })
  }
  return {
    get gatewayId() { return state.gatewayId },
    get mode() { return state.mode },
    get pairingRoute() { return state.pairingRoute },
    get webrtc() { return state.webrtc },
    get p2pUrl() { return state.p2pUrl || '' },
    get tailscaleUrl() { return state.tailscaleUrl || '' },
    // The listen address the owner picked on the Devices page (POST /mgw/listen).
    // Empty means "no choice was made": the configured `lanHost` stays in force.
    get listenHost() { return state.listenHost || '' },
    setListenHost(host) {
      if (typeof host !== 'string' || host === '' || host.length > 255) throw new TypeError('invalid listen host')
      const next = { ...state, listenHost: host }
      validate(next)
      write(next)
      state = next
    },
    // The owner's last "Allow connections" position (POST /mgw/remote-control).
    // `undefined` means the switch was never moved: the config decides at start.
    get remoteControl() { return state.remoteControl },
    setRemoteControl(enabled) {
      if (typeof enabled !== 'boolean') throw new TypeError('invalid remote control switch')
      const next = { ...state, remoteControl: enabled }
      validate(next)
      write(next)
      state = next
    },
    setConnection(route, webrtc, p2pUrl = state.p2pUrl || '', tailscaleUrl = state.tailscaleUrl || '') {
      if (!PAIRING_ROUTES.includes(route)) throw new TypeError('invalid pairing route')
      const next = { ...state, pairingRoute: route, webrtc: normalizeTransportConfig(webrtc), p2pUrl, tailscaleUrl }
      validate(next)
      write(next)
      state = next
    },
    setMode(mode) {
      if (!GATEWAY_MODES.includes(mode)) throw new TypeError('invalid gateway mode')
      const next = { ...state, mode }
      write(next)
      state = next
    },
  }
}
