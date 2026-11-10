// T007 / FR-005 — the protocol package must match the shipped contract document.
//
// Parses `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md` (looked up from this
// package, going up until the repo root) and asserts that every exported constant is exactly
// what the document says: the §4 `type` column / response `kind` column, the §6 error table
// (`—` ⇒ null), the §2 QR payload, the §3 `hello` and `client-hello` frames, the §5 approval
// outcomes and receipt reasons, and the §3 close codes. Any drift fails here instead of at a
// device.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as protocol from '../src/index.mjs'
import {
  APPROVAL_OUTCOMES_CLIENT,
  APPROVAL_OUTCOMES_FINAL,
  CAPABILITIES,
  CLOSE_CODES,
  COMPANION_PROTOCOL_VERSION,
  ERROR_CODES,
  MIN_CLIENT_VERSION,
  OP_RESPONSES,
  OPTIONAL_CAPABILITIES,
  OPS,
  PAIRING_QR_VERSION,
  PING_INTERVAL_MS,
  PROTOCOL_SUBPROTOCOL,
  RECEIPT_REASONS,
  SUBPROTOCOL_PREFIXES,
} from '../src/index.mjs'

const CONTRACT_PATH = 'specs/001-gateway-hardening/contracts/mobile-protocol-v1.md'

function findContract() {
  let directory = path.dirname(fileURLToPath(import.meta.url))
  while (true) {
    const candidate = path.join(directory, CONTRACT_PATH)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`cannot find ${CONTRACT_PATH} above ${import.meta.url}`)
    directory = parent
  }
}

const contract = fs.readFileSync(findContract(), 'utf8')
const lines = contract.replace(/\r/g, '').split('\n')

function section(prefix) {
  const start = lines.findIndex((line) => line.startsWith(prefix))
  assert.notEqual(start, -1, `contract section starting with "${prefix}" not found`)
  const body = []
  for (let index = start + 1; index < lines.length && !lines[index].startsWith('## '); index += 1) body.push(lines[index])
  return body
}

/**
 * Markdown table rows of a section, as arrays of trimmed cells. `\|` is an escaped pipe inside
 * a cell (the contract writes `queue`/`steer` and `apns`/`fcm` unions that way), so only
 * unescaped pipes split cells.
 */
function tableRows(prefix) {
  const rows = []
  for (const line of section(prefix)) {
    const row = line.trim()
    if (!row.startsWith('|')) continue
    const cells = splitRow(row)
    if (cells.length === 0) continue
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue // separator row
    rows.push(cells)
  }
  return rows
}

