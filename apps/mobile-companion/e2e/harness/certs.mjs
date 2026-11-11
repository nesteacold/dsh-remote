// Leaf certificates for the device-validation fixture.
//
// The phone trusts a Host only through the leaf SHA-256 carried in the pairing QR (contract §2,
// §3.1); there is no CA. That makes four device-observable certificate states worth testing, and
// each one has a different *expected* outcome:
//
//   | mode       | advertised `certSha256` | served leaf        | expected app outcome                       |
//   |------------|-------------------------|--------------------|--------------------------------------------|
//   | `ok`       | served leaf             | valid window       | pairing succeeds                            |
//   | `wrong`    | a *different* leaf      | valid window       | `client/pin-mismatch`, **nothing sent**      |
//   | `expired`  | served leaf             | `notAfter` past    | refused: pin matches, validity must not      |
//   | `not-yet`  | served leaf             | `notBefore` future | refused: pin matches, validity must not      |
//
// `wrong` is how "the host is not the computer the code belongs to" is reproduced without a
// proxy: the fixture advertises leaf A and serves leaf B, which is exactly what an attacker (or a
// regenerated certificate) looks like from the phone.
//
// `expired` / `not-yet` are the cases that separate a *pin* from a *pin plus validity window*:
// the leaf is the pinned one, so a transport that only compares hashes would accept it. The
// app's native trust managers must reject both (A032 for the Node transport, A047 for iOS; the
// Android check lives in `PinnedTrustManager`).
//
// Nothing here is written to disk: every key and certificate is generated in memory for one run.

import { X509Certificate } from 'node:crypto'
import selfsigned from 'selfsigned'

/** SHA-256 of a certificate's DER bytes, lowercase hex (== the QR `certSha256`). */
export function sha256OfCertificate (cert) {
  const der = typeof cert === 'string' ? Buffer.from(new X509Certificate(cert).raw) : cert
  return new X509Certificate(der).fingerprint256.replaceAll(':', '').toLowerCase()
}

/** Parsed validity window in epoch ms (for `GET /state` evidence). */
export function validityWindowOf (cert) {
  const parsed = new X509Certificate(cert)
  return { validFrom: Date.parse(parsed.validFrom), validTo: Date.parse(parsed.validTo) }
}

/**
 * Generate one self-signed leaf.
 *
 * `selfsigned` 5.x has no `days` option: it derives `notAfter` from `notBeforeDate` (+365 days)
 * unless `notAfterDate` is given, so the invalid-window modes pass explicit dates.
 *
 * The subject/SANs use the host the phone dials. That is not the identity — pinning is — but a
 * certificate whose names have nothing to do with the endpoint makes device logs confusing.
 */
export async function generateLeaf ({ hostname = '127.0.0.1', notBefore, notAfter } = {}) {
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')
  const attrs = [{ name: 'commonName', value: hostname }]
  const altNames = isIp
    ? [{ type: 7, ip: hostname }]
    : [{ type: 2, value: hostname }]
  // Loopback stays in the SAN list so the same leaf also works for a local smoke run.
  altNames.push({ type: 7, ip: '127.0.0.1' })

  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'subjectAltName', altNames },
    ],
    ...(notBefore === undefined ? {} : { notBeforeDate: notBefore }),
    ...(notAfter === undefined ? {} : { notAfterDate: notAfter }),
  })

  return { cert: pems.cert, key: pems.private, certSha256: sha256OfCertificate(pems.cert), window: validityWindowOf(pems.cert) }
}

/**
 * Build the certificate pair for a mode.
 *
 * @param {'ok'|'wrong'|'expired'|'not-yet'} mode
 * @param {{hostname?: string, now?: number}} [options]
 * @returns {Promise<{
 *   mode: string,
 *   served: {cert: string, key: string, certSha256: string, window: {validFrom: number, validTo: number}},
 *   advertisedSha256: string,
 *   note: string,
 * }>}
 */
export async function buildCertificateSet (mode, options = {}) {
  const hostname = options.hostname ?? '127.0.0.1'
  const now = options.now ?? Date.now()
  const YEAR = 365 * 24 * 60 * 60 * 1000

  switch (mode) {
    case 'ok': {
      const served = await generateLeaf({ hostname })
      return { mode, served, advertisedSha256: served.certSha256, note: 'valid leaf, advertised hash is the served leaf' }
    }
    case 'wrong': {
      const advertised = await generateLeaf({ hostname })
      const served = await generateLeaf({ hostname })
      return {
        mode,
        served,
        advertisedSha256: advertised.certSha256,
        note: 'advertises leaf A, serves leaf B: the app must abort with client/pin-mismatch and send nothing',
      }
    }
    case 'expired': {
      const served = await generateLeaf({ hostname, notBefore: new Date(now - 2 * YEAR), notAfter: new Date(now - 24 * 60 * 60 * 1000) })
      return {
        mode,
        served,
        advertisedSha256: served.certSha256,
        note: 'pin matches but notAfter is in the past: a valid certificate must be refused',
      }
    }
    case 'not-yet': {
      const served = await generateLeaf({ hostname, notBefore: new Date(now + 24 * 60 * 60 * 1000), notAfter: new Date(now + YEAR) })
      return {
        mode,
        served,
        advertisedSha256: served.certSha256,
        note: 'pin matches but notBefore is in the future: a not-yet-valid certificate must be refused',
      }
    }
    default:
      throw new Error(`unknown certificate mode: ${mode} (expected ok|wrong|expired|not-yet)`)
  }
}
