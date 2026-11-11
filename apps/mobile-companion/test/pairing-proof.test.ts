// Pairing proof exchange (contract §3.8, revision 6) — the client half.
//
// What this pins down, and why each one is worth a test:
//
//   * a pairing socket answers `pairing-challenge` with exactly one well-formed
//     `pairing-proof {clientNonce}` and sends nothing else before admission (the Host refuses
//     every other frame with `op/forbidden` and closes 4403 after the third);
//   * a Host that never challenges still works: a bare `paired` is accepted exactly as before
//     (backward compatibility — the strict fixtures only arrive in slice C);
//   * `otpRequired: true` fails honestly with `client/pairing-otp-unsupported` instead of sending
//     a proof the Host would close with 4410 (decision already taken: no OTP screen yet);
//   * an unusable nonce is reported, never written: the Host would answer `pairing/bad-nonce`;
//   * THE APPROVAL WAIT IS NOT A HANDSHAKE STEP. `pairing-pending` replaces the transport
//     handshake deadline with one derived from the Host's `expiresAt`, so a human taking minutes
//     on the desktop cannot be killed by a 10 s budget — and the deadline still caps a Host that
//     promises a distant expiry;
//   * the pairing close codes 4403 / 4408 / 4410 map to distinct client errors and stop automatic
//     retries, because the reason strings are not a stable contract but the codes are.
//
// The controller half (at the end) proves the same for `AppController.pair()`, which used to cap
// the whole pairing at a hard-coded 20 s.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PAIRING_NONCE } from '@dsh-ext/mobile-protocol';

import { encodePairingPayload, type PairingPayload } from '../src/core';
import { CompanionClient } from '../src/core/client';
import { CoreError } from '../src/core/errors';
import type { PinnedTransport } from '../src/platform';
import { AppController } from '../src/app-state';
import { ScriptedTransport } from './support/scripted-transport';
import { waitFor } from './support/wait';

const PIN = 'a'.repeat(64);
const PAIRING_CODE = 'Q'.repeat(43);
const INSTALL_ID = '3f2a1c9e-0b7d-4f6a-9c1e-8d5b2a7f4c63';
const GATEWAY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const TARGET = { installId: INSTALL_ID, deviceName: 'Pixel test', appVersion: '0.1.0', platform: 'android' as const };
const HELLO = {
  kind: 'hello',
  protocol: 1,
  companionProtocol: 1,
  minClientVersion: 1,
  capabilities: [],
  authenticated: true,
  device: { id: INSTALL_ID, name: 'Pixel test' },
  gatewayId: GATEWAY_ID,
};
const CHALLENGE = { kind: 'pairing-challenge', serverNonce: 's'.repeat(32), certSha256: PIN, otpRequired: false };

const PAIR_INPUT = { url: 'wss://127.0.0.1:1/ws', certSha256: PIN, pairingCode: PAIRING_CODE, ...TARGET };

function scriptedClient(transport: ScriptedTransport, overrides: Record<string, unknown> = {}): CompanionClient {
  return new CompanionClient({
    transport,
    appVersion: TARGET.appVersion,
    platform: TARGET.platform,
    requestTimeoutMs: 1_000,
    pingIntervalMs: 0,
    // Valid, deterministic and obviously ours: the exact bytes do not matter to the Host.
    clientNonce: () => 'client-nonce-0123456789-_',
    ...overrides,
  });
}

