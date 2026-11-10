package expo.modules.pinnedws

import java.net.URI
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSession
import javax.net.ssl.X509TrustManager
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * One pinned WebSocket: the per-connection OkHttp plumbing plus the frame/state rules.
 *
 * Hard rules encoded here:
 *  1. `wss://` only. The scheme is checked before the request is built, so a caller can never
 *     downgrade to cleartext `ws://`.
 *  2. One [OkHttpClient] per connection, built from a fresh [PinnedTrustManager] and a fresh
 *     [SSLContext]. Nothing (connection pool, trust manager, cookie jar, dispatcher) is shared
 *     with another socket: a socket's identity can never leak into another handshake, and a
 *     closed socket leaves no pooled TLS connection a later, differently pinned, call could
 *     pick up.
 *  3. The pin is the only anchor ([PinnedTrustManager]); [identityHostnameVerifier] explains
 *     why a hostname check is not only unnecessary but would be wrong here.
 *  4. Subprotocols are written to `Sec-WebSocket-Protocol` as an explicit header, and the
 *     negotiated value is read back from the 101 response's `Sec-WebSocket-Protocol`.
 *  5. Text frames only (the companion contract is JSON text); `send` before open is refused.
 *
 * Threading and locking (N3): [webSocket], [closed], [opened], [released] and the two diagnostic
 * counters ([received], [sendRefused]) are guarded by [stateLock]. Nothing else may read or write
 * them. Lock order: the registry lock may be held
 * while `start`/`close`/`send` are *called*, but this class never calls back into the registry
 * while holding [stateLock] — [emit] only hands the event to the registry's sink, which posts it
 * to the main looper and takes the registry lock later, on the main thread, never nested here.
 * No JS emission and no listener callback happens under [stateLock].
 *
 * The lock is what makes `start`/`close` atomic: creating the OkHttp socket and observing
 * [closed] happen in one critical section, so a `close(id)` racing a `connect(id)` can never
 * leave a dial behind (close wins => no socket is created) and a socket that already exists is
 * closed, never orphaned. OkHttp only *enqueues* the call from `newWebSocket`; it never invokes
 * a [WebSocketListener] inline, so holding the lock across creation cannot re-enter this class.
 */
