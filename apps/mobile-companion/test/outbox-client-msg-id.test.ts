// Portable `clientMsgId` generation for the outbox (the second device regression, after the
// handshake one pinned in client-request-id.test.ts).
//
// React Native 0.88 exposes no Web Crypto, so `globalThis.crypto.randomUUID` is undefined on a
// device while Node (the test runtime) always has it. Once the handshake was fixed,
// `defaultClientMsgId()` still threw `client/bad-state` on the first prompt. A `clientMsgId` is
// not just an id: it is the host's at-most-once dedup key (contract §4), so a collision re-sends
// a cached `sent` and the user's prompt never runs. These cases pin the three-step degrade, the
// uniqueness of the fallback, retry stability (the id lives on the item) and the typed-error
// path for a broken injected source. `globalThis.crypto` is stubbed per case and restored in
// `afterEach` because a stubbed global must not leak into another test.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { CompanionClient } from '../src/core/client';
import { CoreError } from '../src/core/errors';
import { Outbox, defaultClientMsgId, type OutboxFrame } from '../src/core/outbox';
import { FakeGateway } from './support/fake-gateway';
import { createNodePinnedTransportFactory } from './support/node-pinned-transport';
import { deferred, waitFor } from './support/wait';

const TARGET = { installId: '6b1c2f4e-8a9d-4c3b-b2a1-0f9e8d7c6b5a', appVersion: '0.1.0', platform: 'ios' as const };

/** RFC 4122 v4: version nibble 4, variant 10xx. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Gateway rule (`plugins/mobile-gateway/lib/index.mjs:4447-4452`): trimmed, 1..128 chars. */
function assertAcceptableIds(id: string): void {
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0, 'the id is not empty');
  assert.ok(id.length <= 128, 'the id fits the gateway limit');
  assert.equal(id, id.trim(), 'the host trims, so edge whitespace would desync the dedup key');
}

