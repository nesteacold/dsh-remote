package expo.modules.pinnedws

/**
 * Error codes the native side reports through `onError`. They MUST stay identical to
 * `modules/pinned-ws/src/errors.ts` (Android, iOS and JS all spell the same strings); the
 * JS unit test pins the values.
 *
 * Never put a URL, a query string, a header value, a subprotocol or a frame into a message:
 * this code ends up in the app's redacted diagnostics and, on the pairing screen, on screen.
 */
internal object PinnedWsErrors {
  /** Leaf certificate SHA-256 != pin. The TLS handshake is aborted; nothing was sent. */
  const val PIN_MISMATCH = "client/pin-mismatch"

  /** URL scheme is not wss:// (ws://, http://, or anything else). No I/O happened. */
  const val INSECURE_URL = "client/insecure-url"

  /** Caller tried to set a header only the native WebSocket layer may set. No I/O happened. */
  const val INSECURE_HEADERS = "client/insecure-headers"

  /** The HTTP upgrade was refused with a status other than 101 (see `status`). */
  const val UPGRADE_FAILED = "client/upgrade-failed"

  /** DNS / TCP / TLS / protocol failure without a peer close frame. */
  const val CONNECT_FAILED = "client/connect-failed"
}

/** One error as delivered to JS (`onError`). */
internal data class PinnedWsError(
  val code: String,
  val message: String,
  val status: Int? = null,
  val observedSha256: String? = null
)

/** Message texts: fixed, secret-free strings only. */
internal object PinnedWsMessages {
  const val PIN_MISMATCH = "The server certificate does not match the pinned fingerprint"
  const val NO_CERTIFICATE = "The server presented no certificate"
  const val PINNED_CERTIFICATE_EXPIRED = "The pinned certificate has expired"
  const val PINNED_CERTIFICATE_NOT_YET_VALID = "The pinned certificate is not valid yet"
  const val BAD_PIN = "The pinned fingerprint is not a SHA-256 hex digest"
  const val INSECURE_URL = "Only wss:// URLs are allowed"
  const val BAD_URL = "The URL is not valid"
  const val BAD_HEADER_NAME = "A forbidden header was requested"
  const val ALREADY_CONNECTED = "A socket with this id already exists"
  const val BAD_ID = "The socket id is empty"
  const val BACKPRESSURE = "The socket buffer is full; the frame was not queued"
  const val NOT_OPEN = "The socket is not open"
  const val UPGRADE_FAILED = "The WebSocket upgrade was refused"
  const val CONNECT_FAILED = "The connection failed"
}
