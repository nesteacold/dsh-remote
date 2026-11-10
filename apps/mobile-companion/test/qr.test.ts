// Unit tests for QR v3 parsing/validation (A010), contract §2 revision 2: the text is
// unpadded base64url of the JSON payload with epoch-ms `expiresAt`, `publicUrl`, `endpoints[]`,
// `gatewayId`, `gatewayName`.
//
// The strictness under test is the contract's own: `expiresAt` ≤ 300 000 ms ahead with no skew
// allowance, `gatewayId` a canonical lowercase UUID v4, `pairingCode` the canonical 43-character
// base64url of 256 bits, and a raw-text bound so a pasted blob is refused before decoding.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import type { PairingPayload } from '@dsh-ext/mobile-protocol';

import {
  decodeBase64Url,
  encodeBase64Url,
  encodePairingPayload,
  MAX_QR_PAYLOAD_BYTES,
  MAX_QR_TEXT_LENGTH,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
  parsePairingQr,
  qrExpiresInMs,
} from '../src/core/qr';

const NOW = Date.parse('2026-11-09T06:00:00Z');
const now = () => NOW;

const CODE = 'A'.repeat(43); // 32-byte base64url, no padding
const SHA = 'a'.repeat(64);
const GATEWAY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const PAYLOAD: PairingPayload = {
  version: 3,
  publicUrl: 'wss://192.168.1.10:3443/ws/mobile',
  pairingCode: CODE,
  expiresAt: NOW + 300_000,
  certSha256: SHA,
  gatewayId: GATEWAY_ID,
  gatewayName: 'my-pc',
  endpoints: ['wss://192.168.1.10:3443/ws/mobile'],
};

function encode(payload: unknown = PAYLOAD): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Base64url text for the default payload with some fields replaced/dropped. */
function raw(overrides: Record<string, unknown> = {}): string {
  const payload: Record<string, unknown> = { ...PAYLOAD, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete payload[key];
  }
  return encode(payload);
}

describe('parsePairingQr — accepted payloads', () => {
  it('accepts a contract-example v3 payload (base64url text)', () => {
    const result = parsePairingQr(encode(), { now });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, PAYLOAD);
  });

  it('round-trips through encodePairingPayload', () => {
    const text = encodePairingPayload(PAYLOAD);
    assert.match(text, /^[A-Za-z0-9_-]+$/);
    assert.equal(text.includes('='), false);
    const result = parsePairingQr(text, { now });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value, PAYLOAD);
  });

  it('accepts several wss endpoints and an IPv6 literal', () => {
    const result = parsePairingQr(
      encode({
        ...PAYLOAD,
        publicUrl: 'wss://[::1]:3443/ws/mobile',
        endpoints: ['wss://[::1]:3443/ws/mobile', 'wss://gateway.example.com/ws/mobile'],
      }),
      { now },
    );
    assert.equal(result.ok, true);
  });

  it('tolerates surrounding whitespace from a paste', () => {
    assert.equal(parsePairingQr(`  ${encode()}\n`, { now }).ok, true);
  });

  it('accepts a code expiring at the 5-minute TTL boundary', () => {
    const result = parsePairingQr(encode({ ...PAYLOAD, expiresAt: NOW + 300_000 }), { now });
    assert.equal(result.ok, true);
  });

  it('accepts a canonical 43-character code produced from 32 bytes', () => {
    const code = encodeBase64Url(new Uint8Array(32).map((_, index) => (index * 31 + 7) & 0xff));
    assert.equal(code.length, PAIRING_CODE_LENGTH);
    const result = parsePairingQr(encode({ ...PAYLOAD, pairingCode: code }), { now });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.pairingCode, code);
  });

  it('accepts a payload just under the raw-text bound', () => {
    // Unknown members are ignored, so a large-but-legal payload can be exercised without
    // changing the decoded shape.
    const text = encode({ ...PAYLOAD, padding: 'x'.repeat(11_000) });
    assert.equal(text.length <= MAX_QR_TEXT_LENGTH, true);
    const result = parsePairingQr(text, { now });
    assert.equal(result.ok, true);
  });

  it('accepts the exact text the gateway produces (Node Buffer base64url)', () => {
    // plugins/mobile-gateway: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url').
    // Independent of this module's own encoder, so a mismatch in either direction shows up here.
    const text = Buffer.from(JSON.stringify(PAYLOAD), 'utf8').toString('base64url');
    assert.equal(text.includes('='), false);
    assert.equal(Buffer.from(text, 'base64url').length, JSON.stringify(PAYLOAD).length);
    const result = parsePairingQr(text, { now });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value, PAYLOAD);
    // The gateway's code is always canonical: 32 random bytes -> 43 chars, zero pad bits.
    assert.equal(result.ok && result.value.pairingCode.length, PAIRING_CODE_LENGTH);
  });
});

