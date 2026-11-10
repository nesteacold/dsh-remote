// CompanionClient tests (A012): paired -> hello -> client-hello handshake, companion version
// gate, requestId correlation, error-code mapping, close codes 4004/4003/4401, ping,
// revocation, pin refusal before anything is sent, and the QR -> pairing subprotocol flow.
//
// M6: explicit close is terminal and reported exactly once (pending requests rejected), and the
// handshake is bounded (`handshakeTimeoutMs`). The close/deadline cases at the end run over the
// *production* `PinnedTransport` with a mocked `pinned-ws` module, not only the Node transport.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { CLOSE_CODES, COMPANION_PROTOCOL_VERSION } from '@dsh-ext/mobile-protocol';

import { classifyProtocolUnsupported, CompanionClient, DEFAULT_HANDSHAKE_TIMEOUT_MS } from '../src/core/client';
import { CoreError } from '../src/core/errors';
import { TransportEmitter, type Transport, type TransportListener } from '../src/core/transport';
import { PinnedTransport } from '../src/platform/pinned-transport';
import type { PinnedWsAdapter, PinnedWsEventName } from '../modules/pinned-ws';
import { generateTestCertificate } from './support/certs';
import { FakeGateway } from './support/fake-gateway';
import { NodePinnedTransport, createNodePinnedTransportFactory } from './support/node-pinned-transport';
import { ScriptedTransport } from './support/scripted-transport';
import { deferred, waitFor } from './support/wait';

const CODE = 'Q'.repeat(43);
const INSTALL_ID = '3f2a1c9e-0b7d-4f6a-9c1e-8d5b2a7f4c63';
const TARGET = { installId: INSTALL_ID, deviceName: 'Pixel test', appVersion: '0.1.0', platform: 'android' as const };

describe('classifyProtocolUnsupported', () => {
  it('says the app must update when the host requires a newer client', () => {
    const update = classifyProtocolUnsupported({ companionProtocol: 2, minClientVersion: 2 }, null);
    assert.equal(update.side, 'app');
    assert.equal(update.code, 'protocol/unsupported');
    assert.equal(update.minClientVersion, 2);
  });

  it('says the host must update when the host protocol is older than ours', () => {
    const update = classifyProtocolUnsupported({ companionProtocol: 0, minClientVersion: 0 }, null);
    assert.equal(update.side, 'host');
  });
});

