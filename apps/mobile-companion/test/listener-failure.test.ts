// Listener-boundary failures: `native` (pinned-ws wrapper), `transport` (TransportEmitter) and
// `client` (CompanionClient.emit).
//
// The rule the device builds broke: isolation stays — one throwing listener must never break the
// socket loop or skip the other listeners — but the throw must not be invisible either. Each
// boundary reports a fixed boundary name and a fixed stage string to an injected reporter, and
// nothing else (no exception message, payload, frame or stack). At the protocol-processing
// boundary (a client frame) the attempt is finished too: a half-applied frame must not leave the
// client pretending to be healthy, and a programming error must not spin a reconnect loop.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CompanionClient,
  TransportEmitter,
  type ListenerFailureInfo,
  type TransportEvent,
} from '../src/core';
import {
  addPinnedWsListener,
  type PinnedWsAdapter,
  type PinnedWsEventName,
  type PinnedWsListenerFailure,
} from '../modules/pinned-ws';
import { ScriptedTransport } from './support/scripted-transport';

const PIN = 'a'.repeat(64);
const TARGET = {
  installId: '11111111-2222-4333-8444-555555555555',
  deviceName: 'Pixel test',
} as const;

/** In-memory `pinned-ws` native module: records listeners and lets the test emit an event. */
class FakePinnedWsModule {
  private readonly listeners = new Map<PinnedWsEventName, Set<(event: unknown) => void>>();

  get adapter(): PinnedWsAdapter {
    return {
      connect: async () => {
        /* nothing to do: the test drives the events */
      },
      send: async () => true,
      close: async () => {
        /* no socket */
      },
      addListener: (name: PinnedWsEventName, listener: (event: unknown) => void) => {
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

  emit(name: PinnedWsEventName, event: unknown): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
  }
}

function makeClient(
  transport: ScriptedTransport,
  onListenerFailure: (info: ListenerFailureInfo) => void,
): CompanionClient {
  return new CompanionClient({
    transport,
    appVersion: '0.1.0',
    platform: 'android',
    pingIntervalMs: 0,
    newRequestId: () => 'req-1',
    onListenerFailure,
  });
}

function connectOpen(client: CompanionClient, transport: ScriptedTransport): void {
  client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });
  transport.fireOpen();
}

describe('native boundary (addPinnedWsListener)', () => {
  it('reports the fixed event name, keeps the other listeners running and leaks nothing', () => {
    const module = new FakePinnedWsModule();
    const reports: PinnedWsListenerFailure[] = [];
    const seen: string[] = [];
    const throwingSecret = 'tok-secret-pairing-code';
    const frameSecret = '{"kind":"event","text":"secret payload"}';

    // Two independent subscriptions, like two consumers of one native event.
    addPinnedWsListener(
      module.adapter,
      {
        onMessage: () => {
          throw new Error(`boom ${throwingSecret}`);
        },
      },
      (info) => reports.push(info),
    );
    addPinnedWsListener(module.adapter, {
      onMessage: (event) => seen.push(String((event as { data?: string }).data)),
    });

    module.emit('onMessage', { id: 'pw-1', data: frameSecret });

    // Isolation: the second subscription still received the frame.
    assert.deepEqual(seen, [frameSecret]);
    // Observability: exactly the fixed boundary + stage.
    assert.deepEqual(reports, [{ boundary: 'native', stage: 'onMessage' }]);
    const serialised = JSON.stringify(reports);
    assert.equal(serialised.includes(throwingSecret), false);
    assert.equal(serialised.includes(frameSecret), false);
    assert.equal(serialised.includes('boom'), false);
  });

  it('does not close anything: every hook family keeps its own subscription', () => {
    const module = new FakePinnedWsModule();
    const reports: PinnedWsListenerFailure[] = [];
    const opens: string[] = [];
    addPinnedWsListener(
      module.adapter,
      {
        onMessage: () => {
          throw new Error('consumer bug');
        },
        onOpen: (event) => opens.push(String(event.protocol)),
      },
      (info) => reports.push(info),
    );

    module.emit('onOpen', { id: 'pw-1', protocol: 'dsh-mobile-v1' });
    module.emit('onMessage', { id: 'pw-1', data: '{}' });

    assert.deepEqual(opens, ['dsh-mobile-v1']);
    assert.deepEqual(reports, [{ boundary: 'native', stage: 'onMessage' }]);
  });
});

