// Redaction tests (A017 / FR-011): tokens, pairing codes, Authorization headers, pins and tool
// arguments / argsPreview never survive into a diagnostic string. Covers the contract §3
// subprotocols (`dsh-pair.`, `dsh-auth.`) as well as the legacy shapes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REDACTED,
  redactArgsPreview,
  redactDiagnostic,
  redactFingerprint,
  redactString,
  redactValue,
} from '../src/core/redact';

const TOKEN = 'tok-9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const PAIRING_CODE = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';
const BEARER = `Bearer ${TOKEN}`;

describe('redactString', () => {
  it('masks bearer credentials', () => {
    const out = redactString(`Authorization: ${BEARER}`);
    assert.equal(out.includes(TOKEN), false);
    assert.match(out, /Bearer \[redacted\]/);
  });

  it('masks Basic credentials', () => {
    assert.equal(redactString('Basic dXNlcjpwYXNzd29yZDEyMw==').includes('dXNlcjpw'), false);
  });

  it('masks the contract §3 subprotocols (dsh-pair., dsh-auth.)', () => {
    const pair = redactString(`protocols: ["dsh-mobile-v1", "dsh-pair.${PAIRING_CODE}"]`);
    assert.equal(pair.includes(PAIRING_CODE), false);
    assert.match(pair, /dsh-pair\.\[redacted\]/);
    const auth = redactString(`protocols: ["dsh-mobile-v1", "dsh-auth.${TOKEN}"]`);
    assert.equal(auth.includes(TOKEN), false);
    assert.match(auth, /dsh-auth\.\[redacted\]/);
  });

  it('masks tokens in URLs', () => {
    assert.equal(redactString(`wss://h:3443/stream?token=${TOKEN}&x=1`).includes(TOKEN), false);
    assert.equal(redactString(`wss://h/?pairingCode=${PAIRING_CODE}`).includes(PAIRING_CODE), false);
  });

  it('masks JWT-shaped values', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    assert.equal(redactString(`x ${jwt}`).includes(jwt), false);
  });

  it('masks a bare 43-char base64url pairing code (the QR code shape)', () => {
    const out = redactString(`scanned ${PAIRING_CODE} now`);
    assert.equal(out.includes(PAIRING_CODE), false);
    assert.match(out, new RegExp(`scanned ${REDACTED.replace(/[[\]]/g, '\\$&')} now`));
  });

  it('leaves ordinary text and wss URLs alone', () => {
    const text = 'Session s-running is waiting for your decision.';
    assert.equal(redactString(text), text);
    assert.equal(redactString('wss://192.168.1.10:3443/ws/mobile'), 'wss://192.168.1.10:3443/ws/mobile');
  });
});

describe('redactValue', () => {
  const frame = {
    type: 'message',
    requestId: 'r-1',
    clientMsgId: 'c1',
    sessionId: 's1',
    token: TOKEN,
    Authorization: BEARER,
    pairingCode: PAIRING_CODE,
    nested: {
      deviceToken: 'abc',
      headers: { authorization: BEARER, 'content-type': 'application/json' },
    },
    arguments: { command: 'cat ~/.ssh/id_ed25519', cwd: '/home/me' },
    argsPreview: '{"command":"ls -la"}',
    items: [{ secret: 's3cr3t' }],
  };

  it('masks sensitive keys at any depth', () => {
    const out = redactValue(frame) as Record<string, unknown>;
    assert.equal(out.token, REDACTED);
    assert.equal(out.Authorization, REDACTED);
    assert.equal(out.pairingCode, REDACTED);
    const nested = out.nested as Record<string, unknown>;
    assert.equal(nested.deviceToken, REDACTED);
    assert.equal((nested.headers as Record<string, unknown>).authorization, REDACTED);
    assert.equal((nested.headers as Record<string, unknown>)['content-type'], 'application/json');
    assert.equal((out.items as Array<Record<string, unknown>>)[0]?.secret, REDACTED);
  });

  it('masks tool arguments by default', () => {
    const out = redactValue(frame) as Record<string, unknown>;
    assert.equal(out.arguments, REDACTED);
    assert.equal(out.argsPreview, REDACTED);
  });

  it('keeps a short truncated preview when explicitly allowed', () => {
    const out = redactValue(frame, { allowArgsPreview: true, previewMaxLength: 10 }) as Record<string, unknown>;
    assert.equal(typeof out.argsPreview, 'string');
    assert.equal((out.argsPreview as string).length <= 10, true);
    assert.equal(typeof out.arguments, 'string');
    assert.match(out.arguments as string, /…$/);
  });

  it('masks extra keys on request', () => {
    const out = redactValue({ myCustomSecret: 'x' }, { extraKeys: ['my-custom-secret'] }) as Record<string, unknown>;
    assert.equal(out.myCustomSecret, REDACTED);
  });

  it('redacts secrets embedded in otherwise ordinary values', () => {
    const out = redactValue({ url: `wss://h/?token=${TOKEN}`, note: `see ${PAIRING_CODE}` }) as Record<string, string>;
    assert.equal(out.url?.includes(TOKEN), false);
    assert.equal(out.note?.includes(PAIRING_CODE), false);
  });

  it('is cycle-safe and depth-limited', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = redactValue(cyclic) as Record<string, unknown>;
    assert.equal(out.a, 1);
    assert.equal(out.self, '[circular]');
  });
});

describe('redactArgsPreview', () => {
  it('renders a single-line, truncated, redacted preview', () => {
    const preview = redactArgsPreview({ command: 'ls', token: TOKEN }, 40);
    assert.equal(preview.includes(TOKEN), false);
    assert.equal(preview.includes('\n'), false);
    assert.equal(preview.length <= 40, true);
  });

  it('accepts a string preview and strips tokens inside', () => {
    assert.equal(redactArgsPreview(`curl -H "Authorization: ${BEARER}"`).includes(TOKEN), false);
  });

  it('returns an empty string for null/undefined', () => {
    assert.equal(redactArgsPreview(null), '');
    assert.equal(redactArgsPreview(undefined), '');
  });

  it('survives unserialisable input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(redactArgsPreview(circular), '[unserialisable]');
  });

  it('defaults to a card-friendly length well under the 2 KB contract cap', () => {
    const preview = redactArgsPreview('x'.repeat(5_000));
    assert.equal(preview.length <= 401, true);
  });
});

describe('redactDiagnostic / redactFingerprint', () => {
  it('builds one redacted line', () => {
    const line = redactDiagnostic('connect', { token: TOKEN, url: `wss://h/?token=${TOKEN}` });
    assert.equal(line.includes(TOKEN), false);
    assert.match(line, /^connect: \{/);
  });

  it('shortens certificate fingerprints in diagnostics', () => {
    const fp = 'a'.repeat(64);
    const out = redactFingerprint(`pinned ${fp}`);
    assert.equal(out.includes(fp), false);
    assert.match(out, /aaaaaaaa…\[redacted\]/);
  });
});