function splitRow(row) {
  const cells = []
  let current = ''
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index]
    if (char === '\\' && row[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  // The row is fenced by pipes: drop the empty leading/trailing cells they produce.
  return cells.slice(1, -1)
}

/** First inline code span of a cell (`\`x\` …` ⇒ `x`), or the bare cell text. */
function firstCode(cell) {
  const match = cell.match(/`([^`]+)`/)
  return match ? match[1] : cell.trim()
}

/**
 * Kind in a response cell. Every §4 kind is a response kind of this package, so it is located
 * by membership — never by guessing which code span in the cell is the kind. The `message`
 * cell also spells the `queue|steer` mode and `push-register` the platform enum, and a few
 * cells append the payload shape (`{items[]}`), which this avoids entirely.
 */
function responseKind(cell) {
  // Tokens anywhere in the cell: backticked spans first, then plain words. Selecting by
  // membership keeps parameters (`queue|steer`, `apns|fcm`) and payload shapes (`{items[]}`)
  // out of the result without an index guess.
  const tokens = [
    ...[...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
    ...(cell.match(/[A-Za-z][A-Za-z-]*/g) ?? []),
  ]
  const kind = tokens.find((token) => isResponseKind(token))
  return kind ?? cell.trim()
}

/** Response kinds per contract §4 (an immutable fixture, not `OP_RESPONSES` — see below). */
const CONTRACT_RESPONSE_KINDS = new Set([
  'client-hello', 'pong', 'sessions', 'search', 'history', 'subscribed', 'unsubscribed',
  'sent', 'session-cancelled', 'approval-response', 'device-info', 'device-forgotten',
  'push-registered', 'push-removed',
])

function isResponseKind(token) {
  return CONTRACT_RESPONSE_KINDS.has(token)
}

// ---------------------------------------------------------------------------
// §4 operations
// ---------------------------------------------------------------------------

const opRows = tableRows('## 4. Operations').slice(1) // drop the header row
const contractOps = opRows.map((cells) => firstCode(cells[0]))
const contractOpResponses = Object.fromEntries(
  opRows.map((cells) => [firstCode(cells[0]), responseKind(cells[2])]),
)

test('OPS equals the §4 `type` column, in table order', () => {
  assert.ok(contractOps.length > 0, 'no operations parsed from the contract')
  assert.deepEqual([...OPS], contractOps)
  assert.equal(Object.isFrozen(OPS), true)
})

test('OPS holds only unique operation names', () => {
  assert.equal(new Set(OPS).size, OPS.length)
})

test('OP_RESPONSES equals the §4 response `kind` column', () => {
  assert.equal(opRows.length, 14, 'the contract table is expected to list 14 operations')
  assert.deepEqual({ ...OP_RESPONSES }, contractOpResponses)
  assert.equal(Object.isFrozen(OP_RESPONSES), true)
})

// ---------------------------------------------------------------------------
// §6 error codes
// ---------------------------------------------------------------------------

function contractErrorCodes() {
  const rows = tableRows('## 6. Error codes')
  const found = new Map()
  for (const cells of rows.slice(1)) {
    const code = firstCode(cells[0])
    const http = cells[1]
    // Error codes are either `ns/name` or a single lowercase word (`bad-request`).
    assert.match(code, /^[a-z][a-z-]*(\/[a-z][a-z-]*)?$/, `unexpected error code cell "${code}"`)
    if (http === '—' || http === '-') found.set(code, null)
    else if (/^\d{3}$/.test(http)) found.set(code, Number(http))
    else assert.fail(`unexpected HTTP cell "${http}" for ${code}`)
  }
  return found
}

test('ERROR_CODES equals the §6 table exactly (— ⇒ null)', () => {
  const expected = contractErrorCodes()
  assert.ok(expected.size > 0, 'no error codes parsed from the contract')
  assert.deepEqual({ ...ERROR_CODES }, Object.fromEntries(expected))
  assert.equal(Object.isFrozen(ERROR_CODES), true)
  // The three upgrade-time statuses the contract makes normative.
  assert.equal(ERROR_CODES['auth/required'], 401)
  assert.equal(ERROR_CODES['remote/disabled'], 403)
  assert.equal(ERROR_CODES['pairing/expired'], 401)
  assert.equal(ERROR_CODES['op/forbidden'], null)
})

// ---------------------------------------------------------------------------
// §3 connection: close codes, hello, capabilities, subprotocols
// ---------------------------------------------------------------------------

test('CLOSE_CODES match §3 (4004 disabled, 4003 re-auth, 4401 revoked)', () => {
  const closeSection = section('## 3. Connection').join('\n')
  assert.match(closeSection, /`4004` gateway disabled \(stop auto-reconnect\)/)
  assert.match(closeSection, /`4003` re-authenticate/)
  assert.match(closeSection, /`4401` revoked/)
  assert.deepEqual({ ...CLOSE_CODES }, { gatewayDisabled: 4004, reauth: 4003, revoked: 4401 })
  assert.equal(Object.isFrozen(CLOSE_CODES), true)
})

/** The `hello` JSON example of §3.5 (it spans several lines, fenced by ```json). */
function contractHello() {
  const start = lines.findIndex((line) => line.includes('{ "kind": "hello"'))
  assert.notEqual(start, -1, 'hello example not found')
  let blockStart = -1
  for (let index = start - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === '```json') {
      blockStart = index
      break
    }
  }
  assert.notEqual(blockStart, -1, 'hello example must sit in a ```json block')
  const blockEnd = lines.findIndex((line, index) => index > start && line.trim() === '```')
  assert.notEqual(blockEnd, -1, 'unterminated hello example block')
  return JSON.parse(lines.slice(blockStart + 1, blockEnd).join('\n'))
}

test('hello example carries the package companion protocol constants and capabilities', () => {
  const hello = contractHello()
  assert.equal(hello.kind, 'hello')
  assert.equal(hello.companionProtocol, COMPANION_PROTOCOL_VERSION)
  assert.equal(hello.minClientVersion, MIN_CLIENT_VERSION)
  assert.deepEqual(hello.capabilities, [...CAPABILITIES])
  for (const capability of hello.capabilities) {
    assert.ok(CAPABILITIES.includes(capability) || OPTIONAL_CAPABILITIES.includes(capability), capability)
  }
  assert.equal(COMPANION_PROTOCOL_VERSION, 1)
  assert.equal(MIN_CLIENT_VERSION, 1)
})

