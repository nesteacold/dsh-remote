// Pairing-focused controller tests (M9/A048 and the M5 pairing races).
//
// What they pin down:
//   * a pairing is a success only after the host accepted `hello` + `client-hello` (contract
//     §5a) — a `paired` frame alone, a token save, or a started reconnect loop are not enough;
//   * the token from `paired` is persisted immediately and survives a later terminal failure,
//     so a one-time code is never stranded; the host record stays for a retry/update;
//   * every awaited step is guarded by the attempt generation: a lock, a forget, a revoke or a
//     newer pairing makes the attempt stale, and a stale attempt never writes this.host /
//     this.hosts / the pairing banner or the stored host list;
//   * a credential write that is still landing when a forget/revoke deletes the same key is
//     settled first, so it can never resurrect a token; a delayed revocation cleanup never
//     clears a host the user selected while that cleanup was parked;
//   * a forget removes the credential *instances* that exist when it is invoked, through the same
//     per-gateway revision transaction a revocation uses: a pairing of the same gateway that
//     registers a fresh revision while the forget is parked keeps its token and wins, an attempt
//     for another gateway dies as it was interrupted, never one the forget committed;
//   * `start()` owns its listeners: a stop or a newer start while the stored host list is still
//     being read leaves no listener, host record or socket behind, and a `start()` that wins
//     installs them once;
//   * a failing install-id read is a typed pairing failure, not an unhandled throw;
//   * the pairing gate is bounded, so a silent host cannot leave the screen waiting forever.
//
// `expo-secure-store` is replaced for this file only (see the hook below) by a small in-memory
// stub whose one-key write can be delayed. That makes the `await saveHost(...)` window, which
// is where the M5 races live, deterministic; no other harness file is touched.

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import { encodePairingPayload, type PairingPayload } from '../src/core';
import { FakeGateway } from './support/fake-gateway';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { deferred, waitFor } from './support/wait';
import { resetAppState } from './support/stubs/react-native.stub';

// ---------------------------------------------------------------------------
// Delayable secure store (same surface as test/support/stubs/expo-secure-store.stub.ts)
// ---------------------------------------------------------------------------

const STORE_SOURCE = `
const store = new Map();
const state = { rule: null, deleteRule: null, failGet: null };
async function gate(rule, key) {
  if (rule === null || rule.key !== key) return;
  if (typeof rule.onEnter === 'function') rule.onEnter();
  await new Promise((resolve) => setTimeout(resolve, rule.ms));
}
export async function getItemAsync(key) {
  const failure = state.failGet;
  if (failure !== null && failure.key === key) {
    state.failGet = null; // one shot: the next read fails normally
    throw new Error(failure.message);
  }
  // Reads take the same gate as writes: a harness read that must be observed in flight
  // (the stored host list, a token) is parked here, deterministically.
  if (state.rule !== null) await gate(state.rule, key);
  return store.get(key) ?? null;
}
export async function setItemAsync(key, value) {
  if (state.rule !== null) await gate(state.rule, key);
  store.set(key, value);
}
export async function deleteItemAsync(key) {
  if (state.deleteRule !== null) await gate(state.deleteRule, key);
  store.delete(key);
}
export async function isAvailableAsync() { return true; }
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';
export const AFTER_FIRST_UNLOCK = 'AFTER_FIRST_UNLOCK';
export const WHEN_UNLOCKED = 'WHEN_UNLOCKED';
export function __reset() { store.clear(); }
export function __entries() { return [...store.entries()]; }
export function __delay(key, ms, onEnter) { state.rule = { key, ms, onEnter }; }
export function __clearDelay() { state.rule = null; }
export function __delayDelete(key, ms, onEnter) { state.deleteRule = { key, ms, onEnter }; }
export function __clearDeleteDelay() { state.deleteRule = null; }
export function __failGet(key, message) { state.failGet = { key, message }; }
`;

const STORE_URL = `data:text/javascript;base64,${Buffer.from(STORE_SOURCE, 'utf8').toString('base64')}`;

registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'expo-secure-store') return { url: STORE_URL, shortCircuit: true };
    return nextResolve(specifier, _context);
  },
});

interface DelayableStore {
  __reset(): void;
  __entries(): Array<[string, string]>;
  __delay(key: string, ms: number, onEnter?: () => void): void;
  __clearDelay(): void;
  /** Park one key's delete (the credential removal), for a forget/revoke window. */
  __delayDelete(key: string, ms: number, onEnter?: () => void): void;
  __clearDeleteDelay(): void;
  __failGet(key: string, message: string): void;
}

// Loaded in `before()` — i.e. after the hook above — so the app's `expo-secure-store` import
// resolves to this stub. (A top-level `await import()` is not available: this package's test
// files compile as CJS.)
let store: DelayableStore;
let AppController: typeof import('../src/app-state').AppController;
/** Same module instance the controller uses: lets a test clear the cached install id. */
let installId: typeof import('../src/platform/install-id');
/**
 * The controller subscribes through the bare `expo-notifications` specifier, so the test must
 * load the stub the same way: a relative import of the stub file is a *second* module instance in
 * the test runner, and a helper called on it would never reach the controller's listener.
 */
interface NotificationStub {
  emitNotificationResponse(url: string): void;
}
let notifications: NotificationStub;