function record(client: CompanionClient): { errors: CoreError[]; events: string[]; pending: unknown[]; closed: unknown[] } {
  const errors: CoreError[] = [];
  const events: string[] = [];
  const pending: unknown[] = [];
  const closed: unknown[] = [];
  client.on('error', (error) => errors.push(error));
  client.on('paired', () => events.push('paired'));
  client.on('ready', () => events.push('ready'));
  client.on('pairingPending', (frame) => pending.push(frame));
  client.on('disconnected', (frame) => closed.push(frame));
  return { errors, events, pending, closed };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('pairing proof exchange (contract §3.8)', () => {
  it('answers the challenge with exactly one well-formed proof and nothing else', () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport);
    const seen = record(client);

    client.connect(PAIR_INPUT);
    transport.fireOpen();
    transport.deliver(CHALLENGE);

    const sent = transport.sentFrames();
    assert.equal(sent.length, 1, 'the only frame before admission is the proof');
    assert.equal(sent[0]?.type, 'pairing-proof');
    assert.equal(sent[0]?.requestId, undefined, 'the proof carries no requestId (contract §3.8)');
    assert.equal(PAIRING_NONCE.test(String(sent[0]?.clientNonce)), true, 'clientNonce must be 16–64 base64url chars');
    assert.equal(seen.errors.length, 0);

    // A duplicate challenge is a protocol violation, and it must never produce a second proof.
    transport.deliver(CHALLENGE);
    assert.equal(transport.sentFrames().filter((frame) => frame.type === 'pairing-proof').length, 1);
    assert.equal(seen.errors[0]?.code, 'client/bad-message');
    client.close();
  });

  it('still accepts a bare `paired` when the host sends no challenge (backward compatible)', () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport);
    const seen = record(client);

    client.connect(PAIR_INPUT);
    transport.fireOpen();
    // The fixtures (and Hosts before revision 6) go straight to `paired`.
    transport.deliver({ kind: 'paired', token: 'tok-legacy', device: { id: INSTALL_ID, name: 'Pixel test' } });

    assert.deepEqual(seen.events, ['paired']);
    assert.equal(client.pairedToken, 'tok-legacy');
    assert.deepEqual(transport.sentFrames().filter((frame) => frame.type === 'pairing-proof'), []);
    assert.equal(seen.errors.length, 0);
    client.close();
  });

  it('fails honestly when the challenge asks for a one-time code instead of sending a proof', () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport);
    const seen = record(client);

    client.connect(PAIR_INPUT);
    transport.fireOpen();
    transport.deliver({ ...CHALLENGE, otpRequired: true });

    assert.deepEqual(transport.sentFrames(), [], 'nothing is written for a flow this build cannot finish');
    assert.equal(seen.errors[0]?.code, 'client/pairing-otp-unsupported');
    assert.equal(client.state, 'closed');
    assert.equal(seen.closed.length, 1);
  });

  it('never sends an unusable nonce (a broken random source is reported, not written)', () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport, { clientNonce: () => 'too-short' });
    const seen = record(client);

    client.connect(PAIR_INPUT);
    transport.fireOpen();
    transport.deliver(CHALLENGE);

    assert.deepEqual(transport.sentFrames(), []);
    assert.equal(seen.errors[0]?.code, 'client/bad-state');
    assert.equal(client.state, 'closed');
  });

  it('keeps the handshake deadline out of the approval wait, then finishes on `paired`', async () => {
    const transport = new ScriptedTransport();
    // 40 ms instead of the 10 s default: the same budget, short enough to observe. If the
    // handshake deadline still governed a pending approval, this socket would die almost at once.
    const client = scriptedClient(transport, { handshakeTimeoutMs: 40 });
    const seen = record(client);

    client.connect(PAIR_INPUT);
    transport.fireOpen();
    transport.deliver(CHALLENGE);
    transport.deliver({ kind: 'pairing-pending', verificationCode: '482 913', requestId: 'r-1', expiresAt: Date.now() + 60_000 });

    assert.equal(seen.pending.length, 1);
    assert.deepEqual(seen.pending[0], { verificationCode: '482 913', requestId: 'r-1', expiresAt: (seen.pending[0] as { expiresAt: number }).expiresAt });
    await delay(250);
    assert.deepEqual(seen.errors, [], 'the handshake deadline must not fire while the user is approving');
    assert.deepEqual(seen.closed, [], 'the socket must stay open while the user is approving');
    assert.notEqual(client.state, 'closed');

    // …and the pairing still completes the moment the desktop approves.
    transport.deliver({ kind: 'paired', token: 'tok-approved', device: { id: INSTALL_ID, name: 'Pixel test' } });
    transport.deliver(HELLO);
    const requestId = transport.lastRequestId('client-hello');
    transport.deliver({ kind: 'client-hello', requestId, accepted: true });

    assert.deepEqual(seen.events, ['paired', 'ready']);
    assert.equal(client.state, 'ready');
    client.close();
  });

  it('expires the approval wait at the host `expiresAt`, not at a fixed handshake budget', async () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport);
    const seen = record(client);

    client.connect(PAIR_INPUT);
    transport.fireOpen();
    transport.deliver(CHALLENGE);
    transport.deliver({ kind: 'pairing-pending', verificationCode: '111 222', requestId: 'r-2', expiresAt: Date.now() + 90 });

    await waitFor(() => seen.closed.length > 0, { timeoutMs: 2_000, label: 'approval window closed' });
    assert.equal(seen.errors.at(-1)?.code, 'client/pairing-timeout');
    assert.equal(seen.errors.at(-1)?.retryable, false, 'a fresh code is required: do not auto-retry');
    const closed = seen.closed[0] as { code: number; retry: boolean };
    assert.equal(closed.retry, false);
    client.close();
  });

  it('caps a host that promises a distant expiry with pairApprovalTimeoutMs', async () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport, { pairApprovalTimeoutMs: 70 });
    const seen = record(client);

    client.connect(PAIR_INPUT);
    transport.fireOpen();
    transport.deliver(CHALLENGE);
    transport.deliver({ kind: 'pairing-pending', verificationCode: '333 444', requestId: 'r-3', expiresAt: Date.now() + 60 * 60_000 });

    await waitFor(() => seen.closed.length > 0, { timeoutMs: 2_000, label: 'capped approval window closed' });
    assert.equal(seen.errors.at(-1)?.code, 'client/pairing-timeout');
    client.close();
  });

  it('maps the pairing close codes to distinct errors and stops automatic retries', () => {
    for (const [code, expected] of [[4403, 'client/pairing-rejected'], [4408, 'client/pairing-timeout'], [4410, 'client/pairing-expired']] as const) {
      const transport = new ScriptedTransport();
      const client = scriptedClient(transport);
      const seen = record(client);

      client.connect(PAIR_INPUT);
      transport.fireOpen();
      transport.deliver(CHALLENGE);
      transport.close(code, 'pairing/x');

      assert.equal(seen.errors.at(-1)?.code, expected, `close ${code} must report ${expected}`);
      assert.equal(seen.errors.at(-1)?.retryable, false);
      assert.equal((seen.closed[0] as { code: number }).code, code);
      assert.equal((seen.closed[0] as { retry: boolean }).retry, false, 'pairing outcomes never auto-retry');
      assert.equal((seen.errors.at(-1)?.details as { closeCode: number }).closeCode, code);
    }
  });

  it('carries the in-band rejection reason into the close error', () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport);
    const seen = record(client);

    client.connect(PAIR_INPUT);
    transport.fireOpen();
    transport.deliver(CHALLENGE);
    // The Host explains itself in-band, then closes with the code that carries the meaning.
    transport.deliver({ kind: 'pairing-rejected', reason: 'pairing/busy' });
    transport.close(4403, 'pairing/refused');

    assert.equal(seen.errors.at(-1)?.code, 'client/pairing-rejected');
    assert.equal((seen.errors.at(-1)?.details as { reason: string }).reason, 'pairing/busy');
    client.close();
  });
});