test('CAPABILITIES / OPTIONAL_CAPABILITIES match the prose of §3.5', () => {
  assert.match(contract, /`capabilities` on the companion channel are exactly the package `CAPABILITIES` the gateway supports;/)
  assert.match(contract, /`push-v1` is added only when remote push is configured\./)
  assert.deepEqual([...CAPABILITIES], ['sessions-read', 'prompt', 'cancel', 'approval-v1'])
  assert.deepEqual([...OPTIONAL_CAPABILITIES], ['push-v1'])
  assert.equal(Object.isFrozen(CAPABILITIES), true)
  assert.equal(Object.isFrozen(OPTIONAL_CAPABILITIES), true)
})

test('PROTOCOL_SUBPROTOCOL and the subprotocol fallbacks match §1/§3', () => {
  assert.match(contract, /Subprotocol always includes `dsh-mobile-v1`\./)
  assert.equal(PROTOCOL_SUBPROTOCOL, 'dsh-mobile-v1')
  assert.equal(SUBPROTOCOL_PREFIXES.pair, 'dsh-pair.')
  assert.equal(SUBPROTOCOL_PREFIXES.auth, 'dsh-auth.')
  assert.equal(SUBPROTOCOL_PREFIXES.device, 'dsh-device.')
  for (const prefix of Object.values(SUBPROTOCOL_PREFIXES)) {
    assert.ok(contract.includes(`${prefix}<`), `${prefix}<…> must appear in the contract`)
  }
  // The header that travels with the pair subprotocol, and its subprotocol fallback.
  assert.match(contract, /`X-DSH-Device-ID:/)
  assert.equal(protocol.DEVICE_ID_HEADER, 'X-DSH-Device-ID')
  assert.deepEqual(protocol.pairingSubprotocols('abc'), ['dsh-mobile-v1', 'dsh-pair.abc'])
  assert.deepEqual(protocol.authSubprotocols('tok'), ['dsh-mobile-v1', 'dsh-auth.tok'])
  assert.deepEqual(protocol.authSubprotocols(), ['dsh-mobile-v1'])
  assert.equal(protocol.deviceSubprotocol('uuid-1'), 'dsh-device.uuid-1')
})

test('client-hello example (§3.6) uses the package shape', () => {
  const match = contract.match(/\{ "type": "client-hello", "requestId": "[^"]*", "companionProtocol": (\d+), "appVersion": "[^"]*", "platform": "ios\|android" \}/)
  assert.ok(match, 'client-hello example not found in §3.6')
  assert.equal(Number(match[1]), COMPANION_PROTOCOL_VERSION)
  const example = protocol.pairingSubprotocols // keep the import tree-shake proof honest
  assert.equal(typeof example, 'function')
})

// ---------------------------------------------------------------------------
// §2 pairing QR
// ---------------------------------------------------------------------------

test('PAIRING_QR_VERSION matches the §2 example', () => {
  const match = contract.match(/\{ "version": (\d+), "publicUrl":/)
  assert.ok(match, 'QR payload example not found in §2')
  assert.equal(Number(match[1]), PAIRING_QR_VERSION)
  assert.equal(PAIRING_QR_VERSION, 3)
  assert.match(contract, /Client MUST reject `version !== 3`/)
  assert.match(contract, /`expiresAt` is epoch milliseconds/)
  assert.match(contract, /unpadded base64url/)
})

// ---------------------------------------------------------------------------
// §5 approvals
// ---------------------------------------------------------------------------

test('APPROVAL_OUTCOMES_CLIENT matches the §5 response line', () => {
  const match = contract.match(/"outcome": "([a-z-]+)" \| "([a-z-]+)"/)
  assert.ok(match, 'client outcome union not found in §5')
  assert.deepEqual([...APPROVAL_OUTCOMES_CLIENT], [match[1], match[2]])
  assert.equal(Object.isFrozen(APPROVAL_OUTCOMES_CLIENT), true)
  assert.match(contract, /`cancelled`\/`unavailable` are host states and are never sent by the client\./)
})

test('APPROVAL_OUTCOMES_FINAL matches the §5 approval-resolved line', () => {
  const match = contract.match(/"outcome": "([a-z-]+)"\s*\n?\s*\| "([a-z-]+)" \| "([a-z-]+)" \| "([a-z-]+)" \}/)
  assert.ok(match, 'final outcome union not found in §5')
  const finals = match.slice(1, 5)
  assert.deepEqual([...APPROVAL_OUTCOMES_FINAL], finals)
  // The first two are exactly the client-sendable outcomes.
  assert.deepEqual(finals.slice(0, 2), [...APPROVAL_OUTCOMES_CLIENT])
  assert.equal(Object.isFrozen(APPROVAL_OUTCOMES_FINAL), true)
})

test('RECEIPT_REASONS match the §5 receipt paragraph', () => {
  // "…or `accepted: false` with `reason` ∈ `not-pending` (already decided / handed to desktop),
  //  `hash-mismatch` (content changed — …)"
  const match = contract.match(/`accepted: false` with `reason` ∈ `([a-z-]+)`[\s\S]{0,200}?\n?`([a-z-]+)`/)
  assert.ok(match, 'receipt reasons not found in §5')
  assert.deepEqual([...RECEIPT_REASONS], [match[1], match[2]])
  assert.deepEqual([...RECEIPT_REASONS], ['not-pending', 'hash-mismatch'])
  assert.equal(Object.isFrozen(RECEIPT_REASONS), true)
})

test('approval-requested push carries argsHash: null for desktop-only requests', () => {
  assert.match(contract, /"argsHash": "<64 hex> \| null"/)
  assert.match(contract, /the client MUST NOT offer approve\/reject/)
  assert.match(contract, /Client deduplicates by `rpcId`\./)
})

test('PING_INTERVAL_MS matches the §4 ping row', () => {
  const pingRow = opRows.find((cells) => firstCode(cells[0]) === 'ping')
  assert.ok(pingRow, 'ping row not found')
  assert.match(pingRow[3] ?? '', /every 25 s/)
  assert.equal(PING_INTERVAL_MS, 25_000)
})

test('every export is frozen where it is a constant table', () => {
  for (const name of [
    'OPS', 'CAPABILITIES', 'OPTIONAL_CAPABILITIES', 'ERROR_CODES', 'CLOSE_CODES', 'RECEIPT_REASONS',
    'APPROVAL_OUTCOMES_CLIENT', 'APPROVAL_OUTCOMES_FINAL', 'SUBPROTOCOL_PREFIXES', 'OP_RESPONSES',
    'SERVER_PUSH_KINDS', 'PASSTHROUGH_ERROR_CODES', 'DEVICE_KINDS', 'SCOPES', 'DESKTOP_DEFAULT_SCOPES',
    'SCOPE_BY_TYPE', 'REMOTE_CLIENT_TYPES', 'REMOTE_SERVER_KINDS', 'DESKTOP_ONLY_SCOPES', 'SCOPE_PRESETS',
  ]) {
    assert.equal(Object.isFrozen(protocol[name]), true, `${name} must be frozen`)
  }
})

// ---------------------------------------------------------------------------
// Spec 005 — device kinds, scopes, auth/forbidden-scope (revision 3)
// ---------------------------------------------------------------------------

const SPEC_008_SCOPES = [
  'harness:remote', 'commands:execute', 'workspace:manage', 'credentials:write', 'plugins:manage', 'schedule:write', 'terminal',
]

test('SCOPES are the six spec 005 FR2 scopes plus the spec 008 scopes; DESKTOP_DEFAULT_SCOPES are the FR3 three', () => {
  assert.deepEqual([...protocol.SCOPES],
    ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'files:write', 'settings:write', ...SPEC_008_SCOPES])
  // Spec 008: these must be chosen at pair time, never defaulted.
  for (const scope of SPEC_008_SCOPES) {
    assert.equal(protocol.DESKTOP_DEFAULT_SCOPES.includes(scope), false, `${scope} must not be a default`)
  }
  assert.deepEqual([...protocol.DESKTOP_ONLY_SCOPES], SPEC_008_SCOPES)
  assert.deepEqual([...protocol.DEVICE_KINDS], ['mobile', 'desktop'])
  assert.deepEqual([...protocol.DESKTOP_DEFAULT_SCOPES], ['sessions:read', 'prompt:send', 'approval:respond'])
  // The spec restates the revision in the contract document; both must list every scope.
  const specDir = path.join(path.dirname(path.dirname(path.dirname(findContract()))), '005-remote-desktop-client')
  const spec = fs.readFileSync(path.join(specDir, 'spec.md'), 'utf8')
  const contractDoc = fs.readFileSync(findContract(), 'utf8')
  assert.match(contractDoc, /\*\*Revision 3/)
  // The spec 008 scopes belong to spec 008, not to the six 005 scopes.
  for (const scope of protocol.SCOPES.filter((name) => !SPEC_008_SCOPES.includes(name))) {
    assert.ok(spec.includes(`\`${scope}\``), `${scope} must appear in spec 005`)
    assert.ok(contractDoc.includes(`\`${scope}\``), `${scope} must appear in contract §3/§6`)
  }
  for (const scope of protocol.DESKTOP_DEFAULT_SCOPES) assert.ok(protocol.SCOPES.includes(scope), scope)
})

