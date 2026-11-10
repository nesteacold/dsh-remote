// Error codes reported by the native `pinned-ws` module (Android + iOS must use exactly
// these strings; the Kotlin and Swift sources keep a hand-kept copy and the unit test
// `test/pinned-transport.test.ts` pins them).
//
// They live in the contract's app-local `client/*` namespace so a host code can never collide
// with them.

export const PINNED_WS_ERROR = {
  /** TLS identity established, but the leaf SHA-256 != `certSha256`. Nothing was sent. */
  pinMismatch: 'client/pin-mismatch',
  /** The URL is not `wss://` (ws/http/https/anything else). Nothing was sent. */
  insecureUrl: 'client/insecure-url',
  /**
   * The caller tried to set a header only the native layer may set (Host, Connection,
   * Upgrade, Sec-WebSocket-*). Nothing was sent.
   */
  insecureHeaders: 'client/insecure-headers',
  /** The server answered the HTTP upgrade with a non-101 status (see `status`). */
  upgradeFailed: 'client/upgrade-failed',
  /** DNS, TCP, TLS handshake or any other transport failure before/without a close frame. */
  connectFailed: 'client/connect-failed',
} as const;

export type PinnedWsErrorCode = (typeof PINNED_WS_ERROR)[keyof typeof PINNED_WS_ERROR];

export const PINNED_WS_ERROR_CODES: readonly string[] = Object.values(PINNED_WS_ERROR);
