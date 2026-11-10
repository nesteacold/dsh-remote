// A030 — `src/platform/pinned-transport.ts` over a MOCKED `pinned-ws` native module.
//
// The native code (Kotlin/Swift) cannot be built on this machine, so these tests pin the JS half
// of the contract: how native events are routed per socket id, how error codes are mapped, and
// that nothing can be sent before `open` — in particular that `open` is never invented, since
// the core treats `open` as proof that the TLS leaf pin matched (contract §3.1).
//
// M6 close semantics: ending a socket is terminal and reported exactly once. A local `close()`,
// a failed `connect()` (rejection or throw) and a pre-open native error each emit one `close`,
// and every native event that arrives afterwards is filtered.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PinnedTransport, defaultUpgradeMapping, socketRef, upgradeStatusError } from '../src/platform/pinned-transport';
import { resetPinnedWsCache } from '../modules/pinned-ws/src/PinnedWsModule';
import {
  PINNED_WS_ERROR,
  PINNED_WS_EVENT_NAMES,
  getPinnedWsModule,
  isPinnedWsAvailable,
  type PinnedWsAdapter,
  type PinnedWsEventName,
} from '../modules/pinned-ws';
import { setOptionalModule, resetOptionalModules } from './support/stubs/expo-modules-core.stub';
import type { TransportEvent } from '../src/core/transport';
import { waitFor } from './support/wait';

const MODULE_NAME = 'PinnedWs';
const PIN = 'a'.repeat(64);

interface ConnectCall {
  id: string;
  url: string;
  options: Record<string, unknown>;
}

/** In-memory stand-in for the native module: records calls, lets the test emit events. */
class FakePinnedWs {
  readonly connects: ConnectCall[] = [];
  readonly sends: Array<{ id: string; text: string }> = [];
  readonly closes: Array<{ id: string; code: number; reason: string }> = [];
  /** Set to make `connect` reject like the native bridge does for bad argument types. */
  connectRejects: Error | null = null;
  /** Set to make `connect` throw synchronously (the bridge is missing/broken). */
  connectThrows: Error | null = null;
  /** Set to make `send` resolve false (native refused the frame). */
  refuseSends = false;

  private readonly listeners = new Map<PinnedWsEventName, Set<(event: unknown) => void>>();