test('SCOPE_BY_TYPE only names contract ops and scopes, and covers the FR2 mapped types', () => {
  for (const [type, scope] of Object.entries(protocol.SCOPE_BY_TYPE)) {
    // Spec 008 remote-bridge frames are scoped too, but are not §4 ops (see below).
    assert.ok(OPS.includes(type) || protocol.REMOTE_CLIENT_TYPES.includes(type), `${type} is not a contract §4 op`)
    assert.ok(protocol.SCOPES.includes(scope), `${type} → unknown scope ${scope}`)
  }
  // The types the desktop client (spec 005 US2) must be able to send.
  for (const type of ['sessions', 'history', 'message', 'session-cancel', 'approval-response']) {
    assert.ok(protocol.SCOPE_BY_TYPE[type], `${type} must be mapped`)
  }
  // Unmappable today: they manage the credential or push, not a scoped capability.
  for (const type of ['device-forget', 'push-register', 'push-remove']) {
    assert.equal(protocol.SCOPE_BY_TYPE[type], undefined, `${type} must stay unmapped (fail closed)`)
  }
})

test('auth/forbidden-scope is an in-band-only contract error (spec 005 FR6)', () => {
  assert.equal(protocol.ERROR_CODES['auth/forbidden-scope'], null)
  assert.match(contract, /\| `auth\/forbidden-scope` \| — \|/)
  assert.match(contract, /Other host error codes .* passed through unchanged/)
})

