// Approval content binding for spec 001 US4 (FR-008, T025) — the pure part.
//
// `approvalArgsHash()` returns the protocol's `argsHash`
// (contracts/mobile-protocol-v1.md §5, research V1):
//
//   sha256_hex(JCS({ toolName, callId, arguments: JSON.parse(rawArguments) }))
//
// or `null` when the content cannot be bound. `null` means "mobile may not
// decide": the gateway must hand the decision to the desktop (`return next()`,
// research V2 — returning `undefined` would reject immediately, not delegate).
// Caching `tool/call`, the ≤ 1 s wait for a late event and the 409 on mismatch
// belong to the caller (T026); this module only binds content.
//
// JCS (RFC 8785) is implemented in full on Node built-ins, not as "sorted
// JSON.stringify":
//   - object keys: sorted by UTF-16 code units, recursively;
//   - arrays: order preserved;
//   - strings: ECMAScript JSON.stringify() escaping — \b \t \n \f \r for those
//     controls, \" and \\ for the two specials, \u00xx (lowercase) for the rest
//     of U+0000–U+001F, every other character literal as UTF-8. No Unicode
//     normalization: JCS is byte-exact, so NFC and NFD spellings differ;
//   - numbers: ECMAScript Number::toString() for finite doubles, so `-0` → 0,
//     `1e30` → 1e+30, `1e-7` → 1e-7, `1e20` → 100000000000000000000. NaN and
//     ±Infinity have no JSON representation and are rejected.
// Lone surrogates are rejected anywhere (JSON/UTF-8 cannot carry them), and the
// UTF-16 sort deliberately places a non-BMP character before U+FFFD (its high
// surrogate 0xD83D sorts below 0xFFFD) — that is the RFC rule, not a bug.
//
// Deliberately absent: an `argsPreview` helper. The contract bounds the preview
// (≤ 2 KB text, always a string) and data-model.md requires it to be redacted
// in logs (lib/redact.mjs masks `arguments`/`argsPreview` keys), but neither
// states a content-redaction rule for what may be shown to the phone. Until
// the contract gains one, this module exposes no preview and never puts raw
// arguments into a return value, an error message or a log line.
//
// Fail-closed (always `null`): missing/empty/non-string `toolName` or
// `callId`, non-string `rawArguments`, JSON.parse failure, any non-finite
// number (e.g. `1e400` parses to Infinity) or other non-JSON value, an
// unpaired surrogate, a circular structure, or any other canonicalization
// error. `approvalArgsHash()` never throws and never logs.
//
// Pure module: no I/O, no config, no global state.
import { createHash } from 'node:crypto'

// ECMAScript Number::toString() output for finite values. The pattern is a
// defensive assertion: a finite double always formats to a valid JSON number,
// but the hash must not silently accept a surprising format if that assumption
// ever breaks on another engine.
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/

/**
 * RFC 8785 (JCS) canonical JSON of a parsed JSON value.
 *
 * Throws `TypeError` when `value` (or anything nested in it) is not a JSON
 * value: `undefined`, BigInt, symbol, function, NaN/±Infinity, a lone
 * surrogate, a non-plain object, a sparse array or a cycle. The messages are
 * generic and never contain the value itself.
 */
export function canonicalizeJcs(value) {
  return serializeJsonValue(value, new WeakSet())
}

/**
 * `argsHash` for a pending approval, or `null` when content cannot be bound.
 *
 * Integration (T026, single owner of lib/index.mjs):
 *   const argsHash = approvalArgsHash({ toolName, callId, rawArguments })
 *   // null → do not offer approve/reject; leave the decision to the desktop
 *
 * `rawArguments` is the `tool/call` argument string exactly as emitted by the
 * model (research V1); it is parsed with JSON.parse before canonicalization, so
 * key order, whitespace and equivalent number spellings do not change the hash
 * while array order and any value change do. A missing `tool/call` is the
 * caller's concern — pass the cached string only when one exists, otherwise
 * `null` without calling this function.
 */
export function approvalArgsHash(options) {
  try {
    if (options === null || typeof options !== 'object') return null
    const { toolName, callId, rawArguments } = options
    if (typeof toolName !== 'string' || toolName === '') return null
    if (typeof callId !== 'string' || callId === '') return null
    if (typeof rawArguments !== 'string') return null
    let parsed
    try {
      parsed = JSON.parse(rawArguments)
    } catch {
      return null
    }
    const canonical = canonicalizeJcs({ toolName, callId, arguments: parsed })
    return createHash('sha256').update(canonical, 'utf8').digest('hex')
  } catch {
    // Any canonicalization or property-access failure is "cannot bind":
    // fail closed, never let a hostile payload throw into the approval path.
    return null
  }
}

function serializeJsonValue(value, seen) {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return serializeNumber(value)
    case 'string':
      return serializeString(value)
    case 'object':
      return serializeObject(value, seen)
    default:
      // undefined, bigint, symbol, function — outside the JSON data model.
      throw new TypeError(`not a JSON value: ${typeof value}`)
  }
}

function serializeObject(value, seen) {
  if (seen.has(value)) throw new TypeError('circular structure is not a JSON value')
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('symbol-keyed properties are not JSON')
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) return serializeArray(value, seen)
    if (!isPlainObject(value)) throw new TypeError('only plain objects and arrays are JSON values')
    return serializePlainObject(value, seen)
  } finally {
    seen.delete(value)
  }
}

function serializeArray(value, seen) {
  let output = '['
  for (let index = 0; index < value.length; index += 1) {
    // A hole has no JSON representation; JSON.stringify() would emit `null`,
    // which would silently change the bound content.
    if (!Object.hasOwn(value, index)) throw new TypeError('sparse arrays are not JSON values')
    if (index > 0) output += ','
    output += serializeJsonValue(value[index], seen)
  }
  return `${output}]`
}

function serializePlainObject(value, seen) {
  const keys = Object.keys(value).sort(compareUtf16)
  let output = '{'
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) output += ','
    const key = keys[index]
    output += `${serializeString(key)}:${serializeJsonValue(value[key], seen)}`
  }
  return `${output}}`
}

function serializeNumber(value) {
  if (!Number.isFinite(value)) throw new TypeError('non-finite numbers are not JSON values')
  if (Object.is(value, -0)) return '0'
  const text = String(value)
  if (!JSON_NUMBER.test(text)) throw new TypeError('number is not representable as a JCS number')
  return text
}

function serializeString(value) {
  let output = '"'
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('string contains an unpaired high surrogate')
      }
      output += value.slice(index, index + 2)
      index += 1
      continue
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('string contains an unpaired low surrogate')
    }
    const escape = shortEscape(unit)
    if (escape !== null) {
      output += escape
      continue
    }
    if (unit < 0x20) {
      // Lowercase hex, four digits, as RFC 8785 / ECMAScript emit it.
      output += `\\u${unit.toString(16).padStart(4, '0')}`
      continue
    }
    output += value[index]
  }
  return `${output}"`
}

function shortEscape(unit) {
  switch (unit) {
    case 0x08: return '\\b'
    case 0x09: return '\\t'
    case 0x0a: return '\\n'
    case 0x0c: return '\\f'
    case 0x0d: return '\\r'
    case 0x22: return '\\"'
    case 0x5c: return '\\\\'
    default: return null
  }
}

// RFC 8785 §3.2.3: compare property names as arrays of UTF-16 code units,
// unsigned, independent of locale. This also means a non-BMP character (its
// high surrogate in 0xD800–0xDBFF) sorts below U+E000–U+FFFF.
function compareUtf16(left, right) {
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