describe('parsePairingQr — rejections', () => {
  const cases: Array<[string, () => string, string]> = [
    ['plain JSON (not base64url)', () => JSON.stringify(PAYLOAD), 'qr/invalid-json'],
    ['padded base64', () => `${encode()}==`, 'qr/invalid-json'],
    ['empty text', () => '   ', 'qr/invalid-json'],
    ['valid base64url of non-JSON', () => encodeBase64Url(new TextEncoder().encode('hello')), 'qr/invalid-json'],
    ['version 2', () => raw({ version: 2 }), 'qr/unsupported-version'],
    ['version as string', () => raw({ version: '3' }), 'qr/unsupported-version'],
    ['missing version', () => raw({ version: undefined }), 'qr/unsupported-version'],
    ['ws publicUrl', () => raw({ publicUrl: 'ws://192.168.1.10:3443' }), 'qr/bad-endpoint'],
    ['https publicUrl', () => raw({ publicUrl: 'https://192.168.1.10' }), 'qr/bad-endpoint'],
    ['publicUrl with query (token leak shape)', () => raw({ publicUrl: 'wss://h:1/?token=abc' }), 'qr/bad-endpoint'],
    ['publicUrl with credentials', () => raw({ publicUrl: 'wss://u:p@h:1' }), 'qr/bad-endpoint'],
    ['missing publicUrl', () => raw({ publicUrl: undefined }), 'qr/bad-endpoint'],
    ['ws endpoint in endpoints[]', () => raw({ endpoints: ['wss://h:1', 'ws://h:2'] }), 'qr/bad-endpoint'],
    ['empty endpoints', () => raw({ endpoints: [] }), 'qr/bad-endpoint'],
    ['short hash', () => raw({ certSha256: 'a'.repeat(63) }), 'qr/bad-cert-sha256'],
    ['uppercase hash', () => raw({ certSha256: 'A'.repeat(64) }), 'qr/bad-cert-sha256'],
    ['colon hash', () => raw({ certSha256: 'aa:'.repeat(32) }), 'qr/bad-cert-sha256'],
    ['missing code', () => raw({ pairingCode: undefined }), 'qr/bad-pairing-code'],
    ['empty code', () => raw({ pairingCode: '' }), 'qr/bad-pairing-code'],
    ['padded code', () => raw({ pairingCode: 'A'.repeat(42) + '=' }), 'qr/bad-pairing-code'],
    ['plus/slash alphabet', () => raw({ pairingCode: 'A'.repeat(20) + '+' + '/'.repeat(22) }), 'qr/bad-pairing-code'],
    ['code one character short (42)', () => raw({ pairingCode: 'A'.repeat(42) }), 'qr/bad-pairing-code'],
    ['code one character long (44)', () => raw({ pairingCode: 'A'.repeat(44) }), 'qr/bad-pairing-code'],
    ['code with non-zero trailing bits', () => raw({ pairingCode: 'A'.repeat(42) + 'B' }), 'qr/bad-pairing-code'],
    ['arbitrary ASCII code ("hello world")', () => raw({ pairingCode: 'helloworld' }), 'qr/bad-pairing-code'],
    ['ISO expiresAt (rev 1 shape)', () => raw({ expiresAt: '2026-11-09T06:05:00Z' }), 'qr/bad-expires-at'],
    ['fractional expiresAt', () => raw({ expiresAt: NOW + 1_000.5 }), 'qr/bad-expires-at'],
    ['seconds instead of ms', () => raw({ expiresAt: Math.floor(NOW / 1000) + 300 }), 'qr/expired'],
    ['expiresAt equal to now', () => raw({ expiresAt: NOW }), 'qr/expired'],
    ['expiresAt in the past', () => raw({ expiresAt: NOW - 1_000 }), 'qr/expired'],
    ['expiresAt beyond the 5-minute TTL', () => raw({ expiresAt: NOW + 3_600_000 }), 'qr/expired'],
    ['expiresAt one millisecond past the TTL', () => raw({ expiresAt: NOW + 300_001 }), 'qr/expired'],
    ['expiresAt 330 s ahead (the old 30 s skew)', () => raw({ expiresAt: NOW + 330_000 }), 'qr/expired'],
    ['missing gatewayId', () => raw({ gatewayId: undefined }), 'qr/bad-gateway-id'],
    ['uppercase gatewayId', () => raw({ gatewayId: GATEWAY_ID.toUpperCase() }), 'qr/bad-gateway-id'],
    ['gatewayId v1 (version nibble)', () => raw({ gatewayId: '0f8fad5b-d9cb-169f-a165-70867728950e' }), 'qr/bad-gateway-id'],
    ['gatewayId with a non-RFC variant', () => raw({ gatewayId: '0f8fad5b-d9cb-469f-c165-70867728950e' }), 'qr/bad-gateway-id'],
    ['gatewayId without dashes', () => raw({ gatewayId: GATEWAY_ID.replace(/-/g, '') }), 'qr/bad-gateway-id'],
    ['gatewayId that is not hex', () => raw({ gatewayId: 'zzzzzzzz-d9cb-469f-a165-70867728950e' }), 'qr/bad-gateway-id'],
    ['arbitrary gatewayId string', () => raw({ gatewayId: 'my-gateway' }), 'qr/bad-gateway-id'],
    ['gatewayName not string', () => raw({ gatewayName: 7 }), 'qr/bad-host-name'],
    ['gatewayName too long', () => raw({ gatewayName: 'x'.repeat(129) }), 'qr/bad-host-name'],
  ];

  for (const [label, build, reason] of cases) {
    it(`rejects ${label} with ${reason}`, () => {
      const result = parsePairingQr(build(), { now });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, reason);
    });
  }

  it('rejects a JSON array payload', () => {
    const text = encodeBase64Url(new TextEncoder().encode('[]'));
    const result = parsePairingQr(text, { now });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'qr/invalid-json');
  });

  it('rejects invalid UTF-8 bytes', () => {
    const result = parsePairingQr(encodeBase64Url(new Uint8Array([0xff, 0xfe, 0xfd])), { now });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'qr/invalid-json');
  });

  it('never throws, even for non-string input', () => {
    for (const value of [undefined, null, 42, {}, []] as unknown[]) {
      const result = parsePairingQr(value as string, { now });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'qr/invalid-json');
    }
  });
});

