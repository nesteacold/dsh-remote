/**
 * `@dsh-ext/mobile-protocol` — the shared wire contract for the DeepSeek
 * Harness mobile companion (protocol v1, contract revision 2).
 *
 * Source of truth: `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md`
 * (revision 2 — aligned with the upstream gateway wire format: client frames use
 * `type`, server frames use `kind`, every answer echoes `requestId`) and
 * `specs/005-remote-desktop-client/spec.md` (revision 3 — device `kind`/`scopes`
 * and `auth/forbidden-scope`; additive, so the wire protocol stays v1) and
 * `specs/008-devices-page/plan.md` (revision 4 — scope `harness:remote` and the
 * remote-bridge frames; additive, the wire protocol stays v1; revision 5 adds the
 * full-control scopes and `SCOPE_PRESETS`).
 * `test/contract.test.mjs` parses that document and fails when a constant here
 * drifts from it. Breaking change ⇒ v2, never an edit in place.
 *
 * Pure ESM, no dependencies: importable by the Host plugin (`plugins/mobile-gateway`)
 * and by the companion app (`apps/mobile-companion`) unchanged.
 * TypeScript consumer types live in `index.d.ts` beside this file.
 */

// ---------------------------------------------------------------------------
// §1 Framing / §3 Connection
// ---------------------------------------------------------------------------

/** WebSocket subprotocol every companion connection offers first (contract §1, §3). */
export const PROTOCOL_SUBPROTOCOL = 'dsh-mobile-v1'

/**
 * Companion protocol revision carried in `hello.companionProtocol` and
 * `client-hello.companionProtocol` (contract §3.5–6).
 */
export const COMPANION_PROTOCOL_VERSION = 1

/**
 * Oldest companion client version a host accepts (contract §3.5 `minClientVersion`,
 * §3.6 `protocol/unsupported`).
 */
export const MIN_CLIENT_VERSION = 1

/**
 * Pairing QR payload `version` (contract §2). The QR text is unpadded base64url of the
 * UTF-8 JSON payload, not the JSON itself.
 */
export const PAIRING_QR_VERSION = 3

/**
 * Subprotocol prefixes used instead of headers where a client cannot set them
 * (contract §3.2, §3.4). The server only ever negotiates back `dsh-mobile-v1`.
 */
export const SUBPROTOCOL_PREFIXES = Object.freeze({
  pair: 'dsh-pair.',
  auth: 'dsh-auth.',
  device: 'dsh-device.',
})

/** Header carrying the install-scoped device UUID during pairing (contract §3.2). */
export const DEVICE_ID_HEADER = 'X-DSH-Device-ID'

/** Subprotocols offered for first pairing: `dsh-mobile-v1, dsh-pair.<code>` (contract §3.2). */
export function pairingSubprotocols(pairingCode) {
  return [PROTOCOL_SUBPROTOCOL, `${SUBPROTOCOL_PREFIXES.pair}${pairingCode}`]
}

/**
 * Subprotocols offered for an authenticated connection. The bearer token normally travels in
 * `Authorization`; `dsh-auth.<token>` is the fallback for clients without headers (§3.4).
 */
export function authSubprotocols(token) {
  return token === undefined ? [PROTOCOL_SUBPROTOCOL] : [PROTOCOL_SUBPROTOCOL, `${SUBPROTOCOL_PREFIXES.auth}${token}`]
}

/** `dsh-device.<installUuid>` fallback for the `X-DSH-Device-ID` header (contract §3.2). */
export function deviceSubprotocol(installUuid) {
  return `${SUBPROTOCOL_PREFIXES.device}${installUuid}`
}

// ---------------------------------------------------------------------------
// §4 Operations (allowlist `companion-v1`)
// ---------------------------------------------------------------------------

/**
 * The `companion-v1` operation allowlist in contract-table order. The op identity is the
 * client frame's `type`; anything else is answered with `op/forbidden`.
 */
export const OPS = Object.freeze([
  'client-hello',
  'ping',
  'sessions',
  'search',
  'history',
  'subscribe',
  'unsubscribe',
  'message',
  'session-cancel',
  'approval-response',
  'device-info',
  'device-forget',
  'push-register',
  'push-remove',
])