  /** The object shape `src/platform/pinned-transport.ts` consumes. */
  get adapter(): PinnedWsAdapter {
    return {
      connect: (id: string, url: string, options: Record<string, unknown>) => {
        this.connects.push({ id, url, options });
        if (this.connectThrows !== null) throw this.connectThrows;
        if (this.connectRejects !== null) return Promise.reject(this.connectRejects);
        return Promise.resolve();
      },
      send: async (id: string, text: string) => {
        if (this.refuseSends) return false;
        this.sends.push({ id, text });
        return true;
      },
      close: async (id: string, code: number, reason: string) => {
        this.closes.push({ id, code, reason });
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

  listenerCount(name: PinnedWsEventName): number {
    return this.listeners.get(name)?.size ?? 0;
  }

  emit(name: PinnedWsEventName, event: unknown): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
  }

  /** The id the transport handed to the last `connect`. */
  get lastId(): string {
    const call = this.connects.at(-1);
    assert.ok(call, 'connect was never called');
    return call.id;
  }
}

function collect(transport: PinnedTransport): TransportEvent[] {
  const events: TransportEvent[] = [];
  transport.on((event) => events.push(event));
  return events;
}

function newTransport(fake: FakePinnedWs): PinnedTransport {
  return new PinnedTransport({ module: fake.adapter });
}

describe('pinned-ws module surface', () => {
  it('declares exactly the four event names the transport subscribes to', () => {
    assert.deepEqual([...PINNED_WS_EVENT_NAMES], ['onOpen', 'onMessage', 'onClose', 'onError']);
  });

  it('uses the client/* error codes the core maps', () => {
    assert.deepEqual({ ...PINNED_WS_ERROR }, {
      pinMismatch: 'client/pin-mismatch',
      insecureUrl: 'client/insecure-url',
      insecureHeaders: 'client/insecure-headers',
      upgradeFailed: 'client/upgrade-failed',
      connectFailed: 'client/connect-failed',
    });
  });

  it('reports the module as unavailable in Expo Go / Node (no native module registered)', () => {
    resetOptionalModules();
    resetPinnedWsCache();
    assert.equal(getPinnedWsModule(), null);
    assert.equal(isPinnedWsAvailable(), false);
  });

  it('finds the module when the native side registered it', () => {
    resetOptionalModules();
    const fake = new FakePinnedWs();
    setOptionalModule(MODULE_NAME, fake.adapter);
    resetPinnedWsCache();
    assert.equal(isPinnedWsAvailable(), true);
    // Clean up so later cases start from the Expo Go state.
    resetOptionalModules();
    resetPinnedWsCache();
  });
});

describe('PinnedTransport (mocked pinned-ws)', () => {
  it('passes the URL, pin, subprotocols and headers to the native module', () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    transport.connect('wss://192.168.1.10:3443/ws/mobile', {
      certSha256: PIN.toUpperCase(),
      protocols: ['dsh-mobile-v1', 'dsh-pair.code-1'],
      headers: { 'X-DSH-Device-ID': 'device-1' },
    });
    assert.equal(fake.connects.length, 1);
    const call = fake.connects[0]!;
    assert.equal(call.url, 'wss://192.168.1.10:3443/ws/mobile');
    // The pin is normalised to lowercase hex, which is what both native implementations compare.
    assert.equal(call.options.certSha256, PIN);
    assert.deepEqual(call.options.protocols, ['dsh-mobile-v1', 'dsh-pair.code-1']);
    assert.deepEqual(call.options.headers, { 'X-DSH-Device-ID': 'device-1' });
    // Header *names* only, never values (no secrets in diagnostics); the subprotocol values
    // (`dsh-pair.<code>` / `dsh-auth.<token>`) are counted, never retained (N6).
    assert.deepEqual(transport.offeredHeaderNames, ['X-DSH-Device-ID']);
    assert.equal(transport.offeredProtocols, 2);
  });

  it('keeps only bounded counters, never the offered subprotocols or sent frames (N6)', () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    transport.connect('wss://host/ws', {
      certSha256: PIN,
      protocols: ['dsh-mobile-v1', 'dsh-pair.secret-pairing-code'],
      headers: { Authorization: 'Bearer secret-token' },
    });

    // The transport exposes numbers, so a long-lived process cannot accumulate payloads and a
    // `dsh-auth.<token>` / `dsh-pair.<code>` subprotocol can never be read back out of it.
    assert.equal(typeof transport.offeredProtocols, 'number');
    assert.equal(typeof transport.framesSent, 'number');
    assert.equal(typeof transport.framesSentBeforeOpen, 'number');
    assert.equal(transport.send('{"type":"ping","requestId":"r1"}'), false);
    assert.equal(transport.framesSentBeforeOpen, 1);
    const serialised = JSON.stringify(transport);
    assert.equal(serialised.includes('secret-pairing-code'), false);
    assert.equal(serialised.includes('secret-token'), false);
  });

  it('refuses to send before open and never puts a frame on the wire', async () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });

