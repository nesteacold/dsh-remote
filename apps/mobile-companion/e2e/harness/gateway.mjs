// Device-validation fixture gateway for the DSH Companion app (A040 / A041 / A034).
//
// WHY THIS EXISTS
// The real counterpart is the hardened gateway from spec 001, which only runs inside a DSH Host
// with `remoteControl.enabled` and a live session to approve. That makes the *app* checks
// (unlock gate, pairing UI, approval card states, reconnect banners, revocation wipe) dependent
// on host-side setup that does not exist on this machine yet. This fixture is a contract-shaped
// stand-in: it speaks the same TLS + WSS framing, the same pairing offer (QR v3), the same
// `paired`/`hello`/`client-hello` handshake, the same `sessions`/`history`/`subscribe` projections
// and the same approval receipts as `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md`
// revision 3, so every phone-side checkpoint can be driven deterministically — and re-run.
//
// It is a TEST FIXTURE, not a gateway: no DSH session, no token persistence, no production
// hardening. Passing these flows says the *app* behaves; it does not say the real gateway does
// (that is spec 001's own E2E, `specs/001-gateway-hardening/quickstart.md`).
//
// WHAT IT ADDS OVER `test/support/fake-gateway.ts`
//   * binds and advertises `127.0.0.1` by default; a phone on the LAN is an explicit opt-in
//     (`--bind <hostIP|0.0.0.0> --lan-host <hostIP>`, warned about at startup);
//   * prints the pairing QR text and rotates it on demand (codes are one-time and ≤ 5 min TTL);
//   * a loopback-only control API so a test run can force the scenario (drop sockets, revoke,
//     change an approval hash, refuse the upgrade with 401/403, gate the protocol version);
//   * certificate modes (wrong / expired / not-yet-valid) built for the pin and validity checks;
//   * `GET /state` evidence: what the phone actually sent, so "nothing was sent" is provable.
//
// SECURITY POSTURE (fixture only, still deliberate)
//   * TLS only; the leaf is self-signed and generated per run, never written to disk.
//   * The TLS/WSS listener binds `127.0.0.1` by default: nothing on this machine is reachable from
//     outside unless the operator passes `--bind` / `--lan-host` for a device run.
//   * The control API always binds 127.0.0.1 and requires `x-fixture-token` for every mutation —
//     `--bind` never changes that.
//   * No credential is logged; pairing codes are printed only because the operator has to paste
//     them into the app under test.
//
// USAGE
//   node e2e/harness/gateway.mjs --port 3443 --control-port 3444 --cert-mode ok   # loopback only
//   node e2e/harness/gateway.mjs --cert-mode wrong      # pin-mismatch checkpoint
//   node e2e/harness/gateway.mjs --print-json           # machine-readable startup block
//   node e2e/harness/gateway.mjs --bind 0.0.0.0 --lan-host 192.168.1.20   # LAN device run (opt-in)
//
// See `e2e/README.md` for the flow-by-flow matrix and `docs/device-validation.md` for the
// operator checklist.

import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'

import { WebSocketServer } from 'ws'

import { buildCertificateSet, sha256OfCertificate } from './certs.mjs'
import { exposureWarning, parseFixtureArgs } from './options.mjs'
import { buildPairingOffer, newGatewayId, newPairingCode } from './pairing.mjs'

// ---------------------------------------------------------------------------
// Contract constants (mirrored here on purpose; see pairing.mjs header)
// ---------------------------------------------------------------------------

/** Subprotocol every companion connection negotiates back. */
const PROTOCOL_SUBPROTOCOL = 'dsh-mobile-v1'
/** Subprotocol prefixes for credentials the client cannot put in a header. */
const SUBPROTOCOL_PREFIX = { pair: 'dsh-pair.', auth: 'dsh-auth.', device: 'dsh-device.' }
/** Companion protocol revision this fixture speaks. */
const COMPANION_PROTOCOL_VERSION = 1
/** Oldest client the fixture accepts. */
const MIN_CLIENT_VERSION = 1
/** Capabilities advertised in `hello` (no `push-v1`: remote push is A042). */
const CAPABILITIES = ['sessions-read', 'prompt', 'cancel', 'approval-v1']
/** Contract §3 close codes. */
const CLOSE_CODES = { gatewayDisabled: 4004, reauth: 4003, revoked: 4401, protocolUnsupported: 4426 }
/** Contract §3.8 pairing close codes (deliberately separate from the authenticated ones). */
const PAIRING_CLOSE_CODES = { rejected: 4403, timeout: 4408, expired: 4410 }
/** Contract §3.8 `clientNonce` shape: 16–64 chars of unpadded base64url. */
const PAIRING_NONCE = /^[A-Za-z0-9_-]{16,64}$/
/** Contract §3.8 proof operation name. */
const PAIRING_PROOF_TYPE = 'pairing-proof'
/** Refusals of pre-admission frames allowed before the pairing socket is closed (contract §3.8). */
const PAIRING_MAX_REFUSALS = 3

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Session rows in the **canonical** shape (contract revision 2.1 §5a): `sessionId`, boolean
 * `running`, epoch-ms `updatedAt`, title under `projections.values.title`, `archived` for the
 * archive tab. This is what the app's `SessionsStore` projects (A046), so the flow proves the
 * canonical mapping rather than the legacy `id`/`state` fallback.
 */
// Spec 011 (mobile session authoring) — served by the `workspaces` and `models` frames. The Host is
// the source of these shapes (the gateway proxies `workspace/list` and `llm/models` verbatim), so the
// fixture mirrors the fields the app's picker/model row read: `workspaceId` + name/path, and
// model id/label/provider.
const AUTHORING_WORKSPACES = [
  { workspaceId: 'ws-disktree', name: 'DiskTree', path: '/home/me/DiskTree' },
  { workspaceId: 'ws-dxvk', name: 'DXVK_Project', path: '/home/me/DXVK_Project' },
]

const AUTHORING_MODELS = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash', provider: 'deepseek' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro', provider: 'deepseek' },
]

/**
 * Spec 011: the scopes a modern gateway reports in `hello.device.scopes`. The authoring flows need
 * `sessions:author` present (happy path) or absent (the honest "not granted" branch), so the value is
 * a scenario toggle rather than a constant.
 */
const AUTHORING_SCOPES = ['sessions:read', 'sessions:author', 'prompt:send', 'approval:respond']

/** Title of a session created through `session-create` (fixture data, not app copy). */
const CREATED_SESSION_TITLE = 'Created from phone'

const BASE_SESSIONS = [
  { sessionId: 'sess-alpha', running: true, updatedAtOffsetMs: -60_000, title: 'Refactor gateway TLS', archived: false },
  { sessionId: 'sess-beta', running: false, updatedAtOffsetMs: -5 * 60_000, title: 'Release notes draft', archived: false },
  { sessionId: 'sess-gamma', running: false, updatedAtOffsetMs: -3 * 24 * 60 * 60_000, title: 'Old spike', archived: true },
]

