// T006 / FR-012 — `lib/redact.mjs`: no credential survives into a log line.
//
// Covers the classes named in spec 001 (R11): bearer tokens / Authorization
// headers, pairing codes, 32-byte base64url or hex device tokens, the
// `arguments` / `argsPreview` fields of a tool-call or approval frame, and URL
// query parameters named token | code | pairingCode. Plus the structural
// contract `lib/logging.mjs` relies on: `log()` redacts before it prints.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { REDACTED, redact, redactLine, redactString } from '../lib/redact.mjs'

const loggingURL = new URL('../lib/logging.mjs', import.meta.url).href

// Realistic secrets in the shapes the gateway issues (devices.js / pairing).
const pairingCode = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url') // 32 bytes → 43 chars
const deviceToken = Buffer.alloc(32, 7).toString('base64url')
const hexToken = 'a3f1'.repeat(16) // 64 hex chars, like a sha256 digest used as a token
const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXZpY2UifQ.c2lnbmF0dXJlLXZhbHVl'

test('pairing codes (32-byte base64url) are masked', () => {
  assert.equal(pairingCode.length, 43)
  const line = redactString(`pairing created: iPhone, code=${pairingCode}`)
  assert.equal(line.includes(pairingCode), false)
  assert.match(line, /\[redacted\]/)
  // Also as a standalone value and JSON-escaped inside a QR/frame dump.
  assert.equal(redactString(pairingCode), REDACTED)
  assert.match(redactString(JSON.stringify({ pairingCode: pairingCode })), /"pairingCode":"\[redacted\]"/)
})

test('device tokens (32-byte base64url, hex and JWT shapes) are masked', () => {
  for (const token of [deviceToken, hexToken, jwtLike]) {
    assert.equal(redactString(`token: ${token}`).includes(token), false, token)
    assert.equal(redactString(`"token":"${token}"`).includes(token), false, token)
  }
})

test('Authorization and Bearer header values are masked in every common spelling', () => {
  for (const line of [
    `Authorization: Bearer ${deviceToken}`,
    `authorization=Bearer ${deviceToken}`,
    `headers: {"Authorization":"Bearer ${deviceToken}"}`,
    `headers: {"Authorization": "Bearer ${deviceToken}"}`,
    `{ authorization: 'Basic ${deviceToken}' }`,
    `{"authorization":"Basic ${deviceToken}"}`,
    `{"authorization":"Bearer ${deviceToken}"}`,
    `{\\"authorization\\":\\"Bearer ${deviceToken}\\"}`,
    `failed with Bearer ${deviceToken} from 127.0.0.1`,
  ]) {
    const output = redactString(line)
    assert.equal(output.includes(deviceToken), false, line)
    assert.match(output, /\[redacted\]/, line)
  }
})

test('URL query parameters named token, code, pairingCode and friends are masked', () => {
  const url = `wss://192.168.1.10:3443/ws/mobile?pairingCode=${pairingCode}&device=a1`
  assert.equal(redactString(url), 'wss://192.168.1.10:3443/ws/mobile?pairingCode=[redacted]&device=a1')
  for (const query of [`?token=${deviceToken}`, `&code=${pairingCode}`, `?access_token=${deviceToken}`]) {
    const output = redactString(`upgrade ${query}`)
    assert.equal(output.includes(deviceToken), false, query)
    assert.equal(output.includes(pairingCode), false, query)
  }
  // JSON-escaped URL inside a serialized frame.
  const escaped = JSON.stringify({ url: `wss://h/ws/mobile?pairingCode=${pairingCode}` })
  assert.equal(redactString(escaped).includes(pairingCode), false)
})

test('a trailing pairing code quoted in a rejection message does not survive', () => {
  const line = `pairing rejected: code=${pairingCode}`
  assert.equal(redactString(line).includes(pairingCode), false)
})

test('arguments and argsPreview fields are masked at any depth, keys case-insensitive', () => {
  const frame = {
    type: 'approval-requested',
    approvalId: 'a1',
    toolName: 'shell',
    argsHash: null,
    argsPreview: '{"cmd":"rm -rf build","secret":"keep-me-out"}',
    arguments: '{"cmd":"rm -rf build"}',
    nested: { ArgsPreview: 'ls -la', Arguments: '{}' },
    list: [{ arguments: '{"a":1}', argsPreview: 'a 1' }, 'keep'],
  }
  const output = redact(frame)
  assert.equal(output.argsPreview, REDACTED)
  assert.equal(output.arguments, REDACTED)
  assert.equal(output.nested.ArgsPreview, REDACTED)
  assert.equal(output.nested.Arguments, REDACTED)
  assert.equal(output.list[0].arguments, REDACTED)
  assert.equal(output.list[0].argsPreview, REDACTED)
  // Non-sensitive data is preserved byte for byte; the input object is untouched.
  assert.equal(output.toolName, 'shell')
  assert.equal(output.list[1], 'keep')
  assert.equal(frame.arguments, '{"cmd":"rm -rf build"}')
  assert.equal(JSON.stringify(output).includes('keep-me-out'), false)
})

