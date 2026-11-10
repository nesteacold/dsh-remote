// T025 / FR-008 — unit tests for `lib/approval-hash.mjs` (the pure primitive).
//
// Golden vectors for RFC 8785 (JCS) canonicalization and for the protocol's
// `argsHash`, plus mutation checks: key order, whitespace and equivalent number
// or escape spellings never change the hash; array order and any content change
// always do; every unrepresentable input fails closed to `null`.
//
// Run directly (package.json is owned elsewhere and does not list this file):
//
//   node --test test/approval-hash-unit.test.mjs
//
// The end-to-end gateway test for T024 lives in `test/approval-hash.test.mjs`;
// this file exercises only the primitive.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { approvalArgsHash, canonicalizeJcs } from '../lib/approval-hash.mjs'

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const argsHash = (toolName, callId, rawArguments) => approvalArgsHash({ toolName, callId, rawArguments })
const HEX64 = /^[0-9a-f]{64}$/

// ---------------------------------------------------------------------------
// RFC 8785 canonicalization
// ---------------------------------------------------------------------------

test('canonical JSON of primitives', () => {
  assert.equal(canonicalizeJcs(null), 'null')
  assert.equal(canonicalizeJcs(true), 'true')
  assert.equal(canonicalizeJcs(false), 'false')
  assert.equal(canonicalizeJcs('hi'), '"hi"')
  assert.equal(canonicalizeJcs(42), '42')
  assert.equal(canonicalizeJcs(''), '""')
  assert.equal(canonicalizeJcs([]), '[]')
  assert.equal(canonicalizeJcs({}), '{}')
})

