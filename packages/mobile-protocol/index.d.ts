/**
 * TypeScript declarations for `@dsh-ext/mobile-protocol` (contract v1, revision 4).
 *
 * Keep in step with `src/index.mjs`; `test/contract.test.mjs` checks the runtime values
 * against the contract document, and `types.test-d.ts` inside the companion app keeps a
 * type-level check that this surface still matches what the app imports.
 */

// ---------------------------------------------------------------------------
// §1 / §3 — framing, subprotocols
// ---------------------------------------------------------------------------

export const PROTOCOL_SUBPROTOCOL: 'dsh-mobile-v1'
export const COMPANION_PROTOCOL_VERSION: 1
export const MIN_CLIENT_VERSION: 1
export const PAIRING_QR_VERSION: 3

export const SUBPROTOCOL_PREFIXES: Readonly<{
  pair: 'dsh-pair.'
  auth: 'dsh-auth.'
  device: 'dsh-device.'
}>

export const DEVICE_ID_HEADER: 'X-DSH-Device-ID'

export function pairingSubprotocols(pairingCode: string): string[]
export function authSubprotocols(token?: string): string[]
export function deviceSubprotocol(installUuid: string): string

// ---------------------------------------------------------------------------
// §4 — operations
// ---------------------------------------------------------------------------

export type Op =
  | 'client-hello'
  | 'ping'
  | 'sessions'
  | 'search'
  | 'history'
  | 'subscribe'
  | 'unsubscribe'
  | 'message'
  | 'session-cancel'
  | 'approval-response'
  | 'device-info'
  | 'device-forget'
  | 'push-register'
  | 'push-remove'

export const OPS: readonly Op[]

export type ResponseKind =
  | 'client-hello'
  | 'pong'
  | 'sessions'
  | 'search'
  | 'history'
  | 'subscribed'
  | 'unsubscribed'
  | 'sent'
  | 'session-cancelled'
  | 'approval-response'
  | 'device-info'
  | 'device-forgotten'
  | 'push-registered'
  | 'push-removed'

export const OP_RESPONSES: Readonly<Record<Op, ResponseKind>>

export type PushKind = 'approval-requested' | 'approval-resolved' | 'event'
export const SERVER_PUSH_KINDS: readonly PushKind[]

// ---------------------------------------------------------------------------
// Device kinds and scopes (spec 005, FR2)
// ---------------------------------------------------------------------------

export type DeviceKind = 'mobile' | 'desktop'
export const DEVICE_KINDS: readonly DeviceKind[]

export type Scope =
  | 'sessions:read'
  | 'prompt:send'
  | 'approval:respond'
  | 'files:read'
  | 'files:write'
  | 'settings:write'
  /** Spec 008: remote-bridge channel; desktop only, never a default. */
  | 'harness:remote'
  /** Spec 008 full control (revision 5): desktop only, explicit only, never a default. */
  | 'commands:execute'
  | 'workspace:manage'
  | 'credentials:write'
  | 'plugins:manage'
  | 'schedule:write'
  | 'terminal'

export const SCOPES: readonly Scope[]
export const DESKTOP_DEFAULT_SCOPES: readonly Scope[]
/** Scopes only a `desktop` device may hold, and only when chosen explicitly. */
export const DESKTOP_ONLY_SCOPES: readonly Scope[]
export type ScopePresetName = 'standard' | 'full'
/** Devices UI presets: `standard` = default at Approve, `full` = every desktop scope. */
export const SCOPE_PRESETS: Readonly<Record<ScopePresetName, readonly Scope[]>>

/** Scope of each scoped inbound type; a type absent here is refused for a scoped device. */
export const SCOPE_BY_TYPE: Readonly<Partial<Record<Op | RemoteClientType, Scope>>>

// ---------------------------------------------------------------------------
// Spec 008 — remote-bridge channel (revision 4, additive)
// ---------------------------------------------------------------------------

export type RemoteClientType =
  | 'remote-call'
  | 'remote-stream-open'
  | 'remote-stream-cancel'
  | 'remote-stream-credit'

export type RemoteServerKind = 'remote-result' | 'remote-frame' | 'remote-stream-closed'

export const REMOTE_CLIENT_TYPES: readonly RemoteClientType[]
export const REMOTE_SERVER_KINDS: readonly RemoteServerKind[]
export const REMOTE_STREAM_DEFAULT_CREDIT: 64
export const REMOTE_BINARY_CHUNK_BYTES: 262144

