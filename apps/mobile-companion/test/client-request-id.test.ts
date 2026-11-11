// Portable `requestId` generation + a reported handshake failure (device regression).
//
// React Native 0.88 exposes no Web Crypto, so `globalThis.crypto.randomUUID` is undefined on a
// device while Node (the test runtime) always has it. `defaultRequestId()` used to throw there;
// `sendClientHello()` threw before a frame was written, the exception unwound into the native
// listener (which swallows it by design), and the client sat in `waiting-client-hello` until the
// 10 s handshake deadline with nothing reported. These cases pin the three-step degrade and the
// "report, never wedge" rule. `globalThis.crypto` is stubbed per case and restored in `afterEach`,
// because a stubbed global must not leak into another test.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { COMPANION_PROTOCOL_VERSION } from '@dsh-ext/mobile-protocol';

import { CompanionClient, defaultRequestId } from '../src/core/client';
import type { CoreError } from '../src/core/errors';
import { ScriptedTransport } from './support/scripted-transport';
import { waitFor } from './support/wait';

const PIN = 'a'.repeat(64);
const INSTALL_ID = '3f2a1c9e-0b7d-4f6a-9c1e-8d5b2a7f4c63';
const TARGET = { installId: INSTALL_ID, deviceName: 'Pixel test', appVersion: '0.1.0', platform: 'android' as const };

/** Contract §1: 1..64 chars of `[A-Za-z0-9._-]`. Every branch of the generator must satisfy it. */
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** RFC 4122 v4: version nibble 4, variant 10xx. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

/** The device shapes: no Web Crypto at all, a `getRandomValues`-only polyfill, a broken one. */
interface CryptoStub {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function stubCrypto(value: CryptoStub | null | undefined): void {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
}

afterEach(() => {
  // Never leak a stub: the real generator is exercised again by the next case and by other files.
  if (realCrypto === undefined) {
    delete (globalThis as { crypto?: CryptoStub }).crypto;
    return;
  }
  Object.defineProperty(globalThis, 'crypto', realCrypto);
});

/** A deterministic `getRandomValues` (fills the buffer, so the id is repeatable per call site). */
function fakeRandomBytes(seed: number): (array: Uint8Array) => Uint8Array {
  return (array) => {
    for (let index = 0; index < array.length; index += 1) array[index] = (index * 17 + seed) & 0xff;
    return array;
  };
}

interface Harness {
  client: CompanionClient;
  transport: ScriptedTransport;
  errors: CoreError[];
  drops: Array<{ code: number; reason: string; retry: boolean }>;
  states: string[];
}

function harness(options: { newRequestId?: () => string; pingIntervalMs?: number } = {}): Harness {
  const transport = new ScriptedTransport();
  const client = new CompanionClient({
    transport,
    appVersion: TARGET.appVersion,
    platform: TARGET.platform,
    requestTimeoutMs: 1_000,
    pingIntervalMs: options.pingIntervalMs ?? 0,
    // `undefined` keeps the client's own default generator (the case under test).
    newRequestId: options.newRequestId,
  });
  const errors: CoreError[] = [];
  const drops: Array<{ code: number; reason: string; retry: boolean }> = [];
  const states: string[] = [];
  client.on('error', (error) => errors.push(error));
  client.on('disconnected', (payload) => drops.push(payload));
  client.on('state', (state) => states.push(state));
  return { client, transport, errors, drops, states };
}

/** open -> server `hello`; the client answers with `client-hello` (or reports why it cannot). */
function startHandshake(h: Harness): void {
  h.client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });
  h.transport.fireOpen();
  h.transport.deliver(HELLO);
}

