// Persistent paired-device registry for mobile-gateway authentication.
//
// Long-lived device tokens are generated with 256 bits of entropy and are
// never written to disk. Only their SHA-256 digests are persisted. Pairing
// codes are one-time, short-lived, and memory-only, so a restart invalidates
// every outstanding QR code without affecting already paired devices.
//
// A pairing offer also remembers what the QR promised (T019 / data-model.md
// PairingOffer): the endpoint the code was issued for and the certificate
// fingerprint the client will pin. `claimPairing()` refuses a client that
// presents the code over a different listener certificate, so a code cannot be
// redeemed against an intercepted endpoint.
'use strict'

const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const contract = require('@dsh-ext/mobile-protocol')

// The registry holds hashed device credentials: restrict it to the owner on
// every platform (mode on POSIX, explicit ACL on Windows). `./secure-file.mjs`
// is ESM-only but Node 24 can require() it synchronously, which keeps this
// CommonJS module's save/load synchronous.
let secureFile
function secureFileApi() {
  secureFile ??= require('./secure-file.mjs')
  return secureFile
}

const STORE_VERSION = 3
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000
// Contract §2: a pairing offer's `expiresAt` is at most five minutes ahead. The
// plugin config schema is capped to this too, but a caller that mounts the
// plugin with an object skips schema validation, so the registry is the last
// wall — it must never mint a code that outlives the contract.
const MAX_PAIRING_TTL_MS = DEFAULT_PAIRING_TTL_MS

// Spec 005 FR1/FR2: a device record carries what it is and what it may do. The
// vocabulary lives in the shared contract package.
const { SCOPES: CONTRACT_SCOPES, DESKTOP_DEFAULT_SCOPES } = contract
// Spec 008: `harness:remote` (tunnel DSH wire calls) is granted only to a
// `desktop` device that was offered it explicitly. It is not part of the
// "every scope" grant of a mobile device or of a pre-005 record migration.
// The full-control scopes (commands:execute, workspace:manage, ...) follow the same
// rule, so the list is the contract's DESKTOP_ONLY_SCOPES, not a local copy.
const EXPLICIT_ONLY_SCOPES = contract.DESKTOP_ONLY_SCOPES
const ALL_SCOPES = Object.freeze(CONTRACT_SCOPES.filter((scope) => !EXPLICIT_ONLY_SCOPES.includes(scope)))

function normalizeKind(value) {
  return contract.DEVICE_KINDS.includes(value) ? value : 'mobile'
}

/**
 * Drop unknown scopes and duplicates, keeping contract order. A list that is
 * present is taken literally: an empty list, and a list of nothing but unknown
 * names, both grant nothing. Only an *absent* list falls back to a default, and
 * only the caller knows which default that is (`defaultScopes`).
 */
function normalizeScopes(values, kind) {
  if (!Array.isArray(values)) return []
  // Spec 008: an explicit-only scope survives only on a desktop; a mobile record
  // that somehow lists it (hand-edited store, odd offer) just loses it.
  return CONTRACT_SCOPES.filter((scope) => values.includes(scope)
    && (!EXPLICIT_ONLY_SCOPES.includes(scope) || kind === 'desktop'))
}

/** The grant an offer makes when it names no scopes at all. */
function defaultScopes(kind) {
  return kind === 'desktop' ? [...DESKTOP_DEFAULT_SCOPES] : [...ALL_SCOPES]
}

function digest(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex')
}

/**
 * Clamp a requested pairing TTL into the contract window `(0, MAX_PAIRING_TTL_MS]`.
 * A missing or unusable value takes the five-minute default; values inside the
 * window are returned unchanged, so existing configurations behave identically.
 * @param {unknown} value requested TTL in milliseconds
 * @returns {number} the TTL the registry will use
 */
function clampPairingTtlMs(value) {
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_PAIRING_TTL_MS)
    : DEFAULT_PAIRING_TTL_MS
}