/** A DSH Gateway endpoint (`namespace/method`, `$events` or `$events/result`). */
export interface RemoteCallFrame {
  type: 'remote-call'
  requestId: string
  endpoint: string
  args: Record<string, unknown>
}

export interface RemoteStreamOpenFrame {
  type: 'remote-stream-open'
  requestId?: string
  streamId: string
  endpoint: string
  args: Record<string, unknown>
}

export interface RemoteStreamCancelFrame {
  type: 'remote-stream-cancel'
  streamId: string
}

/** Grants the host `n` more frames on the stream (credit-based backpressure). */
export interface RemoteStreamCreditFrame {
  type: 'remote-stream-credit'
  streamId: string
  n: number
}

export interface RemoteError {
  code: string
  message: string
}

export type RemoteResultFrame =
  | { kind: 'remote-result'; requestId: string; ok: true; value: unknown }
  | { kind: 'remote-result'; requestId: string; ok: false; error: RemoteError }

export interface RemoteFrame {
  kind: 'remote-frame'
  streamId: string
  seq: number
  value: unknown
}

export interface RemoteStreamClosedFrame {
  kind: 'remote-stream-closed'
  streamId: string
  error?: RemoteError
}

// ---------------------------------------------------------------------------
// §3.5 / §5 / §6 — capabilities, close codes, errors, approvals
// ---------------------------------------------------------------------------

export type Capability = 'sessions-read' | 'prompt' | 'cancel' | 'approval-v1'
export type OptionalCapability = 'push-v1'

export const CAPABILITIES: readonly Capability[]
export const OPTIONAL_CAPABILITIES: readonly OptionalCapability[]

export const CLOSE_CODES: Readonly<{
  gatewayDisabled: 4004
  reauth: 4003
  revoked: 4401
}>

export type ContractErrorCode =
  | 'auth/required'
  | 'auth/revoked'
  | 'auth/forbidden-scope'
  | 'remote/disabled'
  | 'op/forbidden'
  | 'pairing/expired'
  | 'protocol/unsupported'
  | 'bad-request'
  | 'session-not-found'

export type PassthroughErrorCode = 'agent-busy' | 'internal'

export const ERROR_CODES: Readonly<Record<ContractErrorCode, number | null>>
export const PASSTHROUGH_ERROR_CODES: readonly PassthroughErrorCode[]

export type ClientApprovalOutcome = 'allowed-once' | 'rejected'
export type FinalApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export type ReceiptReason = 'not-pending' | 'hash-mismatch'

export const APPROVAL_OUTCOMES_CLIENT: readonly ClientApprovalOutcome[]
export const APPROVAL_OUTCOMES_FINAL: readonly FinalApprovalOutcome[]
export const RECEIPT_REASONS: readonly ReceiptReason[]

export const PING_INTERVAL_MS: 25000

// ---------------------------------------------------------------------------
// Frames and payloads (§2–§5)
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  id: string
  name: string
  createdAt?: number | string
  /** Absent on a gateway that predates scopes (revision 2). */
  kind?: DeviceKind
  /** Absent on a gateway that predates scopes; then every type is allowed. */
  scopes?: Scope[]
}

export interface PairingPayload {
  version: 3
  publicUrl: string
  pairingCode: string
  expiresAt: number
  certSha256: string
  gatewayId: string
  gatewayName: string
  endpoints: string[]
}

export interface ClientHelloFrame {
  type: 'client-hello'
  requestId: string
  companionProtocol: number
  appVersion: string
  platform: 'ios' | 'android'
}

export interface PingFrame {
  type: 'ping'
  requestId: string
}

export interface SessionsRequestFrame {
  type: 'sessions'
  requestId: string
}

export interface SearchRequestFrame {
  type: 'search'
  requestId: string
  query: string
}

export interface HistoryRequestFrame {
  type: 'history'
  requestId: string
  sessionId: string
  beforeSeq?: number
  maxMessages?: number
  maxBytes?: number
}

export interface SubscribeFrame {
  type: 'subscribe'
  requestId: string
  sessionId: string
}

export interface UnsubscribeFrame {
  type: 'unsubscribe'
  requestId: string
}

export interface MessageFrame {
  type: 'message'
  requestId: string
  sessionId: string
  text: string
  clientMsgId: string
  mode?: 'queue' | 'steer'
}

export interface SessionCancelFrame {
  type: 'session-cancel'
  requestId: string
  sessionId: string
}

export interface ApprovalResponseFrame {
  type: 'approval-response'
  requestId: string
  rpcId: string
  sessionId: string
  approvalId: string
  argsHash: string
  outcome: ClientApprovalOutcome
}