/** Server → client response `kind` per operation (contract §4 "Response `kind`" column). */
export const OP_RESPONSES = Object.freeze({
  'client-hello': 'client-hello',
  ping: 'pong',
  sessions: 'sessions',
  search: 'search',
  history: 'history',
  subscribe: 'subscribed',
  unsubscribe: 'unsubscribed',
  message: 'sent',
  'session-cancel': 'session-cancelled',
  'approval-response': 'approval-response',
  'device-info': 'device-info',
  'device-forget': 'device-forgotten',
  'push-register': 'push-registered',
  'push-remove': 'push-removed',
})

/** Server → client push frames that carry no `requestId` (contract §1, §5). */
export const SERVER_PUSH_KINDS = Object.freeze([
  'approval-requested',
  'approval-resolved',
  'event',
])

// ---------------------------------------------------------------------------
// §3.2 / §4 Device kinds and scopes (spec 005, FR2)
// ---------------------------------------------------------------------------

/** What paired a device is: the companion phone or the desktop client (spec 005, FR1). */
export const DEVICE_KINDS = Object.freeze(['mobile', 'desktop'])

/** Scopes a pairing offer may grant; a device keeps the ones it was paired with. */
export const SCOPES = Object.freeze([
  'sessions:read',
  'prompt:send',
  'approval:respond',
  'files:read',
  'files:write',
  'settings:write',
  // Spec 008: the remote-bridge channel (desktop → DSH wire calls on this Host).
  // Never a default and never granted to a `mobile` device: the owner has to pick
  // it explicitly when pairing a `desktop`.
  'harness:remote',
  // Spec 008 "full control" (revision 5, additive). Each one opens a capability
  // family of the remote bridge. Like `harness:remote` they are desktop-only and
  // explicit-only: never in a default, never on a `mobile` or legacy record.
  'commands:execute',
  'workspace:manage',
  'credentials:write',
  'plugins:manage',
  'schedule:write',
  'terminal',
])

/**
 * Scopes that exist only for a `desktop` device and must be chosen by the owner
 * (spec 008): the remote bridge itself plus the full-control families.
 */
export const DESKTOP_ONLY_SCOPES = Object.freeze([
  'harness:remote',
  'commands:execute',
  'workspace:manage',
  'credentials:write',
  'plugins:manage',
  'schedule:write',
  'terminal',
])

/**
 * Scopes a desktop offer gets unless the owner picks some (spec 005, FR3): see
 * sessions, prompt, answer approvals — nothing that writes files or settings.
 * `harness:remote` and the full-control scopes are deliberately absent (spec 008):
 * they must be chosen.
 */
export const DESKTOP_DEFAULT_SCOPES = Object.freeze(['sessions:read', 'prompt:send', 'approval:respond'])

/**
 * Pairing presets for the Devices UI (spec 008). `standard` is the default at
 * Approve; `full` ticks every desktop scope ("full control"). A preset is only a
 * list the owner may edit: the grant is still the explicit scope list.
 */
export const SCOPE_PRESETS = Object.freeze({
  standard: Object.freeze(['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote']),
  full: Object.freeze([
    'sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'files:write', 'settings:write',
    'harness:remote', 'commands:execute', 'workspace:manage', 'credentials:write', 'plugins:manage',
    'schedule:write', 'terminal',
  ]),
})

/**
 * Scope of each inbound `msg.type` the desktop client may send. Deliberately
 * narrower than `OPS`: operations that are not listed here (device management,
 * push) cannot be scoped and stay refused for a scoped caller.
 */
export const SCOPE_BY_TYPE = Object.freeze({
  'client-hello': 'sessions:read',
  ping: 'sessions:read',
  sessions: 'sessions:read',
  search: 'sessions:read',
  history: 'sessions:read',
  subscribe: 'sessions:read',
  unsubscribe: 'sessions:read',
  'device-info': 'sessions:read',
  message: 'prompt:send',
  'session-cancel': 'prompt:send',
  'approval-response': 'approval:respond',
  // Spec 008 remote-bridge: the type needs `harness:remote`; the bridge then
  // checks the endpoint's own scope (sessions:read, prompt:send, ...) on top.
  'remote-call': 'harness:remote',
  'remote-stream-open': 'harness:remote',
  'remote-stream-cancel': 'harness:remote',
  'remote-stream-credit': 'harness:remote',
})

// ---------------------------------------------------------------------------
// Spec 008 — remote-bridge channel (revision 4, additive)
// ---------------------------------------------------------------------------

