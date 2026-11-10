// TLS identity of the plugin-owned remote listeners (T016 / R1 / R2).
//
// The gateway exposes its mobile WebSocket only over TLS. The certificate is
// self-signed, generated once per Host on first use with `selfsigned` (an EC
// P-256 key; Node cannot create certificates itself and `openssl` is not
// guaranteed on a Windows Host), and trusted by the phone only through the
// fingerprint carried in the pairing QR (`certSha256`).
//
// Files live in the plugin data directory:
//   mobile-gateway-tls.key   PKCS#8 private key, owner-only (secure-file)
//   mobile-gateway-tls.json  certificate PEM + metadata (Subjects, SANs, times)
//
// The private key is written with `writeSecretFile` and never logged or sent to
// a client. Regeneration is an explicit owner action (`POST /mgw/tls/regenerate`,
// loopback only); because every paired phone pins the old fingerprint, a
// rotation means every device must pair again — `loadOrCreateTlsIdentity`
// reports `created: 'regenerated'` so the caller can say so.
//
// The key is the listener's whole identity: whoever can read it can impersonate
// (or silently intercept) the pinned endpoint. So its restriction is not
// best-effort — after restricting, the real ACL of the key and of its directory is
// verified and an unverifiable/permissive path throws `SecretFilePermissionError`
// (`secret-file/not-owner-only`, naming the path and the reason). The caller then
// refuses to start the remote listener instead of serving that key.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { assertOwnerOnly, ensureOwnerOnlyDirectory, restrictToOwnerSync, writeSecretFile } from './secure-file.mjs'

// `selfsigned` 5.x is CommonJS; the ESM default import is its module object.
const require = createRequire(import.meta.url)

const CERT_FILE = 'mobile-gateway-tls.json'
const KEY_FILE = 'mobile-gateway-tls.key'
const STORE_VERSION = 1
const NOT_AFTER_DAYS = 3650

// Loopback first, then the machine's own name: these are the only names a phone
// can be pointed at on the loopback listener and on a LAN listener bound to
// this Host without an owner-supplied DNS name.
const LOOPBACK_HOSTNAMES = Object.freeze(['localhost', '127.0.0.1', '::1'])

/** Lowercase hex SHA-256 of a PEM/DER certificate — the value pinned in the QR. */
export function fingerprintOf(certificatePemOrDer) {
  const der = Buffer.isBuffer(certificatePemOrDer)
    ? certificatePemOrDer
    : new crypto.X509Certificate(certificatePemOrDer).raw
  return crypto.createHash('sha256').update(der).digest('hex')
}

/** `X509Certificate.fingerprint256` ("AA:BB:…") → `"aabb…"`. */
export function fingerprint256ToHex(value) {
  return String(value ?? '').replaceAll(':', '').toLowerCase()
}

function isIp(value) {
  return require('node:net').isIP(String(value).replace(/^\[|\]$/g, '')) !== 0
}

function normalizeSan(value) {
  return String(value).trim().replace(/^\[|\]$/g, '').toLowerCase()
}

/**
 * Certificate SANs for a listener: the advertised hostnames and IPs plus the
 * loopback names. Deterministic order, no duplicates, loopback first.
 * @param {Iterable<string>} advertised hostnames/IPs the listener may be reached on
 * @param {{ hostname?: string }} [options] `os.hostname()` by default
 */
export function certificateSans(advertised = [], options = {}) {
  const hostname = (options.hostname ?? os.hostname()).replace(/\.local$/i, '')
  const candidates = [
    ...LOOPBACK_HOSTNAMES,
    ...(hostname && !isIp(hostname) ? [hostname] : []),
    ...advertised,
  ]
  const seen = new Set()
  const sans = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const value = normalizeSan(candidate)
    if (!value || seen.has(value) || value === '0.0.0.0' || value === '::') continue
    if (!isIp(value) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)) continue
    seen.add(value)
    sans.push({ type: isIp(value) ? 'ip' : 'dns', value })
  }
  return sans
}

function selfsignedExtensions(sans) {
  return [
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: sans.map((san) => ({ type: san.type === 'ip' ? 7 : 2, value: san.value, ip: san.type === 'ip' ? san.value : undefined })) },
  ]
}

async function generateCertificate({ sans, commonName, days = NOT_AFTER_DAYS }) {
  const selfsigned = require('selfsigned')
  const notAfterDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  const pem = await selfsigned.generate(
    [
      { name: 'commonName', value: commonName },
      { name: 'organizationName', value: 'dsh-ext mobile-gateway' },
    ],
    {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notBeforeDate: new Date(Date.now() - 60_000),
      notAfterDate,
      extensions: selfsignedExtensions(sans),
    },
  )
  return { certificate: pem.cert, privateKey: pem.private, notAfterDate }
}

function readStore(storePath) {
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`failed to load the mobile gateway certificate store: ${error.message}`, { cause: error })
  }
}