// ---------------------------------------------------------------------------
// Spec 008 — remote-bridge channel (revision 4, additive)
// ---------------------------------------------------------------------------

test('remote-bridge frame types are additive: not §4 ops, every client type needs harness:remote', () => {
  assert.deepEqual([...protocol.REMOTE_CLIENT_TYPES],
    ['remote-call', 'remote-stream-open', 'remote-stream-cancel', 'remote-stream-credit'])
  assert.deepEqual([...protocol.REMOTE_SERVER_KINDS], ['remote-result', 'remote-frame', 'remote-stream-closed'])
  for (const type of protocol.REMOTE_CLIENT_TYPES) {
    // The companion-v1 allowlist (§4) is untouched: a mobile device cannot send these.
    assert.equal(OPS.includes(type), false, `${type} must not join the §4 OPS`)
    assert.equal(protocol.SCOPE_BY_TYPE[type], 'harness:remote', `${type} must require harness:remote`)
  }
  assert.equal(OPS.length, 14, 'the §4 table is unchanged by revision 4')
  assert.equal(protocol.REMOTE_STREAM_DEFAULT_CREDIT, 64)
  assert.equal(protocol.REMOTE_BINARY_CHUNK_BYTES, 256 * 1024)
})

test('spec 008 full-control scopes: desktop-only, explicit-only, no frame type maps to them', () => {
  for (const scope of SPEC_008_SCOPES) {
    assert.ok(protocol.SCOPES.includes(scope), `${scope} must be a contract scope`)
    assert.ok(protocol.DESKTOP_ONLY_SCOPES.includes(scope), `${scope} must be desktop-only`)
    assert.equal(protocol.DESKTOP_DEFAULT_SCOPES.includes(scope), false)
  }
  // Frame types only ever need harness:remote; the families are checked per endpoint by the bridge.
  for (const scope of SPEC_008_SCOPES.filter((name) => name !== 'harness:remote')) {
    assert.equal(Object.values(protocol.SCOPE_BY_TYPE).includes(scope), false, `${scope} must not gate a frame type`)
  }
})