describe('defaultRequestId (portable request ids)', () => {
  it('uses crypto.randomUUID when the engine has it (Node, web)', () => {
    stubCrypto({ randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' });
    assert.equal(defaultRequestId(), '123e4567-e89b-42d3-a456-426614174000');
  });

  it('builds an RFC 4122 v4 UUID from getRandomValues when randomUUID is missing (device shape)', () => {
    stubCrypto({ getRandomValues: fakeRandomBytes(3) });
    const id = defaultRequestId();
    assert.match(id, UUID_V4_RE);
    assert.match(id, REQUEST_ID_RE);
    // A different seed -> a different id from the same branch (version/variant bits are forced).
    stubCrypto({ getRandomValues: fakeRandomBytes(11) });
    assert.notEqual(defaultRequestId(), id);
    assert.match(defaultRequestId(), UUID_V4_RE);
  });

  it('falls back to a counter-based id when the platform has no crypto at all', () => {
    stubCrypto(undefined);
    const first = defaultRequestId();
    const second = defaultRequestId();
    assert.match(first, REQUEST_ID_RE);
    assert.match(second, REQUEST_ID_RE);
    assert.notEqual(first, second);

    // A partial polyfill (`crypto: {}`) behaves like no crypto.
    stubCrypto({});
    assert.match(defaultRequestId(), REQUEST_ID_RE);
  });

  it('never throws, whatever the crypto surface does', () => {
    stubCrypto({
      randomUUID: () => {
        throw new Error('randomUUID exploded');
      },
      getRandomValues: () => {
        throw new Error('getRandomValues exploded');
      },
    });
    assert.doesNotThrow(() => defaultRequestId());
    assert.match(defaultRequestId(), REQUEST_ID_RE);

    // A polyfill that returns something outside the contract is not passed through.
    stubCrypto({ randomUUID: () => 'not a valid request id' });
    assert.doesNotThrow(() => defaultRequestId());
    assert.match(defaultRequestId(), REQUEST_ID_RE);

    // A `null` crypto, and a `crypto` getter that throws, are handled like no crypto.
    stubCrypto(null);
    assert.doesNotThrow(() => defaultRequestId());
    assert.match(defaultRequestId(), REQUEST_ID_RE);
    Object.defineProperty(globalThis, 'crypto', {
      get: () => {
        throw new Error('crypto getter exploded');
      },
      configurable: true,
    });
    assert.doesNotThrow(() => defaultRequestId());
    assert.match(defaultRequestId(), REQUEST_ID_RE);
  });

  it('produces unique ids with the real generator (Node Web Crypto)', () => {
    const ids = new Set([defaultRequestId(), defaultRequestId(), defaultRequestId()]);
    assert.equal(ids.size, 3);
    for (const id of ids) assert.match(id, UUID_V4_RE);
  });
});

describe('CompanionClient handshake without Web Crypto (device regression)', () => {
  it('uses the real generator end to end when the platform has crypto (existing behaviour)', () => {
    const h = harness();
    startHandshake(h);
    assert.match(h.transport.lastRequestId('client-hello'), UUID_V4_RE);
    assert.deepEqual(h.errors, []);
    h.client.close();
  });

  it('reaches ready with a valid client-hello requestId when only getRandomValues exists', () => {
    stubCrypto({ getRandomValues: fakeRandomBytes(7) });
    const h = harness();
    startHandshake(h);

    const requestId = h.transport.lastRequestId('client-hello');
    assert.match(requestId, REQUEST_ID_RE);
    h.transport.deliver({ kind: 'client-hello', requestId, accepted: true });

    assert.equal(h.client.state, 'ready');
    assert.deepEqual(h.errors, []);
    h.client.close();
  });

  it('reaches ready with the counter fallback when there is no crypto at all', () => {
    stubCrypto(undefined);
    const h = harness();
    startHandshake(h);

    const requestId = h.transport.lastRequestId('client-hello');
    assert.match(requestId, REQUEST_ID_RE);
    h.transport.deliver({ kind: 'client-hello', requestId, accepted: true });

    assert.equal(h.client.state, 'ready');
    assert.deepEqual(h.errors, []);
    h.client.close();
  });

  it('reports a throwing id source instead of staying in waiting-client-hello', () => {
    stubCrypto(undefined);
    const h = harness({
      newRequestId: () => {
        throw new Error('id source exploded');
      },
    });

    h.client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });
    h.transport.fireOpen();
    // The exception must not escape into the transport listener (the device swallowed it there).
    assert.doesNotThrow(() => h.transport.deliver(HELLO));

    assert.equal(h.client.state, 'closed');
    assert.deepEqual(h.states, ['connecting', 'waiting-hello', 'waiting-client-hello', 'closed']);
    // Nothing was written, and the failure is reported rather than waited out.
    assert.deepEqual(h.transport.sentFrames(), []);
    const reported = h.errors.find((error) => error.code === 'client/bad-state');
    assert.ok(reported !== undefined, 'an error event was emitted');
    assert.equal(reported.details?.stage, 'client-hello');
    assert.match(reported.message, /client-hello/);
    // Terminal, and not retried: the same id source fails identically on every attempt.
    assert.deepEqual(h.drops, [{ code: 1006, reason: 'client-hello-failed', retry: false }]);
  });

  it('reports an unusable id from an injected source the same way (nothing is sent)', () => {
    const h = harness({ newRequestId: () => 'not a valid request id' });
    startHandshake(h);

    assert.equal(h.client.state, 'closed');
    assert.deepEqual(h.transport.sentFrames(), []);
    assert.equal(h.errors[0]?.code, 'client/bad-state');
    assert.equal(h.drops.length, 1);
  });

  it('reports a throwing id source on a ping without killing a ready connection', async () => {
    stubCrypto(undefined);
    let calls = 0;
    const h = harness({
      pingIntervalMs: 20,
      newRequestId: () => {
        calls += 1;
        if (calls > 1) throw new Error('id source exploded');
        return 'id-1';
      },
    });
    startHandshake(h);
    h.transport.deliver({ kind: 'client-hello', requestId: 'id-1', accepted: true });
    assert.equal(h.client.state, 'ready');

    // A throw inside a timer callback would be an uncaught exception (a red box on device).
    await waitFor(() => h.errors.some((error) => error.details?.stage === 'ping'), { label: 'ping error', timeoutMs: 2_000 });
    assert.equal(h.client.state, 'ready');
    assert.deepEqual(h.drops, []);
    h.client.close();
  });
});