// ---------------------------------------------------------------------------
// AppController: the pairing gate must not cap the approval wait at 20 s
// ---------------------------------------------------------------------------

/** A valid QR payload; the one-time code's own expiry is unrelated to the approval window. */
function pairingPayload(): string {
  const payload: PairingPayload = {
    version: 3,
    publicUrl: 'wss://127.0.0.1:14144/ws/mobile',
    pairingCode: PAIRING_CODE,
    expiresAt: Date.now() + 240_000,
    certSha256: PIN,
    gatewayId: GATEWAY_ID,
    gatewayName: 'my-pc',
    endpoints: ['wss://127.0.0.1:14144/ws/mobile'],
  };
  return encodePairingPayload(payload);
}

/** A controller whose transports the test drives frame by frame. */
function scriptedController(options: { handshakeTimeoutMs?: number; pairApprovalTimeoutMs?: number } = {}) {
  const transports: ScriptedTransport[] = [];
  const controller = new AppController({
    locale: () => 'en',
    transport: () => {
      const transport = new ScriptedTransport();
      transports.push(transport);
      return transport as unknown as PinnedTransport;
    },
    ...options,
  });
  return { controller, transports };
}

describe('AppController pairing approval wait (contract §3.8)', () => {
  it('does not fail a pairing while the desktop is approving, and succeeds on `paired`', async () => {
    const { controller, transports } = scriptedController({ handshakeTimeoutMs: 40 });
    // Locked pairing (no unlock): the one-time socket's accepted `client-hello` is the success
    // gate, so no bearer connection has to be driven as well.
    await controller.start();
    try {
      const pairing = controller.pair(pairingPayload());
      // `pair()` reads the install id before it opens the socket, so the transport appears
      // asynchronously.
      await waitFor(() => transports.length > 0, { label: 'pairing socket allocated' });
      const socket = transports[0];
      assert.ok(socket !== undefined);
      socket.fireOpen();
      socket.deliver(CHALLENGE);
      assert.equal(socket.sentFrames().filter((frame) => frame.type === 'pairing-proof').length, 1);

      socket.deliver({ kind: 'pairing-pending', verificationCode: '482 913', requestId: 'r-1', expiresAt: Date.now() + 60_000 });
      await waitFor(() => controller.snapshot().pairingPending !== null, { label: 'approval code published' });
      assert.equal(controller.snapshot().pairingPending?.verificationCode, '482 913');

      // Longer than the client handshake budget (40 ms), so if that deadline still governed a
      // pending approval this attempt would already have failed. The old hard-coded 20 s pairing
      // cap is not observable by waiting (it would take 20 s); the next test proves it is gone by
      // ending the pairing at the host's 120 ms expiry instead.
      const settled = await Promise.race([pairing.then(() => 'settled'), delay(300).then(() => 'pending')]);
      assert.equal(settled, 'pending', 'the pairing must stay open while the desktop user approves');
      assert.equal(controller.snapshot().connection !== 'closed', true);

      socket.deliver({ kind: 'paired', token: 'tok-approved', device: { id: INSTALL_ID, name: 'Pixel test' } });
      socket.deliver(HELLO);
      const requestId = socket.lastRequestId('client-hello');
      socket.deliver({ kind: 'client-hello', requestId, accepted: true });

      const result = await pairing;
      assert.equal(result.ok, true);
      assert.equal(controller.snapshot().pairingPending, null, 'the code is cleared once paired');
    } finally {
      controller.stop();
    }
  });

  it('fails at the host `expiresAt` with client/pairing-timeout (not after 20 s)', async () => {
    const { controller, transports } = scriptedController();
    await controller.start();
    try {
      const started = Date.now();
      const pairing = controller.pair(pairingPayload());
      await waitFor(() => transports.length > 0, { label: 'pairing socket allocated' });
      const socket = transports[0];
      assert.ok(socket !== undefined);
      socket.fireOpen();
      socket.deliver(CHALLENGE);
      socket.deliver({ kind: 'pairing-pending', verificationCode: '111 222', requestId: 'r-2', expiresAt: Date.now() + 120 });

      const result = await pairing;
      const elapsed = Date.now() - started;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'client/pairing-timeout');
      // A 20 s cap could not have produced this: the pairing ended inside a second.
      assert.equal(elapsed < 5_000, true, `the approval window (not the 20 s pairing cap) ended it, took ${elapsed} ms`);
      assert.equal(controller.snapshot().pairingPending, null);
    } finally {
      controller.stop();
    }
  });
});