describe('CompanionClient over the fake gateway', () => {
  let gateway: FakeGateway;
  let transportFactory: ReturnType<typeof createNodePinnedTransportFactory>;
  let counter: number;

  before(async () => {
    gateway = await FakeGateway.create({ pairingCodes: [CODE] });
  });

  after(async () => {
    await gateway.close();
  });

  beforeEach(() => {
    transportFactory = createNodePinnedTransportFactory({ handshakeTimeoutMs: 4_000 });
    counter = 0;
  });

  function makeClient(options: { onRevoked?: () => void; requestTimeoutMs?: number; pingIntervalMs?: number } = {}): CompanionClient {
    return new CompanionClient({
      transport: transportFactory,
      appVersion: TARGET.appVersion,
      platform: TARGET.platform,
      requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
      pingIntervalMs: options.pingIntervalMs ?? 0,
      newRequestId: () => `req-${++counter}`,
      ...(options.onRevoked ? { onRevoked: options.onRevoked } : {}),
    });
  }

  async function connectReady(client: CompanionClient, target: FakeGateway, token: string): Promise<void> {
    const ready = deferred<void>();
    client.on('ready', () => ready.resolve());
    client.connect({ url: target.endpoint, certSha256: target.certSha256, token, ...TARGET });
    await ready.promise;
  }

  it('performs hello -> client-hello and becomes ready', async () => {
    const helloGateway = await FakeGateway.create({ tokens: ['tok-ready'] });
    try {
      const client = makeClient();
      const ready = deferred<{ hello: { companionProtocol: number; capabilities: string[] } }>();
      client.on('ready', (payload) => ready.resolve(payload as never));
      client.connect({ url: helloGateway.endpoint, certSha256: helloGateway.certSha256, token: 'tok-ready', ...TARGET });
      const { hello } = await ready.promise;
      assert.equal(client.state, 'ready');
      assert.equal(hello.companionProtocol, COMPANION_PROTOCOL_VERSION);
      assert.equal(hello.capabilities.includes('approval-v1'), true);
      await waitFor(() => helloGateway.clientHellos.length > 0, { label: 'client-hello' });
      assert.deepEqual(helloGateway.clientHellos.at(-1), {
        type: 'client-hello',
        requestId: helloGateway.clientHellos.at(-1)?.requestId,
        companionProtocol: 1,
        appVersion: '0.1.0',
        platform: 'android',
      });
      client.close();
    } finally {
      await helloGateway.close();
    }
  });

  it('refuses requests before ready without sending them', async () => {
    const client = makeClient();
    await assert.rejects(client.request('sessions'), (err: unknown) => {
      assert.ok(err instanceof CoreError);
      assert.equal(err.code, 'client/bad-state');
      return true;
    });
  });

  it('refuses ops outside the contract allowlist locally', async () => {
    const allowGateway = await FakeGateway.create({ tokens: ['tok-allow'] });
    try {
      const client = makeClient();
      await connectReady(client, allowGateway, 'tok-allow');
      const before = allowGateway.allReceivedFrames.length;
      // @ts-expect-error not in OPS: the client must refuse it before the wire.
      await assert.rejects(client.request('sessions.list'), { code: 'op/forbidden' });
      assert.equal(allowGateway.allReceivedFrames.length, before);
      client.close();
    } finally {
      await allowGateway.close();
    }
  });

  it('correlates answers by requestId and maps contract error codes', async () => {
    gateway.addToken('tok-map');
    const client = makeClient();
    await connectReady(client, gateway, 'tok-map');

    const listed = await client.request('sessions');
    assert.equal(listed.kind, 'sessions');
    assert.equal((listed.items as unknown[]).length >= 3, true);
    // Rows keep the upstream projection: the title lives under projections.values.
    const first = (listed.items as Array<{ projections?: { values?: { title?: string } } }>)[0];
    assert.equal(typeof first?.projections?.values?.title, 'string');

    const searched = await client.request('search', { query: 'release' });
    assert.equal(searched.kind, 'search');

    await assert.rejects(client.request('subscribe', {}), (err: unknown) => {
      assert.ok(err instanceof CoreError);
      assert.equal(err.code, 'bad-request');
      return true;
    });
    client.close();
  });

  it('returns a refusal receipt (accepted:false) instead of rejecting', async () => {
    const receiptGateway = await FakeGateway.create({ tokens: ['tok-receipt'] });
    try {
      const client = makeClient();
      await connectReady(client, receiptGateway, 'tok-receipt');
      const receipt = await client.request('approval-response', {
        rpcId: 'rpc-x',
        sessionId: 's-running',
        approvalId: 'ap-gone',
        argsHash: 'a'.repeat(64),
        outcome: 'allowed-once',
      });
      assert.equal(receipt.kind, 'approval-response');
      assert.equal(receipt.accepted, false);
      assert.equal(receipt.reason, 'not-pending');
      assert.match(String(receipt.requestId), /^req-\d+$/);
      client.close();
    } finally {
      await receiptGateway.close();
    }
  });

  it('refuses unknown ops on the wire with op/forbidden (server allowlist)', async () => {
    const forbidGateway = await FakeGateway.create({ tokens: ['tok-forbid'] });
    try {
      const client = makeClient();
      await connectReady(client, forbidGateway, 'tok-forbid');
      // Bypass the local allowlist to prove the server side is still enforced.
      const transport = client.transportRef as NodePinnedTransport;
      transport.send(JSON.stringify({ type: 'sessions.list', requestId: 'raw-1' }));
      await waitFor(() => forbidGateway.allReceivedFrames.some((text) => text.includes('raw-1')));
      // The server answered op/forbidden; having no pending request, the client ignores it.
      const listed = await client.request('sessions');
      assert.equal(listed.kind, 'sessions');
      client.close();
    } finally {
      await forbidGateway.close();
    }
  });

  it('times out a request that is never answered', async () => {
    const slowGateway = await FakeGateway.create({ tokens: ['tok-slow'], requestDelayMs: 5_000 });
    try {
      const client = makeClient({ requestTimeoutMs: 150 });
      await connectReady(client, slowGateway, 'tok-slow');
      await assert.rejects(client.request('sessions'), (err: unknown) => {
        assert.ok(err instanceof CoreError);
        assert.equal(err.code, 'client/timeout');
        assert.equal(err.retryable, true);
        return true;
      });
      client.close();
    } finally {
      await slowGateway.close();
    }
  });

  it('maps a host protocol mismatch to a typed UpdateRequired{side:"app"}', async () => {
    const newHost = await FakeGateway.create({ tokens: ['tok-new'], companionProtocol: 2, minClientVersion: 2 });
    try {
      const client = makeClient();
      const update = deferred<{ side: 'app' | 'host' }>();
      client.on('updateRequired', (u) => update.resolve(u));
      client.connect({ url: newHost.endpoint, certSha256: newHost.certSha256, token: 'tok-new', ...TARGET });
      const result = await update.promise;
      assert.equal(result.side, 'app');
      assert.equal(client.state, 'update-required');
      client.close();
    } finally {
      await newHost.close();
    }
  });

  it('maps an old host to UpdateRequired{side:"host"}', async () => {
    const oldHost = await FakeGateway.create({ tokens: ['tok-old'], companionProtocol: 0, minClientVersion: 0 });
    try {
      const client = makeClient();
      const update = deferred<{ side: 'app' | 'host' }>();
      client.on('updateRequired', (u) => update.resolve(u));
      client.connect({ url: oldHost.endpoint, certSha256: oldHost.certSha256, token: 'tok-old', ...TARGET });
      const result = await update.promise;
      assert.equal(result.side, 'host');
      client.close();
    } finally {
      await oldHost.close();
    }
  });

  it('calls onRevoked exactly once when the host revoked the device (in-band auth/revoked)', async () => {
    gateway.addToken('tok-revoked');
    let revokedCalls = 0;
    const client = makeClient({ onRevoked: () => { revokedCalls += 1; } });
    const revoked = deferred<void>();
    client.on('revoked', () => revoked.resolve());
    await connectReady(client, gateway, 'tok-revoked');
    gateway.revokeAllTokens();
    await assert.rejects(client.request('sessions'), { code: 'auth/revoked' });
    await revoked.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(revokedCalls, 1);
    assert.equal(client.state, 'revoked');
    gateway.addToken('tok-revoked');
  });

  it('wipes on close code 4401 (revoked)', async () => {
    const closeGateway = await FakeGateway.create({ tokens: ['tok-close-4401'], closeAfterHello: 4401 });
    try {
      const client = makeClient();
      const revoked = deferred<{ code: number }>();
      client.on('disconnected', (payload) => {
        if (payload.code === CLOSE_CODES.revoked) revoked.resolve(payload);
      });
      client.connect({ url: closeGateway.endpoint, certSha256: closeGateway.certSha256, token: 'tok-close-4401', ...TARGET });
      const payload = await revoked.promise;
      assert.equal(payload.code, 4401);
      await waitFor(() => client.state === 'revoked');
      client.close();
    } finally {
      await closeGateway.close();
    }
  });

  it('stops reconnection on close code 4004 (gateway disabled)', async () => {
    const offGateway = await FakeGateway.create({ tokens: ['tok-off'], closeAfterHello: 4004 });
    try {
      const client = makeClient();
      const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
      client.on('gatewayDisabled', (payload) => events.push({ event: 'gatewayDisabled', payload: payload as unknown as Record<string, unknown> }));
      client.on('disconnected', (payload) => events.push({ event: 'disconnected', payload: payload as unknown as Record<string, unknown> }));
      client.connect({ url: offGateway.endpoint, certSha256: offGateway.certSha256, token: 'tok-off', ...TARGET });
      await waitFor(() => events.some((e) => e.event === 'gatewayDisabled'), { label: 'gatewayDisabled' });
      await waitFor(() => events.some((e) => e.event === 'disconnected'), { label: 'disconnected' });
      const disabled = events.find((e) => e.event === 'gatewayDisabled');
      // Every drop of this connection is a hard stop: the close handler must not emit a
      // retryable one (the transport may report the drop itself before the server's code).
      const drops = events.filter((e) => e.event === 'disconnected');
      assert.ok(drops.length >= 1);
      for (const drop of drops) assert.equal(drop.payload.retry, false, JSON.stringify(drop.payload));
      assert.equal(drops.at(-1)?.payload.code, 4004);
      assert.equal(client.state, 'gateway-disabled');
      client.close();
    } finally {
      await offGateway.close();
    }
  });

  it('reports close code 4003 as a re-authentication request', async () => {
    const reauthGateway = await FakeGateway.create({ tokens: ['tok-reauth'], closeAfterHello: 4003 });
    try {
      const client = makeClient();
      const reauth = deferred<{ code: number }>();
      client.on('reauthRequired', (payload) => reauth.resolve(payload));
      client.connect({ url: reauthGateway.endpoint, certSha256: reauthGateway.certSha256, token: 'tok-reauth', ...TARGET });
      assert.equal((await reauth.promise).code, 4003);
      assert.equal(client.state, 'reauth-required');
      client.close();
    } finally {
      await reauthGateway.close();
    }
  });

  it('refuses a wrong-certificate host before sending anything (SC-002)', async () => {
    const wrong = await generateTestCertificate();
    const framesBefore = gateway.allReceivedFrames.length;
    const connectionsBefore = gateway.connectionCount;
    const client = makeClient();
    const err = deferred<CoreError>();
    client.on('error', (e) => err.resolve(e));
    client.connect({ url: gateway.endpoint, certSha256: wrong.certSha256, pairingCode: CODE, ...TARGET });
    const error = await err.promise;
    assert.equal(error.code, 'client/pin-mismatch');
    await waitFor(() => client.state === 'closed');

    const transport = transportFactory.created[0] as NodePinnedTransport;
    assert.equal(transport.framesSent.length, 0);
    assert.equal(transport.framesSentBeforeOpen.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(gateway.allReceivedFrames.length, framesBefore);
    assert.equal(gateway.connectionCount, connectionsBefore);
  });

  it('pairs via subprotocols + X-DSH-Device-ID and receives a token in `paired`', async () => {
    const pairingCode = 'P'.repeat(43);
    const pairGateway = await FakeGateway.create({ pairingCodes: [pairingCode] });
    try {
      const client = makeClient();
      const paired = deferred<{ token: string; device: { id: string; name: string } }>();
      client.on('paired', (payload) => paired.resolve(payload));
      const ready = deferred<void>();
      client.on('ready', () => ready.resolve());
      client.connect({ url: pairGateway.endpoint, certSha256: pairGateway.certSha256, pairingCode, ...TARGET });
      const result = await paired.promise;
      await ready.promise;
      assert.match(result.token, /^tok-/);
      assert.equal(result.device.id, INSTALL_ID);
      assert.equal(client.pairedToken, result.token);
      assert.deepEqual(pairGateway.consumedPairingCodes, [pairingCode]);
      assert.deepEqual(pairGateway.offeredDeviceIds, [INSTALL_ID]);
      // The transport offered the contract subprotocols (one transport per connection).
      assert.equal(transportFactory.created.length, 1);
      const transport = transportFactory.created[0] as NodePinnedTransport;
      assert.deepEqual(transport.offeredProtocols, ['dsh-mobile-v1', `dsh-pair.${pairingCode}`]);
      assert.equal(transport.offeredHeaders['X-DSH-Device-ID'], INSTALL_ID);
      assert.equal(transport.offeredHeaders['X-DSH-Device-Name'], 'Pixel test');

      // The token from `paired` authorises a fresh bearer connection.
      client.close();
      const pairedClient = makeClient();
      await connectReady(pairedClient, pairGateway, result.token);
      const listed = await pairedClient.request('sessions');
      assert.equal((listed.items as unknown[]).length > 0, true);
      pairedClient.close();
    } finally {
      await pairGateway.close();
    }
  });

  it('fails an unknown/expired pairing code with auth/required (401 upgrade)', async () => {
    const pairGateway = await FakeGateway.create({ pairingCodes: ['once'.padEnd(43, 'x')] });
    try {
      const client = makeClient();
      const disconnected = deferred<{ code: number }>();
      client.on('disconnected', (payload) => disconnected.resolve(payload));
      client.connect({ url: pairGateway.endpoint, certSha256: pairGateway.certSha256, pairingCode: 'wrong'.padEnd(43, 'y'), ...TARGET });
      await disconnected.promise;
      assert.notEqual(client.state, 'ready');
      assert.equal(pairGateway.consumedPairingCodes.length, 0);
      client.close();
    } finally {
      await pairGateway.close();
    }
  });

  it('rejects a connect() that carries both a token and a pairing code', () => {
    const client = makeClient();
    assert.throws(
      () => client.connect({ url: gateway.endpoint, certSha256: gateway.certSha256, token: 't', ...TARGET, pairingCode: CODE } as never),
      { code: 'client/bad-state' },
    );
  });

  it('forwards approval-requested and approval-resolved pushes', async () => {
    const pushGateway = await FakeGateway.create({ tokens: ['tok-push'] });
    try {
      const client = makeClient();
      const first = deferred<string>();
      const second = deferred<string>();
      const resolved = deferred<string>();
      const seen: string[] = [];
      client.on('approvalRequested', (frame) => {
        seen.push(frame.approvalId);
        if (frame.approvalId === 'ap-1') first.resolve(frame.approvalId);
        if (frame.approvalId === 'ap-2') second.resolve(frame.approvalId);
      });
      client.on('approvalResolved', (frame) => resolved.resolve(frame.outcome));
      await connectReady(client, pushGateway, 'tok-push');
      const base = { rpcId: 'rpc-1', sessionId: 's-running', toolName: 'bash', argsHash: 'f'.repeat(64) };
      pushGateway.pushApprovalRequested({ approvalId: 'ap-1', ...base, argsPreview: '{"command":"ls"}' });
      assert.equal(await first.promise, 'ap-1');
      pushGateway.pushApprovalRequested({ approvalId: 'ap-2', ...base, argsHash: null });
      assert.equal(await second.promise, 'ap-2');
      assert.deepEqual(seen, ['ap-1', 'ap-2']);
      pushGateway.resolveElsewhere('ap-1', 'cancelled');
      assert.equal(await resolved.promise, 'cancelled');
      client.close();
    } finally {
      await pushGateway.close();
    }
  });

  it('pings every interval with a fresh requestId', async () => {
    const pingGateway = await FakeGateway.create({ tokens: ['tok-ping'] });
    try {
      const client = makeClient({ pingIntervalMs: 40 });
      await connectReady(client, pingGateway, 'tok-ping');
      await waitFor(() => pingGateway.pingCount >= 2, { label: 'pings', timeoutMs: 2_000 });
      const pings = pingGateway.allReceivedFrames
        .map((text) => JSON.parse(text) as { type: string; requestId?: string })
        .filter((frame) => frame.type === 'ping');
      assert.ok(pings.length >= 2);
      assert.equal(new Set(pings.map((p) => p.requestId)).size, pings.length);
      client.close();
    } finally {
      await pingGateway.close();
    }
  });

  it('sends every request frame as {type, requestId, ...params}', async () => {
    const shapeGateway = await FakeGateway.create({ tokens: ['tok-shape'] });
    try {
      const client = makeClient();
      await connectReady(client, shapeGateway, 'tok-shape');
      await client.request('message', { sessionId: 's-running', text: 'hi', clientMsgId: 'cm-1' });
      const sent = shapeGateway.allReceivedFrames
        .map((text) => JSON.parse(text) as Record<string, unknown>)
        .filter((frame) => frame.type === 'message');
      assert.deepEqual(sent.at(-1), { type: 'message', requestId: 'req-2', sessionId: 's-running', text: 'hi', clientMsgId: 'cm-1' });
      assert.deepEqual(shapeGateway.protocolViolations, []);
      client.close();
    } finally {
      await shapeGateway.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Protocol-level regressions over a scripted transport: the host says exactly what the test
// wants, including frames the real (contract-following) gateway would never send.
// ---------------------------------------------------------------------------

const PIN = 'a'.repeat(64);
const PAIRING_CODE = 'A'.repeat(43);
const HELLO = {
  kind: 'hello',
  protocol: 3,
  companionProtocol: COMPANION_PROTOCOL_VERSION,
  minClientVersion: 1,
  capabilities: ['sessions-read', 'prompt', 'cancel', 'approval-v1'],
  authenticated: true,
  device: { id: INSTALL_ID, name: 'Pixel test' },
  gatewayId: 'b3a4c2c9-5d2f-4a8e-9f2b-0c1d2e3f4a5b',
};

function scriptedClient(transport: ScriptedTransport, ids: { counter: { value: number } }): CompanionClient {
  return new CompanionClient({
    transport,
    appVersion: TARGET.appVersion,
    platform: TARGET.platform,
    requestTimeoutMs: 1_000,
    pingIntervalMs: 0,
    newRequestId: () => `sid-${++ids.counter.value}`,
  });
}

describe('CompanionClient frame-level contract (M9 / N1 / N6)', () => {
  it('accepts `paired` exactly once on a pairing socket and refuses a second one (M9)', () => {
    const transport = new ScriptedTransport();
    const ids = { counter: { value: 0 } };
    const client = scriptedClient(transport, ids);
    const tokens: string[] = [];
    const errors: CoreError[] = [];
    client.on('paired', (frame) => tokens.push(frame.token));
    client.on('error', (error) => errors.push(error));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, pairingCode: PAIRING_CODE, ...TARGET });
    transport.fireOpen();
    transport.deliver({ kind: 'paired', token: 'tok-first', device: { id: INSTALL_ID, name: 'Pixel test' } });
    transport.deliver({ kind: 'paired', token: 'tok-second', device: { id: INSTALL_ID, name: 'Pixel test' } });

    assert.deepEqual(tokens, ['tok-first']);
    assert.equal(client.pairedToken, 'tok-first');
    // A second `paired` is a protocol violation, not a credential update.
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, 'client/bad-message');
    client.close();
  });

  it('refuses `hello` that arrives before `paired` on a pairing connection (M9)', () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport, { counter: { value: 0 } });
    const errors: CoreError[] = [];
    client.on('error', (error) => errors.push(error));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, pairingCode: PAIRING_CODE, ...TARGET });
    transport.fireOpen();
    transport.deliver(HELLO);

    // The one-time code must not be consumed without a stored token: no client-hello is sent.
    assert.deepEqual(transport.sentFrames().filter((frame) => frame.type === 'client-hello'), []);
    assert.equal(errors.some((error) => /hello arrived before paired/.test(error.message)), true);
    assert.notEqual(client.state, 'ready');
  });

  it('ignores a rogue `paired` frame on an authenticated connection (M9)', () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport, { counter: { value: 0 } });
    const tokens: string[] = [];
    const errors: CoreError[] = [];
    client.on('paired', (frame) => tokens.push(frame.token));
    client.on('error', (error) => errors.push(error));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });
    transport.fireOpen();
    transport.deliver({ kind: 'paired', token: 'tok-rogue', device: { id: INSTALL_ID, name: 'Pixel test' } });

    assert.deepEqual(tokens, []);
    assert.equal(client.pairedToken, null);
    assert.equal(errors[0]?.code, 'client/bad-message');
    client.close();
  });

  it('drops the one-time token from memory once it is stored and when the socket closes (N6)', () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport, { counter: { value: 0 } });

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, pairingCode: PAIRING_CODE, ...TARGET });
    transport.fireOpen();
    transport.deliver({ kind: 'paired', token: 'tok-one', device: { id: INSTALL_ID, name: 'Pixel test' } });
    assert.equal(client.pairedToken, 'tok-one');
    // The app calls this right after `saveToken` resolved.
    client.forgetPairedToken();
    assert.equal(client.pairedToken, null);

    // And a dropped socket never keeps it either.
    transport.deliver({ kind: 'paired', token: 'tok-two', device: { id: INSTALL_ID, name: 'Pixel test' } });
    client.close();
    assert.equal(client.pairedToken, null);
  });

  it('fails only the addressed request on an orphan requestId error (N1)', async () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport, { counter: { value: 0 } });

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });
    transport.fireOpen();
    transport.deliver(HELLO);
    transport.deliver({ kind: 'client-hello', requestId: transport.lastRequestId('client-hello'), accepted: true });
    assert.equal(client.state, 'ready');

    const listed = client.request('sessions');
    // An error frame whose requestId is unknown (e.g. a request that already timed out).
    transport.deliver({ kind: 'error', code: 'op/forbidden', requestId: 'no-such-request', requestType: 'sessions' });

    // The unrelated pending request must still be answered normally.
    transport.deliver({ kind: 'sessions', requestId: transport.lastRequestId('sessions'), items: [{ sessionId: 's-1' }] });
    const answer = await listed;
    assert.equal(answer.kind, 'sessions');
    client.close();
  });
});

