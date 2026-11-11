// Strict pairing fixtures (contract §3.8, revision 6) — the fixture's own state machine.
//
// WHY these exist: the suite was green while the product could not pair, because BOTH fixtures
// accepted a bare `paired` frame and never required the proof. These tests pin the strict
// behaviour down so a future "helpful" loosening fails loudly:
//
//   * the challenge is sent on accept, unconditionally, before any client frame;
//   * before admission the ONLY acceptable frame is `pairing-proof`; anything else is refused
//     with `op/forbidden`, and the third refusal closes 4403 `pairing/refused`;
//   * an ill-formed `clientNonce` closes 4403 `pairing/bad-nonce`;
//   * `otpRequired: true` answered without `otpProof` closes 4410 `pairing/expired`;
//   * a valid proof reserves the code, raises `pairing-pending`, and `paired`/`hello` follow only
//     when the Host user approves — reject closes 4403, expiry closes 4410;
//   * the one-time code is consumed by the proof, so a replay is refused at the upgrade (401).
//
// These drive a raw `ws` client on purpose: the app's own client always answers the challenge,
// so it cannot express "a client that sends a bare `paired`" — which is exactly the bug that
// shipped.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import WebSocket from 'ws';

import { PAIRING_NONCE } from '@dsh-ext/mobile-protocol';

import { FakeGateway, type FakeGatewayOptions } from './support/fake-gateway';
import { waitFor } from './support/wait';

const DEVICE_ID = '11111111-2222-4333-8444-555555555555';
const CODE_PREFIX = 'strict-';
let codeCounter = 0;

/** A fresh one-time code per test (the fixture consumes them). */
function freshCode(): string {
  codeCounter += 1;
  return `${CODE_PREFIX}${codeCounter}`;
}

interface RawSocket {
  socket: WebSocket;
  frames: Array<Record<string, unknown>>;
  closes: Array<{ code: number; reason: string }>;
  send(frame: Record<string, unknown>): void;
  /** Resolve with the first frame matching `predicate` (already received or arriving later). */
  frame(predicate: (frame: Record<string, unknown>) => boolean, label?: string): Promise<Record<string, unknown>>;
  /** Resolve with the close code (and reason). */
  closed(): Promise<{ code: number; reason: string }>;
}