test('subprotocols that carry the pairing code or device token are masked', () => {
  const line = `upgrade headers: sec-websocket-protocol: dsh-mobile-v1, dsh-pair.${pairingCode}, dsh-auth.${deviceToken}`
  const output = redactString(line)
  assert.equal(output.includes(pairingCode), false)
  assert.equal(output.includes(deviceToken), false)
  assert.match(output, /dsh-mobile-v1, dsh-pair\.\[redacted\], dsh-auth\.\[redacted\]/)
})

test('error traces keep the message and stack but not the credential', () => {
  const error = new Error(`connection failed: Bearer ${deviceToken}`)
  const output = redact(error)
  assert.ok(output instanceof Error)
  assert.equal(output.message.includes(deviceToken), false)
  assert.equal(String(output.stack).includes(deviceToken), false)
  assert.match(output.message, /connection failed: Bearer \[redacted\]/)
  assert.equal(output.name, 'Error')
})

test('non-secret diagnostics stay readable (no over-redaction of ids, uuids or ordinary words)', () => {
  for (const line of [
    'query failed: sessions.list -> op/forbidden: invalid error code',
    'approval response: rpcId=5f0c3d1e session=s1 outcome=allowed-once accepted=true',
    `pairing created: iPhone (${'a9a0134f-0828-4772-9ffe-e9a9b0803e9a'}), expires=2026-11-08T23:05:20.047Z`,
    'auth rejected: missing or invalid device credential; remote=::1',
    'mobile gateway mode=persistent: startup',
    'capabilities sessions-read,prompt,cancel,approval-v1',
  ]) {
    assert.equal(redactString(line), line)
  }
})

test('non-string values pass through or are stringified without throwing', () => {
  assert.equal(redact(42), 42)
  assert.equal(redact(null), null)
  assert.equal(redact(undefined), undefined)
  assert.equal(redact(true), true)
  assert.equal(redact(1n), 1n)
  assert.equal(typeof redactLine({ type: 'hello', token: deviceToken }).token, 'string')
  assert.deepEqual(redact([1, null, 'ok']), [1, null, 'ok'])
})

test('cyclic and deeply nested values are bounded instead of throwing', () => {
  const cyclic = { kind: 'frame' }
  cyclic.self = cyclic
  const output = redact(cyclic)
  assert.equal(output.kind, 'frame')
  assert.equal(output.self, '[circular]')
  let deep = 'leaf'
  for (let index = 0; index < 40; index += 1) deep = { child: deep }
  assert.doesNotThrow(() => redact(deep))
})

test('redactString returns empty strings untouched and never throws on odd input', () => {
  assert.equal(redactString(''), '')
  assert.equal(redactString(null), null)
  assert.equal(redactLine(undefined), undefined)
  assert.equal(redactLine('plain text'), 'plain text')
})

function inTemporaryDirectory(body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-redact-'))
  try { body(directory) } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

test('logging.mjs redacts before printing and before writing the log file', () => {
  inTemporaryDirectory((directory) => {
    const snippet = `import { log } from ${JSON.stringify(loggingURL)}; `
      + `log('paired: token=' + ${JSON.stringify(deviceToken)}); `
      + `log('upgrade to wss://h/ws/mobile?pairingCode=' + ${JSON.stringify(pairingCode)}); `
      + `log('Authorization: Bearer ' + ${JSON.stringify(deviceToken)}); `
      + `log('approval arguments: ' + JSON.stringify({ arguments: '{"cmd":"secret-cmd"}', argsPreview: 'secret-cmd' }))`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', snippet], {
      env: { ...process.env, TMPDIR: directory, TEMP: directory, TMP: directory },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const file = fs.readFileSync(path.join(directory, 'mobile-gateway.log'), 'utf8')
    for (const captured of [result.stdout, file]) {
      assert.equal(captured.includes(deviceToken), false)
      assert.equal(captured.includes(pairingCode), false)
      assert.equal(captured.includes('secret-cmd'), false)
      assert.match(captured, /\[redacted\]/)
      assert.match(captured, /paired: token=\[redacted\]/) // the surrounding diagnostics remain
    }
    // Pairing codes never appear, only the masked placeholder.
    assert.equal(file.includes('pairingCode=[redacted]'), true)
  })
})