describe('parsePairingQr — expiry boundary (contract §2, ≤ 5 min)', () => {
  it('pins the TTL to 300 000 ms with no skew allowance', () => {
    assert.equal(PAIRING_TTL_MS, 300_000);
  });

  it('accepts exactly 300 000 ms ahead', () => {
    assert.equal(parsePairingQr(raw({ expiresAt: NOW + 300_000 }), { now }).ok, true);
  });

  it('rejects 300 001 ms ahead and everything above it', () => {
    for (const ahead of [300_001, 300_999, 301_000, 330_000, 3_600_000]) {
      const result = parsePairingQr(raw({ expiresAt: NOW + ahead }), { now });
      assert.equal(result.ok, false, `ahead=${ahead}`);
      if (!result.ok) assert.equal(result.reason, 'qr/expired', `ahead=${ahead}`);
    }
  });

  it('uses one clock reading for the decision (injected clock, not wall clock)', () => {
    const payload = encode({ ...PAYLOAD, expiresAt: NOW + 300_000 });
    let calls = 0;
    const countingNow = () => {
      calls += 1;
      return NOW;
    };
    assert.equal(parsePairingQr(payload, { now: countingNow }).ok, true);
    assert.equal(calls, 1);
  });
});

describe('parsePairingQr — size bounds (malicious input)', () => {
  it('rejects text over the raw bound without decoding it', () => {
    const result = parsePairingQr('A'.repeat(MAX_QR_TEXT_LENGTH + 1), { now });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'qr/invalid-json');
  });

  it('rejects a 1 MiB paste', () => {
    const result = parsePairingQr('A'.repeat(1024 * 1024), { now });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'qr/invalid-json');
  });

  it('still parses text exactly at the raw bound (the bound is inclusive)', () => {
    // 16 KiB of "A" is exactly MAX_QR_PAYLOAD_BYTES of zero bytes: inside the bound, and then
    // refused as JSON rather than as size.
    const text = 'A'.repeat(MAX_QR_TEXT_LENGTH);
    assert.equal(decodeBase64Url(text)?.length, MAX_QR_PAYLOAD_BYTES);
    const result = parsePairingQr(text, { now });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'qr/invalid-json');
  });

  it('rejects a large payload that decodes to valid JSON but not an object', () => {
    const text = encodeBase64Url(new TextEncoder().encode(JSON.stringify(`x`.repeat(10_000))));
    const result = parsePairingQr(text, { now });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'qr/invalid-json');
  });

  it('keeps the decoded-payload bound consistent with the text bound', () => {
    assert.equal(MAX_QR_PAYLOAD_BYTES, (MAX_QR_TEXT_LENGTH / 4) * 3);
    assert.equal(MAX_QR_TEXT_LENGTH % 4, 0);
  });
});

describe('base64url helpers', () => {
  it('decode(encode(x)) is the identity for every byte length', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 37 + 11) & 0xff);
      const text = encodeBase64Url(bytes);
      assert.equal(text.includes('='), false);
      assert.deepEqual([...((decodeBase64Url(text) as Uint8Array))], [...bytes]);
    }
  });

  it('rejects non-canonical or foreign input', () => {
    assert.equal(decodeBase64Url('abc='), null);
    assert.equal(decodeBase64Url('a+b/'), null);
    assert.equal(decodeBase64Url('a'), null); // length % 4 === 1
    assert.equal(decodeBase64Url('AB'), null); // non-zero trailing bits
  });
});

describe('qrExpiresInMs', () => {
  it('is positive before expiry and negative after', () => {
    assert.equal(qrExpiresInMs({ expiresAt: NOW + 300_000 }, now), 300_000);
    assert.equal(qrExpiresInMs({ expiresAt: NOW - 3_600_000 }, now), -3_600_000);
  });
});