/**
 * Client → server remote-bridge frames (spec 008 P1). They carry a DSH Gateway
 * `endpoint` (`namespace/method`, or `$events`, `$events/result`) and its `args`
 * object. They are NOT contract §4 operations (`OPS` is unchanged): only a
 * `desktop` device holding `harness:remote` can send them, and each endpoint is
 * checked against the Host allowlist (`lib/remote-bridge.mjs`).
 *
 *   remote-call          { type, requestId, endpoint, args }            → remote-result
 *   remote-stream-open   { type, requestId?, streamId, endpoint, args } → remote-frame* … remote-stream-closed
 *   remote-stream-cancel { type, streamId }
 *   remote-stream-credit { type, streamId, n }   grant the host `n` more frames
 */
export const REMOTE_CLIENT_TYPES = Object.freeze([
  'remote-call',
  'remote-stream-open',
  'remote-stream-cancel',
  'remote-stream-credit',
])

/**
 * Server → client remote-bridge frames (they use `kind`, like every server frame):
 *   remote-result         { kind, requestId, ok: true, value } | { kind, requestId, ok: false, error }
 *   remote-frame          { kind, streamId, seq, value }
 *   remote-stream-closed  { kind, streamId, error? }
 */
export const REMOTE_SERVER_KINDS = Object.freeze([
  'remote-result',
  'remote-frame',
  'remote-stream-closed',
])

/** Credit a stream starts with before the client grants more (spec 008, backpressure). */
export const REMOTE_STREAM_DEFAULT_CREDIT = 64

/** Largest binary chunk (bytes, before base64) the bridge puts into one frame. */
export const REMOTE_BINARY_CHUNK_BYTES = 256 * 1024

// ---------------------------------------------------------------------------
// §3.5 / §6 Capabilities, close codes, errors
// ---------------------------------------------------------------------------

/** Capabilities a host advertises in `hello` for companion protocol v1 (contract §3.5). */
export const CAPABILITIES = Object.freeze(['sessions-read', 'prompt', 'cancel', 'approval-v1'])

/** Extra capabilities a host MAY advertise on top of `CAPABILITIES`. */
export const OPTIONAL_CAPABILITIES = Object.freeze(['push-v1'])

/**
 * WebSocket close codes (contract §3). `4004` = gateway disabled, stop auto-reconnect;
 * `4003` = re-authenticate; `4401` = device revoked, wipe the stored credential.
 */
export const CLOSE_CODES = Object.freeze({
  gatewayDisabled: 4004,
  reauth: 4003,
  revoked: 4401,
})

/**
 * Error code → HTTP status on the WebSocket upgrade, `null` where the contract shows `—`
 * (in-band error frames only). See contract §6.
 */
export const ERROR_CODES = Object.freeze({
  'auth/required': 401,
  'auth/revoked': 401,
  // In-band only (spec 005): the device may connect, its scopes just forbid this op.
  'auth/forbidden-scope': null,
  'remote/disabled': 403,
  'op/forbidden': null,
  'pairing/expired': 401,
  'protocol/unsupported': null,
  'bad-request': null,
  'session-not-found': null,
})

/**
 * Host error codes the contract allows to pass through unchanged (contract §6 postscript).
 * Clients show a generic error for any code they do not know.
 */
export const PASSTHROUGH_ERROR_CODES = Object.freeze(['agent-busy', 'internal'])

// ---------------------------------------------------------------------------
// §5 Approvals
// ---------------------------------------------------------------------------

/** Outcomes a companion client may send; `cancelled`/`unavailable` are host-only states. */
export const APPROVAL_OUTCOMES_CLIENT = Object.freeze(['allowed-once', 'rejected'])

/** Every outcome found in an `approval-resolved` push, client-sent ones first. */
export const APPROVAL_OUTCOMES_FINAL = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/**
 * `reason` values of a receipt with `accepted: false` (contract §5):
 * `not-pending` = already decided / handed to the desktop;
 * `hash-mismatch` = the content changed, the client must reload the card and re-review.
 */
export const RECEIPT_REASONS = Object.freeze(['not-pending', 'hash-mismatch'])

/** Keep-alive interval for `{ "type": "ping" }` (contract §4). */
export const PING_INTERVAL_MS = 25_000

// ---------------------------------------------------------------------------
// Types (JSDoc; mirrored for TypeScript consumers in `index.d.ts`)
// ---------------------------------------------------------------------------