test('RFC 8785 worked example canonicalizes exactly', () => {
  // §3.2.2 example, kept as literal input/output strings so neither expected
  // value nor hash is produced by the code under test.
  const input = String.raw`{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/","literals":[null,true,false]}`
  const expected = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`
  assert.equal(canonicalizeJcs(JSON.parse(input)), expected)
})

test('object keys sort by UTF-16 code units, recursively', () => {
  const input = {
    '\u{1F600}': 'emoji',
    '\uFFFD': 'replacement',
    A: 'upper',
    '\u0080': 'c1',
    '\u20ac': 'euro',
    '\n': 'newline',
    nested: { b: 1, a: { d: 2, c: 3 } },
  }
  const expected = '{"\\n":"newline","A":"upper","nested":{"a":{"c":3,"d":2},"b":1},"\u0080":"c1","\u20ac":"euro","\u{1F600}":"emoji","\uFFFD":"replacement"}'
  assert.equal(canonicalizeJcs(input), expected)
})

test('integer-like keys sort as strings, not in numeric order', () => {
  // Object.keys() yields "1", "2", "10" for integer-like keys; JCS re-sorts.
  assert.equal(canonicalizeJcs({ 2: 'b', 10: 'a', 1: 'c' }), '{"1":"c","10":"a","2":"b"}')
})

test('non-BMP keys sort by high surrogate, not by code point', () => {
  // 0xD83D < 0xFFFD as UTF-16 code units, so the emoji sorts before U+FFFD
  // even though its code point (0x1F600) is larger.
  assert.equal(canonicalizeJcs({ '\u{1F600}': 1, '\uFFFD': 2 }), '{"\u{1F600}":1,"\uFFFD":2}')
  assert.ok(0xd83d < 0xfffd)
})

test('arrays preserve order; nested objects inside arrays still sort', () => {
  assert.equal(canonicalizeJcs([3, 1, 2]), '[3,1,2]')
  assert.equal(canonicalizeJcs([{ b: 1, a: 2 }, { d: 3, c: 4 }]), '[{"a":2,"b":1},{"c":4,"d":3}]')
})

test('strings escape exactly what RFC 8785 / ECMAScript requires', () => {
  // U+0000–U+001F: short escapes where they exist, lowercase \u00xx otherwise.
  assert.equal(
    canonicalizeJcs('\u0000\u0001\b\t\n\u000b\f\r\u001f'),
    String.raw`"\u0000\u0001\b\t\n\u000b\f\r\u001f"`,
  )
  // Quote and backslash escaped; forward slash literal.
  assert.equal(canonicalizeJcs('"\\/'), String.raw`"\"\\/"`)
  // U+007F, C1 controls and line/paragraph separators stay literal.
  assert.equal(canonicalizeJcs('\u007f\u0080\u2028\u2029'), '"\u007f\u0080\u2028\u2029"')
  // Non-ASCII (BMP and non-BMP) is literal UTF-8, never \u-escaped.
  assert.equal(canonicalizeJcs('é😀'), '"é😀"')
})

test('valid surrogate pairs survive; lone surrogates are rejected', () => {
  assert.equal(canonicalizeJcs('\u{1F600}'), '"😀"')
  assert.equal(canonicalizeJcs('\uD83D\uDE00'), '"😀"')
  for (const bad of ['\uD800', '\uDC00', 'a\uD800', '\uDC00a', '\uD800\uD800', '\uDE00\uD83D']) {
    assert.throws(() => canonicalizeJcs(bad), TypeError)
  }
  assert.throws(() => canonicalizeJcs({ '\uD800': 1 }), TypeError)
  assert.throws(() => canonicalizeJcs([1, '\uDC00']), TypeError)
})

test('numbers serialize as the ECMAScript Number::toString() JCS form', () => {
  const cases = [
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [-1, '-1'],
    [1.5, '1.5'],
    [0.1, '0.1'],
    [1 / 3, '0.3333333333333333'],
    [4.5, '4.5'],
    [0.002, '0.002'],
    [1e20, '100000000000000000000'],
    [1e21, '1e+21'],
    [1e30, '1e+30'],
    [1e-6, '0.000001'],
    [1e-7, '1e-7'],
    [1e-27, '1e-27'],
    [333333333.33333329, '333333333.3333333'],
    [9007199254740992, '9007199254740992'],
    [9007199254740993, '9007199254740992'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    [Number.MAX_VALUE, '1.7976931348623157e+308'],
    [Number.MIN_VALUE, '5e-324'],
    [123456789012345678901234567890, '1.2345678901234568e+29'],
  ]
  for (const [value, expected] of cases) assert.equal(canonicalizeJcs(value), expected, String(value))
  // Negative zero has no distinct JSON representation.
  assert.equal(canonicalizeJcs(-0), canonicalizeJcs(0))
})

test('non-finite and non-JSON values are rejected, never coerced', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, 1n, Symbol('s'), () => 1, new Date(), new Map(), new Set(), Buffer.from('x')]) {
    assert.throws(() => canonicalizeJcs(bad), TypeError)
  }
  // JSON.stringify() would drop `a` or emit null; both would change the bound
  // content, so the canonicalizer refuses instead.
  assert.throws(() => canonicalizeJcs({ a: undefined }), TypeError)
  assert.throws(() => canonicalizeJcs({ a: NaN }), TypeError)
  assert.throws(() => canonicalizeJcs([1, undefined]), TypeError)
})

test('cycles, sparse arrays and symbol keys are rejected', () => {
  const cycle = {}
  cycle.self = cycle
  assert.throws(() => canonicalizeJcs(cycle), TypeError)

  const sparse = [1]
  sparse[2] = 3
  assert.throws(() => canonicalizeJcs(sparse), TypeError)

  assert.throws(() => canonicalizeJcs({ [Symbol('s')]: 1 }), TypeError)
})

// ---------------------------------------------------------------------------
// Protocol argsHash — golden vectors
// ---------------------------------------------------------------------------

test('golden vector: ASCII tool call', () => {
  const canonical = String.raw`{"arguments":{"command":"echo hi","cwd":"/tmp"},"callId":"call-42","toolName":"bash"}`
  assert.equal(sha256(canonical), 'ab2408167c0818bc700feb58a8198057913b9a779fbf1a542983138cb50c2da7')
  assert.equal(
    argsHash('bash', 'call-42', String.raw`{"cwd":"/tmp","command":"echo hi"}`),
    'ab2408167c0818bc700feb58a8198057913b9a779fbf1a542983138cb50c2da7',
  )
})

test('golden vector: Unicode tool call, exponent and negative zero', () => {
  const canonical = String.raw`{"arguments":{"n":1e+30,"q":"café 😀","zero":0},"callId":"调用-1","toolName":"搜索"}`
  assert.equal(sha256(canonical), '7a4ae56c74efb5005306d5120a11cf9d15a0db89766c97a96d466fb238f5a4d3')
  assert.equal(
    argsHash('搜索', '调用-1', String.raw`{"zero":-0,"n":1E30,"q":"caf\u00e9 \ud83d\ude00"}`),
    '7a4ae56c74efb5005306d5120a11cf9d15a0db89766c97a96d466fb238f5a4d3',
  )
})

test('the bound object is exactly {arguments, callId, toolName} in JCS order', () => {
  const canonical = String.raw`{"arguments":{"z":0},"callId":"c","toolName":"t"}`
  assert.equal(argsHash('t', 'c', '{"z":-0}'), sha256(canonical))
})

// ---------------------------------------------------------------------------
// Equivalence and mutation
// ---------------------------------------------------------------------------

test('equivalent JSON encodings hash the same', () => {
  const base = argsHash('bash', 'c1', '{"a":1,"b":{"y":2,"x":3}}')
  for (const raw of [
    '{"b":{"x":3,"y":2},"a":1}',
    ' { "a" : 1 , "b" : { "y" : 2 , "x" : 3 } } ',
    '\n{"a":1.0,"b":{"y":2e0,"x":3.00}}\n',
    '{"a":1e0,"b":{"y":0.2e1,"x":3}}',
    String.raw`{"\u0061":1,"b":{"y":2,"x":3}}`,
  ]) {
    assert.equal(argsHash('bash', 'c1', raw), base, raw)
  }
})

test('key order never changes the hash', () => {
  const expected = argsHash('tool', 'call', '{"x":1,"y":{"q":2,"p":3},"z":[1,2]}')
  for (const raw of [
    '{"z":[1,2],"y":{"p":3,"q":2},"x":1}',
    '{"y":{"q":2,"p":3},"x":1,"z":[1,2]}',
    '{"x":1,"z":[1,2],"y":{"q":2,"p":3}}',
  ]) {
    assert.equal(argsHash('tool', 'call', raw), expected, raw)
  }
})

test('changing tool name, call id or any argument changes the hash', () => {
  const base = argsHash('bash', 'call-1', '{"command":"ls","cwd":"/work","env":{"A":1}}')
  assert.match(base, HEX64)
  const variants = new Set([base])
  variants.add(argsHash('bash2', 'call-1', '{"command":"ls","cwd":"/work","env":{"A":1}}'))
  variants.add(argsHash('bash', 'call-2', '{"command":"ls","cwd":"/work","env":{"A":1}}'))
  variants.add(argsHash('bash', 'call-1', '{"command":"ls -la","cwd":"/work","env":{"A":1}}'))
  variants.add(argsHash('bash', 'call-1', '{"command":"ls","cwd":"/other","env":{"A":1}}'))
  variants.add(argsHash('bash', 'call-1', '{"command":"ls","cwd":"/work","env":{"A":2}}'))
  variants.add(argsHash('bash', 'call-1', '{"command":"ls","cwd":"/work","env":{"A":1,"B":2}}'))
  variants.add(argsHash('bash', 'call-1', '{"command":"ls","cwd":"/work"}'))
  variants.add(argsHash('bash', 'call-1', '{"command":["ls"],"cwd":"/work","env":{"A":1}}'))
  assert.equal(variants.size, 9)
})

test('array order is significant', () => {
  assert.notEqual(argsHash('t', 'c', '{"a":[1,2,3]}'), argsHash('t', 'c', '{"a":[3,2,1]}'))
  assert.notEqual(argsHash('t', 'c', '[1,2]'), argsHash('t', 'c', '[2,1]'))
  // Reordering object keys around an unchanged array must not change it.
  assert.equal(argsHash('t', 'c', '{"a":[1,2],"b":{"x":[3]}}'), argsHash('t', 'c', '{"b":{"x":[3]},"a":[1,2]}'))
})

test('JCS does not normalize Unicode (NFC and NFD differ)', () => {
  const composed = argsHash('t', 'c', JSON.stringify({ s: '\u00e9' }))
  const decomposed = argsHash('t', 'c', JSON.stringify({ s: 'e\u0301' }))
  assert.match(composed, HEX64)
  assert.match(decomposed, HEX64)
  assert.notEqual(composed, decomposed)
})

test('duplicate object keys resolve as JSON.parse does (last wins)', () => {
  assert.equal(argsHash('t', 'c', '{"a":1,"a":2}'), argsHash('t', 'c', '{"a":2}'))
})

test('any parsed JSON value can be bound as arguments', () => {
  for (const raw of ['null', 'true', 'false', '0', '""', '"text"', '[1,2]', '{"a":1}']) {
    assert.match(argsHash('bash', 'c', raw), HEX64, raw)
  }
})

test('an own __proto__ key is bound like any other key and does not pollute', () => {
  const raw = '{"__proto__":{"polluted":true},"a":1}'
  const parsed = JSON.parse(raw)
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype)
  assert.equal({}.polluted, undefined)
  assert.match(argsHash('t', 'c', raw), HEX64)
  // Same content, different key order → same hash (the key is not dropped).
  assert.equal(argsHash('t', 'c', raw), argsHash('t', 'c', '{"a":1,"__proto__":{"polluted":true}}'))
  assert.notEqual(argsHash('t', 'c', raw), argsHash('t', 'c', '{"a":1}'))
})

// ---------------------------------------------------------------------------
// Fail-closed: null, never a throw
// ---------------------------------------------------------------------------

test('missing or unusable callId, toolName or rawArguments return null', () => {
  for (const callId of [undefined, null, '', 42, {}, []]) {
    assert.equal(approvalArgsHash({ toolName: 'bash', callId, rawArguments: '{}' }), null)
  }
  for (const toolName of [undefined, null, '', 42, {}]) {
    assert.equal(approvalArgsHash({ toolName, callId: 'c', rawArguments: '{}' }), null)
  }
  for (const rawArguments of [undefined, null, 42, {}, Buffer.from('{}')]) {
    assert.equal(approvalArgsHash({ toolName: 'bash', callId: 'c', rawArguments }), null)
  }
  assert.equal(approvalArgsHash(), null)
  assert.equal(approvalArgsHash(null), null)
  assert.equal(approvalArgsHash('bash'), null)
})

test('unparsable arguments return null', () => {
  for (const raw of [
    '', ' ', '{', '}', '{"a":}', '{"a":1,}', '{"a":01}', '{"a":+1}', "{'a':1}",
    '{"a":.5}', '{"a":1.}', '0x10', 'NaN', 'Infinity', 'undefined', '[1,]',
    '{"a":1} trailing', '\uFEFF{"a":1}', '{"a":1e}',
  ]) {
    assert.equal(argsHash('bash', 'c', raw), null, JSON.stringify(raw))
  }
})

test('non-finite numbers in arguments (overflow) fail closed', () => {
  for (const raw of ['1e400', '-1e400', '{"a":1e400}', '{"a":[-1e400]}', '{"a":1e999}']) {
    assert.equal(approvalArgsHash({ toolName: 'bash', callId: 'c', rawArguments: raw }), null, raw)
  }
  // Underflow is a finite 0, which JCS can bind.
  assert.match(argsHash('bash', 'c', '{"a":1e-400}'), HEX64)
})

test('unpaired surrogates in arguments fail closed; valid pairs hash', () => {
  for (const raw of [
    String.raw`{"a":"\ud800"}`,
    String.raw`{"a":"\udc00"}`,
    String.raw`{"a":"x\ud800"}`,
    String.raw`{"a":"\ud800x"}`,
    String.raw`{"\ud800":1}`,
    String.raw`["\udc00"]`,
    String.raw`{"a":["ok","\ud800"]}`,
  ]) {
    assert.equal(argsHash('bash', 'c', raw), null, raw)
  }
  const escapedPair = argsHash('bash', 'c', String.raw`{"a":"\ud83d\ude00"}`)
  assert.match(escapedPair, HEX64)
  assert.equal(escapedPair, argsHash('bash', 'c', '{"a":"😀"}'))
})

test('unpaired surrogates in toolName or callId fail closed', () => {
  assert.equal(approvalArgsHash({ toolName: '\uD800', callId: 'c', rawArguments: '{}' }), null)
  assert.equal(approvalArgsHash({ toolName: 't', callId: '\uDC00', rawArguments: '{}' }), null)
})

test('approvalArgsHash never throws on hostile input', () => {
  assert.equal(approvalArgsHash(new Proxy({}, { get() { throw new Error('boom') } })), null)
  assert.equal(approvalArgsHash({ get toolName() { throw new Error('boom') } }), null)

  // Reasonable nesting binds normally.
  let deep = { leaf: true }
  for (let index = 0; index < 500; index += 1) deep = { child: deep }
  assert.match(
    approvalArgsHash({ toolName: 't', callId: 'c', rawArguments: JSON.stringify(deep) }),
    HEX64,
  )

  // Pathological nesting may hit a parser/canonicalizer limit; the contract is
  // "null or a valid hash", never an exception escaping to the approval path.
  const tooDeep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`
  const result = approvalArgsHash({ toolName: 't', callId: 'c', rawArguments: tooDeep })
  assert.ok(result === null || HEX64.test(result))
})

test('hash is deterministic, lowercase hex and 64 characters', () => {
  const first = argsHash('bash', 'call-9', '{"a":1}')
  for (let index = 0; index < 5; index += 1) assert.equal(argsHash('bash', 'call-9', '{"a":1}'), first)
  assert.match(first, HEX64)
})