    assert.equal(transport.send('{"type":"client-hello","requestId":"r1"}'), false);
    assert.equal(transport.framesSentBeforeOpen, 1);
    await Promise.resolve();
    assert.equal(fake.sends.length, 0);
    // The transport itself never reports open; only the native side can.
    assert.equal(events.some((event) => event.type === 'open'), false);
  });

  it('routes open / message / close by socket id and ignores another socket', async () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;

    // Events for a different socket (e.g. an earlier, abandoned attempt) are dropped.
    fake.emit('onOpen', { id: 'other-socket', protocol: 'dsh-mobile-v1' });
    fake.emit('onMessage', { id: 'other-socket', data: '{"kind":"hello"}' });
    assert.deepEqual(events, []);
    assert.equal(transport.isOpenPublic, false);

    fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });
    fake.emit('onMessage', { id, data: '{"kind":"hello","companionProtocol":1}' });
    fake.emit('onClose', { id, code: 4004, reason: 'gateway disabled' });
    fake.emit('onMessage', { id, data: '{"late":true}' });

    assert.deepEqual(events, [
      { type: 'open' },
      { type: 'message', data: '{"kind":"hello","companionProtocol":1}' },
      { type: 'close', code: 4004, reason: 'gateway disabled', wasClean: false },
    ]);
  });

  it('sends frames only after open and records what the native side accepted', async () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    transport.connect('wss://host/ws', { certSha256: PIN });
    fake.emit('onOpen', { id: fake.lastId, protocol: 'dsh-mobile-v1' });

    assert.equal(transport.isOpenPublic, true);
    assert.equal(transport.send('{"type":"ping","requestId":"r2"}'), true);
    await waitFor(() => fake.sends.length === 1);
    assert.deepEqual(fake.sends, [{ id: fake.lastId, text: '{"type":"ping","requestId":"r2"}' }]);
    assert.equal(transport.framesSent, 1);
    assert.equal(transport.framesSentBeforeOpen, 0);
  });

  // Device evidence: the native module logged a delivered frame while JS was still `connecting`,
  // i.e. `onMessage` before `onOpen`. Dropping that frame left the handshake silent and the socket
  // died on its 10 s deadline, so a real frame is accepted as proof of the (pinned) upgrade.
  it('treats a message before onOpen as proof the socket opened, then sends', async () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;

    fake.emit('onMessage', { id, data: '{"kind":"server-hello","companionProtocol":1}' });

    // Exactly one `open`, ahead of the frame it proved.
    assert.deepEqual(events, [
      { type: 'open' },
      { type: 'message', data: '{"kind":"server-hello","companionProtocol":1}' },
    ]);
    assert.equal(transport.isOpenPublic, true);
    // The transition is what lets the handshake answer: the frame now reaches the native socket.
    assert.equal(transport.send('{"type":"client-hello","requestId":"r1"}'), true);
    assert.equal(transport.framesSentBeforeOpen, 0);
    await waitFor(() => fake.sends.length === 1);
    assert.deepEqual(fake.sends, [{ id, text: '{"type":"client-hello","requestId":"r1"}' }]);
    assert.equal(transport.framesSent, 1);
  });

  it('keeps exactly one open when onOpen arrives after the message-first transition', () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;

    fake.emit('onMessage', { id, data: '{"kind":"server-hello"}' });
    fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });
    fake.emit('onMessage', { id, data: '{"kind":"second"}' });

    assert.deepEqual(events, [
      { type: 'open' },
      { type: 'message', data: '{"kind":"server-hello"}' },
      { type: 'message', data: '{"kind":"second"}' },
    ]);
    assert.equal(events.filter((event) => event.type === 'open').length, 1);
  });

  it('still drops a straggler message after a local close() or a native onClose', () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;

    // Local close before any open: the late frame must not resurrect the socket.
    transport.close(1000, 'give-up');
    fake.emit('onMessage', { id, data: '{"late":true}' });
    assert.deepEqual(events, [{ type: 'close', code: 1000, reason: 'give-up', wasClean: false }]);
    assert.equal(transport.isOpenPublic, false);

    // Native close: the same frame afterwards is filtered too.
    const secondFake = new FakePinnedWs();
    const other = newTransport(secondFake);
    const otherEvents = collect(other);
    other.connect('wss://host/ws', { certSha256: PIN });
    const otherId = secondFake.lastId;
    secondFake.emit('onClose', { id: otherId, code: 1006, reason: '' });
    secondFake.emit('onMessage', { id: otherId, data: '{"late":true}' });
    assert.deepEqual(otherEvents, [{ type: 'close', code: 1006, reason: '', wasClean: false }]);
    assert.equal(other.isOpenPublic, false);
    assert.deepEqual(secondFake.sends, []);
  });

  it('leaves the normal onOpen -> onMessage order unchanged', () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;

    fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });
    fake.emit('onMessage', { id, data: '{"kind":"server-hello"}' });

    assert.deepEqual(events, [
      { type: 'open' },
      { type: 'message', data: '{"kind":"server-hello"}' },
    ]);
  });

  it('maps a pin mismatch to client/pin-mismatch and keeps the socket shut', async () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });

    fake.emit('onError', {
      id: fake.lastId,
      code: 'client/pin-mismatch',
      message: 'The server certificate does not match the pinned fingerprint',
      observedSha256: 'b'.repeat(64),
    });
    fake.emit('onClose', { id: fake.lastId, code: 1006, reason: '' });

    const error = events.find((event) => event.type === 'error') as { code: string; details?: Record<string, unknown> };
    assert.equal(error.code, 'client/pin-mismatch');
    assert.deepEqual(error.details, { observedSha256: 'b'.repeat(64) });
    assert.equal(events.some((event) => event.type === 'open'), false);
    assert.equal(transport.send('{"type":"client-hello"}'), false);
    // A pre-open native error is terminal on its own: one close with the pin reason, and the
    // native close that follows is filtered (exactly one end per socket).
    assert.deepEqual(events.map((event) => event.type), ['error', 'close']);
    assert.deepEqual(events.at(-1), { type: 'close', code: 1006, reason: 'pin-mismatch', wasClean: false });
    assert.deepEqual(fake.sends, []);
  });

  it('maps a non-wss URL to client/insecure-url', async () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('ws://host/ws', { certSha256: PIN });

    fake.emit('onError', { id: fake.lastId, code: 'client/insecure-url', message: 'Only wss:// URLs are allowed' });
    fake.emit('onClose', { id: fake.lastId, code: 1006, reason: '' });

    const error = events.find((event) => event.type === 'error') as { code: string };
    assert.equal(error.code, 'client/insecure-url');
    assert.equal(events.some((event) => event.type === 'open'), false);
  });

  it('surfaces the HTTP upgrade status of a refused upgrade (401 -> auth/required)', async () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });

    fake.emit('onError', {
      id: fake.lastId,
      code: 'client/upgrade-failed',
      message: 'The WebSocket upgrade was refused',
      status: 401,
    });
    fake.emit('onClose', { id: fake.lastId, code: 1006, reason: '' });

    const error = events.find((event) => event.type === 'error') as { code: string; details?: Record<string, unknown> };
    assert.equal(error.code, 'auth/required');
    assert.deepEqual(error.details, { status: 401 });
    assert.equal(events.some((event) => event.type === 'open'), false);
  });

  it('maps 403 to remote/disabled and other statuses to client/upgrade-failed', async () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    fake.emit('onError', { id: fake.lastId, code: 'client/upgrade-failed', message: 'refused', status: 403 });
    await Promise.resolve();
    assert.equal((events.find((event) => event.type === 'error') as { code: string }).code, 'remote/disabled');

    const second = new FakePinnedWs();
    const other = newTransport(second);
    const otherEvents = collect(other);
    other.connect('wss://host/ws', { certSha256: PIN });
    second.emit('onError', { id: second.lastId, code: 'client/upgrade-failed', message: 'refused', status: 502 });
    await Promise.resolve();
    const error = otherEvents.find((event) => event.type === 'error') as { code: string; details?: Record<string, unknown> };
    assert.equal(error.code, 'client/upgrade-failed');
    assert.deepEqual(error.details, { status: 502 });
  });

  it('lets a caller override the upgrade mapping', async () => {
    const fake = new FakePinnedWs();
    const transport = new PinnedTransport({
      module: fake.adapter,
      mapUpgradeStatus: (status) => ({ code: status === 429 ? 'client/timeout' : 'client/upgrade-failed' }),
    });
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    fake.emit('onError', { id: fake.lastId, code: 'client/upgrade-failed', message: 'slow down', status: 429 });
    await Promise.resolve();
    assert.equal((events.find((event) => event.type === 'error') as { code: string }).code, 'client/timeout');
  });

  it('maps an unknown native error code to client/connect-failed', async () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    fake.emit('onError', { id: fake.lastId, code: 'something/else', message: 'boom' });
    await Promise.resolve();
    assert.equal((events.find((event) => event.type === 'error') as { code: string }).code, 'client/connect-failed');
  });

  it('reports client/pinned-transport-unavailable when the native module is missing (Expo Go)', async () => {
    resetOptionalModules();
    resetPinnedWsCache();
    const transport = new PinnedTransport();
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    await waitFor(() => events.some((event) => event.type === 'close'));
    const error = events.find((event) => event.type === 'error') as { code: string };
    assert.equal(error.code, 'client/pinned-transport-unavailable');
    assert.equal(events.some((event) => event.type === 'open'), false);
    assert.equal(transport.send('{"type":"ping"}'), false);
  });

  it('reports a rejected native connect() as client/connect-failed, then closes exactly once', async () => {
    const fake = new FakePinnedWs();
    fake.connectRejects = new Error('connect(): 2nd argument is not a String');
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;
    await waitFor(() => events.some((event) => event.type === 'close'));

    // The rejected promise is the only report the native side gives: without the synthesized
    // close the core would wait in `connecting` forever (M6).
    assert.deepEqual(events.map((event) => event.type), ['error', 'close']);
    assert.equal((events.find((event) => event.type === 'error') as { code: string }).code, 'client/connect-failed');
    assert.deepEqual(events.at(-1), { type: 'close', code: 1006, reason: 'connect-failed', wasClean: false });
    assert.equal(events.some((event) => event.type === 'open'), false);
    assert.equal(transport.isOpenPublic, false);
    assert.equal(transport.send('{"type":"ping"}'), false);

    // Late native events for the failed socket are filtered: no second close, no open.
    fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });
    fake.emit('onError', { id, code: 'client/connect-failed', message: 'late' });
    fake.emit('onClose', { id, code: 1006, reason: '' });
    assert.deepEqual(events.map((event) => event.type), ['error', 'close']);
  });

  it('reports a connect() that throws synchronously as one error + one close', async () => {
    const fake = new FakePinnedWs();
    fake.connectThrows = new Error('native bridge unavailable');
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    await waitFor(() => events.some((event) => event.type === 'close'));

    assert.deepEqual(events.map((event) => event.type), ['error', 'close']);
    assert.equal((events[0] as { code: string }).code, 'client/connect-failed');
    assert.deepEqual(events[1], { type: 'close', code: 1006, reason: 'connect-failed', wasClean: false });
    assert.equal(events.some((event) => event.type === 'open'), false);
    assert.equal(transport.send('{"type":"ping"}'), false);
  });

  it('finishes a pre-open native error even when no native onClose ever arrives', () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;

    fake.emit('onError', { id, code: 'client/upgrade-failed', message: 'refused', status: 401 });
    // No `onClose` follows in this case on purpose: the transport must synthesize the end.
    assert.deepEqual(events.map((event) => event.type), ['error', 'close']);
    assert.equal((events[0] as { code: string }).code, 'auth/required');
    assert.deepEqual(events[1], { type: 'close', code: 1006, reason: 'connect-failed', wasClean: false });

    fake.emit('onClose', { id, code: 1006, reason: '' });
    assert.equal(events.filter((event) => event.type === 'close').length, 1);
  });

  it('does not synthesize a close for an error after open (the core owns the handshake deadline)', async () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;
    fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });
    fake.emit('onError', { id, code: 'client/connect-failed', message: 'native read failed' });

    // The error is reported, but the core keeps its handshake deadline armed and closes the
    // attempt itself; a live (ready) socket must survive a spurious error and end on its real
    // close. Inventing one here would tear down an established connection.
    assert.deepEqual(events.map((event) => event.type), ['open', 'error']);
    assert.equal(transport.isOpenPublic, true);
    assert.equal(transport.send('{"type":"ping","requestId":"r1"}'), true);

    transport.close(1006, 'handshake-timeout');
    await waitFor(() => fake.closes.length === 1);
    assert.deepEqual(fake.closes, [{ id, code: 1006, reason: 'handshake-timeout' }]);
    assert.deepEqual(events.map((event) => event.type), ['open', 'error', 'close']);
    assert.deepEqual(events.at(-1), { type: 'close', code: 1006, reason: 'handshake-timeout', wasClean: false });
    assert.equal(transport.isOpenPublic, false);
  });

  it('never invents a second close when connect() is called on a finished transport', () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    fake.emit('onClose', { id: fake.lastId, code: 1006, reason: '' });
    assert.equal(events.filter((event) => event.type === 'close').length, 1);

    transport.connect('wss://host/ws', { certSha256: PIN });
    assert.equal(events.filter((event) => event.type === 'close').length, 1);
    const last = events.at(-1) as { type: string; code?: string };
    assert.equal(last.type, 'error');
    assert.equal(last.code, 'client/connect-failed');
    assert.equal(fake.connects.length, 1);
  });

  it('close() reports exactly one terminal close and filters late native events', async () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;
    fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });

    transport.close(1000, 'app-stop');
    await waitFor(() => fake.closes.length === 1);
    assert.deepEqual(fake.closes, [{ id, code: 1000, reason: 'app-stop' }]);
    for (const name of PINNED_WS_EVENT_NAMES) assert.equal(fake.listenerCount(name), 0);
    // The local close is terminal on its own: the core never sees a socket stuck "open" because
    // the native side stayed silent after being unsubscribed.
    assert.deepEqual(events, [
      { type: 'open' },
      { type: 'close', code: 1000, reason: 'app-stop', wasClean: true },
    ]);
    assert.equal(transport.isOpenPublic, false);
    assert.equal(transport.send('{"type":"ping"}'), false);

    // Idempotent: a second close and a late native close never add a second event.
    transport.close(1000, 'again');
    fake.emit('onClose', { id, code: 1000, reason: 'app-stop' });
    assert.equal(events.filter((event) => event.type === 'close').length, 1);
  });

  it('close() while connecting is terminal and a late native open cannot resurrect it', () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;

    transport.close(1000, 'give-up');
    assert.deepEqual(events, [{ type: 'close', code: 1000, reason: 'give-up', wasClean: false }]);
    assert.deepEqual(fake.closes, [{ id, code: 1000, reason: 'give-up' }]);

    fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });
    fake.emit('onMessage', { id, data: '{"kind":"hello"}' });
    assert.deepEqual(events, [{ type: 'close', code: 1000, reason: 'give-up', wasClean: false }]);
    assert.equal(transport.isOpenPublic, false);
    assert.equal(transport.send('{"type":"ping"}'), false);
  });

  it('never emits open on its own and never sends after a close', async () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;
    fake.emit('onClose', { id, code: 1006, reason: '' });
    assert.deepEqual(events, [{ type: 'close', code: 1006, reason: '', wasClean: false }]);
    assert.equal(transport.send('{"type":"ping"}'), false);
    assert.deepEqual(fake.sends, []);
  });
});

