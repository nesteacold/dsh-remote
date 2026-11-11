// Transport + fake gateway tests (A011): pinning happens before `open`, nothing is sent on a
// certificate mismatch, and the rev-2 handshake (subprotocols, X-DSH-Device-ID, `hello`,
// client-hello) works against the in-test gateway.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { TransportEvent } from '../src/core/transport';
import { generateTestCertificate } from './support/certs';
import { FakeGateway } from './support/fake-gateway';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { waitFor } from './support/wait';

function collect(transport: NodePinnedTransport): TransportEvent[] {
  const events: TransportEvent[] = [];
  transport.on((event) => events.push(event));
  return events;
}

describe('NodePinnedTransport + FakeGateway', () => {
  let gateway: FakeGateway;
  const transports: NodePinnedTransport[] = [];

  before(async () => {
    gateway = await FakeGateway.create({ pairingCodes: ['pair-code-1'], tokens: ['tok-transport'] });
  });

  after(async () => {
    for (const t of transports) t.close();
    await gateway.close();
  });

  function makeTransport(): NodePinnedTransport {
    const transport = new NodePinnedTransport({ handshakeTimeoutMs: 4_000 });
    transports.push(transport);
    return transport;
  }

  it('connects over wss to 127.0.0.1 on an ephemeral port and receives `hello` (kind)', async () => {
    const transport = makeTransport();
    const events = collect(transport);
    transport.connect(gateway.endpoint, {
      certSha256: gateway.certSha256,
      protocols: ['dsh-mobile-v1'],
      headers: { Authorization: 'Bearer tok-transport' },
    });
    await waitFor(() => events.some((e) => e.type === 'open'));
    await waitFor(() => events.some((e) => e.type === 'message'));
    const hello = JSON.parse((events.find((e) => e.type === 'message') as { data: string }).data) as Record<string, unknown>;
    assert.equal(hello.kind, 'hello');
    assert.equal(hello.companionProtocol, 1);
    assert.equal(hello.minClientVersion, 1);
    assert.deepEqual(hello.capabilities, ['sessions-read', 'prompt', 'cancel', 'approval-v1']);
    assert.equal(hello.certSha256, gateway.certSha256);
    assert.equal(transport.observedFingerprints[0], gateway.certSha256);
    assert.deepEqual(transport.offeredProtocols, ['dsh-mobile-v1']);
  });

  it('offers the pairing subprotocol and X-DSH-Device-ID and sends only after open', async () => {
    const framesBefore = gateway.allReceivedFrames.length;
    const transport = makeTransport();
    const events = collect(transport);
    transport.connect(gateway.endpoint, {
      certSha256: gateway.certSha256,
      protocols: ['dsh-mobile-v1', 'dsh-pair.pair-code-1'],
      headers: { 'X-DSH-Device-ID': '11111111-2222-4333-8444-555555555555' },
    });
    // Sending before open must not put anything on the wire.
    assert.equal(transport.send('{"type":"ping","requestId":"r0"}'), false);
    assert.equal(transport.framesSentBeforeOpen.length, 1);
    await waitFor(() => events.some((e) => e.type === 'open'));
    // Contract §3.8: a pairing socket is admitted only by a valid proof, so this raw-transport
    // test answers the challenge before it may send anything else.
    await waitFor(() => (events.filter((e) => e.type === 'message')).length >= 1);
    const challenge = JSON.parse(events.find((e) => e.type === 'message')?.data as string) as Record<string, unknown>;
    assert.equal(challenge.kind, 'pairing-challenge');
    assert.equal(challenge.certSha256, gateway.certSha256);
    assert.equal(challenge.otpRequired, false);
    assert.equal(
      transport.send(JSON.stringify({ type: 'pairing-proof', clientNonce: 'transport-nonce-0123456789' })),
      true,
    );
    // `pending` and (auto-approved) `paired` + `hello` follow the proof.
    await waitFor(() => (events.filter((e) => e.type === 'message')).length >= 4);
    const kinds = events.filter((e) => e.type === 'message')
      .map((e) => (JSON.parse(e.data as string) as { kind?: string }).kind);
    assert.deepEqual(kinds, ['pairing-challenge', 'pairing-pending', 'paired', 'hello']);
    assert.equal(transport.send('{"type":"client-hello","requestId":"r1","companionProtocol":1,"appVersion":"0.1.0","platform":"ios"}'), true);
    await waitFor(() => gateway.clientHellos.length > 0);
    assert.deepEqual(gateway.offeredPairingCodes.at(-1), 'pair-code-1');
    assert.deepEqual(gateway.offeredDeviceIds.at(-1), '11111111-2222-4333-8444-555555555555');
    // Exactly two frames reached the server from this connection: the proof and the client-hello.
    assert.equal(gateway.allReceivedFrames.length, framesBefore + 2);
  });

  it('refuses an unknown pairing code with a 401 upgrade (no socket, no frame)', async () => {
    const before = gateway.connectionCount;
    const transport = makeTransport();
    const events = collect(transport);
    transport.connect(gateway.endpoint, {
      certSha256: gateway.certSha256,
      protocols: ['dsh-mobile-v1', 'dsh-pair.not-a-real-code'],
    });
    await waitFor(() => events.some((e) => e.type === 'close'));
    assert.equal(events.some((e) => e.type === 'open'), false);
    assert.equal(gateway.connectionCount, before);
  });

  it('refuses a host whose certificate does not match the pin and sends nothing', async () => {
    const wrong = await generateTestCertificate();
    const beforeFrames = gateway.allReceivedFrames.length;
    const beforeConnections = gateway.connectionCount;
    const beforeCodes = gateway.offeredPairingCodes.length;
    const transport = makeTransport();
    const events = collect(transport);
    transport.connect(gateway.endpoint, {
      certSha256: wrong.certSha256,
      protocols: ['dsh-mobile-v1', 'dsh-pair.pair-code-1'],
    });
    await waitFor(() => events.some((e) => e.type === 'close'));
    assert.equal(transport.observedFingerprints[0], gateway.certSha256);
    assert.notEqual(transport.observedFingerprints[0], wrong.certSha256);

    const error = events.find((e) => e.type === 'error') as { code: string; message: string };
    assert.equal(error.code, 'client/pin-mismatch');
    assert.match(error.message, /pinned fingerprint/i);
    assert.equal(events.some((e) => e.type === 'open'), false);
    assert.equal(transport.framesSent.length, 0);
    assert.equal(transport.framesSentBeforeOpen.length, 0);

    // The gateway never saw a WebSocket upgrade: no new connection, no subprotocol, no frame.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(gateway.connectionCount, beforeConnections);
    assert.equal(gateway.allReceivedFrames.length, beforeFrames);
    assert.equal(gateway.offeredPairingCodes.length, beforeCodes);
  });

  it('refuses to connect when the pin is not a 64-char hex digest', async () => {
    const transport = makeTransport();
    const events = collect(transport);
    transport.connect(gateway.endpoint, { certSha256: 'not-a-sha256' });
    await waitFor(() => events.some((e) => e.type === 'close'));
    assert.equal((events.find((e) => e.type === 'error') as { code: string }).code, 'client/pin-mismatch');
    assert.equal(transport.framesSent.length, 0);
  });

  it('refuses non-wss URLs', async () => {
    const transport = makeTransport();
    const events = collect(transport);
    transport.connect('ws://127.0.0.1:1', { certSha256: gateway.certSha256 });
    await waitFor(() => events.some((e) => e.type === 'close'));
    assert.equal((events.find((e) => e.type === 'error') as { code: string }).code, 'client/bad-url');
  });

  it('reports close when the gateway drops the connection', async () => {
    const transport = makeTransport();
    const events = collect(transport);
    transport.connect(gateway.endpoint, {
      certSha256: gateway.certSha256,
      protocols: ['dsh-mobile-v1'],
      headers: { Authorization: 'Bearer tok-transport' },
    });
    await waitFor(() => events.some((e) => e.type === 'open'));
    gateway.dropAllConnections();
    await waitFor(() => events.some((e) => e.type === 'close'));
  });
});
