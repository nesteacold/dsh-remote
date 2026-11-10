import Foundation

/**
 Error codes reported through `onError`. Identical strings to `src/errors.ts` and the Android
 `PinnedWsErrors`; the JS unit test pins the values.

 Never put a URL, query string, header value, subprotocol or frame content into a message:
 these reach the app's diagnostics and the pairing screen.
 */
enum PinnedWsErrorCode: String {
  /// Leaf certificate SHA-256 != pin: the challenge is cancelled, nothing was sent.
  case pinMismatch = "client/pin-mismatch"
  /// URL scheme is not `wss://`.
  case insecureUrl = "client/insecure-url"
  /// Caller tried to set a header only the native layer may set.
  case insecureHeaders = "client/insecure-headers"
  /// The HTTP upgrade was refused with a status other than 101.
  case upgradeFailed = "client/upgrade-failed"
  /// Name resolution / TCP / TLS / protocol failure without a peer close frame.
  case connectFailed = "client/connect-failed"
}

/// Fixed, secret-free message strings.
enum PinnedWsMessage {
  static let pinMismatch = "The server certificate does not match the pinned fingerprint"
  static let noCertificate = "The server presented no certificate"
  static let badPin = "The pinned fingerprint is not a SHA-256 hex digest"
  /// Pin matched, but the leaf's validity window does not cover the device clock.
  static let pinnedCertificateExpired = "The pinned certificate has expired"
  static let pinnedCertificateNotYetValid = "The pinned certificate is not valid yet"
  /// Pin matched, but the leaf's validity field could not be read. Fail closed.
  static let pinnedCertificateUnreadable = "The pinned certificate validity could not be read"
  static let insecureUrl = "Only wss:// URLs are allowed"
  static let badUrl = "The URL is not valid"
  static let badHeader = "A forbidden header was requested"
  static let alreadyConnected = "A socket with this id already exists"
  static let badId = "The socket id is empty"
  static let notOpen = "The socket is not open"
  static let upgradeFailed = "The WebSocket upgrade was refused"
  static let connectFailed = "The connection failed"
  static let responseNotWebSocket = "The server did not upgrade to a WebSocket"
}

/// Event names; must match `PinnedWsEvents` in `src/events.ts` and the Android emitter.
enum PinnedWsEventName {
  static let open = "onOpen"
  static let message = "onMessage"
  static let close = "onClose"
  static let error = "onError"
  static let all = [open, message, close, error]
}

/// Close code for a socket that never opened (mirrors the WebSocket spec's 1006).
let PINNED_WS_CLOSE_ABNORMAL = 1006
/// WebSocket close reasons are capped at 123 UTF-8 bytes by RFC 6455.
let PINNED_WS_MAX_REASON_BYTES = 123
