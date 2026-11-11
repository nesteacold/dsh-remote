package expo.modules.pinnedws

import android.util.Log

/**
 * The module's single logcat tag (`adb logcat -s PinnedWs`): which socket was accepted, which
 * callback fired, which event was dropped and why.
 *
 * What a line MAY contain: [ref] — a bounded, sanitized, non-reversible reference to the socket
 * id, NEVER the id itself — an event name, booleans, counters, a close code and the LENGTH of a
 * close reason.
 *
 * What a line MUST NEVER contain: the caller-supplied socket id (caller input: it can hold
 * newlines, control or bidi characters, be arbitrarily long, or be a credential passed by
 * mistake), the peer's close reason (the peer controls that text: it can carry a token, an
 * identity or a newline), a bearer token, a pairing code, a header VALUE, a URL or its query, a
 * frame payload, certificate bytes or a certificate hash. This module carries the credentials of
 * every socket and logcat is readable from any debuggable-app context — the same rule as
 * [PinnedWsErrors], and header NAMES are the most a diagnostic may name.
 */
internal object PinnedWsLog {
  const val TAG = "PinnedWs"

  /**
   * Per-frame diagnostics are opt-in because `Log.d` is NOT stripped from a release APK: a hot
   * line is only built when this was already true. Arm it for a diagnostic run with
   * `adb shell setprop log.tag.PinnedWs DEBUG` (then restart the app).
   */
  val debugEnabled: Boolean = Log.isLoggable(TAG, Log.DEBUG)

  fun d(message: String) {
    Log.d(TAG, message)
  }

  /** A dropped event/frame or a refused call: exactly the cases that silently break the JS side. */
  fun w(message: String) {
    Log.w(TAG, message)
  }

  /**
   * A log-safe stand-in for a caller-supplied socket id: the first [REF_PREFIX_LIMIT] characters
   * that are `[A-Za-z0-9._-]` (every other character dropped), then `#` and 8 hex digits of a
   * 32-bit FNV-1a hash of the WHOLE id, e.g. `pw-17a2#3f9c1d04`.
   *
   * Bounded (at most [REF_PREFIX_LIMIT] + 9 chars), free of newlines/control/bidi characters and
   * no longer the id itself, so a crafted id cannot forge a log line and a mistakenly-passed
   * credential is never reproduced verbatim. Routing and lookup always use the real id; this is
   * logging only.
   */
  fun ref(id: String): String {
    val out = StringBuilder(REF_PREFIX_LIMIT + 9)
    for (index in id.indices) {
      if (out.length == REF_PREFIX_LIMIT) break
      val c = id[index]
      if (c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c == '.' || c == '_' || c == '-') {
        out.append(c)
      }
    }
    out.append('#')
    out.append(fnv1aHex(id))
    return out.toString()
  }

  /** 32-bit FNV-1a over the id's UTF-16 units, as exactly 8 lowercase hex digits. */
  private fun fnv1aHex(value: String): String {
    var hash = -0x7EE3623B // 0x811C9DC5, the FNV-1a 32-bit offset basis
    for (c in value) {
      hash = hash xor c.code
      hash *= FNV_PRIME
    }
    val out = StringBuilder(8)
    for (shift in 28 downTo 0 step 4) out.append(HEX[(hash ushr shift) and 0xf])
    return out.toString()
  }

  private const val REF_PREFIX_LIMIT = 12
  private const val FNV_PRIME = 0x01000193
  private const val HEX = "0123456789abcdef"
}