/** The device shapes: no Web Crypto at all, a `getRandomValues`-only polyfill, a broken one. */
interface CryptoStub {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const realRandom = Math.random;

function stubCrypto(value: CryptoStub | null | undefined): void {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
}

afterEach(() => {
  // Never leak a stub: the real generator is exercised again by the next case and by other files.
  Math.random = realRandom;
  if (realCrypto === undefined) {
    delete (globalThis as { crypto?: CryptoStub }).crypto;
    return;
  }
  Object.defineProperty(globalThis, 'crypto', realCrypto);
});

/** A `getRandomValues` polyfill whose bytes change per call, like a real random source. */
function varyingRandomBytes(): (array: Uint8Array) => Uint8Array {
  let draw = 0;
  return (array) => {
    draw += 1;
    for (let index = 0; index < array.length; index += 1) array[index] = (index * 17 + draw * 31) & 0xff;
    return array;
  };
}

describe('defaultClientMsgId (portable dedup ids)', () => {
  it('uses crypto.randomUUID unchanged when the engine has it (Node, web)', () => {
    stubCrypto({ randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' });
    assert.equal(defaultClientMsgId(), '123e4567-e89b-42d3-a456-426614174000');
    // The outbox takes that same value: existing behaviour is untouched.
    const outbox = new Outbox({ send: async () => undefined });
    assert.equal(outbox.enqueuePrompt('s1', 'hi').clientMsgId, '123e4567-e89b-42d3-a456-426614174000');
  });

  it('builds a v4 UUID from getRandomValues when randomUUID is missing (device shape)', () => {
    stubCrypto({ getRandomValues: varyingRandomBytes() });
    const first = defaultClientMsgId();
    const second = defaultClientMsgId();
    assert.match(first, UUID_V4_RE);
    assert.match(second, UUID_V4_RE);
    assert.notEqual(first, second);
    assertAcceptableIds(first);
  });

  it('falls back to timestamp + counter + random ids when there is no crypto at all', () => {
    stubCrypto(undefined);
    const first = defaultClientMsgId();
    const second = defaultClientMsgId();
    assertAcceptableIds(first);
    assertAcceptableIds(second);
    assert.notEqual(first, second);
    assert.notEqual(first, defaultClientMsgId());
    // The fallback shape (timestamp.tag.sequence[.random]): a device with no crypto is here, not
    // on a UUID branch. A UUID is the same 36 chars, so the separator is what tells them apart.
    assert.match(first, /^[0-9a-z]+\.[0-9a-z]+\.[0-9a-z]+/);

    // A partial polyfill (`crypto: {}`) behaves like no crypto, and the fallback stays unique:
    // the per-process counter alone already rules out a repeat inside this process.
    stubCrypto({});
    const ids = new Set(Array.from({ length: 50 }, () => defaultClientMsgId()));
    assert.equal(ids.size, 50);
    for (const id of ids) assertAcceptableIds(id);
  });

  it('keeps fallback ids distinct even when Math.random is broken', () => {
    stubCrypto(undefined);
    Math.random = () => {
      throw new Error('Math.random exploded');
    };
    const first = defaultClientMsgId();
    const second = defaultClientMsgId();
    assertAcceptableIds(first);
    assertAcceptableIds(second);
    assert.notEqual(first, second, 'the monotonic counter never repeats within a process');
  });

  it('never throws when globalThis.crypto is missing, null, partial or a throwing getter', () => {
    stubCrypto(undefined);
    assert.doesNotThrow(() => defaultClientMsgId());
    assertAcceptableIds(defaultClientMsgId());

    stubCrypto(null);
    assert.doesNotThrow(() => defaultClientMsgId());
    assertAcceptableIds(defaultClientMsgId());

    stubCrypto({});
    assert.doesNotThrow(() => defaultClientMsgId());
    assertAcceptableIds(defaultClientMsgId());

    // A polyfill whose methods throw is treated as no polyfill at all.
    stubCrypto({
      randomUUID: () => {
        throw new Error('randomUUID exploded');
      },
      getRandomValues: () => {
        throw new Error('getRandomValues exploded');
      },
    });
    assert.doesNotThrow(() => defaultClientMsgId());
    assertAcceptableIds(defaultClientMsgId());

    // A value the gateway would refuse is not passed through.
    stubCrypto({ randomUUID: () => 'padded id'.padStart(140) });
    assert.doesNotThrow(() => defaultClientMsgId());
    assertAcceptableIds(defaultClientMsgId());

    // A `crypto` getter that throws is handled like a missing one.
    Object.defineProperty(globalThis, 'crypto', {
      get: () => {
        throw new Error('crypto getter exploded');
      },
      configurable: true,
    });
    assert.doesNotThrow(() => defaultClientMsgId());
    assertAcceptableIds(defaultClientMsgId());
  });
});

describe('Outbox keeps a stable id per entry', () => {
  it('reuses the stored id on a retry and never asks the generator again', async () => {
    let generated = 0;
    let attempt = 0;
    const frames: OutboxFrame[] = [];
    const outbox = new Outbox({
      send: async (frame) => {
        attempt += 1;
        frames.push(frame);
        if (attempt === 1) throw new CoreError({ code: 'client/disconnected', message: 'socket gone' });
      },
      newClientMsgId: () => {
        generated += 1;
        return `id-${generated}`;
      },
    });
    const item = outbox.enqueuePrompt('s1', 'one');
    await outbox.drain();
    assert.equal(outbox.get(item.clientMsgId)?.status, 'queued');
    outbox.onDisconnected();
    await outbox.drain();

    assert.equal(generated, 1, 'the retry reused the id instead of generating a new one');
    assert.equal(outbox.get(item.clientMsgId)?.status, 'acked');
    assert.equal(outbox.clientMsgIds[0], item.clientMsgId);
    assert.equal(frames[0]?.params.clientMsgId, item.clientMsgId);
    assert.equal(frames[1]?.params.clientMsgId, item.clientMsgId);
    assert.equal(outbox.get(item.clientMsgId)?.attempts, 2);
  });

  it('reports a throwing injected id source as a typed CoreError, not a raw throw', () => {
    const outbox = new Outbox({
      send: async () => undefined,
      newClientMsgId: () => {
        throw new Error('id source exploded');
      },
    });
    assert.throws(
      () => outbox.enqueuePrompt('s1', 'hi'),
      (error: unknown) => error instanceof CoreError
        && error.code === 'client/bad-state'
        && error.details?.stage === 'enqueue'
        && (error.cause as Error | undefined)?.message === 'id source exploded',
    );
    assert.throws(() => outbox.enqueueCancel('s1'), CoreError);
    assert.deepEqual(outbox.list(), [], 'nothing was queued without an id');
  });

  it('refuses ids the gateway would reject (empty, over-long, edge whitespace)', () => {
    for (const id of ['', '   ', 'x'.repeat(129), ' padded', 'padded ']) {
      const outbox = new Outbox({ send: async () => undefined, newClientMsgId: () => id });
      assert.throws(
        () => outbox.enqueuePrompt('s1', 'hi'),
        (error: unknown) => error instanceof CoreError && error.code === 'client/bad-state',
        `rejects ${JSON.stringify(id)}`,
      );
      assert.deepEqual(outbox.list(), []);
    }
    // The longest id the gateway accepts is accepted here too.
    const longest = 'x'.repeat(128);
    const outbox = new Outbox({ send: async () => undefined, newClientMsgId: () => longest });
    assert.equal(outbox.enqueuePrompt('s1', 'hi').clientMsgId, longest);
  });
});

describe('Outbox against the fake gateway without Web Crypto', () => {
  it('sends a fallback-id prompt that the gateway accepts and applies only once on retry', async () => {
    // The gateway (TLS + a self-signed leaf) is built first, then the device shape is stubbed in:
    // no Web Crypto at all, exactly like React Native 0.88.
    const gateway = await FakeGateway.create({ tokens: ['tok-msgid'] });
    try {
      const transports = createNodePinnedTransportFactory();
      let requestCounter = 0;
      const client = new CompanionClient({
        transport: transports,
        appVersion: TARGET.appVersion,
        platform: TARGET.platform,
        requestTimeoutMs: 2_000,
        newRequestId: () => `r-${++requestCounter}`,
      });
      const ready = deferred<void>();
      client.on('ready', () => ready.resolve());
      client.connect({ url: gateway.endpoint, certSha256: gateway.certSha256, token: 'tok-msgid', ...TARGET });
      await ready.promise;

      const frames: OutboxFrame[] = [];
      let applied = false;
      // Device shape from here on: the handshake used an injected requestId, and the prompt must
      // be id'd by the portable default generator (fallback branch), never by Web Crypto.
      stubCrypto(undefined);
      const outbox = new Outbox({
        send: async (frame) => {
          frames.push(frame);
          await client.request(frame.op, frame.params);
          if (!applied) {
            applied = true;
            // The frame reached the host, then the link died before the receipt was usable.
            throw new CoreError({ code: 'client/disconnected', message: 'socket dropped after sent', retryable: true });
          }
        },
      });
      const item = outbox.enqueuePrompt('s-running', 'add tests');
      assertAcceptableIds(item.clientMsgId);
      assert.ok(item.clientMsgId.includes('.'), 'the device took the fallback branch, not a UUID branch');

      await outbox.drain();
      assert.equal(outbox.get(item.clientMsgId)?.status, 'queued');
      await waitFor(() => gateway.promptApplications.length === 1, { label: 'first application' });

      await outbox.drain();
      assert.equal(outbox.get(item.clientMsgId)?.status, 'acked');
      assert.equal(frames.length, 2);
      assert.equal(frames[0]?.params.clientMsgId, item.clientMsgId);
      assert.equal(frames[1]?.params.clientMsgId, item.clientMsgId);
      assert.equal(gateway.promptApplications.length, 1, 'the gateway deduped the retry by clientMsgId');
      assert.equal(gateway.promptApplications[0]?.clientMsgId, item.clientMsgId);
      client.close();
    } finally {
      await gateway.close();
    }
  });
});
