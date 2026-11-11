// A032 — the Node test transport must refuse a pinned leaf whose validity window does not
// cover "now", exactly like the native pinning code:
//   * Android `PinnedTrustManager.verifyPinned` calls `leaf.checkValidity()` after the SHA-256
//     comparison, so an expired / not-yet-valid pinned leaf surfaces as a pin failure;
//   * `plugins/mobile-gateway/lib/tls.mjs` refuses to keep serving an expired leaf.
//
// The rejection has to happen at the same point as a pin mismatch — after the TLS handshake,
// before the WebSocket upgrade — so no `dsh-pair.<code>` subprotocol, `X-DSH-Device-ID` or
// `Authorization` header can ever reach the network on a rotated identity.

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import type { TransportEvent } from '../src/core/transport';
import { generateTestCertificate, validityWindowOf, type TestCertificate } from './support/certs';
import { FakeGateway } from './support/fake-gateway';
import { NodePinnedTransport, type NodePinnedTransportOptions } from './support/node-pinned-transport';
import { waitFor } from './support/wait';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEVICE_ID = '22222222-3333-4444-8555-666666666666';

function at(offsetDays: number): Date {
  return new Date(Date.now() + offsetDays * DAY_MS);
}

function collect(transport: NodePinnedTransport): TransportEvent[] {
  const events: TransportEvent[] = [];
  transport.on((event) => events.push(event));
  return events;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('NodePinnedTransport leaf validity window (A032)', () => {
  const transports: NodePinnedTransport[] = [];
  const gateways: FakeGateway[] = [];

  after(async () => {
    for (const transport of transports) transport.close();
    for (const gateway of gateways) await gateway.close();
  });

  function makeTransport(options: NodePinnedTransportOptions = {}): NodePinnedTransport {
    const transport = new NodePinnedTransport({ handshakeTimeoutMs: 5_000, ...options });
    transports.push(transport);
    return transport;
  }

  async function serve(
    certificate: TestCertificate,
    options: { pairingCodes?: string[]; tokens?: string[] } = {},
  ): Promise<FakeGateway> {
    const gateway = await FakeGateway.create({ certificate, ...options });
    gateways.push(gateway);
    return gateway;
  }

  it('rejects an expired leaf before the upgrade even though its SHA-256 matches the pin', async () => {
    const expired = await generateTestCertificate({ notBefore: at(-30), notAfter: at(-2) });
    const window = validityWindowOf(expired.cert);
    const gateway = await serve(expired, { pairingCodes: ['pair-expired'] });
    const transport = makeTransport();
    const events = collect(transport);

    transport.connect(gateway.endpoint, {
      certSha256: expired.certSha256,
      protocols: ['dsh-mobile-v1', 'dsh-pair.pair-expired'],
      headers: { 'X-DSH-Device-ID': DEVICE_ID, Authorization: 'Bearer tok-should-never-be-sent' },
    });
    await waitFor(() => events.some((event) => event.type === 'error'), { label: 'validity rejection' });

    // The pin itself matched: the leaf hash the transport observed is the pinned one.
    assert.deepEqual(transport.observedFingerprints, [expired.certSha256]);
    assert.equal(gateway.certSha256, expired.certSha256);

    const error = events.find((event) => event.type === 'error') as { code: string; message: string };
    assert.equal(error.code, 'client/pin-mismatch');
    assert.match(error.message, /expired/i);
    assert.doesNotMatch(error.message, /pinned fingerprint/i);

    // Same abort path as a pin mismatch: no `open`, nothing sent, and a synthetic close.
    await waitFor(() => events.some((event) => event.type === 'close'));
    assert.equal(events.some((event) => event.type === 'open'), false);
    assert.equal(transport.isOpenPublic, false);
    assert.equal(transport.send('{"type":"client-hello","requestId":"r1"}'), false);
    assert.equal(transport.framesSent.length, 0);
    // After the abort a send is refused outright, not queued for a later (never-coming) open.
    assert.equal(transport.framesSentBeforeOpen.length, 0);
    assert.deepEqual(
      events.find((event) => event.type === 'close'),
      { type: 'close', code: 1006, reason: 'pin-mismatch', wasClean: false },
    );

    // The gateway never saw an HTTP upgrade: no socket, no subprotocol, no auth, no frame.
    await delay(50);
    assert.equal(gateway.connectionCount, 0);
    assert.deepEqual(gateway.allReceivedFrames, []);
    assert.deepEqual(gateway.offeredPairingCodes, []);
    assert.deepEqual(gateway.offeredDeviceIds, []);

    // The window was read and compared against the wall clock (not merely "reject old certs").
    assert.equal(transport.observedValidityWindows.length, 1);
    const observed = transport.observedValidityWindows[0]!;
    assert.equal(observed.validFrom, new Date(window.validFrom).toISOString());
    assert.equal(observed.validTo, new Date(window.validTo).toISOString());
    assert.ok(observed.checkedAt > window.validTo, 'the wall clock is past the leaf notAfter');
  });

  it('rejects a not-yet-valid leaf the same way', async () => {
    const future = await generateTestCertificate({ notBefore: at(2), notAfter: at(30) });
    const window = validityWindowOf(future.cert);
    const gateway = await serve(future);
    const transport = makeTransport();
    const events = collect(transport);

    transport.connect(gateway.endpoint, { certSha256: future.certSha256, protocols: ['dsh-mobile-v1'] });
    await waitFor(() => events.some((event) => event.type === 'close'));

    assert.deepEqual(transport.observedFingerprints, [future.certSha256]);
    const error = events.find((event) => event.type === 'error') as { code: string; message: string };
    assert.equal(error.code, 'client/pin-mismatch');
    assert.match(error.message, /not valid yet/i);
    assert.equal(events.some((event) => event.type === 'open'), false);
    assert.equal(transport.observedValidityWindows[0]!.checkedAt < window.validFrom, true);

    await delay(50);
    assert.equal(gateway.connectionCount, 0);
    assert.deepEqual(gateway.allReceivedFrames, []);
  });

  it('checks the pin first: an expired leaf with a wrong pin reports the pin mismatch', async () => {
    const expired = await generateTestCertificate({ notBefore: at(-30), notAfter: at(-2) });
    const other = await generateTestCertificate();
    const gateway = await serve(expired);
    const transport = makeTransport();
    const events = collect(transport);

    transport.connect(gateway.endpoint, { certSha256: other.certSha256, protocols: ['dsh-mobile-v1'] });
    await waitFor(() => events.some((event) => event.type === 'close'));

    const error = events.find((event) => event.type === 'error') as { code: string; message: string };
    assert.equal(error.code, 'client/pin-mismatch');
    assert.match(error.message, /pinned fingerprint/i);
    // The pin failed first, so the validity window was never consulted.
    assert.deepEqual(transport.observedValidityWindows, []);
  });

  it('uses the `now` option: a clock past `validTo` rejects a leaf that is valid on the wall clock', async () => {
    const certificate = await generateTestCertificate();
    const window = validityWindowOf(certificate.cert);
    const gateway = await serve(certificate, { pairingCodes: ['pair-later'] });
    const transport = makeTransport({ now: window.validTo + DAY_MS });
    const events = collect(transport);

    transport.connect(gateway.endpoint, {
      certSha256: certificate.certSha256,
      protocols: ['dsh-mobile-v1', 'dsh-pair.pair-later'],
    });
    await waitFor(() => events.some((event) => event.type === 'error'));

    assert.deepEqual(transport.observedFingerprints, [certificate.certSha256]);
    const error = events.find((event) => event.type === 'error') as { code: string; message: string };
    assert.equal(error.code, 'client/pin-mismatch');
    assert.match(error.message, /expired/i);
    assert.equal(transport.observedValidityWindows[0]!.checkedAt, window.validTo + DAY_MS);
    assert.equal(events.some((event) => event.type === 'open'), false);

    await delay(50);
    assert.equal(gateway.connectionCount, 0);
    assert.deepEqual(gateway.offeredPairingCodes, []);
  });

  it('accepts a leaf whose window covers the configured clock', async () => {
    const certificate = await generateTestCertificate();
    const window = validityWindowOf(certificate.cert);
    const gateway = await serve(certificate, { pairingCodes: ['pair-inside'] });
    const checkedAt = window.validFrom + 60_000;
    const transport = makeTransport({ now: checkedAt });
    const events = collect(transport);

    transport.connect(gateway.endpoint, {
      certSha256: certificate.certSha256,
      protocols: ['dsh-mobile-v1', 'dsh-pair.pair-inside'],
    });
    await waitFor(() => events.some((event) => event.type === 'open'));

    assert.deepEqual(transport.observedFingerprints, [certificate.certSha256]);
    assert.equal(transport.observedValidityWindows[0]!.checkedAt, checkedAt);
    assert.equal(events.some((event) => event.type === 'error'), false);
    assert.deepEqual(gateway.offeredPairingCodes, ['pair-inside']);
    transport.close();
  });

  it('rejects on the window, not on age: an expired leaf is accepted when the clock is inside it', async () => {
    const expired = await generateTestCertificate({ notBefore: at(-30), notAfter: at(-2) });
    const window = validityWindowOf(expired.cert);
    const gateway = await serve(expired, { tokens: ['tok-expired'] });
    const checkedAt = window.validFrom + 60_000;
    const transport = makeTransport({ now: checkedAt });
    const events = collect(transport);

    transport.connect(gateway.endpoint, {
      certSha256: expired.certSha256,
      protocols: ['dsh-mobile-v1'],
      headers: { Authorization: 'Bearer tok-expired' },
    });
    await waitFor(() => events.some((event) => event.type === 'open'));

    assert.equal(transport.observedValidityWindows[0]!.checkedAt, checkedAt);
    assert.equal(events.some((event) => event.type === 'error'), false);
    transport.close();
  });
});
