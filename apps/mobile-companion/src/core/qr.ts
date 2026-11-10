// QR v3 parsing/validation per contract §2 (revision 2):
//
//   QR/manual text = unpadded base64url(UTF-8 JSON
//     { version: 3, publicUrl, pairingCode, expiresAt (epoch ms), certSha256, gatewayId,
//       gatewayName, endpoints[] })
//
// Pure: no react-native/expo/Node imports; the clock is injected for tests. base64url is
// decoded locally (no Buffer/atob), so the same code runs in Node tests and in Hermes.
//
// Reject rule summary (spec FR-002 / SC-002): nothing about a QR we cannot fully trust may
// reach the transport, because the QR is the only source of the certificate pin.
//
// Every rule below is the contract's, with no extra tolerance:
//   - `expiresAt` must be epoch milliseconds ≤ 5 min (300 000 ms) ahead of the injected clock.
//     No clock-skew allowance: the contract states the bound, and a longer grace period would
//     let the phone keep presenting a code the host has already dropped.
//   - `gatewayId` must be the UUID v4 the host writes (`crypto.randomUUID()`); the host itself
//     refuses a state file whose id is not lowercase v4, so any other spelling cannot be live.
//   - `pairingCode` must be the canonical unpadded base64url of 256 bits: exactly 43 characters
//     from the base64url alphabet, decoding to 32 bytes with the two spare bits zero.
//   - the raw text and the decoded payload are bounded before any JSON work, so a pasted blob
//     cannot turn the parser into an allocation/parse amplifier.

import { PAIRING_QR_VERSION, type PairingQr } from './protocol';

export type QrRejectReason =
  /** Not base64url text, larger than any pairing code, or not valid UTF-8 JSON. */
  | 'qr/invalid-json'
  /** `version` missing or != 3. */
  | 'qr/unsupported-version'
  /** `publicUrl` or `endpoints[]` missing, not a URL, or scheme != wss. */
  | 'qr/bad-endpoint'
  /** `certSha256` missing or not exactly 64 lowercase hex chars. */
  | 'qr/bad-cert-sha256'
  /** `pairingCode` missing or not the canonical 43-char base64url of 32 bytes. */
  | 'qr/bad-pairing-code'
  /** `expiresAt` missing or not epoch milliseconds. */
  | 'qr/bad-expires-at'
  /** `expiresAt` is at or before the injected clock, or more than `PAIRING_TTL_MS` ahead. */
  | 'qr/expired'
  /** `gatewayName` present but not a string (or too long). */
  | 'qr/bad-host-name'
  /** `gatewayId` missing or not a canonical lowercase UUID v4. */
  | 'qr/bad-gateway-id';

export type QrParseResult =
  | { ok: true; value: PairingQr }
  | { ok: false; reason: QrRejectReason; message: string };

/** RFC 4648 §5 alphabet without padding. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const CERT_SHA256_RE = /^[0-9a-f]{64}$/;
/** The id the host writes (`crypto.randomUUID()`), and the only form its own state file accepts. */
const GATEWAY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_GATEWAY_NAME = 128;

/** Contract §2: `expiresAt` is ≤ 5 min ahead. Strict — the contract documents no skew allowance. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;
/** Contract §2: `pairingCode` is 256 bits of unpadded base64url — 32 bytes, 43 characters. */
export const PAIRING_CODE_BYTES = 32;
export const PAIRING_CODE_LENGTH = 43;

/**
 * Upper bound on the raw QR/manual text, checked before decoding.
 *
 * A QR symbol tops out at 2953 bytes (version 40, error correction L), and the gateway's payload
 * is ~400 bytes in practice, so 16 KiB is several times larger than anything a real pairing code
 * (or the spec-005 desktop copy-paste of the same string) can be. It is a bound, not a size
 * budget: a pasted blob is refused instead of being decoded and parsed.
 */
