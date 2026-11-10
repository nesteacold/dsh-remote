// Redaction for app diagnostics (FR-011): tokens, pairing codes, Authorization headers and
// tool arguments / argsPreview must never reach logs, crash breadcrumbs or support screens.
//
// Pure string/object transform: no react-native/expo/Node imports.

export const REDACTED = '[redacted]';

/** Keys whose values are always masked, matched case-insensitively on the whole key. */
export const SENSITIVE_KEYS: readonly string[] = [
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'devicetoken',
  'device_token',
  'authtoken',
  'auth_token',
  'authorization',
  'proxyauthorization',
  'cookie',
  'set-cookie',
  'secret',
  'password',
  'passcode',
  'apikey',
  'api_key',
  'pairingcode',
  'pairing_code',
  'code',
  'credential',
  'privatekey',
  'private_key',
  'signature',
  'pin',
];

/**
 * Keys whose value is a tool-argument blob. Masked unless the caller explicitly passes
 * `allowArgsPreview` (the UI shows a redacted preview, diagnostics never do).
 */
export const ARGUMENT_KEYS: readonly string[] = ['arguments', 'args', 'argspreview', 'input', 'params', 'parameters'];

// Contract §3 subprotocols: `dsh-pair.<code>`, `dsh-auth.<token>`, `dsh-device.<uuid>`.
const PAIR_SUBPROTOCOL_RE = /dsh-pair\.[A-Za-z0-9_-]+/g;
const AUTH_SUBPROTOCOL_RE = /dsh-auth\.[A-Za-z0-9._~+/=-]+/g;
const BEARER_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIAL_RE = /([?&](?:token|code|pairingCode|pairing_code|access_token)=)[^&\s]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
const LONG_B64URL_RE = /\b[A-Za-z0-9_-]{43}\b/g;
const HEX64_RE = /\b[0-9a-f]{64}\b/gi;

export interface RedactOptions {
  /** Keep a redacted, truncated `argsPreview`/`arguments` value instead of masking it. */
  allowArgsPreview?: boolean;
  /** Max characters kept for allowed previews. */
  previewMaxLength?: number;
  /** Extra key names to mask (case-insensitive). */
  extraKeys?: readonly string[];
}

function normaliseKey(key: string): string {
  return key.replace(/[-_\s]/g, '').toLowerCase();
}

function isSensitiveKey(key: string, options: RedactOptions): boolean {
  const k = normaliseKey(key);
  if (options.extraKeys?.some((extra) => normaliseKey(extra) === k)) return true;
  return SENSITIVE_KEYS.includes(k);
}

function isArgumentKey(key: string): boolean {
  return ARGUMENT_KEYS.includes(normaliseKey(key));
}

/**
 * Redact every secret-looking substring in free text. Used for error messages, URLs and
 * anything that came from the wire before it is written to a log.
 */
export function redactString(input: string): string {
  return input
    .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(PAIR_SUBPROTOCOL_RE, `dsh-pair.${REDACTED}`)
    .replace(AUTH_SUBPROTOCOL_RE, `dsh-auth.${REDACTED}`)
    .replace(URL_CREDENTIAL_RE, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    // A bare 43-char base64url token is the shape of a pairing code (32 bytes).
    .replace(LONG_B64URL_RE, REDACTED);
}

/** Hex fingerprints are not secrets, but a full diagnostics dump does not need them either. */
export function redactFingerprint(input: string): string {
  return input.replace(HEX64_RE, (m) => `${m.slice(0, 8)}…${REDACTED}`);
}

/**
 * Deep-redact an arbitrary JSON-ish value (frame, error details) for diagnostics.
 * Cycle-safe, depth-limited, array-length limited.
 */
export function redactValue(value: unknown, options: RedactOptions = {}, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (depth > 6) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactValue(v, options, depth + 1, seen));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key, options)) {
        out[key] = REDACTED;
      } else if (isArgumentKey(key)) {
        out[key] = options.allowArgsPreview ? redactArgsPreview(v, options.previewMaxLength ?? 200) : REDACTED;
      } else {
        out[key] = redactValue(v, options, depth + 1, seen);
      }
    }
    return out;
  }
  return String(value);
}

/**
 * Short, single-line, redacted preview of tool arguments for the approval card and for
 * diagnostics with `allowArgsPreview`. Never returns the raw blob; strings are cut.
 * Contract §5 caps `argsPreview` at 2 KB; the card shows far less.
 */
export function redactArgsPreview(value: unknown, maxLength = 400): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (value === null || value === undefined) {
    return '';
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return '[unserialisable]';
    }
  }
  const scrubbed = redactString(text).replace(/\s+/g, ' ').trim();
  if (scrubbed.length <= maxLength) return scrubbed;
  return `${scrubbed.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Format one diagnostic line: `label: <redacted json>`. */
export function redactDiagnostic(label: string, payload: unknown, options: RedactOptions = {}): string {
  const safeLabel = redactString(label);
  let body: string;
  try {
    body = JSON.stringify(redactValue(payload, options));
  } catch {
    body = '[unserialisable]';
  }
  return `${safeLabel}: ${body ?? 'undefined'}`;
}