// ---------------------------------------------------------------------------
// Transport-event ordering (device regression, bearer socket): the native module logged `onOpen`
// and then `onMessage ... delivered=1`, so JS saw both events, yet the client never sent
// `client-hello` and closed at its 10 s handshake deadline. A single missed/mis-ordered `open`
// made `onTransportEvent` discard the server `hello` and then `handleHello` silently return.
// These pin that a server frame can never be lost that way — without weakening the
// pairing-before-hello rule (§3.3/§5a) or the ignore-frames-after-close rule.
// ---------------------------------------------------------------------------

/**
 * Stand-in for the device case: the socket really is open (frames arrive and `send` reaches the
 * wire), but the `open` event never reaches JS.
 */
class LostOpenTransport implements Transport {
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  private readonly emitter = new TransportEmitter();

  connect(): void {
    // The native socket opens; only the `open` event is lost on the way to JS.
  }

  send(data: string): boolean {
    this.sent.push(data);
    return true;
  }

  close(code = 1000, reason = ''): void {
    this.closes.push({ code, reason });
    this.emitter.emit({ type: 'close', code, reason, wasClean: code === 1000 });
  }

  on(listener: TransportListener): () => void {
    return this.emitter.on(listener);
  }

  /** A server frame arrived without any `open` before it. */
  deliver(frame: Record<string, unknown>): void {
    this.emitter.emit({ type: 'message', data: JSON.stringify(frame) });
  }

  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

function lostOpenClient(transport: Transport): CompanionClient {
  let counter = 0;
  return new CompanionClient({
    transport,
    appVersion: TARGET.appVersion,
    platform: TARGET.platform,
    requestTimeoutMs: 1_000,
    pingIntervalMs: 0,
    newRequestId: () => `lo-${++counter}`,
  });
}

describe('CompanionClient transport-event ordering (lost `open`)', () => {
  it('treats the first inbound frame as proof of `open` and answers hello (regression)', () => {
    const transport = new LostOpenTransport();
    const client = lostOpenClient(transport);
    const states: string[] = [];
    client.on('state', (state) => states.push(state));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });
    assert.equal(client.state, 'connecting');

    // Only the frame makes it through: no `open` event ever reaches the client.
    transport.deliver(HELLO);

    assert.equal(client.state, 'waiting-client-hello');
    assert.equal(client.connected, true);
    assert.deepEqual(states, ['connecting', 'waiting-hello', 'waiting-client-hello']);
    // The host's hello was answered: this is the frame the device never sent.
    const frames = transport.sentFrames();
    assert.deepEqual(frames.map((frame) => frame.type), ['client-hello']);
    assert.deepEqual(frames[0], {
      type: 'client-hello',
      requestId: 'lo-1',
      companionProtocol: COMPANION_PROTOCOL_VERSION,
      appVersion: '0.1.0',
      platform: 'android',
    });
    client.close();
  });