async function openPairing(gateway: FakeGateway, code: string): Promise<RawSocket> {
  const socket = new WebSocket(gateway.endpoint, ['dsh-mobile-v1', `dsh-pair.${code}`], {
    rejectUnauthorized: false,
    headers: { 'X-DSH-Device-ID': DEVICE_ID },
  });
  const frames: Array<Record<string, unknown>> = [];
  const closes: Array<{ code: number; reason: string }> = [];
  socket.on('message', (data) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  socket.on('close', (closeCode, reason) => {
    closes.push({ code: closeCode, reason: reason.toString() });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return {
    socket,
    frames,
    closes,
    send(frame) {
      socket.send(JSON.stringify(frame));
    },
    async frame(predicate, label = 'frame') {
      await waitFor(() => frames.some(predicate), { label });
      return frames.find(predicate) as Record<string, unknown>;
    },
    async closed() {
      await waitFor(() => closes.length > 0, { label: 'socket close' });
      return closes[0] as { code: number; reason: string };
    },
  };
}

async function withGateway(options: FakeGatewayOptions, run: (gateway: FakeGateway, code: string) => Promise<void>): Promise<void> {
  const code = freshCode();
  const gateway = await FakeGateway.create({ ...options, pairingCodes: [...(options.pairingCodes ?? []), code] });
  try {
    await run(gateway, code);
  } finally {
    await gateway.close();
  }
}

/** A well-formed client nonce (32 chars of unpadded base64url, like the app sends). */
const VALID_NONCE = 'raw-test-clientnonce-01234567';

describe('strict pairing fixture (contract §3.8)', () => {
  it('sends the challenge on accept, before any client frame, and nothing else', async () => {
    await withGateway({}, async (gateway, code) => {
      const client = await openPairing(gateway, code);
      const challenge = await client.frame((frame) => frame.kind === 'pairing-challenge');
      assert.equal(PAIRING_NONCE.test(String(challenge.serverNonce)), true, 'serverNonce must be base64url');
      assert.equal(challenge.certSha256, gateway.certSha256, 'the challenge pins the leaf the client verified');
      assert.equal(challenge.otpRequired, false);
      assert.equal(gateway.pairingChallenges, 1);
      // No `paired`, no `hello`, no token: the socket is not a MobileConnection yet.
      assert.deepEqual(client.frames.map((frame) => frame.kind), ['pairing-challenge']);
      assert.deepEqual(gateway.mintedTokens, []);
      client.socket.close();
    });
  });

  it('refuses a bare `paired` with op/forbidden and closes 4403 on the third refusal', async () => {
    await withGateway({}, async (gateway, code) => {
      const client = await openPairing(gateway, code);
      await client.frame((frame) => frame.kind === 'pairing-challenge');
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        client.send({ kind: 'paired', token: 'tok-forged', device: { id: DEVICE_ID, name: 'forged' } });
        if (attempt < 3) {
          const error = await client.frame((frame) => frame.kind === 'error' && frame.requestType === 'paired');
          assert.equal(error.code, 'op/forbidden');
          assert.match(String(error.message), /only the pairing proof/);
        }
      }
      const close = await client.closed();
      assert.equal(close.code, 4403);
      assert.equal(close.reason, 'pairing/refused');
      assert.equal(gateway.pairingRefusals, 3);
      // A refused pairing never hands out a credential, and never consumes the code.
      assert.deepEqual(gateway.mintedTokens, []);
      assert.deepEqual(gateway.consumedPairingCodes, []);
      assert.equal(client.frames.some((frame) => frame.kind === 'paired'), false);
    });
  });

  it('refuses an ill-formed clientNonce with 4403 pairing/bad-nonce', async () => {
    await withGateway({}, async (gateway, code) => {
      const client = await openPairing(gateway, code);
      await client.frame((frame) => frame.kind === 'pairing-challenge');
      client.send({ type: 'pairing-proof', clientNonce: 'too-short' });
      const close = await client.closed();
      assert.equal(close.code, 4403);
      assert.equal(close.reason, 'pairing/bad-nonce');
      assert.deepEqual(gateway.pairingProofs, [], 'an invalid nonce is never accepted');
      assert.deepEqual(gateway.consumedPairingCodes, []);
    });
  });

  it('closes 4410 when an OTP challenge is answered without otpProof', async () => {
    await withGateway({ otpRequired: true }, async (gateway, code) => {
      const client = await openPairing(gateway, code);
      const challenge = await client.frame((frame) => frame.kind === 'pairing-challenge');
      assert.equal(challenge.otpRequired, true);
      client.send({ type: 'pairing-proof', clientNonce: VALID_NONCE });
      const close = await client.closed();
      assert.equal(close.code, 4410);
      assert.equal(close.reason, 'pairing/expired');
      assert.deepEqual(gateway.pairingProofs, []);
    });
  });

  it('admits an OTP challenge that carries an otpProof', async () => {
    await withGateway({ otpRequired: true }, async (gateway, code) => {
      const client = await openPairing(gateway, code);
      await client.frame((frame) => frame.kind === 'pairing-challenge');
      client.send({ type: 'pairing-proof', clientNonce: VALID_NONCE, otpProof: '123456' });
      await client.frame((frame) => frame.kind === 'paired');
      await client.frame((frame) => frame.kind === 'hello');
      assert.deepEqual(gateway.pairingProofs, [VALID_NONCE]);
    });
  });

  it('accepts the proof, raises pending, and only approves on the control', async () => {
    await withGateway({ autoApprovePairing: false }, async (gateway, code) => {
      const client = await openPairing(gateway, code);
      await client.frame((frame) => frame.kind === 'pairing-challenge');
      client.send({ type: 'pairing-proof', clientNonce: VALID_NONCE });

      const pending = await client.frame((frame) => frame.kind === 'pairing-pending');
      assert.equal(typeof pending.verificationCode, 'string');
      assert.ok(String(pending.verificationCode).length > 0, 'the user must be able to compare a code');
      assert.equal(typeof pending.requestId, 'string');
      assert.equal(typeof pending.expiresAt, 'number');
      assert.ok((pending.expiresAt as number) > Date.now(), 'the pending window is in the future');

      // Nothing is approved yet: no `paired`, no `hello`, no credential.
      assert.equal(client.frames.some((frame) => frame.kind === 'paired'), false);
      assert.deepEqual(gateway.mintedTokens, []);
      assert.equal(gateway.pendingPairings.length, 1);
      assert.deepEqual(gateway.pairingProofs, [VALID_NONCE]);
      assert.equal(gateway.consumedPairingCodes.length, 1, 'the proof consumes the one-time code');
      // The proof has no `requestId`; it must never be recorded as a protocol violation.
      assert.deepEqual(gateway.protocolViolations, []);

      gateway.approvePairing();
      const paired = await client.frame((frame) => frame.kind === 'paired');
      const hello = await client.frame((frame) => frame.kind === 'hello');
      assert.equal(typeof paired.token, 'string');
      assert.equal(hello.authenticated, true, 'the approved socket is authenticated by its new token');
      assert.equal(gateway.mintedTokens.length, 1);
      assert.equal(gateway.pendingPairings.length, 0);
      client.socket.close();
    });
  });

  it('rejects a pending pairing with 4403', async () => {
    await withGateway({ autoApprovePairing: false }, async (gateway, code) => {
      const client = await openPairing(gateway, code);
      await client.frame((frame) => frame.kind === 'pairing-challenge');
      client.send({ type: 'pairing-proof', clientNonce: VALID_NONCE });
      await client.frame((frame) => frame.kind === 'pairing-pending');

      gateway.rejectPairing();
      const rejected = await client.frame((frame) => frame.kind === 'pairing-rejected');
      assert.equal(rejected.reason, 'pairing/refused');
      const close = await client.closed();
      assert.equal(close.code, 4403);
      assert.equal(client.frames.some((frame) => frame.kind === 'paired'), false);
      assert.deepEqual(gateway.mintedTokens, []);
    });
  });

  it('expires a pending pairing with 4410', async () => {
    await withGateway({ autoApprovePairing: false }, async (gateway, code) => {
      const client = await openPairing(gateway, code);
      await client.frame((frame) => frame.kind === 'pairing-challenge');
      client.send({ type: 'pairing-proof', clientNonce: VALID_NONCE });
      await client.frame((frame) => frame.kind === 'pairing-pending');

      gateway.expirePairing();
      const rejected = await client.frame((frame) => frame.kind === 'pairing-rejected');
      assert.equal(rejected.reason, 'pairing/expired');
      const close = await client.closed();
      assert.equal(close.code, 4410);
      assert.equal(client.frames.some((frame) => frame.kind === 'paired'), false);
    });
  });

  it('consumes the code on the proof, so a replay is refused at the upgrade (401)', async () => {
    await withGateway({}, async (gateway, code) => {
      const client = await openPairing(gateway, code);
      await client.frame((frame) => frame.kind === 'pairing-challenge');
      client.send({ type: 'pairing-proof', clientNonce: VALID_NONCE });
      await client.frame((frame) => frame.kind === 'paired');

      // Same one-time code again: the upgrade must fail, not open a second pairing socket.
      const replay = new WebSocket(gateway.endpoint, ['dsh-mobile-v1', `dsh-pair.${code}`], {
        rejectUnauthorized: false,
        headers: { 'X-DSH-Device-ID': DEVICE_ID },
      });
      const outcome = await new Promise<string>((resolve) => {
        replay.once('unexpected-response', (_request, response) => resolve(`status ${response.statusCode}`));
        replay.once('error', (error) => resolve(`error ${(error as NodeJS.ErrnoException).code ?? ''}`));
        replay.once('open', () => resolve('opened'));
      });
      assert.match(outcome, /401/, 'a used code is an upgrade refusal, never a socket');
      replay.terminate();
      client.socket.close();
    });
  });
});