test('SCOPE_PRESETS: standard is the four read/prompt/approve/files scopes plus harness:remote; full is every desktop scope', () => {
  assert.deepEqual(Object.keys(protocol.SCOPE_PRESETS), ['standard', 'full'])
  assert.deepEqual([...protocol.SCOPE_PRESETS.standard],
    ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote'])
  // "Every desktop scope" = every contract scope: the desktop may hold all of them.
  assert.deepEqual([...protocol.SCOPE_PRESETS.full].sort(), [...protocol.SCOPES].sort())
  for (const scope of SPEC_008_SCOPES) assert.ok(protocol.SCOPE_PRESETS.full.includes(scope), `full must include ${scope}`)
  for (const preset of Object.values(protocol.SCOPE_PRESETS)) {
    assert.equal(Object.isFrozen(preset), true)
    for (const scope of preset) assert.ok(protocol.SCOPES.includes(scope), `${scope} is not a contract scope`)
  }
  // Neither preset is a default: DESKTOP_DEFAULT_SCOPES stays the FR3 three.
  assert.deepEqual([...protocol.DESKTOP_DEFAULT_SCOPES], ['sessions:read', 'prompt:send', 'approval:respond'])
})

test('the d.ts declares the revision 4 surface', () => {
  const declaration = fs.readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8')
  assert.match(declaration, /\| 'harness:remote'/)
  for (const scope of SPEC_008_SCOPES) assert.ok(declaration.includes(`| '${scope}'`), `${scope} must be declared as a Scope`)
  for (const name of ['DESKTOP_ONLY_SCOPES', 'SCOPE_PRESETS']) {
    assert.ok(declaration.includes(`export const ${name}`), `${name} must be declared`)
  }
  for (const name of ['REMOTE_CLIENT_TYPES', 'REMOTE_SERVER_KINDS', 'REMOTE_STREAM_DEFAULT_CREDIT', 'REMOTE_BINARY_CHUNK_BYTES']) {
    assert.ok(declaration.includes(`export const ${name}`), `${name} must be declared`)
  }
  for (const type of protocol.REMOTE_CLIENT_TYPES) assert.ok(declaration.includes(`'${type}'`), `${type} must be declared`)
  for (const kind of protocol.REMOTE_SERVER_KINDS) assert.ok(declaration.includes(`'${kind}'`), `${kind} must be declared`)
  for (const name of ['RemoteCallFrame', 'RemoteStreamOpenFrame', 'RemoteStreamCancelFrame', 'RemoteStreamCreditFrame',
    'RemoteResultFrame', 'RemoteFrame', 'RemoteStreamClosedFrame']) {
    assert.match(declaration, new RegExp(`export (interface|type) ${name}\\b`), `${name} must be declared`)
  }
})

// ---------------------------------------------------------------------------
// §5a — session rows (revision 2.1): canonical sessionId/running
// ---------------------------------------------------------------------------

test('SessionRow §5a fields are normative and the package mirrors them', () => {
  // Exact revision 2.1 clarification: the row id is `sessionId`, not `id`.
  assert.match(contract, /## 5a\. Clarifications \(rev 2\.1/)
  assert.match(
    contract,
    /`sessions` rows carry `sessionId`, `updatedAt` \(epoch ms\), `running`, `projections\.values\.title`/,
  )
  assert.match(contract, /client\s*\n\s*derives running\/idle\/archived\./)

  const declaration = fs.readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8')
  const interfaceBlock = declaration.match(/export interface SessionRow \{[\s\S]*?\n\}/)?.[0]
  assert.ok(interfaceBlock, 'SessionRow interface not found in index.d.ts')
  assert.match(interfaceBlock, /^\s*sessionId: string$/m)
  assert.match(interfaceBlock, /^\s*running\?: boolean$/m)
  // `id` survives only as an explicitly deprecated optional compatibility fallback.
  assert.match(interfaceBlock, /^\s*id\?: string$/m)
  assert.match(interfaceBlock, /@deprecated[\s\S]*?id\?: string/)
  assert.doesNotMatch(interfaceBlock, /^\s*id: string$/m)

  const runtime = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8')
  const start = runtime.indexOf('@typedef {Object} SessionRow')
  assert.notEqual(start, -1, 'SessionRow typedef not found in src/index.mjs')
  const typedef = runtime.slice(start, runtime.indexOf('*/', start))
  assert.match(typedef, /@property \{string\} sessionId/)
  assert.match(typedef, /@property \{boolean\} \[running\]/)
  assert.match(typedef, /@property \{string\} \[id\] Deprecated:/)
  assert.doesNotMatch(typedef, /@property \{string\} id\b/)
})