/**
 * `device` object as sent in `paired`, `hello`, and `device-info` (contract §3.3, §3.5, §4).
 * @typedef {Object} DeviceInfo
 * @property {string} id Server-side device id.
 * @property {string} name Display name (client-supplied on pairing).
 * @property {number|string} [createdAt] Epoch milliseconds (upstream) — treat as opaque.
 * @property {DeviceKind} [kind] Absent on a gateway that predates scopes.
 * @property {Scope[]} [scopes] Same: any type of a gateway without scopes is allowed.
 */

/**
 * Client → server request frame (contract §1). `requestId` is required, ≤ 64 chars of
 * `[A-Za-z0-9._-]`; every answer echoes it.
 * @typedef {Object} ClientRequestFrame
 * @property {string} type One of {@link OPS}.
 * @property {string} requestId
 */

/** @typedef {{ type: 'client-hello', requestId: string, companionProtocol: number, appVersion: string, platform: 'ios'|'android' }} ClientHelloFrame */
/** @typedef {{ type: 'ping', requestId: string }} PingFrame */
/** @typedef {{ type: 'sessions', requestId: string }} SessionsRequestFrame */
/** @typedef {{ type: 'search', requestId: string, query: string }} SearchRequestFrame */
/** @typedef {{ type: 'history', requestId: string, sessionId: string, beforeSeq?: number, maxMessages?: number, maxBytes?: number }} HistoryRequestFrame */
/** @typedef {{ type: 'subscribe', requestId: string, sessionId: string }} SubscribeFrame */
/** @typedef {{ type: 'unsubscribe', requestId: string }} UnsubscribeFrame */
/** @typedef {{ type: 'message', requestId: string, sessionId: string, text: string, clientMsgId: string, mode?: 'queue'|'steer' }} MessageFrame */
/** @typedef {{ type: 'session-cancel', requestId: string, sessionId: string }} SessionCancelFrame */
/** @typedef {{ type: 'approval-response', requestId: string, rpcId: string, sessionId: string, approvalId: string, argsHash: string, outcome: 'allowed-once'|'rejected' }} ApprovalResponseFrame */
/** @typedef {{ type: 'device-info', requestId: string }} DeviceInfoRequestFrame */
/** @typedef {{ type: 'device-forget', requestId: string }} DeviceForgetFrame */
/** @typedef {{ type: 'push-register', requestId: string, platform: 'apns'|'fcm', token: string }} PushRegisterFrame */
/** @typedef {{ type: 'push-remove', requestId: string }} PushRemoveFrame */

/**
 * Server → client `hello` (contract §3.5). Sent after `paired` (first pairing) or after the
 * bearer credential was accepted.
 * @typedef {Object} HelloFrame
 * @property {'hello'} kind
 * @property {number} protocol Upstream wire protocol number (3 today), not the companion version.
 * @property {number} companionProtocol {@link COMPANION_PROTOCOL_VERSION}
 * @property {number} minClientVersion {@link MIN_CLIENT_VERSION}
 * @property {string[]} capabilities {@link CAPABILITIES} plus any advertised {@link OPTIONAL_CAPABILITIES}.
 * @property {boolean} authenticated
 * @property {DeviceInfo} device
 * @property {string} gatewayId
 * @property {string} [dshVersion] DSH runtime version, e.g. `0.2.2-rc.1`.
 * @property {string} [certSha256] Hex SHA-256 of the pinned TLS leaf certificate.
 */

/**
 * Server → client `paired`, sent exactly once on a pairing connection (contract §3.3).
 * The client stores `token` in the secure store immediately; it is never sent again.
 * @typedef {Object} PairedFrame
 * @property {'paired'} kind
 * @property {string} token Long-lived device token.
 * @property {DeviceInfo} device
 */

/**
 * Server → client error frame (contract §1). `requestId`/`requestType` are present when the
 * error answers a request; `minClientVersion` accompanies `protocol/unsupported`.
 * @typedef {Object} ErrorFrame
 * @property {'error'} kind
 * @property {string} code One of {@link ERROR_CODES} or a passthrough code.
 * @property {string} [requestType] The op whose request failed.
 * @property {string} [requestId]
 * @property {string} [message]
 * @property {number} [minClientVersion]
 */