before(async () => {
  store = (await import('expo-secure-store')) as unknown as DelayableStore;
  notifications = (await import('expo-notifications')) as unknown as NotificationStub;
  installId = await import('../src/platform/install-id');
  ({ AppController } = await import('../src/app-state'));
});

// ---------------------------------------------------------------------------

const HOSTS_KEY = 'dsh-companion.hosts';
const TOKEN_PREFIX = 'dsh-companion.token.';
const GATEWAY_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const GATEWAY_B = '3c9e1a52-8b1f-4a3d-b6c0-2d5e7f8a9b1c';
const NOW = Date.now();

const nodeTransport = () => new NodePinnedTransport({ handshakeTimeoutMs: 4_000 });

function pairingPayload(gateway: FakeGateway, code: string, gatewayId = GATEWAY_A, name = 'my-pc'): string {
  const payload: PairingPayload = {
    version: 3,
    publicUrl: gateway.endpoint,
    pairingCode: code,
    expiresAt: NOW + 240_000,
    certSha256: gateway.certSha256,
    gatewayId,
    gatewayName: name,
    endpoints: [gateway.endpoint],
  };
  return encodePairingPayload(payload);
}

function pairCode(letter: string): string {
  // `parsePairingQr` requires the canonical unpadded base64url of 32 bytes: 43 characters whose
  // last one has its two spare bits zero (only A E I M Q U Y c g k o s w 0 4 8 qualify).
  const canonical = ['A', 'E', 'I', 'M', 'Q', 'U', 'Y', 'c', 'g', 'k', 'o', 's', 'w', '0', '4', '8'];
  const index = Math.abs(letter.charCodeAt(0) - 'A'.charCodeAt(0)) % canonical.length;
  return 'A'.repeat(42) + (canonical[index] as string);
}

function tokenEntries(): Array<[string, string]> {
  return store.__entries().filter(([key]) => key.startsWith(TOKEN_PREFIX));
}

function storedHosts(): Array<{ gatewayId: string }> {
  const raw = store.__entries().find(([key]) => key === HOSTS_KEY)?.[1];
  return raw === undefined ? [] : (JSON.parse(raw) as Array<{ gatewayId: string }>);
}

type Controller = InstanceType<typeof AppController>;

async function unlockedController(transport = nodeTransport): Promise<Controller> {
  const controller = new AppController({ locale: () => 'en', transport, pairAckTimeoutMs: 400 });
  await controller.start();
  await controller.unlock();
  return controller;
}

