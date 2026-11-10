// Test-only TLS helpers: a self-signed certificate is generated in-process for the fake
// gateway and is NEVER written to disk or the repo (key material stays in memory).

import { X509Certificate } from 'node:crypto';
import selfsigned from 'selfsigned';

export interface TestCertificate {
  /** PEM certificate chain (leaf only). */
  cert: string;
  /** PEM private key. Test-only, ephemeral, never persisted. */
  key: string;
  /** SHA-256 of the DER encoding of the leaf certificate, lowercase hex (== QR certSha256). */
  certSha256: string;
}

export interface TestCertificateOptions {
  /**
   * Start of the validity window (default: now). `selfsigned` 5.x has no `days` option: it
   * derives `notAfter` from this date (+365 days) unless `notAfter` is given, so tests that
   * need an expired or not-yet-valid leaf must pass explicit dates.
   */
  notBefore?: Date;
  /** End of the validity window (default: `notBefore` + 365 days). */
  notAfter?: Date;
}

/** SHA-256 of a certificate's DER bytes, lowercase hex. Accepts PEM or DER. */
export function sha256OfCertificate(cert: string | Buffer): string {
  const der = typeof cert === 'string' ? Buffer.from(new X509Certificate(cert).raw) : cert;
  return new X509Certificate(der).fingerprint256.replace(/:/g, '').toLowerCase();
}

/** Parsed validity window of a certificate in epoch ms. Accepts PEM or DER. */
export function validityWindowOf(cert: string | Buffer): { validFrom: number; validTo: number } {
  const parsed = new X509Certificate(cert);
  const validFrom = Date.parse(parsed.validFrom);
  const validTo = Date.parse(parsed.validTo);
  if (Number.isNaN(validFrom) || Number.isNaN(validTo)) {
    throw new Error('test certificate has unparseable validity dates');
  }
  return { validFrom, validTo };
}

export async function generateTestCertificate(options: TestCertificateOptions = {}): Promise<TestCertificate> {
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    algorithm: 'sha256',
    ...(options.notBefore === undefined ? {} : { notBeforeDate: options.notBefore }),
    ...(options.notAfter === undefined ? {} : { notAfterDate: options.notAfter }),
  } as Parameters<typeof selfsigned.generate>[1]);
  const cert = pems.cert;
  return { cert, key: pems.private, certSha256: sha256OfCertificate(cert) };
}