/**
 * Server push when an approval waits for a decision (contract §5).
 * `argsHash === null` means the gateway could not bind the content: the client MUST NOT offer
 * approve/reject. Deduplicate by `rpcId`.
 * @typedef {Object} ApprovalRequestedFrame
 * @property {'approval-requested'} kind
 * @property {string} rpcId
 * @property {string} sessionId
 * @property {string} approvalId
 * @property {string} toolName
 * @property {string} [callId]
 * @property {string} [reason]
 * @property {Record<string,string>} [displayReason] Localised display text, e.g. `{ "en": "..." }`.
 * @property {string|null} argsHash 64 hex chars, or `null` (desktop only).
 * @property {string} [argsPreview] ≤ 2 KB text. Always a string from a revision 2.1 gateway
 *   (contract §5a); optional here only because a pre-2.1 host may omit the field.
 * @property {boolean} [replay] True when replayed for a fresh `subscribe`.
 */

/**
 * Server receipt for an `approval-response` (contract §5).
 * @typedef {Object} ApprovalResponseReceipt
 * @property {'approval-response'} kind
 * @property {string} requestId
 * @property {string} rpcId
 * @property {string} sessionId
 * @property {string} approvalId
 * @property {'allowed-once'|'rejected'} outcome
 * @property {true} accepted
 */

/**
 * Server receipt when a decision was refused.
 * @typedef {Object} ApprovalResponseRejected
 * @property {'approval-response'} kind
 * @property {string} requestId
 * @property {string} rpcId
 * @property {string} sessionId
 * @property {string} approvalId
 * @property {'allowed-once'|'rejected'} outcome
 * @property {false} accepted
 * @property {'not-pending'|'hash-mismatch'} reason
 */

/**
 * Final-state push, sent to every client once an approval leaves the pending set.
 * @typedef {Object} ApprovalResolvedFrame
 * @property {'approval-resolved'} kind
 * @property {string} rpcId
 * @property {string} sessionId
 * @property {string} approvalId
 * @property {'allowed-once'|'rejected'|'cancelled'|'unavailable'} outcome
 */

/**
 * Decoded pairing payload: the unpadded-base64url QR/manual text decodes to this JSON
 * (contract §2).
 * @typedef {Object} PairingPayload
 * @property {3} version {@link PAIRING_QR_VERSION}
 * @property {string} publicUrl `wss://…`
 * @property {string} pairingCode Base64url 256-bit one-time code.
 * @property {number} expiresAt Epoch milliseconds, ≤ 5 min ahead.
 * @property {string} certSha256 64 lowercase hex.
 * @property {string} gatewayId UUID v4.
 * @property {string} gatewayName
 * @property {string[]} endpoints `wss://…` URLs; `publicUrl` is always first.
 */

/**
 * One session row from `sessions`/`search` (upstream list projection, contract rev 2.1 §5a:
 * canonical `sessionId`, epoch-ms `updatedAt`, `running`, title in `projections.values.title`;
 * the client derives running/idle/archived).
 * @typedef {Object} SessionRow
 * @property {string} sessionId Canonical upstream session id.
 * @property {string} [id] Deprecated: pre-rev2.1 alias; only a documented compatibility fallback.
 * @property {number|string} [updatedAt] Epoch ms (epoch seconds tolerated for legacy hosts).
 * @property {boolean} [running] True while the session runs; false/absent means idle.
 * @property {'running'|'idle'|'archived'} [state] Deprecated: not an upstream field.
 * @property {{ values?: { title?: string }, [key: string]: unknown }} [projections]
 * @property {boolean} [needsDecision]
 */

/** @typedef {typeof OPS[number]} Op */
/** @typedef {typeof SCOPE_BY_TYPE[keyof typeof SCOPE_BY_TYPE]} ScopedOp */
/** @typedef {typeof DEVICE_KINDS[number]} DeviceKind */
/** @typedef {typeof SCOPES[number]} Scope */
/** @typedef {typeof CAPABILITIES[number] | typeof OPTIONAL_CAPABILITIES[number]} Capability */
/** @typedef {typeof APPROVAL_OUTCOMES_CLIENT[number]} ClientApprovalOutcome */
/** @typedef {typeof APPROVAL_OUTCOMES_FINAL[number]} FinalApprovalOutcome */
/** @typedef {typeof RECEIPT_REASONS[number]} ReceiptReason */
/** @typedef {keyof typeof CLOSE_CODES} CloseCodeName */
/** @typedef {typeof CLOSE_CODES[CloseCodeName]} CloseCode */