describe('transport boundary (TransportEmitter)', () => {
  it('reports the fixed event kind, keeps delivering and leaks no payload', () => {
    const reports: ListenerFailureInfo[] = [];
    const emitter = new TransportEmitter((info) => reports.push(info));
    const delivered: TransportEvent[] = [];
    const secret = 'frame-with-a-token tok-auth';

    emitter.on(() => {
      throw new Error(`listener exploded: ${secret}`);
    });
    emitter.on((event) => delivered.push(event));

    emitter.emit({ type: 'message', data: secret });

    assert.equal(delivered.length, 1);
    assert.deepEqual(reports, [{ boundary: 'transport', stage: 'message' }]);
    const serialised = JSON.stringify(reports);
    assert.equal(serialised.includes(secret), false);
    assert.equal(serialised.includes('exploded'), false);
  });

  it('does not report a failure from a listener that never throws', () => {
    const reports: ListenerFailureInfo[] = [];
    const emitter = new TransportEmitter((info) => reports.push(info));
    emitter.on(() => undefined);
    emitter.emit({ type: 'open' });
    assert.deepEqual(reports, []);
  });

  it('survives a reporter that throws (diagnostics must never alter a socket)', () => {
    const emitter = new TransportEmitter(() => {
      throw new Error('reporter bug');
    });
    const delivered: TransportEvent[] = [];
    emitter.on(() => {
      throw new Error('listener bug');
    });
    emitter.on((event) => delivered.push(event));
    emitter.emit({ type: 'open' });
    assert.equal(delivered.length, 1);
  });
});

describe('client boundary (CompanionClient.emit)', () => {
  it('reports the frame stage, ends the attempt and still runs the other handlers', () => {
    const transport = new ScriptedTransport();
    const reports: ListenerFailureInfo[] = [];
    const disconnected: Array<{ code: number; reason: string; retry: boolean }> = [];
    const handled: string[] = [];
    const secret = 'tok-auth-should-never-be-reported';
    const client = makeClient(transport, (info) => reports.push(info));

    client.on('event', () => {
      throw new Error(`handler failed for ${secret}`);
    });
    client.on('event', (frame) => handled.push(String(frame.kind)));
    client.on('disconnected', (payload) => disconnected.push(payload));

    connectOpen(client, transport);
    transport.deliver({ kind: 'event', sessionId: 's-1', event: { message: { text: secret } } });

    // (a) the other listener ran, (b) the fixed boundary + stage, (c) nothing secret.
    assert.deepEqual(handled, ['event']);
    assert.deepEqual(reports, [{ boundary: 'client', stage: 'frame:event' }]);
    const serialised = JSON.stringify(reports);
    assert.equal(serialised.includes(secret), false);
    assert.equal(serialised.includes('handler failed'), false);

    // (d) the attempt terminated instead of continuing: one terminal report, no retry, and a
    // later frame is dropped.
    assert.deepEqual(disconnected, [{ code: 1011, reason: 'listener-failure', retry: false }]);
    assert.equal(client.state, 'closed');
    transport.deliver({ kind: 'event', sessionId: 's-1', event: { message: { text: 'later' } } });
    assert.deepEqual(handled, ['event']);
    assert.deepEqual(reports, [{ boundary: 'client', stage: 'frame:event' }]);
  });

  it('reports but does NOT end the attempt when the throw is outside frame processing', () => {
    const transport = new ScriptedTransport();
    const reports: ListenerFailureInfo[] = [];
    const states: string[] = [];
    const client = makeClient(transport, (info) => reports.push(info));

    // `connect()` emits `state` on a live socket; a throwing `state` handler is reported there
    // but must not manufacture a disconnect (only frame handling treats a throw as fatal).
    client.on('state', (state) => {
      states.push(state);
      throw new Error('screen bug');
    });

    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, token: 'tok-auth', ...TARGET });

    assert.deepEqual(states, ['connecting']);
    assert.deepEqual(reports, [{ boundary: 'client', stage: 'state' }]);
    assert.equal(client.state, 'connecting');
    assert.equal(transport.sentBeforeOpen.length, 0);
  });
});
