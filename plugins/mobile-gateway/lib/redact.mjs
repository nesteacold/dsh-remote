// Central log redaction (FR-012 / research R11).
//
// Every gateway log line passes through `redact()` (see `logging.mjs`), so
// credentials must never survive into stdout, the log file or an error trace:
// bearer tokens, Authorization header values, pairing codes, device tokens,
// tool-call `arguments`/`argsPreview` payloads and credential URL query
// parameters. Pairing codes and tokens are interchangeable as far as entropy
// goes — both are 32 random bytes in base64url or hex — so one set of patterns
// masks both, plus the forms the QR/hello frames can embed (JWT-like and
// `dsh-pair.<code>` / `dsh-auth.<token>` / `Bearer <token>` subprotocols).
const MASK = '[redacted]'

const TOKEN_LIKE = String.raw`[A-Za-z0-9_-]{43}={0,2}|([0-9][a-fA-F]{63}|[a-fA-F][0-9a-fA-F]{62}[0-9])|([A-Za-z0-9-_]{20,}\.){2}[A-Za-z0-9-_]{10,}`
// `code` is matched only next to a URL separator or a key, never as a bare word,
// so ordinary words such as "error code" stay readable.
const SENSITIVE_QUERY = String.raw`(?:token|access_token|auth|authorization|pairingCode|pairing_code|pairingToken|secret|apiKey)`
const SENSITIVE_KEY = String.raw`(?:token|access_token|auth|authorization|arguments|argsPreview|code|pairingCode|pairing_code|pairingToken|pairingTokenHash|secret|apiKey)`
// A query value is redacted whole (`code=ab12cd`) or, when the value is a
// sentence containing spaces, up to the first space (`code: invalid, expired`).
const QUERY_VALUE = String.raw`[^\s"'#\\<>]*(?:(?:\s*,\s*)|\s)\S+`
const QUERY_PREFIX = String.raw`([?&](?:${SENSITIVE_QUERY}|code)=)`
const KEY_PREFIX_DOUBLE_QUOTED = String.raw`(\b${SENSITIVE_KEY}"\s*:\s*(?:"\s*))`
const KEY_PREFIX_DOUBLE_QUOTED_ESCAPED = String.raw`(\b${SENSITIVE_KEY}\\":\\")`
const KEY_PREFIX_SINGLE_QUOTED = String.raw`(\b${SENSITIVE_KEY}'[ \t]*:[ \t]*(?:'[ \t]*))`
const KEY_VALUE = String.raw`(?:[^"\\]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*`

// String-level rules, applied in order. The flags stay non-global on the
// literals; `redactString` copies them with `g`.
const STRING_RULES = [
  // `"token":"..."`, JSON-escaped (`{\"token\":\"...\"}`) or with a quoted key
  // (`{"argsPreview": "..."}`): the whole JSON string value is masked, escaped
  // quotes included, before any other rule can rewrite its contents.
  [new RegExp(KEY_PREFIX_DOUBLE_QUOTED + KEY_VALUE, 'gi'), `$1${MASK}`],
  [new RegExp(KEY_PREFIX_DOUBLE_QUOTED_ESCAPED + KEY_VALUE, 'gi'), `$1${MASK}`],
  [new RegExp(KEY_PREFIX_SINGLE_QUOTED + KEY_VALUE, 'gi'), `$1${MASK}`],
  // Authorization header, any scheme.
  [/\b(Authorization)(\\?"?\s*[:=]\s*\\?"?)(?:Bearer|Basic|Token|Digest)?\s*[^\s"'\\,;}]+/gi, `$1$2${MASK}`],
  // Bare header value in a crash/error payload or a fetched headers object.
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, `Bearer ${MASK}`],
  // Credential values, also when embedded in a JSON-escaped URL (\/, \u0026) or
  // when the value is a sentence ("pairingCode: invalid, expired"). The
  // lookbehind keeps a message such as "?code=cc" or "?code=pc" readable.
  [new RegExp(String.raw`(?<![?!])` + QUERY_PREFIX + QUERY_VALUE, 'gi'), `$1${MASK}`],
  // Connection subprotocols that carry the pairing code or device token.
  [/\b(dsh-(?:pair|auth)\.)[^\s"',;]+/gi, `$1${MASK}`],
  // Bare 32-byte base64url / hex / JWT-shaped secrets (pairing codes, device tokens, API tokens).
  [new RegExp(String.raw`\b(?:${TOKEN_LIKE})\b`, 'g'), MASK],
]

const SENSITIVE_KEYS = new Set(['arguments', 'argspreview'])

export function redactString(text) {
  if (typeof text !== 'string' || text === '') return text
  let output = text
  for (const [pattern, replacement] of STRING_RULES) {
    output = output.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), replacement)
  }
  return output
}

/**
 * Redact one value. Deep objects are copied with sensitive fields masked and
 * every string redacted (`Error` keeps its type, message and redacted stack).
 * Unknown objects are redacted through `String()`. A cyclic object is masked at
 * the cycle instead of throwing. Plain objects and arrays are bounded to depth
 * 6 and 1000 entries so a hostile payload cannot stall logging.
 */
export function redact(value, { depth = 0, seen = new WeakSet() } = {}) {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 6) return MASK
  if (seen.has(value)) return '[circular]'
  if (value instanceof Error) {
    const copy = new Error(redactString(value.message))
    copy.name = redactString(value.name)
    if (typeof value.stack === 'string') copy.stack = redactString(value.stack)
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'cause') continue
      copy[key] = redactValue(key, entry, depth + 1, seen)
    }
    return copy
  }
  if (value instanceof Date || value instanceof RegExp || value instanceof URL) return redactString(String(value))
  if (Array.isArray(value)) {
    seen.add(value)
    const copy = value.slice(0, 1000).map((entry) => redact(entry, { depth: depth + 1, seen }))
    seen.delete(value)
    return copy
  }
  if (!isPlainObject(value)) return redactString(String(value))
  seen.add(value)
  const copy = {}
  let entries = 0
  for (const [key, entry] of Object.entries(value)) {
    if (entries >= 1000) break
    entries += 1
    copy[key] = redactValue(key, entry, depth + 1, seen)
  }
  seen.delete(value)
  return copy
}

function redactValue(key, entry, depth, seen) {
  if (typeof key === 'string' && SENSITIVE_KEYS.has(key.toLowerCase())) return entry === undefined ? entry : MASK
  return redact(entry, { depth, seen })
}

function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Redact one log line, never throwing: logging must not fail because of redaction. */
export function redactLine(line) {
  try {
    return typeof line === 'string' ? redactString(line) : redact(line)
  } catch {
    return MASK
  }
}

export const REDACTED = MASK