  it('keeps exactly one `waiting-hello` transition when `open` arrives first', () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport, { counter: { value: 0 } });
    const states: string[] = [];
    client.on('state', (state) => states.push(state));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });
    transport.fireOpen();
    transport.deliver(HELLO);

    assert.equal(client.state, 'waiting-client-hello');
    assert.deepEqual(states, ['connecting', 'waiting-hello', 'waiting-client-hello']);
    assert.equal(states.filter((state) => state === 'waiting-hello').length, 1);
    assert.deepEqual(transport.sentFrames().map((frame) => frame.type), ['client-hello']);

    // Idempotent: a second `open` for the same socket changes nothing and is never re-emitted.
    transport.fireOpen();
    assert.equal(states.filter((state) => state === 'waiting-hello').length, 1);
    assert.equal(client.state, 'waiting-client-hello');
    client.close();
  });

  it('ignores frames after a local close or after a reported close', () => {
    // 1. local close before anything arrived
    const first = new LostOpenTransport();
    const closedEarly = lostOpenClient(first);
    const firstStates: string[] = [];
    const errors: CoreError[] = [];
    closedEarly.on('state', (state) => firstStates.push(state));
    closedEarly.on('error', (error) => errors.push(error));
    closedEarly.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });
    closedEarly.close(1000, 'app-close');
    assert.equal(closedEarly.state, 'closed');
    first.deliver(HELLO);
    assert.equal(closedEarly.state, 'closed');
    assert.deepEqual(first.sentFrames(), []);
    assert.deepEqual(errors, []);
    assert.deepEqual(firstStates, ['connecting', 'closed']);

    // 2. local close on an established connection
    const second = new ScriptedTransport();
    const closedLive = scriptedClient(second, { counter: { value: 0 } });
    closedLive.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });
    second.fireOpen();
    closedLive.close(1000, 'app-close');
    const sentBeforeStraggler = second.sent.length;
    second.deliver(HELLO);
    assert.equal(closedLive.state, 'closed');
    assert.equal(second.sent.length, sentBeforeStraggler);
    assert.deepEqual(second.sentFrames().filter((frame) => frame.type === 'client-hello'), []);

    // 3. the transport reported the close itself (dropped socket), then a straggler arrives
    const third = new ScriptedTransport();
    const dropped = scriptedClient(third, { counter: { value: 0 } });
    dropped.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });
    third.fireOpen();
    third.close(1006, 'dropped');
    assert.equal(dropped.state, 'closed');
    third.deliver(HELLO);
    assert.equal(dropped.state, 'closed');
    assert.deepEqual(third.sentFrames().filter((frame) => frame.type === 'client-hello'), []);
  });

  it('still fails closed when hello is the first frame on a pairing socket (no `open`)', () => {
    const transport = new LostOpenTransport();
    const client = lostOpenClient(transport);
    const errors: CoreError[] = [];
    client.on('error', (error) => errors.push(error));

    client.connect({
      url: 'wss://127.0.0.1:1/ws',
      certSha256: PIN,
      pairingCode: PAIRING_CODE,
      ...TARGET,
    });
    transport.deliver(HELLO);

    // §3.3/§5a: the one-time code must not be consumed without a stored token.
    assert.deepEqual(transport.sentFrames().filter((frame) => frame.type === 'client-hello'), []);
    assert.equal(errors.some((error) => /hello arrived before paired/.test(error.message)), true);
    assert.equal(client.pairedToken, null);
    assert.equal(client.state, 'closed');
    assert.deepEqual(transport.closes, [{ code: 1002, reason: 'hello-before-paired' }]);
  });
});

