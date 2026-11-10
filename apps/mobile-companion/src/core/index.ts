// Public surface of the pure-TS core. Everything here runs unchanged in Node (tests) and in
// the app bundle; nothing may import react-native, expo or Node built-ins
// (`npm run check:core` enforces that).

export * from './protocol';
export * from './errors';
export { parsePairingQr, parsePairingQrOrThrow, qrExpiresInMs, encodePairingPayload, decodeBase64Url, encodeBase64Url, PAIRING_TTL_MS } from './qr';
export type { QrParseResult, QrRejectReason, ParseQrOptions } from './qr';
export * from './transport';
export {
  CompanionClient,
  classifyProtocolUnsupported,
  defaultRequestId,
  DEFAULT_REQUEST_TIMEOUT_MS,
  NO_AUTO_RECONNECT_CLOSE_CODES,
} from './client';
export type {
  ClientEventMap,
  ClientOptions,
  ClientState,
  ClientTransportSource,
  ConnectOptions,
  ConnectionTarget,
  UpdateRequired,
} from './client';
export { SessionsStore, MAX_SESSIONS, MAX_SESSION_AGE_MS, toEpochMs } from './sessions';
export type { SessionSummary, SessionState, SessionSnapshot, SessionTab } from './sessions';
export {
  ApprovalCard,
  ApprovalCards,
  TERMINAL_STATUSES,
  approvalSourceFromFrame,
} from './approvals';
export type {
  ApprovalCardState,
  ApprovalCardStatus,
  ApprovalDecision,
  ApprovalReceiptOutcome,
  ApprovalResponder,
  ApprovalSource,
} from './approvals';
export { Outbox, defaultClientMsgId } from './outbox';
export type { CancelItem, OutboxDeps, OutboxFrame, OutboxItem, OutboxStatus, PromptItem } from './outbox';
export { HistoryStore, coerceHistoryMessage } from './history';
export type { HistoryMessage, HistoryPage, MessageRole } from './history';
export { Reconnector, backoffDelayMs, planResync, realClock, BACKOFF_DELAYS_MS, MAX_BACKOFF_MS, RESTART_DELAY_MS } from './reconnect';
export type { ReconnectClock, ReconnectSnapshot, ReconnectState, ResyncInput } from './reconnect';
export { redactArgsPreview, redactDiagnostic, redactFingerprint, redactString, redactValue, REDACTED } from './redact';
export type { RedactOptions } from './redact';
export { PAIRED_HOST_SCHEMA_VERSION, pairedHostFromPayload, isReconnectable, describeHost } from './host';
export type { PairedHost } from './host';
export { parseSessionDeepLink, sessionDeepLink } from './deeplink';
export type { SessionDeepLink } from './deeplink';
export { DebugLog } from './debug-log';
export type { LogLine, LogSink } from './debug-log';