/** Approval fixtures. `argsHash: null` is the "decide on your computer" card (FR-006). */
const BASE_APPROVALS = [
  {
    approvalId: 'apv-hash',
    rpcId: 'rpc-hash',
    sessionId: 'sess-alpha',
    toolName: 'shell.exec',
    argsHash: sha256Fixture('{"command":"npm test"}'),
    argsPreview: 'npm test',
    displayReason: { en: 'Run the test suite', vi: 'Chạy bộ kiểm thử' },
  },
  {
    approvalId: 'apv-null',
    rpcId: 'rpc-null',
    sessionId: 'sess-beta',
    toolName: 'fs.write',
    argsHash: null,
    argsPreview: 'notes/release.md',
    displayReason: { en: 'Write the release notes', vi: 'Ghi chú bản phát hành' },
  },
]

/** Deterministic 64-hex "hash" for fixtures (the app only round-trips the value). */
function sha256Fixture (text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

// ---------------------------------------------------------------------------
// Options
//
// Defaults are loopback-only and live in `options.mjs` so they can be tested without a listener.
// ---------------------------------------------------------------------------

/** First non-internal IPv4 of this machine (only used when the operator passes `--lan-host auto`). */
function detectLanHost () {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return '127.0.0.1'
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

class FixtureGateway {
  constructor (options, certificateSet) {
    this.options = options
    this.certificateSet = certificateSet
    this.gatewayId = newGatewayId()
    this.controlToken = crypto.randomBytes(16).toString('base64url')

    /** Pending approvals (contract §5). Mutated by the control API for the mismatch scenario. */
    this.approvals = structuredClone(BASE_APPROVALS)
    /** Live connections: { socket, token, deviceId, subscribed, ready }. */
    this.connections = new Set()
    /** Accepted bearer/device tokens. */
    this.tokens = new Set()
    /** Outstanding, unused pairing codes. */
    this.pairingCodes = new Set()
    /**
     * Spec 011: sessions created through `session-create`, in creation order. They are served by
     * every later `sessions`/`search` answer so the app's refresh really sees the new row.
     */
    this.createdSessions = []
    /** Evidence: everything the phone did. */
    this.evidence = {
      tcpConnections: 0,
      tlsHandshakesCompleted: 0,
      tlsFailures: 0,
      upgradeAttempts: 0,
      upgradeRefusals: [],
      offeredPairingCodes: [],
      consumedPairingCodes: [],
      deviceIds: [],
      clientHellos: [],
      frames: [],
      approvalReceipts: [],
      prompts: [],
      cancels: [],
      protocolViolations: [],
      /** Contract §3.8: challenges sent, proofs accepted, pre-admission refusals. */
      pairingChallenges: 0,
      pairingProofs: [],
      pairingRefusals: 0,
      pairingApprovals: 0,
      pairingRejections: [],
      pendingPairings: [],
      /**
       * Spec 011 authoring evidence. `authoringRequests` records every authoring op the phone sent
       * (`workspaces` / `models` / `session-create`), so "no authoring frame was sent" is provable
       * rather than inferred from a screenshot; `sessionCreates` keeps the requested workspace ids.
       */
      authoringRequests: [],
      sessionCreates: [],
      openConnections: 0,
      peakOpenConnections: 0,
    }
    /** Scenario toggles driven by the control API. */
    this.scenario = {
      /**
       * Contract §3.8: when true a pairing stays `pairing-pending` until the control API
       * approves it — the real two-party flow on a device. Default false (auto-approve) so the
       * existing automated flows keep their shape.
       */
      requirePairingApproval: false,
      /** `otpRequired` advertised in the pairing challenge (the app has no OTP flow yet). */
      pairingOtpRequired: false,
      /** When set, every upgrade is refused with this HTTP status (401/403 ...). */
      upgradeStatus: null,
      /** When true, `hello` is never sent (a host that never starts the handshake; M9). */
      suppressHello: false,
      /** Approval ids whose *next* decision must be refused with hash-mismatch (US3 §2, M10). */
      mismatchOnce: new Set(),
      /**
       * When true, the next authenticated request kills the credential and closes every socket
       * with 4401 (contract §3 revoked). Deterministic replacement for "revoke while connected":
       * the app always issues `sessions` right after `client-hello`, so the revoke lands on a
       * live, authenticated connection without any timing assumption.
       */
      revokeOnNextRequest: false,
      /** Companion protocol the fixture requires (version-gate tests). */
      companionProtocol: COMPANION_PROTOCOL_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
      /** Seconds to delay every request answer (timeout tests). */
      requestDelayMs: 0,
      /**
       * Spec 011: `hello.device.scopes`. `null` omits the field entirely (an older gateway that
       * reports no scopes — the app must read that as UNKNOWN, never as "denied"); an array without
       * `sessions:author` is the honest "this phone was not granted authoring" case.
       */
      deviceScopes: [...AUTHORING_SCOPES],
      /** When true, `session-create` is refused with an error frame (the visible-failure branch). */
      sessionCreateRefused: false,
      /** Code used for that refusal; a non-authoring code is what the app reports as "create failed". */
      sessionCreateErrorCode: 'internal',
    }
  }

  // -- lifecycle ------------------------------------------------------------

  async start () {
    const publicHost = this.options.lanHost === 'auto' ? detectLanHost() : this.options.lanHost
    this.publicHost = publicHost
    this.publicPort = await this.listen()
    this.endpoint = `wss://${formatHost(publicHost)}:${this.publicPort}`

    // One-time / rotating pairing offer.
    if (this.options.fixedPairingCode !== null) {
      const code = this.options.fixedPairingCode
      this.pairingCodes.add(code)
      this.offer = buildPairingOffer({
        publicUrl: this.endpoint,
        certSha256: this.certificateSet.advertisedSha256,
        gatewayId: this.gatewayId,
        gatewayName: this.options.name,
        pairingCode: code,
        ttlMs: this.options.ttlMs,
      })
    } else {
      this.rotatePairingCode()
    }

    await this.startControlServer()
    return this
  }

  /** Listen on the TLS port; `--port 0` asks the OS for an ephemeral port. */
  listen () {
    return new Promise((resolve, reject) => {
      const { cert, key } = this.certificateSet.served
      this.server = https.createServer({ cert, key, requestCert: false, rejectUnauthorized: false })

      // Evidence: sockets that never finish the handshake. A client that refuses the pinned leaf
      // aborts before the HTTP upgrade, so `tlsFailures > 0` and `tlsHandshakesCompleted == 0`
      // (for one attempt) is the "the phone rejected the certificate" signal.
      this.server.on('connection', () => {
        this.evidence.tcpConnections += 1
      })
      this.server.on('secureConnection', () => {
        this.evidence.tlsHandshakesCompleted += 1
      })
      this.server.on('tlsClientError', () => {
        this.evidence.tlsFailures += 1
      })
      this.server.on('clientError', () => {
        this.evidence.tlsFailures += 1
      })

      // Explain the beta signal explicitly: no upgrade request ever arrives for a pinned abort.
      this.rawSockets = new Set()
      this.server.on('connection', (socket) => {
        this.rawSockets.add(socket)
        socket.on('close', () => this.rawSockets.delete(socket))
        socket.on('error', () => {})
      })

      this.wss = new WebSocketServer({
        noServer: true,
        // Contract §3: the server only ever negotiates back `dsh-mobile-v1`.
        handleProtocols: (protocols) => (protocols.has(PROTOCOL_SUBPROTOCOL) ? PROTOCOL_SUBPROTOCOL : false),
      })
      this.wss.on('connection', (socket, request) => this.onConnection(socket, request))

      // Upgrade handling is ours (not `ws`'s implicit one) so refusals are counted and answered
      // with an explicit status instead of a bare socket close.
      this.server.on('upgrade', (request, socket, head) => {
        this.evidence.upgradeAttempts += 1
        const refusal = this.upgradeRefusal(request)
        if (refusal !== null) {
          this.evidence.upgradeRefusals.push({ url: request.url ?? '', status: refusal.status, reason: refusal.reason })
          writeHttpResponse(socket, refusal.status, refusal.status === 403 ? 'Forbidden' : 'Unauthorized')
          return
        }
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request)
        })
      })

      this.server.on('error', reject)
      this.server.listen(this.options.port, this.options.bind, () => {
        const address = this.server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : this.options.port)
      })
    })
  }

  rotatePairingCode () {
    const code = newPairingCode()
    this.pairingCodes.add(code)
    this.offer = buildPairingOffer({
      publicUrl: this.endpoint ?? null,
      certSha256: this.certificateSet.advertisedSha256,
      gatewayId: this.gatewayId,
      gatewayName: this.options.name,
      pairingCode: code,
      ttlMs: this.options.ttlMs,
    })
    return this.offer
  }

  async startControlServer () {
    return new Promise((resolve, reject) => {
      this.control = http.createServer((request, response) => this.onControlRequest(request, response))
      this.control.on('error', reject)
      this.control.listen(this.options.controlPort, '127.0.0.1', () => {
        const address = this.control.address()
        this.controlPort = typeof address === 'object' && address !== null ? address.port : this.options.controlPort
        resolve()
      })
    })
  }

  /**
   * Decide the fate of an upgrade (contract §3, §6).
   *
   * Order matters: a scenario override first (401/403 runs), then a query-string credential
   * (rejected by the contract, still an upgrade), then bearer auth, then pairing.
   */
  upgradeRefusal (request) {
    if (this.scenario.upgradeStatus !== null) {
      return { status: this.scenario.upgradeStatus, reason: 'scenario' }
    }
    const url = request.url ?? ''
    if (/[?&](token|pairingCode|pairing_code)=/.test(url)) return { status: 401, reason: 'credential-in-query' }
    if (this.authFrom(request) !== null) return null
    const pairing = this.pairingFrom(request)
    if (pairing !== null && this.pairingCodes.has(pairing.code)) return null
    return { status: 401, reason: pairing === null ? 'no-credential' : 'pairing/expired' }
  }

  authFrom (request) {
    const protocols = protocolsOf(request)
    const header = request.headers.authorization
    const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null
    if (match !== null) {
      const token = match[1]
      return this.tokens.has(token) ? { token, deviceId: headerValue(request, 'x-dsh-device-id') } : null
    }
    for (const protocol of protocols) {
      if (protocol.startsWith(SUBPROTOCOL_PREFIX.auth)) {
        const token = protocol.slice(SUBPROTOCOL_PREFIX.auth.length)
        if (this.tokens.has(token)) return { token, deviceId: deviceProtocolOf(protocols) }
      }
    }
    return null
  }

  pairingFrom (request) {
    const protocols = protocolsOf(request)
    const code = protocols
      .filter((protocol) => protocol.startsWith(SUBPROTOCOL_PREFIX.pair))
      .map((protocol) => protocol.slice(SUBPROTOCOL_PREFIX.pair.length))[0]
    if (code === undefined) return null
    return { code, deviceId: headerValue(request, 'x-dsh-device-id') ?? deviceProtocolOf(protocols) }
  }

  // -- connection -----------------------------------------------------------

  onConnection (socket, request) {
    const auth = this.authFrom(request)
    const pairing = auth === null ? this.pairingFrom(request) : null
    const deviceId = auth?.deviceId ?? pairing?.deviceId ?? `srv-${this.connections.size + 1}`

    const connection = {
      socket,
      token: auth?.token ?? null,
      deviceId,
      device: { id: deviceId, name: 'E2E phone', createdAt: Date.now(), kind: 'mobile' },
      subscribed: null,
      ready: false,
      frames: 0,
      pairing: null,
    }
    this.connections.add(connection)
    this.evidence.openConnections = this.connections.size
    this.evidence.peakOpenConnections = Math.max(this.evidence.peakOpenConnections, this.connections.size)
    if (deviceId !== null) this.evidence.deviceIds.push(deviceId)
    if (pairing !== null) this.evidence.offeredPairingCodes.push(pairing.code)

    if (pairing !== null) {
      // Contract §3.8: the challenge goes out unconditionally on accept, and the socket is NOT a
      // MobileConnection until a valid proof admits it. The one-time code is reserved here and
      // consumed by the proof, not by the upgrade.
      connection.pairing = { code: pairing.code, refusals: 0, admitted: false, pending: null, approved: false, proofNonce: null }
      this.evidence.pairingChallenges += 1
      socket.send(JSON.stringify({
        kind: 'pairing-challenge',
        serverNonce: crypto.randomBytes(24).toString('base64url'),
        certSha256: this.certificateSet.servedSha256 ?? this.certificateSet.advertisedSha256,
        otpRequired: this.scenario.pairingOtpRequired === true,
      }))
    } else {
      if (!this.scenario.suppressHello) socket.send(JSON.stringify(this.helloFrame(connection)))
    }

    socket.on('message', (data) => {
      const text = data.toString()
      connection.frames += 1
      this.evidence.frames.push(text)
      try {
        this.handleFrame(connection, text)
      } catch (error) {
        this.evidence.protocolViolations.push(`handler error: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    socket.on('close', (code, reason) => {
      // DIAGNOSTIC (temporary, device E2E): one line per socket so a device run explains
      // itself without a debug build. Names/booleans only — never a token or a code.
      console.error('[fixture-conn]', JSON.stringify({
        event: 'conn-close',
        authenticated: connection.token !== null,
        pairing: pairing !== null,
        deviceId: connection.device.id,
        deviceHeader: headerValue(request, 'x-dsh-device-id') ?? null,
        offeredProtocolCount: protocolsOf(request).length,
        frames: connection.frames,
        code,
        reason: String(reason ?? ''),
      }))
      this.connections.delete(connection)
      this.evidence.openConnections = this.connections.size
    })
    socket.on('error', () => {})
  }

  // -- pairing proof exchange (contract §3.8) --------------------------------

  /**
   * Everything a pairing socket may (not) send before admission. A proof with a well-formed
   * `clientNonce` reserves the one-time code and raises one pending request; any other frame is
   * refused with `op/forbidden` and the third refusal closes 4403.
   */
  handlePreAdmissionFrame (connection, frame, text) {
    const pairing = connection.pairing
    if (pairing === null) return
    const socket = connection.socket
    const type = typeof frame.type === 'string' ? frame.type : null

    if (type === PAIRING_PROOF_TYPE) {
      const nonce = frame.clientNonce
      if (typeof nonce !== 'string' || !PAIRING_NONCE.test(nonce)) {
        socket.close(PAIRING_CLOSE_CODES.rejected, 'pairing/bad-nonce')
        return
      }
      if (this.scenario.pairingOtpRequired === true) {
        // Contract §3.8: with `otpRequired` the proof MUST carry `otpProof`. The fixture only
        // requires the field (it does not verify an HMAC): the app has no OTP flow yet.
        if (typeof frame.otpProof !== 'string' || frame.otpProof === '') {
          socket.close(PAIRING_CLOSE_CODES.expired, 'pairing/expired')
          return
        }
      }
      this.admitPairing(connection, nonce)
      return
    }

    pairing.refusals += 1
    this.evidence.pairingRefusals += 1
    const requestType = typeof frame.type === 'string'
      ? frame.type
      : (typeof frame.kind === 'string' ? frame.kind : null)
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({
        kind: 'error',
        code: 'op/forbidden',
        ...(requestType === null ? {} : { requestType }),
        message: 'only the pairing proof is accepted before the Host approves',
        ...(typeof frame.requestId === 'string' ? { requestId: frame.requestId } : {}),
      }))
    }
    if (pairing.refusals >= PAIRING_MAX_REFUSALS) socket.close(PAIRING_CLOSE_CODES.rejected, 'pairing/refused')
    this.evidence.protocolViolations.push(`pre-admission frame refused: ${String(requestType ?? 'unknown')} (${text.slice(0, 120)})`)
  }

  /** A valid proof: consume the code, raise the pending request, then approve or wait. */
  admitPairing (connection, clientNonce) {
    const pairing = connection.pairing
    if (pairing === null || pairing.pending !== null) return
    this.pairingCodes.delete(pairing.code)
    this.evidence.consumedPairingCodes.push(pairing.code)
    this.evidence.pairingProofs.push(clientNonce)
    pairing.proofNonce = clientNonce
    pairing.admitted = true

    const verificationCode = `${String(Math.floor(100 + Math.random() * 900))} ${String(Math.floor(100 + Math.random() * 900))}`
    const requestId = `pair-req-${crypto.randomBytes(4).toString('hex')}`
    const expiresAt = Date.now() + 5 * 60 * 1000
    pairing.pending = { verificationCode, requestId, expiresAt }
    this.evidence.pendingPairings.push({ code: pairing.code, verificationCode, requestId, expiresAt })
    if (connection.socket.readyState === 1) {
      connection.socket.send(JSON.stringify({ kind: 'pairing-pending', verificationCode, requestId, expiresAt }))
    }
    console.error('[fixture-pairing]', JSON.stringify({
      event: 'pairing-pending',
      verificationCode,
      requestId,
      expiresAt,
      autoApprove: this.scenario.requirePairingApproval !== true,
    }))
    if (this.scenario.requirePairingApproval !== true) this.approvePairing(connection)
  }

  /** Approve a pending pairing: mint the token, send `paired` then `hello` (desktop Approve). */
  approvePairing (target) {
    const candidates = target === undefined ? this.pendingConnections() : [target]
    let approved = 0
    for (const connection of candidates) {
      const pairing = connection.pairing
      if (pairing === null || pairing.pending === null || pairing.approved) continue
      pairing.approved = true
      const token = `tok-${crypto.randomBytes(12).toString('hex')}`
      this.tokens.add(token)
      connection.token = token
      this.removePendingPairing(pairing.code)
      this.evidence.pairingApprovals += 1
      approved += 1
      if (connection.socket.readyState !== 1) continue
      connection.socket.send(JSON.stringify({ kind: 'paired', token, device: connection.device }))
      if (!this.scenario.suppressHello) connection.socket.send(JSON.stringify(this.helloFrame(connection)))
    }
    return approved
  }

  /** Reject pending pairing(s): `pairing-rejected` then close 4403 (desktop Reject). */
  rejectPairing (reason = 'pairing/refused') {
    const candidates = this.pendingConnections()
    for (const connection of candidates) {
      this.removePendingPairing(connection.pairing.code)
      this.evidence.pairingRejections.push({ reason, close: PAIRING_CLOSE_CODES.rejected })
      connection.socket.send(JSON.stringify({ kind: 'pairing-rejected', reason }))
      connection.socket.close(PAIRING_CLOSE_CODES.rejected, reason)
    }
    return candidates.length
  }

  /** Expire pending pairing(s): `pairing-rejected` then close 4410 (window ran out, §3.8). */
  expirePairing (reason = 'pairing/expired') {
    const candidates = this.pendingConnections()
    for (const connection of candidates) {
      this.removePendingPairing(connection.pairing.code)
      this.evidence.pairingRejections.push({ reason, close: PAIRING_CLOSE_CODES.expired })
      connection.socket.send(JSON.stringify({ kind: 'pairing-rejected', reason }))
      connection.socket.close(PAIRING_CLOSE_CODES.expired, reason)
    }
    return candidates.length
  }

  pendingConnections () {
    return [...this.connections].filter((c) => c.pairing !== null && c.pairing.pending !== null && !c.pairing.approved)
  }

  removePendingPairing (code) {
    const index = this.evidence.pendingPairings.findIndex((entry) => entry.code === code)
    if (index >= 0) this.evidence.pendingPairings.splice(index, 1)
  }

  helloFrame (connection) {
    return {
      kind: 'hello',
      protocol: 3,
      companionProtocol: this.scenario.companionProtocol,
      minClientVersion: this.scenario.minClientVersion,
      capabilities: [...CAPABILITIES],
      authenticated: connection.token !== null,
      device: {
        id: connection.device.id,
        name: connection.device.name,
        // Spec 011: `hello.device` carries the granted `scopes`. A `null` scenario value omits the
        // field entirely, which models an older gateway that reports no scopes (the app must read
        // that as UNKNOWN, not "denied"); an array is what this device was really granted.
        ...(this.scenario.deviceScopes === null || this.scenario.deviceScopes === undefined
          ? {}
          : { kind: 'mobile', scopes: this.scenario.deviceScopes }),
      },
      gatewayId: this.gatewayId,
      dshVersion: '0.2.2-rc.1',
      // The *advertised* hash, so a `wrong`-mode run also shows the mismatch in the hello the
      // app receives (it never trusts this field; the pin is the QR's).
      certSha256: this.certificateSet.advertisedSha256,
    }
  }

  handleFrame (connection, text) {
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      this.evidence.protocolViolations.push('non-json frame')
      return
    }
    const type = frame?.type
    const requestId = frame?.requestId
    // Contract §3.8: before admission the only acceptable frame is the proof, which carries no
    // `requestId` — so the pairing gate runs before the request-shape check.
    if (connection.pairing !== null && !connection.pairing.admitted) {
      this.handlePreAdmissionFrame(connection, frame ?? {}, text)
      return
    }
    if (typeof type !== 'string' || typeof requestId !== 'string') {
      this.evidence.protocolViolations.push(text.slice(0, 200))
      return
    }
    const send = (body) => {
      const outgoing = JSON.stringify({ requestId, ...body })
      const deliver = () => {
        if (connection.socket.readyState === 1) connection.socket.send(outgoing)
      }
      if (this.scenario.requestDelayMs > 0) setTimeout(deliver, this.scenario.requestDelayMs)
      else deliver()
    }
    const fail = (code, message = code, extra = {}) =>
      send({ kind: 'error', code, requestType: type, message, ...extra })

    if (type === 'client-hello') {
      const companionProtocol = typeof frame.companionProtocol === 'number' ? frame.companionProtocol : -1
      this.evidence.clientHellos.push({
        requestId,
        companionProtocol,
        appVersion: typeof frame.appVersion === 'string' ? frame.appVersion : '',
        platform: typeof frame.platform === 'string' ? frame.platform : '',
      })
      if (companionProtocol !== this.scenario.companionProtocol) {
        fail('protocol/unsupported', 'companion protocol mismatch', { minClientVersion: this.scenario.minClientVersion })
        connection.socket.close(CLOSE_CODES.protocolUnsupported, 'protocol/unsupported')
        return
      }
      connection.ready = true
      send({ kind: 'client-hello', accepted: true })
      return
    }
    if (type === 'ping') {
      send({ kind: 'pong', at: Date.now() })
      return
    }
    if (connection.token === null) return fail('auth/required')
    if (!this.tokens.has(connection.token)) return fail('auth/revoked')

    // Armed revocation: the credential dies and every socket closes 4401 before this request is
    // answered, which is what the app must treat as "this device was removed from the computer".
    if (this.scenario.revokeOnNextRequest) {
      this.scenario.revokeOnNextRequest = false
      this.tokens.clear()
      for (const live of this.connections) live.socket.close(CLOSE_CODES.revoked, 'revoked')
      return fail('auth/revoked')
    }

    switch (type) {
      case 'sessions':
        return send({ kind: 'sessions', items: this.sessionRows() })

      // Spec 011 (mobile session authoring) — the two read frames the workspace picker and the
      // composer's model row consume. The real gateway proxies them from the Host verbatim.
      case 'workspaces':
        this.evidence.authoringRequests.push({ type: 'workspaces', workspaceId: null })
        return send({ kind: 'workspaces', items: AUTHORING_WORKSPACES })

      case 'models':
        this.evidence.authoringRequests.push({ type: 'models', workspaceId: null })
        return send({ kind: 'models', current: AUTHORING_MODELS[0], items: AUTHORING_MODELS })

      // Spec 011 authoring write: create a session in the requested workspace. Kept deterministic
      // (`sess-created-<n>`) so a flow can assert the row/hook without an opaque matcher, and
      // served by every later list answer so the app's own refresh really sees it.
      case 'session-create': {
        const workspaceId = typeof frame.workspaceId === 'string' ? frame.workspaceId : ''
        this.evidence.authoringRequests.push({ type: 'session-create', workspaceId })
        if (workspaceId === '') return fail('bad-request', 'workspaceId required')
        if (!AUTHORING_WORKSPACES.some((workspace) => workspace.workspaceId === workspaceId)) {
          return fail('bad-request', 'workspaceId is not a workspace of this host')
        }
        if (this.scenario.sessionCreateRefused) {
          // The honest failure the app must SHOW: a gateway refusal is not a silent no-op.
          return fail(this.scenario.sessionCreateErrorCode ?? 'internal', 'session-create refused by the fixture')
        }
        const sessionId = `sess-created-${this.createdSessions.length + 1}`
        this.createdSessions.push({ sessionId, title: CREATED_SESSION_TITLE, createdAt: Date.now() })
        this.evidence.sessionCreates.push({ workspaceId, sessionId })
        return send({ kind: 'session-created', sessionId })
      }

      case 'search': {
        const query = typeof frame.query === 'string' ? frame.query.toLowerCase() : ''
        const rows = this.sessionRows().filter((row) =>
          row.projections.values.title.toLowerCase().includes(query) || row.sessionId.toLowerCase().includes(query))
        return send({ kind: 'search', items: rows })
      }

      case 'history': {
        const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
        return send({
          kind: 'history',
          sessionId,
          hasMore: false,
          items: [
            { seq: 1, id: `${sessionId}-m1`, role: 'user', text: 'Please refactor the TLS listener', createdAt: Date.now() - 120_000 },
            { seq: 2, id: `${sessionId}-m2`, role: 'assistant', text: 'Working on it.', createdAt: Date.now() - 60_000 },
          ],
        })
      }

      case 'subscribe': {
        const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
        if (sessionId === '') return fail('bad-request', 'sessionId required')
        connection.subscribed = sessionId
        send({ kind: 'subscribed', sessionId })
        // Contract §4: replay the session's pending approvals (fresh server view, `replay: true`).
        for (const approval of this.approvalsFor(sessionId)) {
          this.sendApprovalRequested(connection, approval, { replay: true })
        }
        return
      }

      case 'unsubscribe':
        connection.subscribed = null
        return send({ kind: 'unsubscribed' })

      case 'message': {
        const clientMsgId = typeof frame.clientMsgId === 'string' ? frame.clientMsgId : null
        const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
        if (clientMsgId === null) return fail('bad-request', 'clientMsgId required')
        if (sessionId === '') return fail('bad-request', 'sessionId required')
        if (!this.evidence.prompts.some((item) => item.clientMsgId === clientMsgId)) {
          this.evidence.prompts.push({ clientMsgId, sessionId, text: String(frame.text ?? ''), at: Date.now() })
        }
        return send({ kind: 'sent', sessionId, clientMsgId })
      }

      case 'session-cancel': {
        const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
        this.evidence.cancels.push({ sessionId, at: Date.now() })
        return send({ kind: 'session-cancelled', accepted: true })
      }

      case 'approval-response':
        return this.onApprovalResponse(connection, frame, send, fail)

      case 'device-info':
        return send({
          kind: 'device-info',
          id: connection.device.id,
          name: connection.device.name,
          createdAt: connection.device.createdAt,
          kind: 'mobile',
          scopes: ['sessions:read', 'prompt:send', 'approval:respond'],
        })

      case 'device-forget':
        if (connection.token !== null) this.tokens.delete(connection.token)
        send({ kind: 'device-forgotten' })
        connection.socket.close(CLOSE_CODES.revoked, 'revoked')
        return

      case 'push-register':
        return fail('op/forbidden', 'push-v1 not advertised (A042)')

      case 'push-remove':
        return send({ kind: 'push-removed' })

      default:
        return fail('op/forbidden')
    }
  }

  /** Contract §5: accepted once with the exact hash; mismatch keeps the approval pending. */
  onApprovalResponse (connection, frame, send, fail) {
    const approvalId = typeof frame.approvalId === 'string' ? frame.approvalId : ''
    const outcome = frame.outcome
    const approval = this.approvals.find((entry) => entry.approvalId === approvalId)

    const record = (accepted, reason) => {
      this.evidence.approvalReceipts.push({
        approvalId,
        rpcId: typeof frame.rpcId === 'string' ? frame.rpcId : '',
        sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : '',
        // The exact value the phone echoed — the whole point of the check.
        argsHash: frame.argsHash,
        expectedArgsHash: approval?.argsHash ?? null,
        outcome,
        accepted,
        ...(reason === undefined ? {} : { reason }),
        at: Date.now(),
      })
    }
    const receipt = (accepted, reason) => ({
      kind: 'approval-response',
      rpcId: frame.rpcId,
      sessionId: frame.sessionId,
      approvalId,
      outcome,
      accepted,
      ...(reason === undefined ? {} : { reason }),
    })

    if (outcome !== 'allowed-once' && outcome !== 'rejected') return fail('bad-request', 'outcome')
    if (approval === undefined) {
      record(false, 'not-pending')
      return send(receipt(false, 'not-pending'))
    }
    if (approval.argsHash === null) {
      // Null-hash cards must never be decidable; a client that tries gets `not-pending`.
      record(false, 'not-pending')
      return send(receipt(false, 'not-pending'))
    }
    // US3 §2: the host's view changed between render and decision. Rotating the stored hash and
    // refusing once reproduces "the arguments changed server-side" deterministically; the app
    // must land in `review-again` and only reopen after a fresh `subscribe` (M10).
    if (this.scenario.mismatchOnce.has(approvalId)) {
      this.scenario.mismatchOnce.delete(approvalId)
      approval.argsHash = sha256Fixture(`changed:${Date.now()}`)
      record(false, 'hash-mismatch')
      return send(receipt(false, 'hash-mismatch'))
    }
    if (frame.argsHash !== approval.argsHash) {
      record(false, 'hash-mismatch')
      return send(receipt(false, 'hash-mismatch'))
    }
    record(true)
    this.approvals = this.approvals.filter((entry) => entry.approvalId !== approvalId)
    this.broadcast({ kind: 'approval-resolved', rpcId: approval.rpcId, sessionId: approval.sessionId, approvalId, outcome })
    return send(receipt(true))
  }

  sendApprovalRequested (connection, approval, extra = {}) {
    if (connection.socket.readyState !== 1) return
    connection.socket.send(JSON.stringify({
      kind: 'approval-requested',
      rpcId: approval.rpcId,
      sessionId: approval.sessionId,
      approvalId: approval.approvalId,
      toolName: approval.toolName,
      argsHash: approval.argsHash,
      argsPreview: approval.argsPreview,
      ...(approval.displayReason === undefined ? {} : { displayReason: approval.displayReason }),
      ...(approval.callId === undefined ? {} : { callId: approval.callId }),
      ...(extra.replay === undefined ? {} : { replay: extra.replay }),
    }))
  }

  broadcast (frame) {
    const text = JSON.stringify(frame)
    for (const connection of this.connections) {
      if (connection.socket.readyState === 1) connection.socket.send(text)
    }
  }

  // -- fixtures -------------------------------------------------------------

  sessionRows () {
    const now = Date.now()
    return [
      ...BASE_SESSIONS.map((session) => ({
        sessionId: session.sessionId,
        updatedAt: now + session.updatedAtOffsetMs,
        running: session.running,
        ...(session.archived ? { archived: true } : {}),
        projections: { values: { title: session.title } },
      })),
      // Created sessions are recent on purpose: the app windows its list to 30 days.
      ...this.createdSessions.map((session) => ({
        sessionId: session.sessionId,
        updatedAt: session.createdAt,
        running: false,
        projections: { values: { title: session.title } },
      })),
    ]
  }

  approvalsFor (sessionId) {
    return this.approvals.filter((approval) => approval.sessionId === sessionId)
  }

  // -- control API ----------------------------------------------------------

  onControlRequest (request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const json = (status, body) => {
      const payload = JSON.stringify(body, null, 2)
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(payload)
    }

    if (request.method === 'GET' && url.pathname === '/state') {
      return json(200, this.state())
    }

    // Every mutation needs the per-run token: another local process must not be able to drive
    // the fixture someone else's test run is using.
    if (headerValue(request, 'x-fixture-token') !== this.controlToken) {
      return json(403, { error: 'missing or wrong x-fixture-token' })
    }

    const readBody = () => new Promise((resolve, reject) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        if (body.trim() === '') return resolve({})
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
      request.on('error', reject)
    })

    const run = async () => {
      const body = await readBody()
      switch (`${request.method} ${url.pathname}`) {
        // Rotate the one-time pairing code (codes are consumed at first use and expire in ≤ 5 min).
        case 'POST /pairing/new': {
          const offer = this.rotatePairingCode()
          return json(200, { qr: offer.text, pairingCode: offer.pairingCode, expiresAt: offer.expiresAt, endpoint: this.endpoint })
        }
        // Hold a pairing in `pairing-pending` until approve/reject/expire (contract §3.8), so a
        // device run can exercise the real two-party approval flow.
        case 'POST /scenario/pairing/require-approval': {
          this.scenario.requirePairingApproval = body.enabled !== false
          return json(200, { requirePairingApproval: this.scenario.requirePairingApproval })
        }
        // Advertise `otpRequired` in the pairing challenge. The app has no OTP flow yet, so this
        // drives the honest `client/pairing-otp-unsupported` outcome.
        case 'POST /scenario/pairing/otp': {
          this.scenario.pairingOtpRequired = body.enabled === true
          return json(200, { pairingOtpRequired: this.scenario.pairingOtpRequired })
        }
        // Approve the pending pairing (desktop Approve): mint the token, send `paired` + `hello`.
        case 'POST /scenario/pairing/approve': {
          const approved = this.approvePairing()
          if (approved === 0) return json(409, { error: 'no pairing is pending', pending: this.evidence.pendingPairings })
          return json(200, { approved, pairingApprovals: this.evidence.pairingApprovals })
        }
        // Refuse the pending pairing (desktop Reject): `pairing-rejected`, close 4403.
        case 'POST /scenario/pairing/reject': {
          const rejected = this.rejectPairing(body.reason ?? 'pairing/refused')
          if (rejected === 0) return json(409, { error: 'no pairing is pending', pending: this.evidence.pendingPairings })
          return json(200, { rejected, close: PAIRING_CLOSE_CODES.rejected })
        }
        // Expire the pending pairing (window ran out): `pairing-rejected`, close 4410.
        case 'POST /scenario/pairing/expire': {
          const expired = this.expirePairing(body.reason ?? 'pairing/expired')
          if (expired === 0) return json(409, { error: 'no pairing is pending', pending: this.evidence.pendingPairings })
          return json(200, { expired, close: PAIRING_CLOSE_CODES.expired })
        }
        // Terminate every socket without a close frame: an abrupt network drop (US5).
        case 'POST /scenario/drop': {
          for (const connection of this.connections) connection.socket.terminate()
          return json(200, { dropped: this.connections.size })
        }
        // Refuse every following upgrade with a status (401 / 403 mapping, A034).
        case 'POST /scenario/upgrade-status': {
          this.scenario.upgradeStatus = body.status === null || body.status === undefined ? null : Number(body.status)
          return json(200, { upgradeStatus: this.scenario.upgradeStatus })
        }
        // Revoke every device: 4401 on live sockets, `auth/revoked` in band afterwards.
        case 'POST /scenario/revoke': {
          const count = this.tokens.size
          this.tokens.clear()
          for (const connection of this.connections) connection.socket.close(CLOSE_CODES.revoked, 'revoked')
          return json(200, { revoked: count })
        }
        // Arm revocation for the next authenticated request (deterministic wipe test, no timing).
        case 'POST /scenario/revoke-on-next-request': {
          this.scenario.revokeOnNextRequest = body.enabled !== false
          return json(200, { revokeOnNextRequest: this.scenario.revokeOnNextRequest })
        }
        // Close live sockets with a contract close code (4003 reauth / 4004 gateway disabled).
        case 'POST /scenario/close': {
          const code = Number(body.code)
          for (const connection of this.connections) connection.socket.close(code, body.reason ?? 'fixture-close')
          return json(200, { closed: this.connections.size, code })
        }
        // Change an approval's hash server-side: the next decision must be refused (hash-mismatch).
        case 'POST /scenario/approval/hash': {
          const approval = this.approvals.find((entry) => entry.approvalId === body.approvalId)
          if (approval === undefined) return json(404, { error: 'unknown approvalId' })
          approval.argsHash = body.argsHash ?? sha256Fixture(`changed:${Date.now()}`)
          return json(200, { approvalId: approval.approvalId, argsHash: approval.argsHash })
        }
        // Refuse the next decision with `hash-mismatch` and rotate the stored hash (one shot).
        case 'POST /scenario/approval/mismatch-once': {          const approvalId = body.approvalId ?? 'apv-hash'
          if (!this.approvals.some((entry) => entry.approvalId === approvalId)) return json(404, { error: 'unknown approvalId' })
          if (body.enabled === false) this.scenario.mismatchOnce.delete(approvalId)
          else this.scenario.mismatchOnce.add(approvalId)
          return json(200, { approvalId, mismatchOnce: this.scenario.mismatchOnce.has(approvalId) })
        }
        // Resolve an approval elsewhere (desktop): the card must say "already decided".
        case 'POST /scenario/approval/resolve': {
          const approval = this.approvals.find((entry) => entry.approvalId === body.approvalId)
          if (approval === undefined) return json(404, { error: 'unknown approvalId' })
          this.approvals = this.approvals.filter((entry) => entry.approvalId !== approval.approvalId)
          this.broadcast({
            kind: 'approval-resolved',
            rpcId: approval.rpcId,
            sessionId: approval.sessionId,
            approvalId: approval.approvalId,
            outcome: body.outcome ?? 'cancelled',
          })
          return json(200, { resolved: approval.approvalId })
        }
        // Push a fresh approval (badge / notification checkpoints).
        case 'POST /scenario/approval/raise': {
          const approval = {
            approvalId: body.approvalId ?? `apv-${crypto.randomBytes(4).toString('hex')}`,
            rpcId: body.rpcId ?? `rpc-${crypto.randomBytes(4).toString('hex')}`,
            sessionId: body.sessionId ?? 'sess-alpha',
            toolName: body.toolName ?? 'shell.exec',
            argsHash: body.argsHash === undefined ? sha256Fixture(`raise:${Date.now()}`) : body.argsHash,
            argsPreview: body.argsPreview ?? 'npm test',
            ...(body.displayReason === undefined ? {} : { displayReason: body.displayReason }),
          }
          this.approvals.push(approval)
          this.broadcast({
            kind: 'approval-requested',
            rpcId: approval.rpcId,
            sessionId: approval.sessionId,
            approvalId: approval.approvalId,
            toolName: approval.toolName,
            argsHash: approval.argsHash,
            argsPreview: approval.argsPreview,
            ...(approval.displayReason === undefined ? {} : { displayReason: approval.displayReason }),
          })
          return json(200, { approval })
        }
        // Version gate: the app must show the update-required screen.
        case 'POST /scenario/protocol': {
          if (body.companionProtocol !== undefined) this.scenario.companionProtocol = Number(body.companionProtocol)
          if (body.minClientVersion !== undefined) this.scenario.minClientVersion = Number(body.minClientVersion)
          return json(200, { companionProtocol: this.scenario.companionProtocol, minClientVersion: this.scenario.minClientVersion })
        }
        // A host that never sends `hello` (M9): the app must not report success. Pairing success
        // requires the accepted `client-hello` on an authenticated connection (A048) — never the
        // `paired` token, and never a socket that merely opened.
        case 'POST /scenario/suppress-hello': {
          this.scenario.suppressHello = body.suppress === true
          return json(200, { suppressHello: this.scenario.suppressHello })
        }
        // Slow every answer down (outbox/timeout checkpoints).
        case 'POST /scenario/delay': {
          this.scenario.requestDelayMs = Number(body.ms ?? 0)
          return json(200, { requestDelayMs: this.scenario.requestDelayMs })
        }
        // Spec 011: what `hello.device.scopes` claims. `null`/omitted field = unknown (older
        // gateway); an array without `sessions:author` = this device was not granted authoring.
        case 'POST /scenario/scopes': {
          this.scenario.deviceScopes = body.scopes === null || body.scopes === undefined
            ? null
            : [...body.scopes].map((scope) => String(scope))
          return json(200, { scopes: this.scenario.deviceScopes })
        }
        // Spec 011: refuse `session-create` so the flow can assert the visible failure line and
        // that the app stays on the screen (a refusal must never look like a silent no-op).
        case 'POST /scenario/session-create-refuse': {
          this.scenario.sessionCreateRefused = body.enabled !== false
          if (typeof body.code === 'string' && body.code !== '') this.scenario.sessionCreateErrorCode = body.code
          return json(200, {
            sessionCreateRefused: this.scenario.sessionCreateRefused,
            code: this.scenario.sessionCreateErrorCode,
          })
        }
        default:
          return json(404, { error: `no route: ${request.method} ${url.pathname}` })
      }
    }

    run().then(
      () => {},
      (error) => json(400, { error: error instanceof Error ? error.message : String(error) }),
    )
  }

  state () {
    return {
      mode: 'device-validation-fixture',
      contract: 'mobile-protocol-v1 (revision 3)',
      endpoint: this.endpoint,
      controlUrl: `http://127.0.0.1:${this.controlPort}`,
      controlToken: this.controlToken,
      gatewayId: this.gatewayId,
      gatewayName: this.options.name,
      certMode: this.certificateSet.mode,
      certNote: this.certificateSet.note,
      advertisedSha256: this.certificateSet.advertisedSha256,
      servedSha256: sha256OfCertificate(this.certificateSet.served.cert),
      servedWindow: this.certificateSet.served.window,
      pairing: this.offer === undefined ? null : { qr: this.offer.text, pairingCode: this.offer.pairingCode, expiresAt: this.offer.expiresAt },
      scenario: { ...this.scenario, mismatchOnce: [...this.scenario.mismatchOnce] },
      sessions: this.sessionRows(),
      approvals: this.approvals,
      evidence: {
        ...this.evidence,
        // Derived, so it is always the current truth: the fixture rows plus anything created
        // through `session-create` (a checkpoint asserts the created row is really served).
        sessionRows: this.sessionRows().length,
        // Keep the last frames only: the full list is unnecessary for a report.
        frames: this.evidence.frames.slice(-50),
        openConnections: this.connections.size,
      },
    }
  }

  async close () {
    for (const connection of this.connections) {
      try {
        connection.socket.terminate()
      } catch {
        // already gone
      }
    }
    this.connections.clear()
    await new Promise((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()))
    await new Promise((resolve) => (this.control ? this.control.close(() => resolve()) : resolve()))
    await new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      this.server.closeAllConnections?.()
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function protocolsOf (request) {
  const raw = request.headers['sec-websocket-protocol']
  const joined = Array.isArray(raw) ? raw.join(',') : raw ?? ''
  return joined.split(',').map((protocol) => protocol.trim()).filter((protocol) => protocol !== '')
}

function deviceProtocolOf (protocols) {
  for (const protocol of protocols) {
    if (protocol.startsWith(SUBPROTOCOL_PREFIX.device)) return protocol.slice(SUBPROTOCOL_PREFIX.device.length)
  }
  return null
}

function headerValue (request, name) {
  const raw = request.headers[name]
  if (raw === undefined) return null
  return Array.isArray(raw) ? raw[0] ?? null : raw
}

/** Minimal HTTP answer for a refused upgrade (the socket is then closed). */
function writeHttpResponse (socket, status, reason) {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
  } catch {
    // the peer may already be gone (pin-mismatch abort)
  }
  socket.destroy()
}

/** Bracket IPv6 literals so `wss://` URLs stay parseable. */
function formatHost (host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const options = parseFixtureArgs(process.argv.slice(2))

if (options.help) {
  process.stdout.write(`device-validation fixture gateway (contract v1, revision 3)

  --bind <addr>            interface to listen on (default 127.0.0.1; 0.0.0.0 or the host IP only
                           for a device run — the control API stays 127.0.0.1 either way)
  --port <n>               TLS/WSS port (default 3443; 0 = ephemeral)
  --control-port <n>       loopback control API port (default 3444)
  --cert-mode <mode>       ok | wrong | expired | not-yet  (default ok)
  --lan-host <ip|auto>     host written into the pairing QR (default 127.0.0.1; 'auto' = first
                           non-internal IPv4, for a deliberate LAN run)
  --name <name>            gatewayName shown before pairing (default dsh-e2e)
  --fixed-pairing-code <c> reuse one code instead of rotating (repeatable runs)
  --print-json             print one JSON startup block (for scripts)
  --quiet                  only print the startup block/QR

Docs: apps/mobile-companion/e2e/README.md
`)
  process.exit(0)
}

const warning = exposureWarning(options)
if (warning !== null) process.stderr.write(`${warning}\n`)

const certificateSet = await buildCertificateSet(options.certMode, {
  hostname: options.lanHost === 'auto' ? detectLanHost() : options.lanHost,
})

const fixture = new FixtureGateway(options, certificateSet)
await fixture.start()

const startup = fixture.state()

if (options.printJson) {
  process.stdout.write(`${JSON.stringify(startup)}\n`)
} else if (!options.quiet) {
  process.stdout.write(`dsh-companion device-validation fixture — contract v1 (revision 3)
  endpoint      ${startup.endpoint}
  control       ${startup.controlUrl}   (x-fixture-token for mutations)
  cert mode     ${startup.certMode} — ${startup.certNote}
  advertised    ${startup.advertisedSha256}
  served        ${startup.servedSha256}
  gateway       ${startup.gatewayName} (${startup.gatewayId})
  sessions      ${startup.sessions.map((row) => `${row.sessionId}${row.archived === true ? ' [archived]' : row.running === true ? ' [running]' : ' [idle]'}`).join(', ')}
  approvals     ${startup.approvals.map((approval) => `${approval.approvalId}(${approval.argsHash === null ? 'null-hash' : 'hash'})`).join(', ')}

  Post the QR below into the app (pair screen, "Or paste the code shown on your computer").
  It is single-use and expires at ${new Date(startup.pairing.expiresAt).toISOString()}:
  POST ${startup.controlUrl}/pairing/new  (x-fixture-token) rotates it.

  ${startup.pairing.qr}
`)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void fixture.close().then(() => process.exit(0))
  })
}

export { FixtureGateway, parseFixtureArgs as parseArgs, detectLanHost }