function writeStore(storePath, value) {
  const temporary = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, storePath)
    restrictToOwnerSync(storePath, 'file')
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function usable(store, keyPem) {
  if (!store || store.version !== STORE_VERSION) return false
  if (typeof store.certificate !== 'string' || !store.certificate.includes('BEGIN CERTIFICATE')) return false
  if (typeof keyPem !== 'string' || !keyPem.includes('PRIVATE KEY')) return false
  try {
    const certificate = new crypto.X509Certificate(store.certificate)
    // An expired certificate must never be served silently.
    if (Date.parse(certificate.validTo) <= Date.now() + 24 * 60 * 60 * 1000) return false
    const publicOfKey = crypto.createPublicKey(crypto.createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' })
    if (!publicOfKey.equals(certificate.publicKey.export({ type: 'spki', format: 'der' }))) return false
    return true
  } catch {
    return false
  }
}

export function tlsPaths(directory) {
  return { directory, store: path.join(directory, CERT_FILE), key: path.join(directory, KEY_FILE) }
}

/**
 * Load the Host certificate, generating it when absent or unusable.
 * @param {object} options
 * @param {string} options.directory plugin data directory
 * @param {Iterable<string>} [options.advertised] hostnames/IPs the listeners advertise
 * @param {string} [options.commonName] certificate CN (default: the SAN list's first DNS name)
 * @param {boolean} [options.regenerate] owner action: replace even a usable certificate
 * @param {(message: string) => void} [options.log]
 * @param {(target: string) => (string|null)} [options.ownerOnlyCheck] test-only override
 *   for the ACL verification (never set by the bundle)
 * @returns {Promise<{ certificate: string, key: string, fingerprint256: string, sans: string[],
 *   createdAt: string, notAfter: string, created: 'loaded'|'created'|'regenerated', paths: object }>}
 * @throws {import('./secure-file.mjs').SecretFilePermissionError} when the key or its
 *   directory cannot be verified as owner-only — the listener must not be served then
 */
export async function loadOrCreateTlsIdentity(options) {
  const { directory, regenerate = false, log = () => {} } = options
  if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('a plugin data directory is required')
  const paths = tlsPaths(directory)
  const sans = certificateSans(options.advertised ?? [])
  // Fail closed: the caller serves this key, so a "cannot verify" answer is a
  // refusal, not a warning. `ownerOnlyCheck` is a test-only seam.
  const check = typeof options.ownerOnlyCheck === 'function' ? options.ownerOnlyCheck : undefined
  const verifySecret = (target) => assertOwnerOnly(target, check)
  let created = 'loaded'
  let store = regenerate ? null : readStore(paths.store)
  let keyPem = null
  if (store) {
    try { keyPem = fs.readFileSync(paths.key, 'utf8') } catch { keyPem = null }
  }
  if (!store || !usable(store, keyPem)) {
    ensureOwnerOnlyDirectory(directory)
    // Verify BEFORE the key is written: a secret must not land in a directory
    // other users can read, not even for the moment before restriction.
    verifySecret(directory)
    created = regenerate || store ? 'regenerated' : 'created'
    const commonName = options.commonName
      || sans.find((san) => san.type === 'dns')?.value
      || 'dsh-mobile-gateway'
    const generated = await generateCertificate({ sans, commonName })
    keyPem = generated.privateKey
    store = {
      version: STORE_VERSION,
      certificate: generated.certificate,
      createdAt: new Date().toISOString(),
      notAfter: generated.notAfterDate.toISOString(),
      sans: sans.map((san) => san.value),
      commonName,
    }
    writeSecretFile(paths.key, keyPem)
    verifySecret(paths.key)
    // Re-read the directory AFTER the key write: the check before it only proved
    // the state in which the secret did not exist yet. If the directory is turned
    // permissive in between, the key would otherwise be served from it.
    verifySecret(directory)
    writeStore(paths.store, store)
    // Fingerprints are public (they travel in the pairing QR), so logging one
    // is not a secret leak; prefix keeps redaction from masking it.
    log(`TLS identity ${created}: certSha256=${fingerprintOf(generated.certificate)} sans=${store.sans.join(',')}`)
  } else {
    restrictToOwnerSync(paths.store, 'file')
    restrictToOwnerSync(paths.key, 'file')
    restrictToOwnerSync(directory, 'directory')
    // Re-restriction cannot remove a pre-existing explicit grant, so the DACL is
    // what decides. A permissive key/directory stops the listener here.
    verifySecret(directory)
    verifySecret(paths.key)
  }
  const certificate = new crypto.X509Certificate(store.certificate)
  return {
    certificate: store.certificate,
    key: keyPem,
    fingerprint256: fingerprint256ToHex(certificate.fingerprint256),
    sans: Array.isArray(store.sans) ? store.sans : [],
    createdAt: store.createdAt,
    notAfter: certificate.validTo,
    created,
    paths,
  }
}

/** Options for `https.createServer` / `tls.createServer`. */
export function tlsServerOptions(identity, extra = {}) {
  return {
    key: identity.key,
    cert: identity.certificate,
    minVersion: 'TLSv1.2',
    // The pin replaces the PKI: clients verify the leaf fingerprint from the QR.
    ...extra,
  }
}