describe('PinnedTransport trace hook (opt-in diagnostics)', () => {
  // The transport is where a frame can be dropped silently, so the hook records exactly the
  // decisions it takes: which native event arrived, in which state, and why anything was dropped.
  // Every line carries the *sanitised* socket reference only — never the id, a header or a frame.
  const DETERMINISTIC_ID = 'pw-test-socket-0001-long';

  it('traces a message before onOpen as native-message, open-emitted, message-emitted', () => {
    const fake = new FakePinnedWs();
    const lines: string[] = [];
    const transport = new PinnedTransport({
      module: fake.adapter,
      newSocketId: () => DETERMINISTIC_ID,
      trace: (line) => lines.push(line),
    });
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const data = '{"kind":"server-hello","companionProtocol":1}';

    fake.emit('onMessage', { id: DETERMINISTIC_ID, data });

    const ref = socketRef(DETERMINISTIC_ID);
    assert.deepEqual(lines.map((line) => line.split(' ')[0]), ['native-message', 'open-emitted', 'message-emitted']);
    for (const line of lines) assert.ok(line.includes(`id=${ref}`), line);
    assert.equal(
      lines[0],
      `native-message id=${ref} state=connecting accepted=true closeEmitted=false chars=${data.length}`,
    );
    assert.equal(lines[1], `open-emitted id=${ref}`);
    assert.equal(lines[2], `message-emitted id=${ref}`);
    // The raw id and the frame text never reach the trace (only the ref and a character count).
    assert.equal(lines.some((line) => line.includes(DETERMINISTIC_ID) || line.includes('server-hello')), false);
    // The trace observed the same outcome the core got.
    assert.deepEqual(events, [{ type: 'open' }, { type: 'message', data }]);
  });

  it("traces send() as the state it was attempted in plus the frame's length", async () => {
    const fake = new FakePinnedWs();
    const lines: string[] = [];
    const transport = new PinnedTransport({
      module: fake.adapter,
      newSocketId: () => DETERMINISTIC_ID,
      trace: (line) => lines.push(line),
    });
    transport.connect('wss://host/ws', { certSha256: PIN });
    const frame = '{"type":"client-hello","requestId":"r1"}';

    // Before open: refused, and the trace says so without the frame.
    assert.equal(transport.send(frame), false);
    assert.equal(lines.at(-1), `send id=${socketRef(DETERMINISTIC_ID)} state=connecting chars=${frame.length} ok=false`);

    fake.emit('onOpen', { id: DETERMINISTIC_ID, protocol: 'dsh-mobile-v1' });
    assert.equal(transport.send(frame), true);
    assert.equal(lines.at(-1), `send id=${socketRef(DETERMINISTIC_ID)} state=open chars=${frame.length} ok=true`);
    assert.equal(lines.some((line) => line.includes('client-hello')), false);
    await waitFor(() => fake.sends.length === 1);
  });

  it('produces no line at all when no hook is installed', () => {
    const fake = new FakePinnedWs();
    const transport = newTransport(fake);
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;

    // A hook the transport does not know about: nothing may be produced for it.
    const lines: string[] = [];
    fake.emit('onMessage', { id, data: '{"kind":"server-hello"}' });
    fake.emit('onOpen', { id, protocol: 'dsh-mobile-v1' });
    fake.emit('onError', { id, code: 'client/upgrade-failed', message: 'refused', status: 401 });
    fake.emit('onClose', { id, code: 1006, reason: '' });
    assert.equal(transport.send('{"type":"ping"}'), false);

    assert.deepEqual(lines, []);
    // And the absent hook changes nothing: the same events as before.
    assert.deepEqual(events.map((event) => event.type), ['open', 'message', 'error', 'close']);
  });

  it('keeps behaving when the trace hook throws', () => {
    const fake = new FakePinnedWs();
    const transport = new PinnedTransport({
      module: fake.adapter,
      trace: () => {
        throw new Error('trace sink exploded');
      },
    });
    const events = collect(transport);
    transport.connect('wss://host/ws', { certSha256: PIN });
    const id = fake.lastId;
    const data = '{"kind":"server-hello"}';

    fake.emit('onMessage', { id, data });

    // The message-first path still reported open and delivered the frame, and send still works.
    assert.deepEqual(events, [{ type: 'open' }, { type: 'message', data }]);
    assert.equal(transport.isOpenPublic, true);
    assert.equal(transport.send('{"type":"client-hello"}'), true);
  });
});

