// Contract constants and types for the core.
//
// Source of truth: `@dsh-ext/mobile-protocol` (contract v1, revision 2), which parses
// specs/001-gateway-hardening/contracts/mobile-protocol-v1.md and fails on drift. This module
// only re-exports that surface under the names the core uses and adds the app-local vocabulary
// (client error codes, session tabs) that the contract does not own. No op name is ever
// redefined here — FR-005.
//
// Pure: no react-native, no expo, no Node built-ins.

import type {
  ApprovalRequestedFrame,
  ApprovalResponseRejected,
  ClientApprovalOutcome,
  ContractErrorCode,
  DeviceInfo,
  ErrorFrame,
  HelloFrame,
  PairedFrame,
  PairingPayload,
  SessionRow,
} from '@dsh-ext/mobile-protocol';

export {
  APPROVAL_OUTCOMES_CLIENT,
  APPROVAL_OUTCOMES_FINAL,
  CAPABILITIES,
  CLOSE_CODES,
  COMPANION_PROTOCOL_VERSION,
  DEVICE_ID_HEADER,
  ERROR_CODES,
  MIN_CLIENT_VERSION,
  OP_RESPONSES,
  OPS,
  OPTIONAL_CAPABILITIES,
  PAIRING_QR_VERSION,
  PASSTHROUGH_ERROR_CODES,
  PING_INTERVAL_MS,
  PROTOCOL_SUBPROTOCOL,
  RECEIPT_REASONS,
  SERVER_PUSH_KINDS,
  SUBPROTOCOL_PREFIXES,
  authSubprotocols,
  deviceSubprotocol,
  pairingSubprotocols,
} from '@dsh-ext/mobile-protocol';

export type {
  ApprovalRequestedFrame,
  ApprovalResolvedFrame,
  ApprovalResponseFrame,
  ApprovalResponseReceipt,
  ApprovalResponseRejected,
  ClientApprovalOutcome,
  ClientFrame,
  ClientHelloFrame,
  ContractErrorCode,
  DeviceInfo,
  ErrorFrame,
  FinalApprovalOutcome,
  HelloFrame,
  MessageFrame,
  Op,
  PairedFrame,
  PairingPayload,
  ReceiptReason,
  ResponseKind,
  SearchFrame,
  SentFrame,
  SessionCancelledFrame,
  SessionRow,
  SessionsFrame,
} from '@dsh-ext/mobile-protocol';

/** Decoded, validated pairing QR payload (contract §2, `version: 3`). */
export type PairingQr = PairingPayload;

/** Server → client approval receipt of a decision. */
export type ApprovalReceipt = import('@dsh-ext/mobile-protocol').ApprovalResponseReceipt;

/** Server → client refusal of a decision (`accepted: false`). */
export type ApprovalRefusal = ApprovalResponseRejected;

/** `hello` as the core stores it. */
export type ServerHello = HelloFrame;

/** `paired` as the core reports it. */
export type PairingPaired = PairedFrame;

/** Error frame as the core reports it. */
export type ServerErrorFrame = ErrorFrame;

/** Approval push as the core reports it. */
export type ApprovalPush = ApprovalRequestedFrame;

/** Session row from `sessions`/`search`. */
export type ContractSessionRow = SessionRow;

/** Approval outcomes the app may send. */
export type ApprovalOutcome = ClientApprovalOutcome;

export const SESSION_STATES = ['running', 'idle', 'archived'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Device info as the core exposes it. */
export type ClientDeviceInfo = DeviceInfo;

/** Contract error codes that the app handles specially. */
export const SPECIAL_ERROR_CODES = {
  revoked: 'auth/revoked',
  required: 'auth/required',
  remoteDisabled: 'remote/disabled',
  pairingExpired: 'pairing/expired',
  protocolUnsupported: 'protocol/unsupported',
  opForbidden: 'op/forbidden',
  badRequest: 'bad-request',
  sessionNotFound: 'session-not-found',
} as const satisfies Record<string, ContractErrorCode>;

/**
 * App-local error codes (not part of the host contract). Namespaced with `client/` so they can
 * never collide with a host code; kept here so block UIs/tests share one vocabulary.
 */
export const CLIENT_ERROR_CODES = [
  /** TLS leaf fingerprint != QR certSha256 — nothing was sent. */
  'client/pin-mismatch',
  /** Internal invariant violated by a caller (programming error). */
  'client/bad-state',
  /** A request got no response within its timeout. */
  'client/timeout',
  /** The socket closed before the request completed. */
  'client/disconnected',
  /** Frame was not UTF-8 JSON, or did not have the expected shape. */
  'client/bad-message',
  /** Host answered `protocol/unsupported`: the app must be updated. */
  'client/update-app-required',
  /** Host answered `protocol/unsupported`: the host must be updated. */
  'client/update-host-required',
  /** The device was revoked: the credential must be wiped and the app re-paired. */
  'client/revoked',
  /** The owner switched remote control off on the host (close 4004). */
  'client/gateway-disabled',
  /** The gateway was disabled over an in-band error (`remote/disabled`). */
  'client/remote-disabled',
  /** The host asked the client to re-authenticate (close 4003). */
  'client/reauth-required',
  /** No pinned transport is installed yet (Phase 4, A030). */
  'client/pinned-transport-unavailable',
  /** No device token in secure storage for the stored host. */
  'client/not-paired',
] as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];