export const MAX_QR_TEXT_LENGTH = 16 * 1024;
/** Upper bound on the decoded UTF-8 JSON: base64url expands 4 characters per 3 bytes. */
export const MAX_QR_PAYLOAD_BYTES = (MAX_QR_TEXT_LENGTH / 4) * 3;

export interface ParseQrOptions {
  /** Injected clock (epoch ms); defaults to `Date.now`. Expiry is compared against this. */
  now?: () => number;
}

/**
 * Parse the raw text of a scanned QR (or the manually pasted string). Accepts only the
 * contract's unpadded base64url encoding of the JSON payload. Never throws.
 */
export function parsePairingQr(raw: string, options: ParseQrOptions = {}): QrParseResult {
  const now = options.now ?? Date.now;

  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return reject('qr/invalid-json', 'The code is empty');
  if (text.length > MAX_QR_TEXT_LENGTH) {
    return reject(
      'qr/invalid-json',
      `The code is too large to be a pairing code (limit ${MAX_QR_TEXT_LENGTH} characters)`,
    );
  }
  if (!BASE64URL_RE.test(text)) {
    return reject('qr/invalid-json', 'The code is not unpadded base64url text (no JSON, no "=" padding)');
  }
  const bytes = decodeBase64Url(text);
  if (bytes === null) return reject('qr/invalid-json', 'The code is not valid base64url');
  if (bytes.length > MAX_QR_PAYLOAD_BYTES) {
    return reject('qr/invalid-json', `The decoded payload is too large (limit ${MAX_QR_PAYLOAD_BYTES} bytes)`);
  }

  let data: unknown;
  try {
    data = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch {
    return reject('qr/invalid-json', 'The decoded code is not UTF-8 JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return reject('qr/invalid-json', 'The decoded code is not a JSON object');
  }
  const obj = data as Record<string, unknown>;

  if (obj.version !== PAIRING_QR_VERSION) {
    return reject('qr/unsupported-version', `Code version must be ${PAIRING_QR_VERSION}`);
  }

  const publicUrlCheck = checkWssUrl(obj.publicUrl);
  if (publicUrlCheck !== null) return reject('qr/bad-endpoint', `publicUrl: ${publicUrlCheck}`);

  const endpointsCheck = checkEndpoints(obj.endpoints);
  if (endpointsCheck !== null) return reject('qr/bad-endpoint', endpointsCheck);

  if (typeof obj.certSha256 !== 'string' || !CERT_SHA256_RE.test(obj.certSha256)) {
    return reject('qr/bad-cert-sha256', 'certSha256 must be 64 lowercase hex characters');
  }

  if (!isPairingCode(obj.pairingCode)) {
    return reject(
      'qr/bad-pairing-code',
      `pairingCode must be ${PAIRING_CODE_LENGTH} canonical base64url characters (${PAIRING_CODE_BYTES} bytes)`,
    );
  }

  if (typeof obj.expiresAt !== 'number' || !Number.isSafeInteger(obj.expiresAt) || obj.expiresAt <= 0) {
    return reject('qr/bad-expires-at', 'expiresAt must be epoch milliseconds');
  }
  const remaining = obj.expiresAt - now();
  if (remaining <= 0) {
    return reject('qr/expired', 'This code has expired; show a new one on your computer');
  }
  if (remaining > PAIRING_TTL_MS) {
    // A far-future expiry is not what the gateway emits: the phone clock is wrong, and a
    // pairing attempt would look valid long after the host dropped the code.
    return reject('qr/expired', 'This code expires too far in the future; check your phone clock');
  }

  if (typeof obj.gatewayId !== 'string' || !GATEWAY_ID_RE.test(obj.gatewayId)) {
    return reject('qr/bad-gateway-id', 'gatewayId must be a lowercase UUID v4');
  }

  if (typeof obj.gatewayName !== 'string' || obj.gatewayName.length === 0 || obj.gatewayName.length > MAX_GATEWAY_NAME) {
    return reject('qr/bad-host-name', 'gatewayName must be a non-empty string');
  }

  const value: PairingQr = {
    version: PAIRING_QR_VERSION,
    publicUrl: obj.publicUrl as string,
    pairingCode: obj.pairingCode as string,
    expiresAt: obj.expiresAt,
    certSha256: obj.certSha256 as string,
    gatewayId: obj.gatewayId,
    gatewayName: obj.gatewayName,
    endpoints: [...(obj.endpoints as string[])],
  };
  return { ok: true, value };
}

/** Throwing variant for call sites that already surface a typed error to the UI. */
export function parsePairingQrOrThrow(raw: string, options: ParseQrOptions = {}): PairingQr {
  const result = parsePairingQr(raw, options);
  if (result.ok) return result.value;
  const err = new Error(result.message);
  err.name = 'QrError';
  (err as Error & { reason: QrRejectReason }).reason = result.reason;
  throw err;
}

/** Milliseconds until `expiresAt` (negative when already expired). */
export function qrExpiresInMs(qr: Pick<PairingQr, 'expiresAt'>, now: () => number = Date.now): number {
  return qr.expiresAt - now();
}

/** Encode the contract payload back to QR text (tests and any local tooling). */
export function encodePairingPayload(payload: PairingQr): string {
  return encodeBase64Url(decodeUtf8ToBytes(JSON.stringify(payload)));
}

/**
 * `wss://` only. Query strings and fragments are rejected outright because they are how tokens
 * leaked (`?token=`); the contract carries the code in a subprotocol, never the URL.
 */
function checkWssUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'missing';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'wss:') return 'must use wss://';
  if (url.username !== '' || url.password !== '') return 'must not embed credentials';
  if (url.search !== '') return 'must not carry a query string';
  if (url.hash !== '') return 'must not carry a fragment';
  if (url.hostname === '') return 'must name a host';
  return null;
}

