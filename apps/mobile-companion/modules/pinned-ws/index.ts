// Public JS surface of the `pinned-ws` local Expo module (A030).
//
// It is an Expo module, NOT a `WebSocket` polyfill: every function takes the socket `id` the
// caller chose, so one module instance can hold several sockets at once (pairing + a live
// connection + a retry) and the caller routes the events by id.
//
// Security contract (both platforms, see android/ and ios/):
//   * only `wss://` URLs are accepted — anything else is refused before any I/O;
//   * the TLS handshake is accepted ONLY when the SHA-256 of the server's leaf certificate
//     DER equals the caller's `certSha256` (constant-time compare). There is no CA fallback,
//     no hostname identity, no user-installed CA and no "allow invalid" switch;
//   * the pin is checked inside the handshake, i.e. before the HTTP upgrade request (and its
//     `Sec-WebSocket-Protocol` / `Authorization` / `X-DSH-Device-ID` headers) is sent;
//   * a non-101 upgrade response is reported with its HTTP status (`client/upgrade-failed`).

export {
  PinnedWsEvents,
  PINNED_WS_EVENT_NAMES,
  addPinnedWsListener,
  type PinnedWsEventMap,
  type PinnedWsOpenEvent,
  type PinnedWsMessageEvent,
  type PinnedWsCloseEvent,
  type PinnedWsErrorEvent,
  type PinnedWsAdapter,
  type PinnedWsEventName,
} from './src/events';

/** Error codes the native side reports in `onError` (`code` field). */
export { PINNED_WS_ERROR, PINNED_WS_ERROR_CODES, type PinnedWsErrorCode } from './src/errors';

export {
  PINNED_WS_MODULE_NAME,
  getPinnedWsModule,
  isPinnedWsAvailable,
  requirePinnedWsAdapter,
  resetPinnedWsCache,
} from './src/PinnedWsModule';

/** Default export: the native module, or `null` in Expo Go / web / tests (never throws). */
export { default } from './src/PinnedWsModule';