describe('socketRef (trace id sanitiser)', () => {
  it('bounds a hostile id and is deterministic', () => {
    const hostile = `pw-ok.1_2-3\r\n\u0000\u001b[31m${'a'.repeat(400)}`;
    const ref = socketRef(hostile);

    // Deterministic: the same id always produces the same line-safe reference.
    assert.equal(ref, socketRef(hostile));
    // Bounded: at most 12 sanitised characters, `#` and an 8-hex hash.
    assert.match(ref, /^[A-Za-z0-9._-]{0,12}#[0-9a-f]{8}$/);
    assert.ok(ref.length <= 21, ref);
    // No newline, control or escape sequence from the raw id survives.
    for (const forbidden of ['\r', '\n', '\u0000', '\u001b', '[']) {
      assert.equal(ref.includes(forbidden), false, `ref leaked ${JSON.stringify(forbidden)}`);
    }
    // Prefix rule: the first 12 characters that are `[A-Za-z0-9._-]`, in order.
    assert.equal(socketRef('abcdefghijklmnop').split('#')[0], 'abcdefghijkl');
    assert.equal(socketRef('ab cd ef gh ij kl').split('#')[0], 'abcdefghijkl');
    // Two ids that share a prefix are still distinguishable (the hash covers the whole id).
    const long = 'x'.repeat(300);
    assert.notEqual(socketRef(`${long}1`), socketRef(`${long}2`));
  });
});

describe('upgrade status mapping', () => {
  it('maps 401 and 403 to the contract codes and keeps CoreError details', () => {
    assert.equal(defaultUpgradeMapping(401).code, 'auth/required');
    assert.equal(defaultUpgradeMapping(403).code, 'remote/disabled');
    assert.equal(defaultUpgradeMapping(500).code, 'client/upgrade-failed');

    const error = upgradeStatusError(403);
    assert.equal(error.code, 'remote/disabled');
    assert.deepEqual(error.details, { status: 403 });
  });
});
