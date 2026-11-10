// Spec 008 P1b — the pairing state machine with manual Host approval.
//
//   OTP offer ──(valid proof)──▶ PENDING request ──(Host approves)──▶ token issued
//        │ 3 wrong proofs / 10 min          │ reject / 5 min / client disconnects
//        ▼                                   ▼
//     burned                             discarded
//
// Pure bookkeeping, no sockets and no token minting: index.mjs owns the socket
// and calls `registry.claimPairing` only on Approve, so a pending request never
// holds a credential, a bridge or an RPC channel.
//
// About "store only a digest": the client's proof is HMAC(key = OTP, ...), so the
// Host must be able to recompute it, which needs the OTP itself — a digest cannot
// key the HMAC. The OTP therefore lives only in this process's memory (never on
// disk, in a log, in a status view or in a pending record), is dropped the moment
// the offer is consumed / burned / expired, and every view exposes the digest
// only. The proof never carries the OTP over the wire.
import crypto from 'node:crypto'

export const OTP_DIGITS = 8
export const OTP_TTL_MS = 10 * 60 * 1000
export const OTP_MAX_FAILURES = 3
export const PENDING_TTL_MS = 5 * 60 * 1000
export const MAX_PENDING = 16
export const MAX_OFFERS = 8

/** 8 uniformly random decimal digits (`randomInt` is unbiased). */
export function generateOtp() {
  return String(crypto.randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0')
}

/**
 * HMAC-SHA256(key = otp, certSha256 || clientNonce || serverNonce) as lowercase
 * hex. Both nonces are fresh per connection, so a proof is useless on another
 * connection, and `certSha256` binds it to the certificate the client pinned.
 */
export function otpProof(otp, certSha256, clientNonce, serverNonce) {
  return crypto.createHmac('sha256', String(otp))
    .update(String(certSha256)).update(String(clientNonce)).update(String(serverNonce))
    .digest('hex')
}

/**
 * The 6-digit code both screens show: SHA-256(certSha256 || clientNonce ||
 * serverNonce || 'dsh-verify') mod 10^6. It is derived from the TLS pin and both
 * nonces, NOT from the OTP: a man in the middle terminating TLS with its own
 * certificate necessarily changes the pin on one leg, so the two sides show
 * different codes and the Host user rejects.
 */
export function verificationCode(certSha256, clientNonce, serverNonce) {
  const digest = crypto.createHash('sha256')
    .update(String(certSha256)).update(String(clientNonce)).update(String(serverNonce)).update('dsh-verify')
    .digest()
  // The full 256-bit value mod 10^6, as the spec words it (BigInt, no truncation bias beyond mod).
  return String(BigInt(`0x${digest.toString('hex')}`) % 1_000_000n).padStart(6, '0')
}

const constantTimeEqualHex = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/**
 * @param {{ now?: () => number, otpTtlMs?: number, pendingTtlMs?: number,
 *   onExpire?: (request: object) => void }} [options]
 */
export function createPairingRequests(options = {}) {
  const now = options.now ?? Date.now
  const otpTtlMs = options.otpTtlMs ?? OTP_TTL_MS
  const pendingTtlMs = options.pendingTtlMs ?? PENDING_TTL_MS
  /** @type {Map<string, object>} offer id -> offer */
  const offers = new Map()
  /** @type {Map<string, object>} request id -> pending request */
  const pending = new Map()

  const forget = (offer) => { offer.otp = ''; offers.delete(offer.id) }
  const pruneOffers = () => {
    for (const offer of [...offers.values()]) if (offer.expiresAt <= now()) forget(offer)
  }
  /** Expired requests are dropped here and reported, so the caller closes their socket. */
  const prunePending = () => {
    const expired = []
    for (const [id, request] of pending) {
      if (request.expiresAt <= now()) { pending.delete(id); expired.push(request) }
    }
    for (const request of expired) options.onExpire?.(request)
    return expired
  }

  const publicRequest = (request) => ({
    id: request.id,
    name: request.name,
    clientIp: request.clientIp,
    kind: request.kind,
    // What the client asked for = what the offer allowed. Approve may only narrow it.
    requestedScopes: [...request.requestedScopes],
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    verificationCode: request.verificationCode,
  })

  return {
    /** A new OTP offer. The plaintext OTP is returned once, to the Host UI. */
    createOffer({ kind, scopes, endpoint }) {
      pruneOffers()
      // Bounded table: the oldest offer makes room instead of the table growing.
      if (offers.size >= MAX_OFFERS) {
        forget([...offers.values()].sort((a, b) => a.createdAt - b.createdAt)[0])
      }
      const otp = generateOtp()
      const offer = {
        id: crypto.randomUUID(),
        otp,
        otpDigest: crypto.createHash('sha256').update(otp).digest('hex'),
        kind,
        scopes: [...scopes],
        endpoint: endpoint ?? null,
        failures: 0,
        createdAt: now(),
        expiresAt: now() + otpTtlMs,
      }
      offers.set(offer.id, offer)
      return { otp, offer: { id: offer.id, kind, scopes: [...offer.scopes], expiresAt: offer.expiresAt, otpDigest: offer.otpDigest } }
    },

    offerCount() { pruneOffers(); return offers.size },

    /**
     * Check a client's proof. The Host does not know which offer the client
     * meant, so the proof is tried against every live offer; all are evaluated
     * (no early exit) so timing does not reveal how many exist.
     */
    verifyProof({ proof, certSha256, clientNonce, serverNonce }) {
      pruneOffers()
      let matched
      for (const offer of offers.values()) {
        const expected = otpProof(offer.otp, certSha256, clientNonce, serverNonce)
        if (constantTimeEqualHex(expected, proof) && matched === undefined) matched = offer
      }
      if (matched) {
        const result = { id: matched.id, kind: matched.kind, scopes: [...matched.scopes], endpoint: matched.endpoint }
        forget(matched) // single use: consumed by the first valid proof
        return { ok: true, offer: result }
      }
      // A wrong proof costs one attempt on every live offer; an offer that
      // reaches the limit is burned (its OTP is dropped from memory).
      const burned = []
      for (const offer of [...offers.values()]) {
        offer.failures += 1
        if (offer.failures >= OTP_MAX_FAILURES) { burned.push(offer.id); forget(offer) }
      }
      return { ok: false, reason: 'bad-proof', burned }
    },

    /** A valid proof opens a pending request; it carries no credential. */
    addPending({ offer, name, clientIp, certSha256, clientNonce, serverNonce, deviceId }) {
      prunePending()
      if (pending.size >= MAX_PENDING) return undefined
      const request = {
        id: crypto.randomUUID(),
        name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : '未命名设备',
        clientIp: String(clientIp ?? ''),
        kind: offer.kind,
        requestedScopes: [...offer.scopes],
        createdAt: now(),
        expiresAt: now() + pendingTtlMs,
        verificationCode: verificationCode(certSha256, clientNonce, serverNonce),
        deviceId,
        certSha256,
      }
      pending.set(request.id, request)
      return request
    },

    list() { prunePending(); return [...pending.values()].map(publicRequest) },
    get(id) { prunePending(); return pending.get(id) },
    /** Remove and return a request (approve, reject, disconnect). */
    take(id) {
      prunePending()
      const request = pending.get(id)
      if (request) pending.delete(id)
      return request
    },
    pendingCount() { prunePending(); return pending.size },
    prune() { return prunePending() },
    clear() { for (const offer of [...offers.values()]) forget(offer); pending.clear() },
  }
}