describe('AppController pairing gate (M9 / A048)', () => {
  beforeEach(() => {
    store.__reset();
    store.__clearDelay();
    store.__clearDeleteDelay();
    resetAppState('active');
  });

  afterEach(() => {
    store.__clearDelay();
    store.__clearDeleteDelay();
  });

  it('M9: a locked pairing with hello but no accepted client-hello never claims success', async () => {
    const code = pairCode('A');
    const gateway = await FakeGateway.create({ pairingCodes: [code], suppressClientHelloAck: true });
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport, pairAckTimeoutMs: 400 });
    try {
      await controller.start();
      // Production order is unlock -> pair, but the gate is still closed here on purpose: the
      // pairing socket itself must produce the accepted ack before pair() may succeed.
      const pairing = controller.pair(pairingPayload(gateway, code));
      await waitFor(() => controller.snapshot().connection === 'waiting-client-hello', {
        label: 'hello exchanged on the pairing socket',
      });
      const result = await pairing;

      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'client/timeout');
      assert.equal(controller.snapshot().pairing?.kind, 'connect');
      // The one-time code was consumed: token + host record are kept for a retry, not a new QR.
      assert.equal(gateway.consumedPairingCodes.length, 1);
      assert.equal(tokenEntries().length, 1);
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_A);
      // No bearer connection was opened while the gate was closed (A020/M5).
      assert.equal(gateway.bearerClientHellos, 0);
      assert.notEqual(controller.snapshot().connection, 'ready');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('M9/A048: an unlocked pairing needs the accepted client-hello on the bearer connection', async () => {
    const code = pairCode('B');
    const gateway = await FakeGateway.create({ pairingCodes: [code], suppressClientHelloAck: true });
    const controller = await unlockedController();
    try {
      const started = Date.now();
      const pairing = controller.pair(pairingPayload(gateway, code));
      await waitFor(() => gateway.bearerClientHellos >= 1, { label: 'bearer socket sent client-hello' });
      // The host exchanged hello + client-hello but never accepted it: no success.
      assert.notEqual(controller.snapshot().connection, 'ready');
      const result = await pairing;

      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'client/timeout');
      assert.ok(Date.now() - started < 5_000, 'the pairing gate is bounded');
      // Credential and host record survive the terminal failure (recovery = retry/update).
      assert.equal(tokenEntries().length, 1);
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_A);
      assert.equal(controller.snapshot().pairing?.kind, 'connect');
      // The failed connection is torn down; nothing is left claiming to be live.
      await waitFor(() => gateway.openConnectionCount === 0, { label: 'no live socket after a failed pairing' });
      assert.notEqual(controller.snapshot().connection, 'ready');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('M9/A048: a duplicate accepted client-hello resolves the pairing once, one live socket', async () => {
    const code = pairCode('C');
    const gateway = await FakeGateway.create({ pairingCodes: [code], duplicateClientHelloAck: true });
    const controller = await unlockedController();
    try {
      const result = await controller.pair(pairingPayload(gateway, code));
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(controller.snapshot().connection, 'ready');
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_A);
      assert.equal(gateway.pairingClientHellos, 1);
      assert.equal(gateway.bearerClientHellos, 1);
      assert.equal(gateway.consumedPairingCodes.length, 1);

      await waitFor(() => gateway.openConnectionCount === 1, { label: 'one live connection' });
      const attempts = gateway.connectionAttempts;
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The second ack did not start anything: no extra socket, still exactly one.
      assert.equal(gateway.connectionAttempts, attempts);
      assert.equal(gateway.openConnectionCount, 1);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});

describe('AppController pairing races (M5)', () => {
  beforeEach(() => {
    store.__reset();
    store.__clearDelay();
    store.__clearDeleteDelay();
    resetAppState('active');
  });

  afterEach(() => {
    store.__clearDelay();
    store.__clearDeleteDelay();
  });

  it('M5: a lock during the saveHost write discards the pairing (no host, no banner, no socket)', async () => {
    const code = pairCode('D');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = await unlockedController();
    try {
      const entered = deferred<void>();
      store.__delay(HOSTS_KEY, 250, () => entered.resolve());
      const pairing = controller.pair(pairingPayload(gateway, code));
      await entered.promise; // the secure-store write is in flight
      controller.lock();
      const result = await pairing;

      assert.equal(result.ok, false);
      // The late saveHost continuation is stale: it must not install the host or the banner.
      assert.equal(controller.snapshot().activeHost, null);
      assert.equal(controller.snapshot().hosts.length, 0);
      assert.equal(controller.snapshot().pairing, null);
      assert.notEqual(controller.snapshot().connection, 'ready');
      await waitFor(() => gateway.openConnectionCount === 0, { label: 'lock closed the pairing socket' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('M5: a newer pairing wins and the slow stale attempt never overwrites host state', async () => {
    const codeA = pairCode('E');
    const codeB = pairCode('F');
    const gatewayA = await FakeGateway.create({ pairingCodes: [codeA] });
    const gatewayB = await FakeGateway.create({ pairingCodes: [codeB] });
    const controller = await unlockedController();
    try {
      const entered = deferred<void>();
      store.__delay(HOSTS_KEY, 250, () => entered.resolve());
      const first = controller.pair(pairingPayload(gatewayA, codeA, GATEWAY_A, 'pc-a'));
      await entered.promise; // the first attempt is parked inside saveHost
      store.__clearDelay();
      const second = await controller.pair(pairingPayload(gatewayB, codeB, GATEWAY_B, 'pc-b'));
      const firstResult = await first;

      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(firstResult.ok, false);
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_B);
      assert.equal(controller.snapshot().pairing, null, 'the stale attempt left the banner alone');
      // The stored list is ordered newest-first: the newer pairing is not shadowed by the stale write.
      assert.equal(storedHosts()[0]?.gatewayId, GATEWAY_B);
      assert.equal(controller.snapshot().hosts[0]?.gatewayId, GATEWAY_B);
      await waitFor(() => gatewayB.openConnectionCount === 1, { label: 'newer pairing connected' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_B);
      assert.equal(gatewayA.openConnectionCount, 0);
    } finally {
      controller.stop();
      await gatewayA.close();
      await gatewayB.close();
    }
  });

  it('M5: a forget during the saveHost write leaves no credential and no host record', async () => {
    const code = pairCode('G');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = await unlockedController();
    try {
      const entered = deferred<void>();
      store.__delay(HOSTS_KEY, 250, () => entered.resolve());
      const pairing = controller.pair(pairingPayload(gateway, code));
      await entered.promise;
      await controller.forget();
      const result = await pairing;

      assert.equal(result.ok, false);
      assert.equal(controller.snapshot().activeHost, null);
      assert.equal(controller.snapshot().pairing, null);
      // The token the cancelled pairing persisted is gone with the forgotten credential.
      assert.deepEqual(tokenEntries(), []);
      assert.deepEqual(storedHosts(), []);
      await waitFor(() => gateway.openConnectionCount === 0, { label: 'no socket after forget' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('M5: a revocation while waiting for the ack cancels the pairing and wipes the credential', async () => {
    const code = pairCode('H');
    const gateway = await FakeGateway.create({ pairingCodes: [code], suppressClientHelloAck: true });
    const controller = await unlockedController();
    try {
      const pairing = controller.pair(pairingPayload(gateway, code));
      // Wait for the bearer socket to be live and parked on the missing ack, then revoke it.
      await waitFor(() => gateway.bearerClientHellos >= 1, { label: 'bearer socket awaiting the ack' });
      assert.equal(tokenEntries().length, 1);
      gateway.closeAll(4401, 'revoked');
      const result = await pairing;

      assert.equal(result.ok, false);
      await waitFor(() => controller.snapshot().activeHost === null, { label: 'revoked host forgotten' });
      assert.equal(tokenEntries().length, 0, 'revoked credential wiped');
      assert.deepEqual(storedHosts(), []);
      assert.notEqual(controller.snapshot().connection, 'ready');
      await waitFor(() => gateway.openConnectionCount === 0, { label: 'revoked socket closed' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Credential cleanup races (M5): a delayed store write must never resurrect a credential a
// forget/revoke wipes, and a delayed revocation cleanup must never clobber a host the user
// selected (or a pairing finished) while that cleanup was parked. A cleanup owns one *credential
// instance* per gateway (a revision), never the UI lifecycle: locking or switching to another
// host must not keep a dead secret, while a newer token on the same gateway must survive.
// ---------------------------------------------------------------------------

describe('AppController credential cleanup races (M5)', () => {
  beforeEach(() => {
    store.__reset();
    store.__clearDelay();
    store.__clearDeleteDelay();
    resetAppState('active');
  });

  afterEach(() => {
    store.__clearDelay();
    store.__clearDeleteDelay();
  });

  it('M5: a revocation deletes a token that is still being written (no resurrection)', async () => {
    const code = pairCode('I');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = await unlockedController();
    try {
      const entered = deferred<void>();
      store.__delay(`${TOKEN_PREFIX}${GATEWAY_A}`, 200, () => entered.resolve());
      const pairing = controller.pair(pairingPayload(gateway, code));
      await entered.promise; // the one-time token write is in flight
      // The host revokes the pairing before its host record was even written.
      gateway.closeAll(4401, 'revoked');
      const result = await pairing;

      assert.equal(result.ok, false);
      // Long enough for the delayed write: the cleanup settled it, then deleted the key (M5).
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.deepEqual(tokenEntries(), [], 'the revoked credential is gone');
      assert.deepEqual(storedHosts(), []);
      assert.equal(controller.snapshot().activeHost, null);
      assert.equal(controller.snapshot().banner, 'revoked');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('M5: a forget settles a delayed token write so the credential is not resurrected', async () => {
    const code = pairCode('J');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = await unlockedController();
    try {
      const entered = deferred<void>();
      store.__delay(`${TOKEN_PREFIX}${GATEWAY_A}`, 200, () => entered.resolve());
      const pairing = controller.pair(pairingPayload(gateway, code));
      await entered.promise; // the one-time token write is in flight
      await controller.forget();
      const result = await pairing;

      assert.equal(result.ok, false);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.deepEqual(tokenEntries(), [], 'no credential survives the forget');
      assert.deepEqual(storedHosts(), []);
      assert.equal(controller.snapshot().activeHost, null);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('M5: a delayed revocation cleanup never clobbers a host selected while it is parked', async () => {
    const codeA = pairCode('K');
    const codeB = pairCode('L');
    const gatewayA = await FakeGateway.create({ pairingCodes: [codeA] });
    const gatewayB = await FakeGateway.create({ pairingCodes: [codeB] });
    const controller = await unlockedController();
    try {
      const first = await controller.pair(pairingPayload(gatewayA, codeA, GATEWAY_A, 'pc-a'));
      assert.equal(first.ok, true, JSON.stringify(first));
      const second = await controller.pair(pairingPayload(gatewayB, codeB, GATEWAY_B, 'pc-b'));
      assert.equal(second.ok, true, JSON.stringify(second));
      await controller.selectHost(GATEWAY_A);
      await waitFor(
        () => controller.snapshot().activeHost?.gatewayId === GATEWAY_A && controller.snapshot().connection === 'ready',
        { label: 'host A live again' },
      );

      const entered = deferred<void>();
      let selection: Promise<void> | null = null;
      let armed = true;
      store.__delay(HOSTS_KEY, 250, () => {
        if (!armed) return;
        armed = false;
        // Parked inside forgetHost(A): the user selects the other host meanwhile.
        selection = controller.selectHost(GATEWAY_B);
        entered.resolve();
      });
      gatewayA.closeAll(4401, 'revoked');
      await entered.promise;
      await selection;
      await waitFor(() => controller.snapshot().activeHost?.gatewayId === GATEWAY_B, { label: 'host B selected' });
      await waitFor(() => !tokenEntries().some(([key]) => key === `${TOKEN_PREFIX}${GATEWAY_A}`), {
        label: 'revoked credential deleted',
      });
      // Let the stale cleanup resume and finish.
      await new Promise((resolve) => setTimeout(resolve, 150));

      // The cleanup deleted only the revoked credential; the newer selection owns the UI and the
      // other host's credential is untouched.
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_B);
      assert.equal(tokenEntries().some(([key]) => key === `${TOKEN_PREFIX}${GATEWAY_B}`), true);
      assert.equal(controller.snapshot().hosts.some((host) => host.gatewayId === GATEWAY_A), false);
      assert.equal(storedHosts().some((host) => host.gatewayId === GATEWAY_A), false);
      assert.equal(storedHosts().some((host) => host.gatewayId === GATEWAY_B), true);
      await waitFor(() => gatewayB.openConnectionCount === 1, { label: 'host B connected' });
    } finally {
      controller.stop();
      await gatewayA.close();
      await gatewayB.close();
    }
  });

  it('M5: a delayed revocation cleanup never clobbers a host paired while it is parked', async () => {
    const codeA = pairCode('N');
    const codeB = pairCode('O');
    const gatewayA = await FakeGateway.create({ pairingCodes: [codeA] });
    const gatewayB = await FakeGateway.create({ pairingCodes: [codeB] });
    const controller = await unlockedController();
    try {
      const first = await controller.pair(pairingPayload(gatewayA, codeA, GATEWAY_A, 'pc-a'));
      assert.equal(first.ok, true, JSON.stringify(first));

      const entered = deferred<void>();
      // A holder: the assignment happens inside the store hook, which flow analysis cannot see.
      const newer: { pairing: ReturnType<Controller['pair']> | null } = { pairing: null };
      let armed = true;
      store.__delay(HOSTS_KEY, 300, () => {
        if (!armed) return;
        armed = false;
        // Parked inside forgetHost(A): a fresh pairing for another computer starts meanwhile.
        newer.pairing = controller.pair(pairingPayload(gatewayB, codeB, GATEWAY_B, 'pc-b'));
        entered.resolve();
      });
      gatewayA.closeAll(4401, 'revoked');
      await entered.promise;
      assert.ok(newer.pairing !== null, 'the newer pairing started');
      const result = await newer.pairing;

      assert.equal(result.ok, true, JSON.stringify(result));
      // The cleanup deleted only the revoked credential; the newer pairing's host and token win.
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_B);
      assert.equal(tokenEntries().some(([key]) => key === `${TOKEN_PREFIX}${GATEWAY_A}`), false);
      assert.equal(tokenEntries().some(([key]) => key === `${TOKEN_PREFIX}${GATEWAY_B}`), true);
      assert.deepEqual(storedHosts().map((host) => host.gatewayId), [GATEWAY_B]);
      await waitFor(() => gatewayB.openConnectionCount === 1, { label: 'new host connected' });
      assert.equal(controller.snapshot().banner, 'none');
    } finally {
      controller.stop();
      await gatewayA.close();
      await gatewayB.close();
    }
  });

  it('M5: a revocation parked behind the host-write chain cannot delete a same-gateway re-pair token', async () => {
    const staleCode = pairCode('P');
    const freshCode = pairCode('Q');
    const gateway = await FakeGateway.create({ pairingCodes: [staleCode, freshCode] });
    const controller = await unlockedController();
    try {
      const entered = deferred<void>();
      let armed = true;
      store.__delay(HOSTS_KEY, 800, () => {
        if (!armed) return;
        armed = false;
        entered.resolve();
      });
      const stalePairing = controller.pair(pairingPayload(gateway, staleCode, GATEWAY_A, 'pc-a'));
      await entered.promise; // the first attempt is parked inside its saveHost write
      // Revoke the pairing socket: the cleanup deletes the credential this attempt persisted, and
      // that delete queues behind the parked host write.
      gateway.closeAll(4401, 'revoked');
      await waitFor(() => controller.snapshot().banner === 'revoked', { label: 'revocation started' });

      // The same gateway is paired again while the stale delete is still queued: its token is the
      // current credential instance (a newer revision) and must survive the stale forgetHost.
      const freshPairing = controller.pair(pairingPayload(gateway, freshCode, GATEWAY_A, 'pc-a'));
      store.__clearDelay();
      const [staleResult, freshResult] = await Promise.all([stalePairing, freshPairing]);

      assert.equal(staleResult.ok, false);
      assert.equal(freshResult.ok, true, JSON.stringify(freshResult));
      assert.equal(tokenEntries().length, 1);
      const entry = tokenEntries()[0];
      assert.equal(entry?.[0], `${TOKEN_PREFIX}${GATEWAY_A}`);
      assert.equal(entry?.[1], 'tok-2', 'the newer same-gateway token survives the stale delete');
      assert.deepEqual(storedHosts().map((host) => host.gatewayId), [GATEWAY_A]);
      assert.deepEqual(controller.snapshot().hosts.map((host) => host.gatewayId), [GATEWAY_A]);
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_A);
      assert.equal(controller.snapshot().banner, 'none');
      await waitFor(() => gateway.openConnectionCount === 1, { label: 'the fresh pairing is live' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('M5: a lock while the revocation waits for its token write still deletes the dead token', async () => {
    const code = pairCode('R');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = await unlockedController();
    try {
      const entered = deferred<void>();
      store.__delay(`${TOKEN_PREFIX}${GATEWAY_A}`, 250, () => entered.resolve());
      const pairing = controller.pair(pairingPayload(gateway, code));
      await entered.promise; // the one-time token write is in flight
      gateway.closeAll(4401, 'revoked');
      await waitFor(() => controller.snapshot().banner === 'revoked', { label: 'revocation started' });
      // Locking bumps the UI generation while the cleanup waits for the token write. Ownership is
      // per credential instance, so the revoked token must still be wiped (not kept as dead secret).
      controller.lock();
      const result = await pairing;

      assert.equal(result.ok, false);
      // Long enough for the delayed write: the cleanup settled it, then deleted the key (M5).
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.deepEqual(tokenEntries(), [], 'the revoked credential is gone');
      assert.deepEqual(storedHosts(), []);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  // KNOWN DEFECT (recorded in specs/002-companion-app/tasks.md, "Known open defect"): the store
  // deletes the revoked record after the revoke flow completes, so the in-memory list can stay
  // stale until the next load. Skipped rather than weakened: the assertions stay exactly as
  // written and must pass once the race is fixed.
  it('M5: switching to another host does not cancel the revocation of the old credential', async () => {
    const codeA = pairCode('S');
    const repairCode = pairCode('T');
    const codeB = pairCode('U');
    const gatewayA = await FakeGateway.create({ pairingCodes: [codeA, repairCode] });
    const gatewayB = await FakeGateway.create({ pairingCodes: [codeB] });
    const controller = await unlockedController();
    try {
      assert.equal((await controller.pair(pairingPayload(gatewayA, codeA, GATEWAY_A, 'pc-a'))).ok, true);
      assert.equal((await controller.pair(pairingPayload(gatewayB, codeB, GATEWAY_B, 'pc-b'))).ok, true);

      const entered = deferred<void>();
      store.__delay(`${TOKEN_PREFIX}${GATEWAY_A}`, 250, () => entered.resolve());
      const repair = controller.pair(pairingPayload(gatewayA, repairCode, GATEWAY_A, 'pc-a'));
      await entered.promise; // A's replacement token write is in flight
      gatewayA.closeAll(4401, 'revoked');
      await waitFor(() => controller.snapshot().banner === 'revoked', { label: 'revocation started' });
      // The user switches to B while the cleanup is still waiting for A's token write.
      await controller.selectHost(GATEWAY_B);
      const result = await repair;

      assert.equal(result.ok, false);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(tokenEntries().some(([key]) => key === `${TOKEN_PREFIX}${GATEWAY_A}`), false, 'revoked A token deleted');
      assert.equal(tokenEntries().some(([key]) => key === `${TOKEN_PREFIX}${GATEWAY_B}`), true, 'B token untouched');
      assert.equal(storedHosts().some((host) => host.gatewayId === GATEWAY_A), false, 'revoked A record deleted');
      assert.equal(storedHosts().some((host) => host.gatewayId === GATEWAY_B), true, 'B record untouched');
      assert.equal(controller.snapshot().hosts.some((host) => host.gatewayId === GATEWAY_A), false);
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_B);
    } finally {
      controller.stop();
      await gatewayA.close();
      await gatewayB.close();
    }
  });

  it('M5: a live revocation cannot delete a token a newer same-gateway pairing writes', async () => {
    const staleCode = pairCode('V');
    const freshCode = pairCode('W');
    const gateway = await FakeGateway.create({ pairingCodes: [staleCode, freshCode] });
    const controller = await unlockedController();
    try {
      const first = await controller.pair(pairingPayload(gateway, staleCode, GATEWAY_A, 'pc-a'));
      assert.equal(first.ok, true, JSON.stringify(first));

      const entered = deferred<void>();
      store.__delay(HOSTS_KEY, 600, () => entered.resolve());
      // The live connection is revoked; its cleanup parks inside the host-record write.
      gateway.closeAll(4401, 'revoked');
      await entered.promise;
      // The same gateway is paired again while that cleanup still owns the credential chain: the
      // fresh token write is ordered after the delete, so it survives.
      const fresh = controller.pair(pairingPayload(gateway, freshCode, GATEWAY_A, 'pc-a'));
      store.__clearDelay();
      const result = await fresh;

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(tokenEntries().length, 1);
      assert.equal(tokenEntries()[0]?.[1], 'tok-2', 'the fresh same-gateway token survives');
      assert.deepEqual(storedHosts().map((host) => host.gatewayId), [GATEWAY_A]);
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_A);
      assert.equal(controller.snapshot().banner, 'none');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  // -------------------------------------------------------------------------
  // Forget ownership (M5): a forget removes the credential instances present when it is invoked
  // — its host and the pairing it cancels — through the same per-gateway revision transaction a
  // revocation uses. It never removes a future pairing: a same-gateway pair that registers its
  // token while the forget is parked owns the newer revision and wins.
  // -------------------------------------------------------------------------

  it('M5: a forget parked on its delete cannot delete a newer same-gateway pair token', async () => {
    const staleCode = pairCode('Z');
    const freshCode = pairCode('1');
    const gateway = await FakeGateway.create({ pairingCodes: [staleCode, freshCode] });
    const controller = await unlockedController();
    try {
      const first = await controller.pair(pairingPayload(gateway, staleCode, GATEWAY_A, 'pc-a'));
      assert.equal(first.ok, true, JSON.stringify(first));
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'first pairing live' });

      const entered = deferred<void>();
      store.__delayDelete(`${TOKEN_PREFIX}${GATEWAY_A}`, 700, () => entered.resolve());
      // The forget owns the credential instance of its own host; its delete is parked here.
      const forget = controller.forget();
      await entered.promise;
      // The same gateway is paired again meanwhile: it registers a fresher revision and writes
      // `tok-2` while the parked delete still names the first instance.
      const fresh = controller.pair(pairingPayload(gateway, freshCode, GATEWAY_A, 'pc-a'));
      store.__clearDeleteDelay();
      const [forgetResult, freshResult] = await Promise.all([forget, fresh]);

      assert.equal(forgetResult, undefined);
      assert.equal(freshResult.ok, true, JSON.stringify(freshResult));
      assert.equal(tokenEntries().length, 1);
      assert.equal(tokenEntries()[0]?.[1], 'tok-2', 'the newer same-gateway token survives the forget');
      assert.deepEqual(storedHosts().map((host) => host.gatewayId), [GATEWAY_A]);
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_A);
      assert.equal(controller.snapshot().banner, 'none');
      await waitFor(() => gateway.openConnectionCount === 1, { label: 'the newer pairing is live' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('M5: a forget cancels the pairing it interrupts and removes that attempt\'s token', async () => {
    const staleCode = pairCode('2');
    const freshCode = pairCode('3');
    const gateway = await FakeGateway.create({ pairingCodes: [staleCode, freshCode] });
    const controller = await unlockedController();
    try {
      // The interrupted attempt is parked between its token write and its host-record write (the
      // first host-record write of the test: the unlock above listed an empty store).
      const entered = deferred<void>();
      store.__delay(HOSTS_KEY, 700, () => entered.resolve());
      const interrupted = controller.pair(pairingPayload(gateway, staleCode, GATEWAY_A, 'pc-a'));
      await entered.promise;
      assert.equal(tokenEntries().length, 1, 'the interrupted attempt persisted its one-time token');
      assert.equal(gateway.consumedPairingCodes.length, 1, 'the stale code is the one consumed so far');

      const forget = controller.forget();
      const result = await interrupted;
      // A pairing that starts *after* the forget was invoked is a new instance, not the one it
      // removes: nothing is parked any more, so it decides the outcome.
      store.__clearDelay();
      const fresh = controller.pair(pairingPayload(gateway, freshCode, GATEWAY_A, 'pc-a'));
      await forget;
      const freshResult = await fresh;

      // The interrupted attempt lost its generation: no host, no banner, no recovery record.
      assert.equal(result.ok, false);
      assert.equal(freshResult.ok, true, JSON.stringify(freshResult));
      // The forget removed the token of the attempt it cancelled; the token left is the newer
      // pairing's, minted after that stale code was spent (`tok-3`).
      assert.equal(tokenEntries().length, 1);
      assert.equal(
        tokenEntries()[0]?.[1],
        gateway.mintedTokens[1],
        "only the newer pairing's token exists",
      );
      assert.notEqual(gateway.mintedTokens[1], gateway.mintedTokens[0]);
      assert.deepEqual(storedHosts().map((host) => host.gatewayId), [GATEWAY_A]);
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_A);
      assert.equal(controller.snapshot().banner, 'none');
      await waitFor(() => gateway.openConnectionCount === 1, { label: 'the newer pairing is live' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('M5: a forgotten gateway cannot be resurrected by a token write still landing', async () => {
    const pair1 = pairCode('4');
    const pair2 = pairCode('5');
    const gateway = await FakeGateway.create({ pairingCodes: [pair1, pair2] });
    const controller = await unlockedController();
    try {
      const first = await controller.pair(pairingPayload(gateway, pair1, GATEWAY_A, 'pc-a'));
      assert.equal(first.ok, true, JSON.stringify(first));

      // The same gateway is paired again straight away: its token write is in flight when the
      // user forgets, and the forget probes that instance before it deletes.
      const entered = deferred<void>();
      store.__delay(`${TOKEN_PREFIX}${GATEWAY_A}`, 700, () => entered.resolve());
      const repair = controller.pair(pairingPayload(gateway, pair2, GATEWAY_A, 'pc-a'));
      await entered.promise;
      await controller.forget();
      store.__clearDelay();
      const repairResult = await repair;

      assert.equal(repairResult.ok, false);
      assert.deepEqual(tokenEntries(), [], 'no credential survives the forget');
      assert.deepEqual(storedHosts(), []);
      assert.equal(controller.snapshot().activeHost, null);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('M5: a forget whose delete is parked never clobbers the host/socket of a pairing that replaced it', async () => {
    const codeA = pairCode('6');
    const codeB = pairCode('7');
    const gatewayA = await FakeGateway.create({ pairingCodes: [codeA] });
    const gatewayB = await FakeGateway.create({ pairingCodes: [codeB] });
    const controller = await unlockedController();
    try {
      const first = await controller.pair(pairingPayload(gatewayA, codeA, GATEWAY_A, 'pc-a'));
      assert.equal(first.ok, true, JSON.stringify(first));
      const fresh: { pairing: ReturnType<Controller['pair']> | null } = { pairing: null };

      const entered = deferred<void>();
      let armed = true;
      store.__delayDelete(`${TOKEN_PREFIX}${GATEWAY_A}`, 300, () => {
        if (!armed) return;
        armed = false;
        // Parked inside the forget's delete: a fresh pairing for another computer starts.
        fresh.pairing = controller.pair(pairingPayload(gatewayB, codeB, GATEWAY_B, 'pc-b'));
        entered.resolve();
      });
      const forget = controller.forget();
      await entered.promise;
      assert.ok(fresh.pairing !== null, 'the newer pairing started');
      store.__clearDeleteDelay();
      const result = await fresh.pairing;
      await forget;

      // The forget deleted only A; the newer pair owns the host, the record list and the socket.
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(tokenEntries().some(([key]) => key === `${TOKEN_PREFIX}${GATEWAY_A}`), false);
      assert.equal(tokenEntries().some(([key]) => key === `${TOKEN_PREFIX}${GATEWAY_B}`), true);
      assert.deepEqual(storedHosts().map((host) => host.gatewayId), [GATEWAY_B]);
      assert.deepEqual(controller.snapshot().hosts.map((host) => host.gatewayId), [GATEWAY_B]);
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_B);
      // A stale forget may clear an informational flag, but it never installs a host or a socket.
      assert.equal(controller.snapshot().banner, 'none');
      await waitFor(() => gatewayB.openConnectionCount === 1, { label: 'the newer pairing stays live' });
      assert.equal(gatewayA.openConnectionCount, 0);
    } finally {
      controller.stop();
      await gatewayA.close();
      await gatewayB.close();
    }
  });

  it('M5: forgetting a host that was never paired cancels the pairing in flight (no credential survives)', async () => {
    const code = pairCode('8');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = await unlockedController();
    try {
      // The host list is still loading: `start()` has not installed anything yet, so the active
      // host is null when the forget runs, and the pairing attempt is the only target.
      store.__delay(HOSTS_KEY, 200);
      const pending = controller.start();
      store.__clearDelay();
      const pairing = controller.pair(pairingPayload(gateway, code, GATEWAY_A, 'pc-a'));
      await waitFor(() => tokenEntries().length === 1, { label: 'the cancelled attempt persisted its token' });
      await controller.forget();
      await pending;
      const result = await pairing;

      assert.equal(result.ok, false);
      // Mid-chain: the attempt had a revision when the forget was invoked, so it is forgotten as
      // that instance, and the delete runs after the token write already in the chain.
      assert.deepEqual(tokenEntries(), []);
      assert.deepEqual(storedHosts(), []);
      assert.equal(controller.snapshot().activeHost, null);
      await waitFor(() => gateway.openConnectionCount === 0, { label: 'the cancelled pairing closed' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  // -------------------------------------------------------------------------
  // Start/stop lifecycle (reviewer finding): `start()` reads the stored host list across an await,
  // so a stop (unmount, or the retry `StartupSequence` runs) or a second start can land meanwhile.
  // The listeners belong to the lifecycle that registered them; the gate's own sequencing
  // (`src/core/startup.ts`) keeps those calls ordered, so nothing here races an unlock.
  // -------------------------------------------------------------------------

  it('M5: a stop during the stored host read installs no host, listener or socket', async () => {
    const code = pairCode('9');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    // A paired host is on disk, so a late start result would be visible if it were applied. Only
    // the record is seeded (a pairing without the unlock gate), never a live socket.
    const seeding = new AppController({ locale: () => 'en', transport: nodeTransport, pairAckTimeoutMs: 400 });
    const paired = await seeding.pair(pairingPayload(gateway, code, GATEWAY_A, 'pc-a'));
    assert.equal(paired.ok, true, JSON.stringify(paired));
    seeding.stop();

    // Only this start's read is delayed; earlier harness reads were delayed by their own tests.
    store.__clearDelay();
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport, pairAckTimeoutMs: 400 });
    const entered = deferred<void>();
    store.__delay(HOSTS_KEY, 250, () => entered.resolve());
    const starting = controller.start();
    await entered.promise; // the host list read is in flight
    controller.stop();
    await starting;
    store.__clearDelay();
    await controller.unlock();

    const snapshot = controller.snapshot();
    assert.equal(snapshot.hosts.length, 0, 'the stopped start never installed the stored host');
    assert.equal(snapshot.activeHost, null);
    assert.equal(snapshot.activeHost, null);
    assert.equal(snapshot.hosts.length, 0);
    assert.equal(snapshot.loading, true, 'the late read did not finish the load');
    assert.notEqual(snapshot.connection, 'ready');
    assert.equal(gateway.openConnectionCount, 0, 'a stopped controller never opens a socket');
    controller.stop();
    await gateway.close();
  });

  it('M5: the start that wins installs its listeners once, and a later stop removes them', async () => {
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport, pairAckTimeoutMs: 400 });
    const entered = deferred<void>();
    let reads = 0;
    store.__delay(HOSTS_KEY, 150, () => {
      reads += 1;
      entered.resolve();
    });
    const firstStart = controller.start();
    await entered.promise;
    // A second start while the first read is in flight joins it: `started` latches before the
    // first await, so the host list is read exactly once.
    const secondStart = controller.start();
    await Promise.all([firstStart, secondStart]);
    assert.equal(reads, 1, 'the stored host list was read once');
    store.__clearDelay();
    // The gate resumes the deep link after unlock (A020); no host is paired here, so nothing
    // connects and the notification listener is the only thing that can route the URL.
    await controller.unlock();

    notifications.emitNotificationResponse('dshcompanion://s/s-foreground-race');
    await waitFor(() => controller.snapshot().openSessionId === 's-foreground-race', { label: 'deep link routed' });

    controller.stop();
    notifications.emitNotificationResponse('dshcompanion://s/s-after-stop');
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The stopped lifecycle detached its notification listener: the second URL is never handled.
    assert.equal(controller.snapshot().openSessionId, 's-foreground-race', 'a stopped controller is unsubscribed');
  });

  it('M9: a failing install-id read is a typed pairing failure, not an unhandled throw', async () => {
    const code = pairCode('M');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport, pairAckTimeoutMs: 400 });
    try {
      installId.clearInstallIdCache();
      store.__failGet('dsh-companion.install-id', 'keychain unavailable');
      const result = await controller.pair(pairingPayload(gateway, code));

      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'client/bad-message');
      assert.equal(controller.snapshot().pairing?.kind, 'connect');
      // The failure happened before anything reached the host or the store.
      assert.equal(gateway.connectionAttempts, 0);
      assert.deepEqual(tokenEntries(), []);
      assert.equal(controller.snapshot().activeHost, null);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});