// ---------------------------------------------------------------------------
// M6: explicit close + bounded handshake over the *production* PinnedTransport with a mocked
// `pinned-ws` native module (not only the Node transport). The reviewer found that a local
// close unsubscribed the native listener without emitting anything: the client stayed in
// `ready`, pending requests hung, and a retry loop that closes a still-live client before
// reconnecting waited forever for a drop event. These pin the terminal semantics end to end.
// ---------------------------------------------------------------------------

/** In-memory stand-in for the `pinned-ws` native module (one socket at a time). */
class FakePinnedModule {
  readonly connects: Array<{ id: string; url: string; options: Record<string, unknown> }> = [];
  readonly sends: Array<{ id: string; text: string }> = [];
  readonly closes: Array<{ id: string; code: number; reason: string }> = [];
  connectRejects: Error | null = null;

  private readonly listeners = new Map<PinnedWsEventName, Set<(event: unknown) => void>>();

  get adapter(): PinnedWsAdapter {
    return {
      connect: (id, url, options) => {
        this.connects.push({ id, url, options });
        return this.connectRejects === null ? Promise.resolve() : Promise.reject(this.connectRejects);
      },
      send: (id, text) => {
        this.sends.push({ id, text });
        return Promise.resolve(true);
      },
      close: (id, code, reason) => {
        this.closes.push({ id, code, reason });
        return Promise.resolve();
      },
      addListener: (name, listener) => {
        const set = this.listeners.get(name) ?? new Set<(event: unknown) => void>();
        set.add(listener);
        this.listeners.set(name, set);
        return {
          remove: () => {
            set.delete(listener);
          },
        };
      },
    };
  }