export interface DeviceInfoRequestFrame {
  type: 'device-info'
  requestId: string
}

export interface DeviceForgetFrame {
  type: 'device-forget'
  requestId: string
}

export interface PushRegisterFrame {
  type: 'push-register'
  requestId: string
  platform: 'apns' | 'fcm'
  token: string
}

export interface PushRemoveFrame {
  type: 'push-remove'
  requestId: string
}

export type ClientFrame =
  | ClientHelloFrame
  | PingFrame
  | SessionsRequestFrame
  | SearchRequestFrame
  | HistoryRequestFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | MessageFrame
  | SessionCancelFrame
  | ApprovalResponseFrame
  | DeviceInfoRequestFrame
  | DeviceForgetFrame
  | PushRegisterFrame
  | PushRemoveFrame

/** Every request carries a `type` from OPS and a `requestId`. */
export interface ClientRequestFrameBase {
  type: Op
  requestId: string
}

export interface HelloFrame {
  kind: 'hello'
  protocol: number
  companionProtocol: number
  minClientVersion: number
  capabilities: string[]
  authenticated: boolean
  device: DeviceInfo
  gatewayId: string
  dshVersion?: string
  certSha256?: string
}

export interface PairedFrame {
  kind: 'paired'
  token: string
  device: DeviceInfo
}

export interface ErrorFrame {
  kind: 'error'
  code: string
  requestType?: string
  requestId?: string
  message?: string
  minClientVersion?: number
}

export interface ApprovalRequestedFrame {
  kind: 'approval-requested'
  rpcId: string
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
  displayReason?: Record<string, string>
  argsHash: string | null
  /**
   * Always a string on the wire from a revision 2.1 gateway (contract §5a); optional here
   * because a pre-2.1 host may omit it and the client parser accepts that frame.
   */
  argsPreview?: string
  replay?: boolean
}

export interface ApprovalResponseReceipt {
  kind: 'approval-response'
  requestId: string
  rpcId: string
  sessionId: string
  approvalId: string
  outcome: ClientApprovalOutcome
  accepted: true
}

export interface ApprovalResponseRejected {
  kind: 'approval-response'
  requestId: string
  rpcId: string
  sessionId: string
  approvalId: string
  outcome: ClientApprovalOutcome
  accepted: false
  reason: ReceiptReason
}

export type ApprovalResponseAnswer = ApprovalResponseReceipt | ApprovalResponseRejected

export interface ApprovalResolvedFrame {
  kind: 'approval-resolved'
  rpcId: string
  sessionId: string
  approvalId: string
  outcome: FinalApprovalOutcome
}

export interface SentFrame {
  kind: 'sent'
  requestId: string
  sessionId: string
  clientMsgId: string
}

export interface SessionCancelledFrame {
  kind: 'session-cancelled'
  requestId: string
  accepted: boolean
}

/**
 * One session row from `sessions`/`search` (upstream list projection, contract rev 2.1 §5a).
 * Canonical rows carry `sessionId`, epoch-ms `updatedAt`, `running`, and the title in
 * `projections.values.title`; the client derives running/idle/archived from `running`.
 */
export interface SessionRow {
  /** Canonical upstream session id (contract rev 2.1 §5a). */
  sessionId: string
  /**
   * @deprecated Pre-rev2.1 gateways and old fixtures used `id`. Kept optional only as a
   * documented compatibility fallback; the store uses it when `sessionId` is absent.
   */
  id?: string
  /** Epoch milliseconds (contract §5a); epoch seconds are tolerated for legacy hosts. */
  updatedAt?: number | string
  /** True while the session runs; false/absent means idle (contract §5a). */
  running?: boolean
  /** @deprecated Not an upstream field; pre-rev2.1 fixtures only. */
  state?: 'running' | 'idle' | 'archived'
  projections?: { values?: { title?: string }; [key: string]: unknown }
  needsDecision?: boolean
  [key: string]: unknown
}

export interface SessionsFrame {
  kind: 'sessions'
  requestId: string
  items: SessionRow[]
}

export interface SearchFrame {
  kind: 'search'
  requestId: string
  items: SessionRow[]
}

export interface HistoryMessage {
  seq?: number
  id?: string
  role?: string
  text?: string
  [key: string]: unknown
}

export interface HistoryFrame {
  kind: 'history'
  requestId: string
  sessionId?: string
  items?: HistoryMessage[]
  messages?: HistoryMessage[]
  hasMore?: boolean
  [key: string]: unknown
}

export interface EventFrame {
  kind: 'event'
  sessionId?: string
  event?: unknown
  [key: string]: unknown
}
