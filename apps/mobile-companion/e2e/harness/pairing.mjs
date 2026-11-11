// Pairing payload helpers for the device-validation fixture gateway.
//
// Contract §2 (`specs/001-gateway-hardening/contracts/mobile-protocol-v1.md`, revision 3):
// the QR / manual text is the **unpadded base64url** of the UTF-8 JSON payload
//
//   { version: 3, publicUrl, pairingCode, expiresAt, certSha256, gatewayId, gatewayName, endpoints[] }
//
// These helpers are deliberately independent of the app source (`src/core/qr.ts`) and of
// `@dsh-ext/mobile-protocol`: a fixture that re-used the parser under test could not catch a
// parser/host disagreement. The rules the app enforces are restated here so the fixture emits
// only payloads a correct client accepts:
//
//   * version is exactly 3;
//   * `publicUrl` and every `endpoints[]` entry are `wss://`, with no query/fragment/credentials;
//   * `pairingCode` is the canonical unpadded base64url of exactly 32 bytes (43 characters);
//   * `expiresAt` is epoch ms at most 5 minutes ahead of the phone clock;
//   * `certSha256` is 64 lowercase hex characters;
//   * `gatewayId` is a lowercase UUID v4.

import crypto from 'node:crypto'

/** Contract §2: pairing payload version. */
export const PAIRING_QR_VERSION = 3

/** Contract §2: `expiresAt` is ≤ 5 min ahead; the fixture stays inside the window. */
export const PAIRING_TTL_MS = 5 * 60 * 1000

/** Leave a margin so a slow scan never trips the 5 min bound on the phone's clock. */
export const DEFAULT_TTL_MS = 4 * 60 * 1000

/** One fresh pairing code: 256 bits as canonical unpadded base64url (43 characters). */
export function newPairingCode () {
  return crypto.randomBytes(32).toString('base64url')
}

/** Lowercase UUID v4 — the spelling the host writes and the app accepts. */
export function newGatewayId () {
  return crypto.randomUUID().toLowerCase()
}

/** Unpadded base64url of a UTF-8 JSON payload (the QR/manual text). */
export function encodePairingPayload (payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Build one pairing offer.
 *
 * @param {object} options
 * @param {string} options.publicUrl         `wss://host:port` the phone dials.
 * @param {string} options.certSha256        64 lowercase hex of the leaf the phone must pin.
 * @param {string} options.gatewayId         Lowercase UUID v4.
 * @param {string} options.gatewayName       Display name shown before pairing (`my-pc`).
 * @param {string[]} [options.endpoints]     Alternates; defaults to `[publicUrl]`.
 * @param {string} [options.pairingCode]     Reuse a code (tests); defaults to a fresh one.
 * @param {number} [options.expiresAt]       Epoch ms; defaults to now + 4 min.
 * @param {number} [options.now]             Injected clock (tests).
 */
export function buildPairingOffer (options) {
  const {
    publicUrl,
    certSha256,
    gatewayId,
    gatewayName,
    endpoints,
    pairingCode = newPairingCode(),
    expiresAt,
    now = Date.now(),
    ttlMs = DEFAULT_TTL_MS,
  } = options

  const payload = {
    version: PAIRING_QR_VERSION,
    publicUrl,
    pairingCode,
    expiresAt: expiresAt ?? now + ttlMs,
    certSha256,
    gatewayId,
    gatewayName,
    endpoints: endpoints ?? [publicUrl],
  }
  return { payload, text: encodePairingPayload(payload), pairingCode, expiresAt: payload.expiresAt }
}

/**
 * A payload the app must reject client-side, with no network I/O at all.
 *
 * Used by the `pair/rejected` checkpoints (expired code, wrong version, non-wss endpoint): the
 * pair screen has to show its own copy before any socket exists, so these need no gateway.
 */
export function buildRejectedOffer (kind, options = {}) {
  const now = options.now ?? Date.now()
  const base = {
    version: PAIRING_QR_VERSION,
    publicUrl: 'wss://127.0.0.1:3443',
    pairingCode: newPairingCode(),
    expiresAt: now + DEFAULT_TTL_MS,
    certSha256: '0'.repeat(64),
    gatewayId: newGatewayId(),
    gatewayName: 'dsh-e2e',
    endpoints: ['wss://127.0.0.1:3443'],
  }
  switch (kind) {
    case 'expired':
      // Past expiry: `qr/expired`.
      return encodePairingPayload({ ...base, expiresAt: now - 1000 })
    case 'too-far':
      // Beyond the 5 min bound: `qr/expired` ("check your phone clock").
      return encodePairingPayload({ ...base, expiresAt: now + PAIRING_TTL_MS + 60_000 })
    case 'bad-version':
      return encodePairingPayload({ ...base, version: 2 })
    case 'not-wss':
      return encodePairingPayload({ ...base, publicUrl: `http://127.0.0.1:3443` })
    case 'bad-cert':
      return encodePairingPayload({ ...base, certSha256: 'abc' })
    case 'bad-code':
      return encodePairingPayload({ ...base, pairingCode: 'short' })
    case 'bad-gateway-id':
      return encodePairingPayload({ ...base, gatewayId: 'not-a-uuid' })
    case 'not-base64url':
      // Raw JSON: the app requires base64url text, so this is `qr/invalid-json`.
      return '{"version":3}'
    default:
      throw new Error(`unknown rejected-offer kind: ${kind}`)
  }
}
