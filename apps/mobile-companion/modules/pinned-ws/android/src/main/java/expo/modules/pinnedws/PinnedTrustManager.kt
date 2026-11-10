package expo.modules.pinnedws

import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateExpiredException
import java.security.cert.CertificateNotYetValidException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedTrustManager

/**
 * The identity of the DSH Host, and the ONLY thing that can make this module trust a TLS peer:
 * the SHA-256 of the server's LEAF certificate DER bytes, from the pairing QR (contract §2
 * `certSha256`), compared in constant time.
 *
 * Deliberate properties (do not "improve" any of them):
 *  * no system / CA trust store is consulted — a certificate signed by a public CA or by a
 *    user-installed CA is accepted only if its leaf hash matches;
 *  * no hostname check — the gateway is reached by LAN IP / tunnel with a self-signed leaf, so
 *    the pin *is* the identity (see `PinnedWsConnection.identityHostnameVerifier`);
 *  * no code path returns success without a pin, and there is no "allow invalid" flag.
 *
 * The check runs inside the TLS handshake (`X509ExtendedTrustManager.checkServerTrusted` with
 * an [SSLEngine]), i.e. BEFORE OkHttp writes the HTTP upgrade request. A mismatch throws, the
 * handshake is aborted and no `Sec-WebSocket-Protocol` / `Authorization` / `X-DSH-Device-ID`
 * byte ever reaches the network.
 */
class PinnedTrustManager(private val expectedSha256Hex: String) : X509ExtendedTrustManager() {

  /** What the peer actually presented on the last handshake; diagnostics only. */
  @Volatile
  var observedSha256Hex: String? = null
    private set

  /**
   * Diagnostics only: did the last handshake's pin comparison match? Never the hash, the pin or
   * the certificate — [PinnedWsConnection] logs these two booleans with its socket id, which is
   * what tells "TLS challenge passed/failed" apart from "the socket broke later".
   */
  @Volatile
  var lastPinMatched: Boolean = false
    private set

  /** Diagnostics only: was the pinned leaf inside its validity window on the last handshake? */
  @Volatile
  var lastValidityOk: Boolean = false
    private set

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) {
    // The SSLEngine overload is the one OkHttp calls; the plain overloads below forward here.
    verifyPinned(chain)
  }

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    verifyPinned(chain)
  }

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: java.net.Socket?) {
    verifyPinned(chain)
  }

  /**
   * Not used: the value is always pin-anchored. Implemented because the class is abstract.
   */
  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    throw CertificateException("pinned-ws does not authenticate TLS clients")
  }

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: java.net.Socket?) {
    throw CertificateException("pinned-ws does not authenticate TLS clients")
  }

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) {
    throw CertificateException("pinned-ws does not authenticate TLS clients")
  }

  private fun verifyPinned(chain: Array<out X509Certificate>?) {
    // chain[0] is the leaf, exactly as the peer sent it: the same DER the QR fingerprint was
    // computed from (contract §2 / Node transport `getPeerCertificate().raw`).
    lastPinMatched = false
    lastValidityOk = false
    val leaf: X509Certificate = chain?.firstOrNull()
      ?: run {
        PinnedWsLog.w("tls pinMatched=false validityOk=false refused=no-certificate")
        throw CertificateException(PinnedWsMessages.NO_CERTIFICATE)
      }

    val observed = sha256Hex(leaf.encoded)
    observedSha256Hex = observed
    val matched = constantTimeEquals(expectedSha256Hex, observed)
    lastPinMatched = matched
    if (!matched) {
      // Booleans only: the two hashes stay out of logcat.
      PinnedWsLog.w("tls pinMatched=false validityOk=false refused=pin-mismatch")
      throw CertificateException(PinnedWsMessages.PIN_MISMATCH)
    }
    // Validity window: the pin proves identity, not that the host owner extended the cert. An
    // expired pinned leaf is a rotated/expired identity and must surface as a pin failure
    // rather than silently keep working (contract §2 pin + §3 "before sending anything").
    try {
      leaf.checkValidity()
    } catch (expired: CertificateExpiredException) {
      // Fixed text: `PinnedWsConnection.classify` recognizes it and keeps the refusal on the
      // pin-failure path instead of reporting a generic connect failure.
      PinnedWsLog.w("tls pinMatched=true validityOk=false refused=expired")
      throw CertificateException(PinnedWsMessages.PINNED_CERTIFICATE_EXPIRED)
    } catch (notYetValid: CertificateNotYetValidException) {
      PinnedWsLog.w("tls pinMatched=true validityOk=false refused=not-yet-valid")
      throw CertificateException(PinnedWsMessages.PINNED_CERTIFICATE_NOT_YET_VALID)
    }
    lastValidityOk = true
    PinnedWsLog.d("tls pinMatched=true validityOk=true")
  }

  companion object {
    private const val SHA256_HEX_LENGTH = 64

    fun sha256Hex(der: ByteArray): String {
      val digest = MessageDigest.getInstance("SHA-256").digest(der)
      val out = StringBuilder(digest.size * 2)
      for (byte in digest) {
        val value = byte.toInt() and 0xff
        out.append(HEX[value ushr 4])
        out.append(HEX[value and 0x0f])
      }
      return out.toString().lowercase()
    }

    private const val HEX = "0123456789abcdef"

    /** True when `value` is exactly 64 lowercase hex chars (the JS-side format). */
    fun isWellFormedPin(value: String): Boolean =
      value.length == SHA256_HEX_LENGTH && value.all { it in '0'..'9' || it in 'a'..'f' }

    /**
     * Length check + constant-time byte comparison (`MessageDigest.isEqual`), so a mismatch
     * does not leak how many leading hex chars matched.
     */
    fun constantTimeEquals(expected: String, observed: String): Boolean {
      if (expected.length != SHA256_HEX_LENGTH || observed.length != SHA256_HEX_LENGTH) return false
      return MessageDigest.isEqual(expected.toByteArray(Charsets.US_ASCII), observed.toByteArray(Charsets.US_ASCII))
    }
  }
}