internal class PinnedWsConnection(
  private val id: String,
  rawUrl: String,
  certSha256: String,
  protocols: List<String>,
  headers: Map<String, String>,
  /** Single sink for every event of this socket (the registry marshals it to JS). */
  private val emit: (PinnedWsEvent) -> Unit
) {
  private val trustManager = PinnedTrustManager(certSha256)
  private val client: OkHttpClient
  private val request: Request

  /** Guards every mutable field below; see the class comment for the lock order. */
  private val stateLock = Any()

  private var webSocket: WebSocket? = null

  /** Set by `close()`; no event is emitted for the socket after it. */
  private var closed = false

  /** True only between the 101 response and the close: `send` is refused before this. */
  private var opened = false

  /** Set once by [releaseClientOnce], so the OkHttp client is shut down exactly once. */
  private var released = false

  /** Frames received on this socket; monotonic, diagnostics only (the payload is never kept). */
  private var received = 0L

  /** `send` calls refused because the socket was not open yet; diagnostics only. */
  private var sendRefused = 0L

  init {
    // A malformed pin can never match; the registry refuses it before constructing us, and this
    // guard keeps the invariant if the class is ever used directly.
    if (!PinnedTrustManager.isWellFormedPin(certSha256)) {
      throw PinnedWsRefusal(PinnedWsErrors.PIN_MISMATCH, PinnedWsMessages.BAD_PIN)
    }
    val uri = parseWssUri(rawUrl)
    client = buildClient(trustManager)
    request = buildRequest(uri, protocols, headers)
  }

  /**
   * Create and start the socket, unless [close] already ran.
   *
   * The closed check and the creation share [stateLock], so this is atomic against a concurrent
   * `close(id)`: either close wins and this method never dials, or the socket exists and the
   * close observes it and cancels it. A `start()` after `close()` is therefore a no-op rather
   * than a socket spawned after the JS side finished the id.
   */
  fun start() {
    // OkHttp only enqueues here; listener callbacks run on its own threads and cannot re-enter
    // this call, so holding the lock across creation is safe and makes the two steps atomic.
    val started = try {
      synchronized(stateLock) {
        if (closed) {
          false
        } else {
          webSocket = client.newWebSocket(request, Listener())
          true
        }
      }
    } catch (error: Throwable) {
      PinnedWsLog.w("start id=${PinnedWsLog.ref(id)} threw=${error.javaClass.name}")
      failBeforeOpen(error)
      return
    }
    if (!started) {
      // `close()` won the race: no socket was created, and none may be created later.
      PinnedWsLog.w("start id=${PinnedWsLog.ref(id)} skipped=already-closed")
      return
    }
    PinnedWsLog.d("start id=${PinnedWsLog.ref(id)} dial-dispatched")
  }

  /**
   * Queue one text frame. Returns false when the socket is not open (nothing is written) or
   * when OkHttp refuses the frame.
   */
  fun send(text: String): Boolean {
    var refused = 0L
    var reason = ""
    val socket = synchronized(stateLock) {
      if (!opened || closed) {
        sendRefused += 1
        refused = sendRefused
        reason = if (closed) "closed" else "not-open"
        null
      } else {
        webSocket
      }
    }
    if (socket == null) {
      // Always emitted (never gated): a write refused before open is indistinguishable from a
      // delivered frame on the JS side, so this line must appear without arming DEBUG. The line
      // carries the refusal reason, the counter and the length only — never the frame.
      PinnedWsLog.w(
        "send id=${PinnedWsLog.ref(id)} dropped=$reason count=$refused chars=${text.length}"
      )
      return false
    }
    return try {
      val accepted = socket.send(text)
      if (!accepted) {
        // Always emitted: OkHttp refused the frame, so the JS caller got `true` for a frame that
        // never went out. Length only.
        PinnedWsLog.w("send id=${PinnedWsLog.ref(id)} dropped=okhttp-refused chars=${text.length}")
      } else if (PinnedWsLog.debugEnabled) {
        // Per-write: gated, and only built when armed.
        PinnedWsLog.d("send id=${PinnedWsLog.ref(id)} ok chars=${text.length}")
      }
      accepted
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * Close the socket (or the attempt). Idempotent and atomic against [start]: it either cancels
   * the socket that [start] created, or marks this connection closed before [start] can create
   * one — never both.
   */
  fun close(code: Int, reason: String) {
    var first = false
    val socket = synchronized(stateLock) {
      if (closed) {
        null
      } else {
        closed = true
        opened = false
        first = true
        webSocket
      }
    }
    // `reason` is caller text ("not-started", "module-destroyed", JS): length only, no content.
    PinnedWsLog.d(
      "close id=${PinnedWsLog.ref(id)} code=$code reasonLen=${reason.length} " +
        "first=$first socket=${socket != null}"
    )
    if (socket != null) {
      try {
        socket.close(code, reason.take(MAX_REASON_LENGTH))
      } catch (_: Throwable) {
        socket.cancel()
      }
    } else {
      // start() has not run (or won its race and saw `closed`): cancel any queued work so no
      // attempt can outlive the JS side. A repeated close() lands here too; it is a no-op.
      client.dispatcher.cancelAll()
    }
    releaseClientOnce()
  }

  // -------------------------------------------------------------------------

  private inner class Listener : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      // Only reachable after the TLS handshake succeeded, i.e. after the pin matched.
      val negotiated = response.header("Sec-WebSocket-Protocol")
      val live = synchronized(stateLock) {
        if (closed || this@PinnedWsConnection.webSocket !== webSocket) {
          false
        } else {
          opened = true
          true
        }
      }
      if (!live) {
        // `close()` ran first (or a callback from a socket that is not the live one): make sure
        // this socket cannot outlive the id.
        PinnedWsLog.w("onOpen id=${PinnedWsLog.ref(id)} dropped=not-live")
        webSocket.cancel()
        return
      }
      PinnedWsLog.d(
        "onOpen id=${PinnedWsLog.ref(id)} pinMatched=${trustManager.lastPinMatched} " +
          "validityOk=${trustManager.lastValidityOk} protocolNegotiated=${negotiated != null}"
      )
      emit(PinnedWsEvent.Open(id, negotiated?.takeIf { it.isNotBlank() }))
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      var refused = "foreign-socket"
      var count = 0L
      val live = synchronized(stateLock) {
        when {
          closed -> {
            refused = "closed"
            false
          }
          !opened -> {
            refused = "not-opened"
            false
          }
          this@PinnedWsConnection.webSocket !== webSocket -> {
            refused = "foreign-socket"
            false
          }
          else -> {
            received += 1
            count = received
            true
          }
        }
      }
      if (!live) {
        // Per-frame: gated (checked before any string is built), id only in its [PinnedWsLog.ref] form.
        if (PinnedWsLog.debugEnabled) {
          PinnedWsLog.w("onMessage id=${PinnedWsLog.ref(id)} dropped=$refused chars=${text.length}")
        }
        return
      }
      // Type and size only: the frame is the gateway's JSON (it can carry a token or an approval).
      // `chars` is String.length (UTF-16 units), not an encoded byte count.
      if (PinnedWsLog.debugEnabled) {
        PinnedWsLog.d(
          "onMessage id=${PinnedWsLog.ref(id)} type=text chars=${text.length} received=$count"
        )
      }
      emit(PinnedWsEvent.Message(id, text))
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      PinnedWsLog.d("onClosing id=${PinnedWsLog.ref(id)} code=$code reasonLen=${reason.length}")
      // Acknowledge the peer's close frame; `onClosed` reports it.
      try {
        webSocket.close(1000, null)
      } catch (_: Throwable) {
        // already going away
      }
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      if (!transitionToTerminal(webSocket)) return
      val reported = reason.take(MAX_REASON_LENGTH)
      // The peer chooses this text: it can carry a token, an identity or a newline, so only its
      // length is logged. The JS side still receives `reported` itself.
      PinnedWsLog.d("onClosed id=${PinnedWsLog.ref(id)} code=$code reasonLen=${reported.length}")
      emit(PinnedWsEvent.Close(id, code, reported))
      releaseClientOnce()
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      if (!transitionToTerminal(webSocket)) return
      val status = response?.code
      val seen = synchronized(stateLock) { received }
      // Exception classes, TLS booleans, counts — never the exception message (it can hold a URL
      // or the pinned host) and never certificate material.
      PinnedWsLog.w(
        "onFailure id=${PinnedWsLog.ref(id)} exception=${t.javaClass.name} " +
          "cause=${t.cause?.javaClass?.name} " +
          "status=$status pinMatched=${trustManager.lastPinMatched} " +
          "validityOk=${trustManager.lastValidityOk} received=$seen"
      )
      if (status != null && status != 101) {
        // The upgrade was answered with 401/403/... — surface the status so the client maps it
        // to auth/required or remote/disabled (contract §3/§6).
        emit(PinnedWsEvent.Error(id, PinnedWsError(PinnedWsErrors.UPGRADE_FAILED, PinnedWsMessages.UPGRADE_FAILED, status = status)))
      } else {
        emit(classify(t))
      }
      emit(PinnedWsEvent.Close(id, CLOSE_ABNORMAL, ""))
      releaseClientOnce()
    }
  }

  /**
   * Marks the socket terminal and returns true exactly once per live socket. Every terminal
   * callback (`onClosed`, `onFailure`) goes through it, so a socket that JS already closed, or a
   * callback for a socket that is not the live one, cannot produce a second `onClose`.
   */
  private fun transitionToTerminal(socket: WebSocket): Boolean {
    var terminal = false
    synchronized(stateLock) {
      opened = false
      if (!closed && webSocket === socket) {
        closed = true
        terminal = true
      }
    }
    if (!terminal) {
      PinnedWsLog.w("terminal id=${PinnedWsLog.ref(id)} ignored=already-closed-or-foreign-socket")
    }
    return terminal
  }

  /**
   * Map a pre-open failure to a JS error. A pin mismatch and a pin-matched but out-of-window
   * leaf both stay on the pin-failure path (matching the Node transport and iOS): the pin
   * proves identity, not that the host owner extended the certificate.
   */
  private fun classify(error: Throwable): PinnedWsEvent {
    var current: Throwable? = error
    var pinFailure = false
    var pinFailureMessage = PinnedWsMessages.PIN_MISMATCH
    while (current != null) {
      val message = current.message ?: ""
      if (message.contains(PinnedWsMessages.PIN_MISMATCH) || message.contains(PinnedWsMessages.NO_CERTIFICATE)) {
        pinFailure = true
        break
      }
      val expiredOrNotYetValid =
        message.contains(PinnedWsMessages.PINNED_CERTIFICATE_EXPIRED) ||
          message.contains(PinnedWsMessages.PINNED_CERTIFICATE_NOT_YET_VALID)
      if (expiredOrNotYetValid) {
        pinFailure = true
        pinFailureMessage = message
        break
      }
      current = current.cause
    }
    return if (pinFailure) {
      PinnedWsEvent.Error(
        id,
        PinnedWsError(PinnedWsErrors.PIN_MISMATCH, pinFailureMessage, observedSha256 = trustManager.observedSha256Hex)
      )
    } else {
      PinnedWsEvent.Error(id, PinnedWsError(PinnedWsErrors.CONNECT_FAILED, PinnedWsMessages.CONNECT_FAILED))
    }
  }

  /** A refusal detected before any I/O: one error, then the synthetic close. */
  private fun failBeforeOpen(error: Throwable) {
    var first = false
    synchronized(stateLock) {
      if (!closed) {
        closed = true
        opened = false
        first = true
      }
    }
    if (!first) return
    val refusal = error as? PinnedWsRefusal
    PinnedWsLog.w(
      "refused id=${PinnedWsLog.ref(id)} exception=${error.javaClass.name} phase=before-any-io"
    )
    emit(
      PinnedWsEvent.Error(
        id,
        if (refusal != null) PinnedWsError(refusal.code, refusal.message)
        else PinnedWsError(PinnedWsErrors.CONNECT_FAILED, PinnedWsMessages.CONNECT_FAILED)
      )
    )
    emit(PinnedWsEvent.Close(id, CLOSE_ABNORMAL, ""))
    releaseClientOnce()
  }

  /** Shut the per-connection OkHttp client down exactly once, from whichever path finishes last. */
  private fun releaseClientOnce() {
    var release = false
    synchronized(stateLock) {
      if (!released) {
        released = true
        release = true
      }
    }
    if (release) releaseClient()
  }

  private fun releaseClient() {
    try {
      client.dispatcher.executorService.shutdown()
    } catch (_: Throwable) {
      // dispatcher already gone
    }
    client.connectionPool.evictAll()
  }

  private fun buildClient(trust: PinnedTrustManager): OkHttpClient {
    val sslContext = SSLContext.getInstance("TLS")
    // Only the pinned trust manager: no default trust store, no system CAs, no user CAs.
    sslContext.init(null, arrayOf<X509TrustManager>(trust), SecureRandom())
    return OkHttpClient.Builder()
      .sslSocketFactory(sslContext.socketFactory, trust)
      .hostnameVerifier(identityHostnameVerifier)
      // A refused or failed attempt must be reported, never silently retried/redirected.
      .retryOnConnectionFailure(false)
      .followSslRedirects(false)
      .followRedirects(false)
      // Per-connection client: keep nothing alive for a later, differently pinned, socket.
      .connectionPool(ConnectionPool(1, 1, TimeUnit.SECONDS))
      .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      .readTimeout(READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      .writeTimeout(WRITE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      // Keep-alive pings are the app's job (`ping` op, every 25 s): OkHttp cannot send
      // application frames, and a native ping would not refresh the JS-side liveness timer.
      .pingInterval(0, TimeUnit.MILLISECONDS)
      .build()
  }

  private fun buildRequest(uri: URI, protocols: List<String>, headers: Map<String, String>): Request {
    val builder = Request.Builder().url(uri.toASCIIString())
    val used = HashSet<String>(protocols.size + headers.size)
    for ((name, value) in headers) {
      if (!isAllowedHeader(name)) throw PinnedWsRefusal(PinnedWsErrors.INSECURE_HEADERS, PinnedWsMessages.BAD_HEADER_NAME)
      if (!used.add(name.trim().lowercase())) {
        throw PinnedWsRefusal(PinnedWsErrors.INSECURE_HEADERS, PinnedWsMessages.BAD_HEADER_NAME)
      }
      builder.addHeader(name.trim(), value)
    }
    val offered = protocols.map { it.trim() }.filter { it.isNotEmpty() }
    if (offered.isNotEmpty()) {
      for (protocol in offered) requireProtocolToken(protocol)
      if (!used.add("sec-websocket-protocol")) {
        throw PinnedWsRefusal(PinnedWsErrors.INSECURE_HEADERS, PinnedWsMessages.BAD_HEADER_NAME)
      }
      builder.addHeader("Sec-WebSocket-Protocol", offered.joinToString(", "))
    }
    return builder.build()
  }

  companion object {
    const val CLOSE_ABNORMAL = 1006
    private const val MAX_REASON_LENGTH = 123
    private const val CONNECT_TIMEOUT_MS = 12_000L
    private const val READ_TIMEOUT_MS = 40_000L
    private const val WRITE_TIMEOUT_MS = 10_000L

    /**
     * OK because identity is established elsewhere, completely: the TLS connection is only
     * established when the leaf certificate's SHA-256 equals the pin from the pairing QR
     * ([PinnedTrustManager]). A hostname check here would compare a SAN against a LAN IP or
     * tunnel host that the gateway's self-signed leaf does not certify, so it could only add
     * false failures for legitimately reached hosts — while a matching leaf pin is a strictly
     * stronger identity than any DNS name. Reaching this verifier at all already required the
     * pin. Never reuse this class with a client that is not pinned.
     */
    val identityHostnameVerifier = HostnameVerifier { _: String?, _: SSLSession? -> true }

    /**
     * Headers a caller may never set: the upgrade machinery belongs to OkHttp, and an
     * `Authorization`/`X-DSH-Device-ID` supplied by a caller is fine (the client needs them),
     * but duplicates and anything that rewrites the handshake are refused.
     */
    private val FORBIDDEN_HEADERS = setOf(
      "host",
      "connection",
      "upgrade",
      "content-length",
      "transfer-encoding",
      "proxy-connection"
    )

    fun isAllowedHeader(name: String): Boolean {
      val lower = name.trim().lowercase()
      if (lower.isEmpty()) return false
      if (lower in FORBIDDEN_HEADERS) return false
      if (lower.startsWith("sec-websocket-")) return false
      return lower.all { c -> c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '_' || c == '.' }
    }

    /** RFC 6455 §4.1: a subprotocol is an RFC 7230 `token`. */
    private fun requireProtocolToken(value: String) {
      val ok = value.isNotEmpty() && value.length <= MAX_PROTOCOL_LENGTH && value.all { c ->
        c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || PROTOCOL_PUNCTUATION.contains(c)
      }
      if (!ok) throw PinnedWsRefusal(PinnedWsErrors.INSECURE_HEADERS, PinnedWsMessages.BAD_HEADER_NAME)
    }

    private const val MAX_PROTOCOL_LENGTH = 128
    private const val PROTOCOL_PUNCTUATION = "!#$%&'*+-.^_`|~"

    /**
     * Parse and enforce the transport rule before any I/O: `wss://` only, with a host and no
     * embedded credentials. `ws://`, `http://`, `file://` and a missing scheme refuse here.
     */
    fun parseWssUri(raw: String): URI {
      val trimmed = raw.trim()
      if (!trimmed.startsWith("wss://", ignoreCase = true)) {
        throw PinnedWsRefusal(PinnedWsErrors.INSECURE_URL, PinnedWsMessages.INSECURE_URL)
      }
      val uri = try {
        URI(trimmed)
      } catch (_: Exception) {
        throw PinnedWsRefusal(PinnedWsErrors.INSECURE_URL, PinnedWsMessages.BAD_URL)
      }
      if (!uri.scheme.equals("wss", ignoreCase = true)) {
        throw PinnedWsRefusal(PinnedWsErrors.INSECURE_URL, PinnedWsMessages.INSECURE_URL)
      }
      if (uri.host.isNullOrBlank()) {
        throw PinnedWsRefusal(PinnedWsErrors.INSECURE_URL, PinnedWsMessages.BAD_URL)
      }
      if (uri.userInfo != null) {
        // Credentials in the URL are refused by the contract (§3.2/§3.4) and by OkHttp.
        throw PinnedWsRefusal(PinnedWsErrors.INSECURE_URL, PinnedWsMessages.BAD_URL)
      }
      val port = uri.port
      if (port != -1 && (port < 1 || port > 65535)) {
        throw PinnedWsRefusal(PinnedWsErrors.INSECURE_URL, PinnedWsMessages.BAD_URL)
      }
      return uri
    }
  }
}

/** A refusal detected before any I/O: reported as `onError` + a synthetic close. */
internal class PinnedWsRefusal(val code: String, override val message: String) : Exception(message)

/** Events marshalled from the OkHttp callbacks to the JS event queue. */
internal sealed class PinnedWsEvent {
  /** The caller-chosen socket id; every event routes by it (and by generation, in the registry). */
  abstract val id: String

  data class Open(override val id: String, val protocol: String?) : PinnedWsEvent()
  data class Message(override val id: String, val text: String) : PinnedWsEvent()
  data class Close(override val id: String, val code: Int, val reason: String) : PinnedWsEvent()
  data class Error(override val id: String, val error: PinnedWsError) : PinnedWsEvent()
}