  get lastId(): string {
    const call = this.connects.at(-1);
    if (call === undefined) throw new Error('connect was never called');
    return call.id;
  }

  emit(name: PinnedWsEventName, event: unknown): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
  }

  /** The last frame handed to the native socket, parsed. */
  lastSentFrame(): Record<string, unknown> {
    const sent = this.sends.at(-1);
    if (sent === undefined) throw new Error('no frame was sent');
    return JSON.parse(sent.text) as Record<string, unknown>;
  }
}

let pinnedRequestId = 0;

function pinnedClient(fake: FakePinnedModule, options: { handshakeTimeoutMs?: number } = {}): CompanionClient {
  pinnedRequestId = 0;
  return new CompanionClient({
    transport: { create: () => new PinnedTransport({ module: fake.adapter }) },
    appVersion: TARGET.appVersion,
    platform: TARGET.platform,
    requestTimeoutMs: 1_000,
    pingIntervalMs: 0,
    newRequestId: () => `pin-${++pinnedRequestId}`,
    ...options,
  });
}

/** Bring a `pinnedClient()` to `ready` through fake native events. */
function openPinnedReady(client: CompanionClient, fake: FakePinnedModule): void {
  client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-pinned', ...TARGET });
  const id = fake.lastId;
  fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });
  fake.emit('onMessage', { id, data: JSON.stringify(HELLO) });
  fake.emit('onMessage', {
    id,
    data: JSON.stringify({ kind: 'client-hello', requestId: fake.lastSentFrame().requestId, accepted: true }),
  });
}