function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === 32 && b.length === 32 && crypto.timingSafeEqual(a, b)
}

function publicDevice(device, connections) {
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    scopes: [...device.scopes],
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt || null,
    online: connections > 0,
    connections,
  }
}

function normalizeClientDeviceId(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return /^[A-Za-z0-9._:-]{8,128}$/.test(normalized) ? normalized : undefined
}

function createRegistry(file, options = {}) {
  // Contract §2 wall: never above five minutes, whatever the caller asked for.
  const pairingTtlMs = clampPairingTtlMs(options.pairingTtlMs)
  let devices = []
  const pairings = new Map()
  const online = new Map()
  // Re-pairing replaces a device's credential and scopes in place, so a socket
  // opened under the previous grant cannot tell from the record alone that it is
  // stale. Each rotation bumps the device's (memory-only) generation and every
  // connection remembers the one it authenticated with.
  const generations = new Map()

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    secureFileApi().writeSecretFile(tmp, JSON.stringify({ version: STORE_VERSION, devices }, null, 2))
    fs.renameSync(tmp, file)
  }

  const load = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(parsed.devices)) return
      let migrated = false
      devices = parsed.devices.flatMap((row) => {
        if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') return []
        let tokenHash = typeof row.tokenHash === 'string' ? row.tokenHash : undefined
        // Migrate the v1 development format without invalidating an existing
        // device. The plaintext is removed on the next atomic save.
        if (!tokenHash && typeof row.token === 'string' && row.token !== '') {
          tokenHash = digest(row.token)
          migrated = true
        }
        if (!tokenHash || !/^[a-f0-9]{64}$/.test(tokenHash)) return []
        // Spec 005 FR1: ONLY a record written before `kind` and `scopes` existed
        // migrates, to a mobile device with every scope, so an already-paired
        // phone keeps working. Everything else is read literally: a scope list
        // the owner did write stays what it is (empty or unknown-only stays
        // empty), and a malformed record — an unknown `kind`, `scopes` that is
        // not an array — is dropped as unusable instead of being loaded with a
        // full grant. The next save writes the fields; the store version is
        // unchanged because the format is only additive.
        let kind
        let scopes
        if (row.kind === undefined && row.scopes === undefined) {
          kind = 'mobile'
          scopes = [...ALL_SCOPES]
          migrated = true
        } else {
          if (row.kind !== undefined && !contract.DEVICE_KINDS.includes(row.kind)) return []
          if (row.scopes !== undefined && !Array.isArray(row.scopes)) return []
          kind = normalizeKind(row.kind)
          scopes = normalizeScopes(row.scopes, kind)
        }
        return [{
          id: row.id,
          name: row.name.slice(0, 80),
          clientDeviceId: normalizeClientDeviceId(row.clientDeviceId),
          kind,
          scopes,
          tokenHash,
          createdAt: Number.isFinite(row.createdAt) ? row.createdAt : Date.now(),
          lastSeenAt: Number.isFinite(row.lastSeenAt) ? row.lastSeenAt : null,
          revokedAt: Number.isFinite(row.revokedAt) ? row.revokedAt : (row.revoked ? Date.now() : null),
        }]
      })
      if (migrated || parsed.version !== STORE_VERSION) save()
      else secureFileApi().restrictToOwnerSync(file, 'file')    } catch (error) {
      if (error && error.code !== 'ENOENT') throw new Error(`failed to load device registry: ${error.message}`, { cause: error })
    }
  }

  const prunePairings = (now = Date.now()) => {
    for (const [codeHash, pairing] of pairings) {
      if (pairing.expiresAt <= now) pairings.delete(codeHash)
    }
  }

  /** Credential generation of a live device, `undefined` when it is not paired. */
  const liveGeneration = (deviceId) => {
    const device = devices.find((candidate) => candidate.id === deviceId && !candidate.revokedAt)
    return device ? (generations.get(deviceId) || 0) : undefined
  }

  load()

  return {
    list() {
      const active = devices.filter((device) => !device.revokedAt)
      const counts = new Map()
      const indices = new Map()
      for (const device of active) counts.set(device.name, (counts.get(device.name) || 0) + 1)
      return active.map((device) => {
        const index = (indices.get(device.name) || 0) + 1
        indices.set(device.name, index)
        return {
          ...publicDevice(device, online.get(device.id) || 0),
          displayName: counts.get(device.name) > 1 ? `${device.name} (${index})` : device.name,
        }
      })
    },

    count() {
      return devices.filter((device) => !device.revokedAt).length
    },

    createPairing(name, offer = {}) {
      prunePairings()
      const code = crypto.randomBytes(32).toString('base64url')
      const kind = normalizeKind(offer.kind)
      const pairing = {
        id: crypto.randomUUID(),
        name: typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 80) : '未命名设备',
        // Spec 005 FR3: what the redeeming device becomes and may do. An absent
        // list takes the kind's default; an explicit list (even an empty one) is
        // the owner's grant and is kept as given.
        kind,
        scopes: offer.scopes === undefined ? defaultScopes(kind) : normalizeScopes(offer.scopes, kind),
        expiresAt: Date.now() + pairingTtlMs,
        // PairingOffer fields (data-model.md): the endpoint the QR advertises and
        // the certificate fingerprint the client must pin.
        endpoint: typeof offer.endpoint === 'string' && offer.endpoint.trim() !== '' ? offer.endpoint.trim().slice(0, 2048) : null,
        certSha256: typeof offer.certSha256 === 'string' && /^[a-f0-9]{64}$/i.test(offer.certSha256)
          ? offer.certSha256.toLowerCase()
          : null,
        claimedAt: null,
      }
      pairings.set(digest(code), pairing)
      return { ...pairing, code }
    },

    /** The offer behind a live code, without the code itself (admin view). */
    pairingOffer(code) {
      prunePairings()
      if (typeof code !== 'string' || code === '') return undefined
      const pairing = pairings.get(digest(code))
      return pairing ? { ...pairing } : undefined
    },

    hasPairing(code) {
      prunePairings()
      return typeof code === 'string' && pairings.has(digest(code))
    },

    /**
     * Redeem a one-time code for a device token.
     * @param {string} code pairing code
     * @param {string|undefined} clientDeviceId install-scoped device id
     * @param {string|undefined} clientDeviceName display name
     * @param {{ certSha256?: string }} [listener] certificate fingerprint of the
     *   listener that received the claim; when the offer pinned one, a mismatch
     *   refuses the claim and consumes the code (fail closed).
     */
    claimPairing(code, clientDeviceId, clientDeviceName, listener = {}) {
      prunePairings()
      if (typeof code !== 'string' || code === '') return undefined
      const codeHash = digest(code)
      const pairing = pairings.get(codeHash)
      if (!pairing) return undefined
      // Delete before doing any further work: claiming is single-use even if a
      // later socket upgrade fails.
      pairings.delete(codeHash)
      if (pairing.certSha256) {
        const presented = typeof listener?.certSha256 === 'string' ? listener.certSha256.toLowerCase() : ''
        if (presented !== pairing.certSha256) return undefined
      }
      const token = crypto.randomBytes(32).toString('base64url')
      const normalizedClientDeviceId = normalizeClientDeviceId(clientDeviceId)
      let device = normalizedClientDeviceId
        ? devices.find((candidate) => !candidate.revokedAt && candidate.clientDeviceId === normalizedClientDeviceId)
        : undefined
      // `repaired` = this claim replaced the grant of an already-paired device.
      // The caller must drop what the old grant opened before using the new one.
      const repaired = !!device
      if (device) {
        // A valid one-time pairing code authorizes credential rotation. Keep
        // the stable server-side device record while replacing its token, so
        // re-pairing one iOS installation never creates duplicate rows.
        device.name = typeof clientDeviceName === 'string' && clientDeviceName.trim() ? clientDeviceName.trim().slice(0, 80) : '未命名设备'
        device.tokenHash = digest(token)
        device.clientDeviceId = normalizedClientDeviceId
        // The code in hand is the newest grant the owner made: re-pairing is
        // how scopes are widened or narrowed.
        device.kind = pairing.kind
        device.scopes = [...pairing.scopes]
        // The credential and the grant both changed: sockets that authenticated
        // under the previous generation are stale from here on.
        generations.set(device.id, (generations.get(device.id) || 0) + 1)
      } else {
        device = {
          id: pairing.id,
          name: typeof clientDeviceName === 'string' && clientDeviceName.trim() ? clientDeviceName.trim().slice(0, 80) : '未命名设备',
          clientDeviceId: normalizedClientDeviceId,
          kind: pairing.kind,
          scopes: [...pairing.scopes],
          tokenHash: digest(token),
          createdAt: Date.now(),
          lastSeenAt: null,
          revokedAt: null,
        }
        devices.push(device)
        generations.set(device.id, 0)
      }
      save()
      return { device: publicDevice(device, 0), token, generation: liveGeneration(device.id), repaired }
    },

    authenticate(token, clientDeviceId, clientDeviceName) {
      if (typeof token !== 'string' || token === '') return undefined
      const tokenHash = digest(token)
      const device = devices.find((candidate) => !candidate.revokedAt && safeEqualHex(candidate.tokenHash, tokenHash))
      const normalizedClientDeviceId = normalizeClientDeviceId(clientDeviceId)
      if (device && normalizedClientDeviceId && !device.clientDeviceId) {
        // Migration path for devices paired before installation IDs existed:
        // a valid long-lived token proves ownership of this record, so it is
        // safe to bind the client's stable ID without creating a new device.
        const conflict = devices.some((candidate) => candidate !== device && !candidate.revokedAt && candidate.clientDeviceId === normalizedClientDeviceId)
        if (!conflict) {
          device.clientDeviceId = normalizedClientDeviceId
          save()
        }
      }
      if (device && typeof clientDeviceName === 'string' && clientDeviceName.trim()) {
        const name = clientDeviceName.trim().slice(0, 80)
        if (device.name !== name) {
          device.name = name
          save()
        }
      }
      return device ? publicDevice(device, online.get(device.id) || 0) : undefined
    },

    connected(deviceId) {
      const device = devices.find((candidate) => candidate.id === deviceId && !candidate.revokedAt)
      if (!device) return false
      online.set(deviceId, (online.get(deviceId) || 0) + 1)
      device.lastSeenAt = Date.now()
      save()
      return true
    },

    disconnected(deviceId) {
      const count = online.get(deviceId) || 0
      if (count <= 1) online.delete(deviceId)
      else online.set(deviceId, count - 1)
    },

    revoke(deviceId) {
      const index = devices.findIndex((candidate) => candidate.id === deviceId && !candidate.revokedAt)
      if (index < 0) return false
      devices.splice(index, 1)
      online.delete(deviceId)
      generations.delete(deviceId)
      save()
      return true
    },

    /** One record by id (revoked rows are removed, so only live devices answer). */
    get(deviceId) {
      const device = devices.find((candidate) => candidate.id === deviceId && !candidate.revokedAt)
      return device ? publicDevice(device, online.get(device.id) || 0) : undefined
    },

    /**
     * Credential generation of a live device, `undefined` when no such device is
     * paired. A connection stores the value it authenticated with and compares
     * it before serving, so neither a re-pair nor a revocation can be outlived.
     */
    generation(deviceId) {
      return liveGeneration(deviceId)
    },
  }
}

module.exports = { createRegistry, digest, clampPairingTtlMs, MAX_PAIRING_TTL_MS }