function checkEndpoints(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return 'endpoints must be a non-empty array';
  if (value.length > 16) return 'endpoints has too many entries';
  for (const endpoint of value) {
    const problem = checkWssUrl(endpoint);
    if (problem !== null) return `endpoints entry: ${problem}`;
  }
  return null;
}

/**
 * Contract §2 `pairingCode` is 256 bits: canonical unpadded base64url of exactly 32 bytes. The
 * shape is pinned rather than "any base64url", so a short/over-long/foreign-alphabet code can
 * never be offered as `dsh-pair.<code>`. `decodeBase64Url` also rejects non-zero trailing bits,
 * so two different strings cannot denote the same 32 bytes.
 */
function isPairingCode(value: unknown): boolean {
  if (typeof value !== 'string' || value.length !== PAIRING_CODE_LENGTH) return false;
  if (!BASE64URL_RE.test(value)) return false;
  const bytes = decodeBase64Url(value);
  return bytes !== null && bytes.length === PAIRING_CODE_BYTES;
}

// ---------------------------------------------------------------------------
// base64url (no Buffer / atob: identical in Hermes and Node)
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = new Int16Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index += 1) LOOKUP[ALPHABET.charCodeAt(index)] = index;

/** Strict base64url decode: no padding, no other characters, non-zero trailing bits rejected. */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const value = code < 128 ? LOOKUP[code] : -1;
    if (value === undefined || value === -1) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (buffer >> bits) & 0xff;
      written += 1;
    }
  }
  // Leftover bits must be zero, otherwise the encoding is not canonical.
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return bytes.subarray(0, written);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += ALPHABET[(buffer >> bits) & 0x3f];
    }
  }
  if (bits > 0) output += ALPHABET[(buffer << (6 - bits)) & 0x3f];
  return output;
}

/** UTF-8 decode that throws on malformed input (TextDecoder is available in RN and Node). */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function decodeUtf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function reject(reason: QrRejectReason, message: string): QrParseResult {
  return { ok: false, reason, message };
}