describe('CompanionClient close + handshake deadline over the production PinnedTransport (M6)', () => {
  it('close() is terminal: pending requests rejected, one disconnected, no late frames', async () => {
    const fake = new FakePinnedModule();
    const client = pinnedClient(fake, { handshakeTimeoutMs: 40 });
    const states: string[] = [];
    const drops: Array<{ code: number; reason: string; retry: boolean }> = [];
    const errors: string[] = [];
    client.on('state', (state) => states.push(state));
    client.on('disconnected', (payload) => drops.push(payload));
    client.on('error', (error) => errors.push(error.code));

    openPinnedReady(client, fake);
    assert.equal(client.state, 'ready');
    const id = fake.lastId;

    const pending = assert.rejects(client.request('sessions'), (error: unknown) => {
      assert.ok(error instanceof CoreError);
      assert.equal(error.code, 'client/disconnected');
      return true;
    });
    assert.equal(fake.sends.length, 2); // client-hello + sessions

    // The controller's retry path closes a still-live client and depends on this retryable
    // drop to schedule the next attempt; before M6 nothing was emitted and the loop stalled.
    client.close(1000, 'retry');
    assert.equal(client.state, 'closed');
    assert.equal(client.connected, false);
    assert.deepEqual(drops, [{ code: 1000, reason: 'retry', retry: true }]);
    assert.equal(states.filter((state) => state === 'closed').length, 1);
    await pending;

    // The native socket was told to close exactly once.
    assert.deepEqual(fake.closes, [{ id, code: 1000, reason: 'retry' }]);

    // A local close clears the handshake deadline: no timeout fires on a finished connection.
    // A second close (or a late native frame) reports nothing more.
    await new Promise((resolve) => setTimeout(resolve, 120));
    fake.emit('onMessage', { id, data: JSON.stringify({ kind: 'event', sessionId: 's-running', event: { late: true } }) });
    client.close(1000, 'again');
    assert.deepEqual(errors, []);
    assert.equal(client.state, 'closed');
    assert.equal(drops.length, 1);
    assert.equal(fake.closes.length, 1);
  });

  it('a failed native connect ends the client once instead of wedging it in connecting', async () => {
    const fake = new FakePinnedModule();
    fake.connectRejects = new Error('connect(): bad argument');
    const client = pinnedClient(fake);
    const errors: string[] = [];
    const drops: Array<{ code: number; retry: boolean }> = [];
    client.on('error', (error) => errors.push(error.code));
    client.on('disconnected', (payload) => drops.push({ code: payload.code, retry: payload.retry }));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-fail', ...TARGET });
    await waitFor(() => client.state === 'closed', { label: 'failed connect closed' });
    assert.equal(errors.filter((code) => code === 'client/disconnected').length, 1);
    assert.deepEqual(drops, [{ code: 1006, retry: true }]);
    // Nothing ever opened, so there is no native socket to close: the terminal close is
    // synthesized (`fake.closes` stays empty) and the client still reports the end once.
    assert.deepEqual(fake.closes, []);

    // The retry loop starts a *second* attempt from `closed` with a fresh transport: the failed
    // socket must not block it (that was the wedge: state stayed `connecting`, no close event).
    fake.connectRejects = null;
    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-fail', ...TARGET });
    const id = fake.lastId;
    fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });
    fake.emit('onMessage', { id, data: JSON.stringify(HELLO) });
    fake.emit('onMessage', {
      id,
      data: JSON.stringify({ kind: 'client-hello', requestId: fake.lastSentFrame().requestId, accepted: true }),
    });
    assert.equal(client.state, 'ready');
    assert.equal(drops.length, 1); // the first attempt's report was not repeated
    client.close();
  });

  it('bounded handshake: no open within the deadline reports client/timeout and closes', async () => {
    const fake = new FakePinnedModule();
    const client = pinnedClient(fake, { handshakeTimeoutMs: 50 });
    const errors: CoreError[] = [];
    const drops: Array<{ code: number; retry: boolean; reason: string }> = [];
    client.on('error', (error) => errors.push(error));
    client.on('disconnected', (payload) => drops.push(payload));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok', ...TARGET });
    await waitFor(() => client.state === 'closed', { timeoutMs: 2_000, label: 'no-open deadline' });

    const timeout = errors.find((error) => error.code === 'client/timeout');
    assert.ok(timeout !== undefined, 'client/timeout was emitted');
    assert.equal(timeout.retryable, true);
    assert.equal(timeout.details?.stage, 'connecting');
    assert.deepEqual(drops, [{ code: 1006, reason: 'handshake-timeout', retry: true }]);
    // The attempt was aborted on the transport too: one native close, nothing was sent.
    assert.deepEqual(fake.closes, [{ id: fake.lastId, code: 1006, reason: 'handshake-timeout' }]);
    assert.deepEqual(fake.sends, []);
  });

  it('bounded handshake: hello never arrives within the deadline', async () => {
    const fake = new FakePinnedModule();
    const client = pinnedClient(fake, { handshakeTimeoutMs: 60 });
    const errors: CoreError[] = [];
    client.on('error', (error) => errors.push(error));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok', ...TARGET });
    fake.emit('onOpen', { id: fake.lastId, protocol: 'dsh-mobile-v1' });
    assert.equal(client.state, 'waiting-hello');
    await waitFor(() => client.state === 'closed', { timeoutMs: 2_000, label: 'hello deadline' });

    const timeout = errors.find((error) => error.code === 'client/timeout');
    assert.equal(timeout?.details?.stage, 'waiting-hello');
    assert.equal(client.connected, false);
  });

  it('bounded handshake: the host never accepts client-hello within the deadline', async () => {
    const fake = new FakePinnedModule();
    const client = pinnedClient(fake, { handshakeTimeoutMs: 60 });
    const errors: CoreError[] = [];
    client.on('error', (error) => errors.push(error));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok', ...TARGET });
    const id = fake.lastId;
    fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });
    fake.emit('onMessage', { id, data: JSON.stringify(HELLO) });
    assert.equal(client.state, 'waiting-client-hello');
    assert.equal(fake.lastSentFrame().type, 'client-hello');
    await waitFor(() => client.state === 'closed', { timeoutMs: 2_000, label: 'client-hello ack deadline' });

    const timeouts = errors.filter((error) => error.code === 'client/timeout');
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0]?.details?.stage, 'waiting-client-hello');
  });

  it('the deadline is cleared once the host accepts client-hello', async () => {
    const fake = new FakePinnedModule();
    const client = pinnedClient(fake, { handshakeTimeoutMs: 40 });
    const errors: CoreError[] = [];
    client.on('error', (error) => errors.push(error));

    openPinnedReady(client, fake);
    assert.equal(client.state, 'ready');
    await new Promise((resolve) => setTimeout(resolve, 150)); // > 3x the deadline
    assert.equal(client.state, 'ready');
    assert.deepEqual(errors, []);
    client.close();
  });

  it('a terminal transport error (pin refusal) still ends the attempt exactly once', async () => {
    const fake = new FakePinnedModule();
    const client = pinnedClient(fake, { handshakeTimeoutMs: 60 });
    const errors: CoreError[] = [];
    const drops: Array<{ code: number }> = [];
    client.on('error', (error) => errors.push(error));
    client.on('disconnected', (payload) => drops.push({ code: payload.code }));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok', ...TARGET });
    fake.emit('onError', { id: fake.lastId, code: 'client/pin-mismatch', message: 'pin', observedSha256: 'b'.repeat(64) });
    await waitFor(() => client.state === 'closed', { label: 'pin refusal closed' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The pin refusal is terminal on its own (the transport's synthesized close ends the
    // attempt), so the still-armed deadline must not add a second timeout for it.
    assert.equal(errors.filter((error) => error.code === 'client/timeout').length, 0);
    assert.equal(errors.filter((error) => error.code === 'client/pin-mismatch').length, 1);
    assert.deepEqual(drops, [{ code: 1006 }]);
  });

  // Reviewer finding (M6 follow-up): the production transport only synthesizes a close while it
  // is *connecting*. An error that arrives after `open` can therefore be the last event the
  // transport ever reports. The client used to cancel its handshake deadline on any error, which
  // left the attempt waiting forever in `waiting-hello` / `waiting-client-hello` with no
  // retryable drop. These two cases pin the bounded closure end to end.
  it('bounded closure: open -> error-only, the host never sends hello', async () => {
    const fake = new FakePinnedModule();
    const client = pinnedClient(fake, { handshakeTimeoutMs: 60 });
    const errors: CoreError[] = [];
    const drops: Array<{ code: number; reason: string; retry: boolean }> = [];
    client.on('error', (error) => errors.push(error));
    client.on('disconnected', (payload) => drops.push(payload));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok', ...TARGET });
    const id = fake.lastId;
    fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });
    assert.equal(client.state, 'waiting-hello');
    // The native side reports an error after the socket opened and never follows it with onClose.
    fake.emit('onError', { id, code: 'client/connect-failed', message: 'native read failed' });
    assert.equal(client.state, 'waiting-hello');

    await waitFor(() => client.state === 'closed', { timeoutMs: 2_000, label: 'open error-only deadline' });

    const timeouts = errors.filter((error) => error.code === 'client/timeout');
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0]?.details?.stage, 'waiting-hello');
    assert.deepEqual(drops, [{ code: 1006, reason: 'handshake-timeout', retry: true }]);
    // The attempt was closed on the transport too (one native close), and a late native close
    // cannot add a second end.
    assert.deepEqual(fake.closes, [{ id, code: 1006, reason: 'handshake-timeout' }]);
    fake.emit('onClose', { id, code: 1006, reason: '' });
    assert.equal(drops.length, 1);
  });

  it('bounded closure: open -> error-only while waiting for the client-hello ack', async () => {
    const fake = new FakePinnedModule();
    const client = pinnedClient(fake, { handshakeTimeoutMs: 60 });
    const errors: CoreError[] = [];
    const drops: Array<{ code: number; reason: string; retry: boolean }> = [];
    client.on('error', (error) => errors.push(error));
    client.on('disconnected', (payload) => drops.push(payload));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok', ...TARGET });
    const id = fake.lastId;
    fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });
    fake.emit('onMessage', { id, data: JSON.stringify(HELLO) });
    assert.equal(client.state, 'waiting-client-hello');
    assert.equal(fake.lastSentFrame().type, 'client-hello');
    fake.emit('onError', { id, code: 'client/connect-failed', message: 'native read failed' });
    assert.equal(client.state, 'waiting-client-hello');

    await waitFor(() => client.state === 'closed', { timeoutMs: 2_000, label: 'ack error-only deadline' });

    const timeouts = errors.filter((error) => error.code === 'client/timeout');
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0]?.details?.stage, 'waiting-client-hello');
    assert.deepEqual(drops, [{ code: 1006, reason: 'handshake-timeout', retry: true }]);
    assert.deepEqual(fake.closes, [{ id, code: 1006, reason: 'handshake-timeout' }]);
  });

  it('a transport error that never recovered in a finished handshake cannot kill a ready connection', async () => {
    const fake = new FakePinnedModule();
    const client = pinnedClient(fake, { handshakeTimeoutMs: 40 });
    openPinnedReady(client, fake);
    assert.equal(client.state, 'ready');

    // A spurious post-open error on a *live* connection is reported but not terminal: the
    // deadline was already cleared by `ready`, so it must not fire later and drop the socket.
    fake.emit('onError', { id: fake.lastId, code: 'client/connect-failed', message: 'transient' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(client.state, 'ready');
    assert.deepEqual(fake.closes, []);
    client.close();
  });

  it('keeps terminal protocol states when close() follows a revoke or a mismatch', () => {
    const fake = new FakePinnedModule();
    const client = pinnedClient(fake);
    openPinnedReady(client, fake);
    fake.emit('onMessage', {
      id: fake.lastId,
      data: JSON.stringify({ kind: 'error', code: 'auth/revoked', message: 'revoked' }),
    });
    assert.equal(client.state, 'revoked');
    client.close(1000, 'teardown');
    assert.equal(client.state, 'revoked');
    assert.equal(client.connected, false);

    const transport = new ScriptedTransport();
    const updated = scriptedClient(transport, { counter: { value: 0 } });
    updated.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });
    transport.fireOpen();
    transport.deliver({ ...HELLO, companionProtocol: 2, minClientVersion: 2 });
    assert.equal(updated.state, 'update-required');
    updated.close(1000, 'teardown');
    assert.equal(updated.state, 'update-required');
  });

  it('ignores frames delivered after a local close (no pushes from a dead socket)', () => {
    const transport = new ScriptedTransport();
    const client = scriptedClient(transport, { counter: { value: 0 } });
    const pushes: unknown[] = [];
    client.on('approvalRequested', (frame) => pushes.push(frame));

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });
    transport.fireOpen();
    transport.deliver(HELLO);
    transport.deliver({ kind: 'client-hello', requestId: transport.lastRequestId('client-hello'), accepted: true });
    assert.equal(client.state, 'ready');

    client.close(1000, 'app-close');
    // ScriptedTransport keeps accepting `deliver()` after close: the client must drop it.
    transport.deliver({
      kind: 'approval-requested',
      approvalId: 'ap-late',
      rpcId: 'rpc-late',
      sessionId: 's-running',
      toolName: 'bash',
      argsHash: 'a'.repeat(64),
    });
    assert.deepEqual(pushes, []);
    assert.equal(client.state, 'closed');
  });

  it('defaults the handshake deadline to 10 s', () => {
    assert.equal(DEFAULT_HANDSHAKE_TIMEOUT_MS, 10_000);
  });
});
