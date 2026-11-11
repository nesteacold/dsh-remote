// AppController tests: pairing -> unlock -> list -> open -> decide -> reconnect, against the
// fake gateway, with the platform adapters replaced by the node stubs (see stub-platform.ts).
//
// These cover the wiring the screens rely on:
//   * the credential is only read after `unlock()` and lives only in the secure store;
//   * pairing stores the token from `paired` and reconnects with it;
//   * an approval push sets the badge and, while backgrounded, raises ONE local notification
//     carrying ids only (FR-010);
//   * approve echoes argsHash; hash-mismatch -> review again; not-pending -> already decided;
//   * close 4004 stops reconnecting; 4401 wipes the credential;
//   * a prompt's `clientMsgId` is scoped by the persisted install id (the host's at-most-once
//     dedup key must not collide across restarts or devices), and falls back to the portable core
//     generator while no install id is known.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AppController, createInstallScopedClientMsgId } from '../src/app-state';
import { CoreError, Outbox, encodePairingPayload, type OutboxFrame, type PairingPayload, type Transport } from '../src/core';
import { getInstallId } from '../src/platform/install-id';
import { PinnedTransport, type CreatePinnedTransportOptions } from '../src/platform/pinned-transport';
import { CREDENTIAL_CLEANUP_FAILED } from '../src/platform/secure-store';
import type { PinnedWsAdapter, PinnedWsEventName } from '../modules/pinned-ws';
import { emitAppState, resetAppState } from './support/stubs/react-native.stub';
import { resetLocalAuthentication } from './support/stubs/expo-local-authentication.stub';
import { resetNotifications, scheduledNotifications } from './support/stubs/expo-notifications.stub';
import { failTokenDeletes, resetSecureStore, secureStoreEntries } from './support/stubs/expo-secure-store.stub';
import { FakeGateway } from './support/fake-gateway';
// Spec 011 — the authoring decisions the UI derives from the snapshot, exercised through a real
// pairing so the fixture really sends `hello.device.scopes`.
import { parseWorkspaceItems } from '../src/app-state';
import { reconnectInProgress } from '../src/app-state';
import {
  grantState,
  newSessionAvailability,
  shouldShowModelPill,
  workspaceDetail,
  workspaceLabel,
} from '../src/ui/components/authoring';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { waitFor } from './support/wait';

const NOW = Date.now();

/**
 * The app ships with the PinnedTransport placeholder (A030 pending). Tests inject the Node
 * pinned transport, which implements the same contract (fingerprint compared before `open`).
 */
const nodeTransport = () => new NodePinnedTransport({ handshakeTimeoutMs: 4_000 });

function pairingPayload(gateway: FakeGateway, code: string, name = 'my-pc'): string {
  const payload: PairingPayload = {
    version: 3,
    publicUrl: gateway.endpoint,
    pairingCode: code,
    expiresAt: NOW + 240_000,
    certSha256: gateway.certSha256,
    gatewayId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    gatewayName: name,
    endpoints: [gateway.endpoint],
  };
  return encodePairingPayload(payload);
}

function pairCode(letter: string): string {
  // `parsePairingQr` requires the *canonical* unpadded base64url of 32 bytes: 43 characters
  // whose last one has its two spare bits zero (only A E I M Q U Y c g k o s w 0 4 8 qualify).
  const canonical = ['A', 'E', 'I', 'M', 'Q', 'U', 'Y', 'c', 'g', 'k', 'o', 's', 'w', '0', '4', '8'];
  const index = Math.abs(letter.charCodeAt(0) - 'A'.charCodeAt(0)) % canonical.length;
  return 'A'.repeat(42) + (canonical[index] as string);
}

/** Gateway rule (`plugins/mobile-gateway/lib/index.mjs:4447-4452`): trimmed, 1..128 chars, one line. */
function assertAcceptableClientMsgId(id: string): void {
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0, 'the id is not empty');
  assert.ok(id.length <= 128, `the id fits the gateway limit (${id.length} chars)`);
  assert.equal(id, id.trim(), 'the host trims, so edge whitespace would desync the dedup key');
  assert.equal(/[\r\n]/.test(id), false, 'an id must never contain a line break');
}

describe('AppController against the fake gateway', () => {
  let gateway: FakeGateway;

  beforeEach(async () => {
    resetSecureStore();
    resetAppState('active');
    resetLocalAuthentication();
    resetNotifications(true);
    gateway = await FakeGateway.create({});
  });

  afterEach(async () => {
    await gateway.close();
  });

  async function pairedController(code = pairCode('A'), name = 'my-pc') {
    gateway.addPairingCode(code);
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport });
    await controller.start();
    const result = await controller.pair(pairingPayload(gateway, code, name));
    assert.equal(result.ok, true, JSON.stringify(result));
    await controller.unlock();
    return controller;
  }

  it('stores the token only in the secure store and lists sessions after unlock', async () => {
    const controller = await pairedController();
    try {
      await waitFor(() => controller.snapshot().sessions.length >= 3, { label: 'sessions listed' });
      const snapshot = controller.snapshot();
      assert.equal(snapshot.unlocked, true);
      assert.equal(snapshot.activeHost?.name, 'my-pc');
      const entries = secureStoreEntries();
      const tokenEntry = entries.find(([key]) => key.startsWith('dsh-companion.token.'));
      assert.ok(tokenEntry !== undefined, 'token stored');
      assert.match(tokenEntry[1], /^tok-\d+$/);
      // The host record saved beside it has no token in it.
      const hostEntry = entries.find(([key]) => key === 'dsh-companion.hosts');
      assert.equal(hostEntry?.[1].includes('tok-'), false);
      assert.equal(snapshot.sessions.some((s) => s.id === 's-running'), true);
    } finally {
      controller.stop();
    }
  });

  it('sets the needs-decision badge and notifies once while backgrounded', async () => {
    const controller = await pairedController(pairCode('B'));
    try {
      await waitFor(() => controller.snapshot().sessions.length >= 3, { label: 'sessions listed' });
      emitAppState('background');
      gateway.pushApprovalRequested({
        approvalId: 'ap-1',
        rpcId: 'rpc-1',
        sessionId: 's-running',
        toolName: 'bash',
        argsHash: 'a'.repeat(64),
        argsPreview: '{"command":"ls"}',
      });
      await waitFor(() => (controller.snapshot().needsDecision['s-running'] ?? 0) === 1, { label: 'badge' });
      await waitFor(() => scheduledNotifications().length === 1, { label: 'notification' });
      const notification = scheduledNotifications()[0];
      assert.ok(notification !== undefined);
      // Ids only: no arguments, no preview, no secrets.
      assert.deepEqual(Object.keys(notification.data).sort(), ['approvalId', 'rpcId', 'sessionId', 'url']);
      assert.equal(notification.body.includes('ls'), false);
      assert.equal(notification.data.url, 'dshcompanion://s/s-running?a=ap-1');
      // A duplicate push (reconnect replay) must not notify again.
      gateway.pushApprovalRequested({
        approvalId: 'ap-1',
        rpcId: 'rpc-1',
        sessionId: 's-running',
        toolName: 'bash',
        argsHash: 'a'.repeat(64),
      }, { replay: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(scheduledNotifications().length, 1);
    } finally {
      controller.stop();
    }
  });

  it('does not notify while the app is in the foreground', async () => {
    const controller = await pairedController(pairCode('C'));
    try {
      await waitFor(() => controller.snapshot().sessions.length >= 3, { label: 'sessions listed' });
      gateway.pushApprovalRequested({
        approvalId: 'ap-1',
        rpcId: 'rpc-1',
        sessionId: 's-running',
        toolName: 'bash',
        argsHash: 'a'.repeat(64),
      });
      await waitFor(() => (controller.snapshot().needsDecision['s-running'] ?? 0) === 1, { label: 'badge' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(scheduledNotifications().length, 0);
    } finally {
      controller.stop();
    }
  });

  it('decides an approval with the exact argsHash and records the hash-mismatch refusal', async () => {
    const controller = await pairedController(pairCode('D'));
    try {
      await waitFor(() => controller.snapshot().sessions.length >= 3, { label: 'sessions listed' });
      const hash = 'c'.repeat(64);
      gateway.pushApprovalRequested({
        approvalId: 'ap-ok',
        rpcId: 'rpc-ok',
        sessionId: 's-running',
        toolName: 'bash',
        argsHash: hash,
      });
      controller.openSession('s-running');
      await waitFor(() => controller.snapshot().openApprovals.some((card) => card.approvalId === 'ap-ok'), {
        label: 'card visible',
      });
      await controller.decideApproval('ap-ok', 'allowed-once');
      await waitFor(
        () => controller.snapshot().openApprovals.some((card) => card.approvalId === 'ap-ok' && card.status === 'resolved'),
        { label: 'approved' },
      );
      assert.equal(gateway.approvalReceipts.at(-1)?.argsHash, hash);
      assert.equal(gateway.approvalReceipts.at(-1)?.outcome, 'allowed-once');

      // Changed server-side: the old hash is refused with hash-mismatch -> review again.
      gateway.addApproval({ approvalId: 'ap-changed', rpcId: 'rpc-changed', sessionId: 's-running', toolName: 'bash', argsHash: hash });
      // Re-subscribe replays the pending card (`subscribe` -> `approval-requested`, replay).
      controller.closeSession();
      controller.openSession('s-running');
      await waitFor(() => controller.snapshot().openApprovals.some((card) => card.approvalId === 'ap-changed'), {
        label: 'changed card visible',
      });
      gateway.changeApprovalArgsHash('ap-changed', 'd'.repeat(64));
      await controller.decideApproval('ap-changed', 'rejected');
      await waitFor(
        () => controller.snapshot().openApprovals.some((card) => card.approvalId === 'ap-changed' && card.status === 'review-again'),
        { label: 'review again' },
      );
      // Reloading reopens it for review with the new hash.
      await controller.reloadApproval('ap-changed');
      const reloaded = controller.snapshot().openApprovals.find((card) => card.approvalId === 'ap-changed');
      assert.equal(reloaded?.argsHash, 'd'.repeat(64));
      assert.equal(reloaded?.canApprove, true);
    } finally {
      controller.stop();
    }
  });

  it('sends a prompt with a stable clientMsgId and confirms the optimistic row', async () => {
    const controller = await pairedController(pairCode('E'));
    try {
      await waitFor(() => controller.snapshot().sessions.length >= 3, { label: 'sessions listed' });
      controller.openSession('s-running');
      await waitFor(() => controller.snapshot().history.length === 2, { label: 'history' });
      await controller.sendPrompt('please continue');
      await waitFor(() => gateway.promptApplications.length === 1, { label: 'prompt applied' });
      const applied = gateway.promptApplications[0];
      assert.equal(applied?.text, 'please continue');
      // `pair()` awaited the install id, so every prompt of this installation carries it as the
      // first component (the stable part of the host's at-most-once dedup key).
      const installId = await getInstallId();
      assert.ok((applied?.clientMsgId ?? '').startsWith(`${installId}.`), 'the install id scopes the id');
      assertAcceptableClientMsgId(applied?.clientMsgId ?? '');
      await waitFor(() => controller.snapshot().outgoing.length === 0, { label: 'outbox drained' });
      assert.equal(controller.snapshot().history.some((m) => m.id === applied?.clientMsgId), true);
    } finally {
      controller.stop();
    }
  });

  it('stops reconnect and reports the banner on close 4004', async () => {
    const controller = await pairedController(pairCode('F'));
    try {
      await waitFor(() => controller.snapshot().sessions.length >= 3, { label: 'sessions listed' });
      gateway.closeAll(4004, 'gateway-disabled');
      await waitFor(() => controller.snapshot().banner === 'gateway-off', { label: 'gateway-off banner' });
      assert.equal(controller.snapshot().remoteControlOff, true);
    } finally {
      controller.stop();
    }
  });

  it('wipes the credential on revocation (close 4401)', async () => {
    const controller = await pairedController(pairCode('G'));
    try {
      await waitFor(() => controller.snapshot().sessions.length >= 3, { label: 'sessions listed' });
      gateway.closeAll(4401, 'revoked');
      await waitFor(() => controller.snapshot().activeHost === null, { label: 'host forgotten' });
      assert.equal(secureStoreEntries().some(([key]) => key.startsWith('dsh-companion.token.')), false);
      assert.equal(controller.snapshot().banner, 'revoked');
    } finally {
      controller.stop();
    }
  });

  it('surfaces a remote-control-off pairing failure', async () => {
    const code = pairCode('H');
    gateway.addPairingCode(code);
    const offGateway = await FakeGateway.create({ pairingCodes: [code], upgradeStatus: 403 });
    try {
      const controller = new AppController({ locale: () => 'en', transport: nodeTransport });
      await controller.start();
      const result = await controller.pair(pairingPayload(offGateway, code));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'client/disconnected');
      assert.equal(controller.snapshot().pairing?.kind, 'connect');
      controller.stop();
    } finally {
      await offGateway.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Reviewer regressions: M5 (lock), M6 (retry wiring), M9 (pairing), M10 (approvals).
// ---------------------------------------------------------------------------

describe('AppController connection lifecycle (M5 / M6)', () => {
  let gateway: FakeGateway;

  beforeEach(async () => {
    resetSecureStore();
    resetAppState('active');
    resetLocalAuthentication();
    resetNotifications(true);
    gateway = await FakeGateway.create({});
  });

  afterEach(async () => {
    await gateway.close();
  });

  async function pairedController(code = pairCode('A')) {
    gateway.addPairingCode(code);
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport });
    await controller.start();
    const result = await controller.pair(pairingPayload(gateway, code));
    assert.equal(result.ok, true, JSON.stringify(result));
    await controller.unlock();
    await waitFor(() => controller.snapshot().sessions.length >= 3, { label: 'sessions listed' });
    return controller;
  }

  it('M5: lock closes the socket, stops the retry loop and leaves no token-bearing closure', async () => {
    const controller = await pairedController(pairCode('I'));
    try {
      assert.equal(gateway.openConnectionCount, 1);
      assert.equal(controller.snapshot().reconnect?.state, 'live');

      controller.lock();

      const locked = controller.snapshot();
      assert.equal(locked.unlocked, false);
      assert.notEqual(locked.connection, 'ready');
      assert.equal(locked.reconnect, null);
      await waitFor(() => gateway.openConnectionCount === 0, { label: 'socket closed on lock' });

      // A locked app must not reconnect on its own.
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(gateway.openConnectionCount, 0);
      assert.notEqual(controller.snapshot().connection, 'ready');
    } finally {
      controller.stop();
    }
  });

  it('M5: unlocking after a lock reconnects with the stored token', async () => {
    const controller = await pairedController(pairCode('J'));
    try {
      controller.lock();
      await waitFor(() => gateway.openConnectionCount === 0, { label: 'socket closed' });
      await controller.unlock();
      await waitFor(() => gateway.openConnectionCount === 1, { label: 'reconnected' });
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'ready again' });
      assert.equal(controller.snapshot().sessions.length >= 3, true);
    } finally {
      controller.stop();
    }
  });

  it('M5: a lock while the token read is awaited discards that read (no socket)', async () => {
    const controller = await pairedController(pairCode('K'));
    try {
      controller.lock();
      await waitFor(() => gateway.openConnectionCount === 0, { label: 'socket closed' });

      // `unlock()` awaits the secure-store read; the lock lands before it resumes.
      const unlocking = controller.unlock();
      controller.lock();
      await unlocking;
      await new Promise((resolve) => setTimeout(resolve, 400));

      assert.equal(controller.snapshot().unlocked, false);
      assert.equal(controller.snapshot().connection, 'idle');
      assert.equal(gateway.openConnectionCount, 0);
    } finally {
      controller.stop();
    }
  });

  it('M6: ready drives the retry loop live, and a drop reconnects with a fresh resync', async () => {
    const controller = await pairedController(pairCode('L'));
    try {
      assert.equal(controller.snapshot().reconnect?.state, 'live');
      assert.equal(controller.snapshot().reconnect?.attempt, 0);

      // Only the host knows the new list: seeing it proves `resync` ran through the retry loop.
      gateway.setSessions([
        { id: 's-after-reconnect', title: 'Fresh after reconnect', state: 'running', updatedAt: Date.now() },
      ]);
      gateway.dropAllConnections();

      await waitFor(() => controller.snapshot().sessions.some((session) => session.id === 's-after-reconnect'), {
        timeoutMs: 8_000,
        label: 'resync after reconnect',
      });
      assert.equal(controller.snapshot().reconnect?.state, 'live');
      assert.equal(controller.snapshot().reconnect?.attempt, 0);
      assert.equal(controller.snapshot().banner, 'none');
      assert.equal(gateway.openConnectionCount, 1);
    } finally {
      controller.stop();
    }
  });

  it('M6: returning to the foreground never connects an already-ready client', async () => {
    const controller = await pairedController(pairCode('M'));
    try {
      const connectionsBefore = gateway.connectionCount;

      emitAppState('background');
      emitAppState('active');
      await new Promise((resolve) => setTimeout(resolve, 1_400));

      // No extra attempt, no flip into "reconnecting", still exactly one live socket.
      assert.equal(gateway.connectionCount, connectionsBefore);
      assert.equal(gateway.openConnectionCount, 1);
      assert.equal(controller.snapshot().reconnect?.state, 'live');
      assert.equal(controller.snapshot().banner, 'none');
      assert.notEqual(controller.snapshot().lastError?.code, 'client/bad-state');
    } finally {
      controller.stop();
    }
  });

  it('M6/F1: a native 401 ends in reauth-required, stops the retry loop and leaves an honest snapshot', async () => {
    const code = pairCode('P');
    gateway.addPairingCode(code);
    /** The `pinned-ws` native module while the host refuses the upgrade with HTTP 401. */
    const native = refusingUpgradeModule();
    let refuse = false;
    /** Set when the controller hands its reporter to the transport layer (F1 wiring). */
    let sawListenerReporter = false;
    const transport = (options: CreatePinnedTransportOptions = {}): Transport => {
      if (typeof options.onListenerFailure === 'function') sawListenerReporter = true;
      return refuse ? new PinnedTransport({ module: native.adapter, ...options }) : nodeTransport();
    };
    const controller = new AppController({ locale: () => 'en', transport });
    try {
      await controller.start();
      // Pair while the gate is closed: the one-time socket succeeds, no bearer socket is opened.
      const paired = await controller.pair(pairingPayload(gateway, code));
      assert.equal(paired.ok, true, JSON.stringify(paired));
      // From now on the host refuses this device's credential at the upgrade (401).
      refuse = true;
      await controller.unlock();
      await waitFor(
        () => controller.snapshot().connection === 'reauth-required' && controller.snapshot().banner === 'reauth',
        { label: 'native 401 handled' },
      );
      assert.equal(native.refusedCount(), 1);
      assert.equal(sawListenerReporter, true, 'the transport got the app listener-failure reporter');

      const snapshot = controller.snapshot();
      const host = snapshot.activeHost;
      assert.ok(host !== null, 'a 401 keeps the pairing (only a revocation wipes it)');
      // The whole snapshot: the banner is set (F4), and the retry loop is stopped rather than
      // left `connecting` on a host that will refuse the same credential forever.
      assert.deepEqual(snapshot, {
        unlocked: true,
        hosts: [host],
        activeHost: host,
        connection: 'reauth-required',
        banner: 'reauth',
        loading: true,
        sessions: [],
        hiddenOlderCount: 0,
        needsDecision: {},
        openSessionId: null,
        openApprovals: [],
        history: [],
        historyHasMore: false,
        // Spec 011 follow-up: the older-history affordance now follows the cursor, and its load state
        // is explicit so a failure is shown rather than swallowed. Nothing was fetched here.
        historyHasEarlier: false,
        historyLoading: false,
        historyError: null,
        outgoing: [],
        remoteControlOff: false,
        updateRequired: null,
        reconnect: { state: 'stopped', attempt: 0, lastDelayMs: null },
        pairing: null,
        pairingPending: null,
        pinnedTransportUnavailable: false,
        // Spec 011: the snapshot gained the authoring fields. In this state the credential was
        // refused at the upgrade, so there is no live device (grantedScopes is UNKNOWN, not a
        // grant) and nothing was fetched. This guard is updated rather than relaxed: the whole
        // snapshot is still asserted exhaustively.
        grantedScopes: [],
        workspaces: [],
        workspacesState: 'idle',
        workspacesError: null,
        models: [],
        currentModel: null,
        // Spec 011: the model catalog's own load state, added so a refusal is explainable instead of
        // looking like "this host has no models". In this state nothing was fetched.
        modelsState: 'idle',
        modelsError: null,
        lastError: null,
        locale: 'en',
      });
      // The token is kept (a 401 is not a revocation), so unlocking again is possible.
      assert.equal(secureStoreEntries().some(([key]) => key.startsWith('dsh-companion.token.')), true);
    } finally {
      controller.stop();
    }
  });

  it('Spec 011: granted scopes from hello.device.scopes enable New session, and it really creates', async () => {
    const code = pairCode('G');
    // The fixture only advertises scopes when the option is set — this is the granted path.
    const granted = await FakeGateway.create({ pairingCodes: [code], deviceScopes: ['sessions:read', 'sessions:author'] });
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport });
    try {
      await controller.start();
      const paired = await controller.pair(pairingPayload(granted, code));
      assert.equal(paired.ok, true, JSON.stringify(paired));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'ready' });

      const snap = controller.snapshot();
      assert.deepEqual([...snap.grantedScopes], ['sessions:read', 'sessions:author'], 'scopes come from hello');
      assert.equal(grantState(snap.grantedScopes), 'granted');

      await controller.listWorkspaces();
      const loaded = controller.snapshot();
      const workspace = loaded.workspaces[0];
      assert.ok(workspace !== undefined, 'the fixture serves workspaces');
      assert.deepEqual(
        newSessionAvailability({
          grantedScopes: loaded.grantedScopes,
          workspaceId: workspace.id,
          state: { status: loaded.workspacesState },
          workspaceCount: loaded.workspaces.length,
        }),
        { enabled: true, reason: null },
        'with the grant, a ready list and a chosen workspace the action is enabled',
      );

      // The enabled path really works: create, then the new session is openable (it is listed).
      const created = await controller.createSession({ workspaceId: workspace.id });
      assert.equal(created.ok, true);
      const sessionId = created.ok ? created.value : '';
      assert.match(sessionId, /^sess-created-/);
      await waitFor(() => controller.snapshot().sessions.some((session) => session.id === sessionId), {
        label: 'the created session is in the list the screen navigates from',
      });

      // The EXACT measured per-session `models` frame, through the real snapshot path:
      //   { current: { provider, model }, routable, groups: [{ id, name, models: [{ id, name }] }], failures }
      // (catalog.js + dsh-host-adapter.mjs:364-376). Assertions are the three things that were wrong
      // or unproven before: the provider id comes from `group.id`, the human label comes from the
      // catalog entry's `name` (because `current` carries no label), and the composer's pill gate agrees.
      await controller.listModels('sess-alpha');
      const withModels = controller.snapshot();
      assert.equal(withModels.modelsState, 'ready');
      assert.equal(withModels.modelsError, null);
      assert.ok(withModels.models.length > 0, 'a real groups reply must parse non-empty');
      assert.deepEqual(withModels.models[0], {
        id: 'deepseek-v4-flash',
        label: 'DeepSeek-V4-Flash',
        provider: 'deepseek',
      }, 'provider is inherited from group.id, label from the entry name');
      assert.equal(withModels.models[1]?.provider, 'deepseek', 'every row carries the group provider id');
      assert.equal(withModels.currentModel?.id, 'deepseek-v4-flash', 'current.model resolves');
      assert.equal(withModels.currentModel?.label, 'DeepSeek-V4-Flash', 'label back-filled from the catalog');
      assert.equal(
        shouldShowModelPill({ currentModel: withModels.currentModel, hasCatalog: withModels.models.length > 0 }),
        true,
        'with a real catalog the composer pill is shown',
      );
    } finally {
      controller.stop();
      await granted.close();
    }
  });

  it('Spec 011: scopes WITHOUT sessions:author are denied, and no authoring frame is sent', async () => {
    const code = pairCode('D');
    const denied = await FakeGateway.create({ pairingCodes: [code], deviceScopes: ['sessions:read', 'prompt:send'] });
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport });
    try {
      await controller.start();
      assert.equal((await controller.pair(pairingPayload(denied, code))).ok, true);
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'ready' });

      const snap = controller.snapshot();
      assert.deepEqual([...snap.grantedScopes], ['sessions:read', 'prompt:send']);
      assert.equal(grantState(snap.grantedScopes), 'denied');
      assert.deepEqual(
        newSessionAvailability({
          grantedScopes: snap.grantedScopes,
          workspaceId: 'ws-anything',
          state: { status: 'ready' },
          workspaceCount: 2,
        }),
        { enabled: false, reason: 'authoring.needScope' },
        'the denial reason is shown, not the neutral one',
      );
      // The screen gates on `availability.enabled`, so nothing may have gone out on the wire.
      const authoringFrames = denied.allReceivedFrames
        .filter((frame) => /"type":"(workspaces|session-create|models|select-model)"/.test(frame));
      assert.deepEqual(authoringFrames, [], 'a denied device sends no authoring request');
    } finally {
      controller.stop();
      await denied.close();
    }
  });

  it('Spec 011: an older gateway that reports no scopes is UNKNOWN, never denied', async () => {
    const code = pairCode('U');
    const legacy = await FakeGateway.create({ pairingCodes: [code] }); // no deviceScopes => absent
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport });
    try {
      await controller.start();
      assert.equal((await controller.pair(pairingPayload(legacy, code))).ok, true);
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'ready' });

      const snap = controller.snapshot();
      assert.deepEqual([...snap.grantedScopes], [], 'no reported scopes');
      assert.equal(grantState(snap.grantedScopes), 'unknown');
      assert.deepEqual(
        newSessionAvailability({
          grantedScopes: snap.grantedScopes,
          workspaceId: 'ws-anything',
          state: { status: 'ready' },
          workspaceCount: 2,
        }),
        { enabled: false, reason: 'authoring.scopeUnknown' },
        'the neutral reason is shown, never the denial copy',
      );
    } finally {
      controller.stop();
      await legacy.close();
    }
  });

  it('Spec 011: a workspace with no path renders from its name alone', () => {
    // The gateway will return `{ id, name }` with no `path` for author-only devices.
    const parsed = parseWorkspaceItems({ items: [{ id: 'ws-1', name: 'Author Only' }] });
    assert.deepEqual(parsed, [{ id: 'ws-1', name: 'Author Only' }]);
    const workspace = parsed[0];
    assert.ok(workspace !== undefined);
    assert.equal(workspaceLabel(workspace), 'Author Only', 'the row shows the name');
    assert.equal(workspaceDetail(workspace), null, 'no path => no second line, and nothing is invented');
    // A nameless row still renders (id as the label), so the picker never shows a blank row.
    assert.equal(workspaceLabel({ id: 'ws-2' }), 'ws-2');
    // End to end from the wire: a row carrying NEITHER name NOR path must still produce a visible
    // label (the gateway now sends `name` as a human label and may send nothing else at all).
    const bare = parseWorkspaceItems({ items: [{ id: 'ws-3' }] })[0];
    assert.ok(bare !== undefined);
    assert.equal(workspaceLabel(bare), 'ws-3', 'a bare row falls back to its id, never an empty row');
    assert.equal(workspaceDetail(bare), null);
    // And a name-only row is exactly what the gateway sends now: the human label is what is shown.
    const named = parseWorkspaceItems({ items: [{ id: 'ws-4', name: 'DiskTree' }] })[0];
    assert.ok(named !== undefined);
    assert.equal(workspaceLabel(named), 'DiskTree', 'the human label is rendered as-is');
  });

  it('a healthy ready link is NOT reported as reconnecting', async () => {
    const controller = await pairedController(pairCode('R'));
    try {
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'ready' });
      // The retry loop's state object exists for the whole life of a connection; `'live'` is its
      // healthy value. Reading non-nullness as "reconnecting" disabled "New session" forever on a
      // perfectly healthy link (device defect), so the predicate is asserted explicitly here.
      const snapshot = controller.snapshot();
      assert.equal(snapshot.reconnect?.state, 'live', 'a ready link is watched by a live loop');
      assert.equal(reconnectInProgress(snapshot.reconnect), false, 'live is NOT a reconnect in progress');
    } finally {
      controller.stop();
    }
  });

  it('Spec 011: forgetting a computer clears its workspaces, models and selected model', async () => {
    const controller = await pairedController(pairCode('W'));
    try {
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'connection ready' });
      // The fixture serves `workspaces`, so this exercises the real request -> snapshot path.
      await controller.listWorkspaces();
      const loaded = controller.snapshot();
      assert.equal(loaded.workspacesState, 'ready');
      assert.ok(loaded.workspaces.length > 0, 'the fixture must serve at least one workspace');
      await controller.forget();
      const after = controller.snapshot();
      assert.deepEqual(after.workspaces, [], 'a forgotten computer keeps no workspaces');
      assert.equal(after.workspacesState, 'idle');
      assert.equal(after.workspacesError, null);
      assert.deepEqual(after.models, []);
      assert.equal(after.currentModel, null);
      assert.deepEqual(after.grantedScopes, [], 'no live device => scopes are UNKNOWN, not inherited');
    } finally {
      controller.stop();
    }
  });

  it('F2: a revocation whose credential delete fails is reported, never hidden, and never resurrected', async () => {
    const controller = await pairedController(pairCode('O'));
    try {
      const attemptsBefore = gateway.connectionAttempts;
      failTokenDeletes(); // the store rejects every delete from now on
      gateway.closeAll(4401, 'revoked');

      await waitFor(() => controller.snapshot().banner === 'cleanup-failed', { label: 'cleanup failure reported' });
      const revoked = controller.snapshot();
      assert.equal(revoked.activeHost, null);
      assert.deepEqual(revoked.hosts, []);
      assert.equal(revoked.lastError?.code, CREDENTIAL_CLEANUP_FAILED);
      // The credential could not be destroyed (that is the failure) but it is never used: the
      // host record is gone, so nothing reconnects with it.
      assert.equal(
        secureStoreEntries().some(([key, value]) => key.startsWith('dsh-companion.token.') && /^tok-\d+$/.test(value)),
        true,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(gateway.connectionAttempts, attemptsBefore);

      // A restart must not resurrect a usable credential: the host list is what "paired" means,
      // and it was dropped before the failed delete, so the orphaned token is never read.
      const restarted = new AppController({ locale: () => 'en', transport: nodeTransport });
      await restarted.start();
      try {
        assert.deepEqual(restarted.snapshot().hosts, []);
        assert.equal(restarted.snapshot().activeHost, null);
        await restarted.unlock();
        assert.equal(gateway.connectionAttempts, attemptsBefore);
      } finally {
        restarted.stop();
      }
    } finally {
      controller.stop();
    }
  });
});

/**
 * A `pinned-ws` module whose socket is refused at the upgrade with HTTP 401, exactly what the
 * native side reports after the TLS pin matched and the host rejected the credential.
 */
function refusingUpgradeModule(): { adapter: PinnedWsAdapter; refusedCount: () => number } {
  const listeners = new Map<PinnedWsEventName, Set<(event: unknown) => void>>();
  let refused = 0;
  return {
    adapter: {
      connect: async (id: string) => {
        refused += 1;
        const event = {
          id,
          code: 'client/upgrade-failed',
          message: 'The WebSocket upgrade was refused (HTTP 401)',
          status: 401,
        };
        queueMicrotask(() => {
          for (const listener of [...(listeners.get('onError') ?? [])]) listener(event);
        });
      },
      send: async () => true,
      close: async () => {
        /* no socket to close */
      },
      addListener: (name: PinnedWsEventName, listener: (event: unknown) => void) => {
        const set = listeners.get(name) ?? new Set<(event: unknown) => void>();
        set.add(listener);
        listeners.set(name, set);
        return {
          remove: () => {
            set.delete(listener);
          },
        };
      },
    },
    refusedCount: () => refused,
  };
}

describe('AppController pairing lifecycle (M9)', () => {
  beforeEach(async () => {
    resetSecureStore();
    resetAppState('active');
    resetLocalAuthentication();
    resetNotifications(true);
  });

  it('M9: a host that never sends hello cannot resolve the pairing as success', async () => {
    const code = pairCode('N');
    // A host that sends `paired` and then never completes the handshake.
    const quiet = await FakeGateway.create({ pairingCodes: [code], suppressHello: true });
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport, pairAckTimeoutMs: 300 });
    try {
      await controller.start();
      const result = await controller.pair(pairingPayload(quiet, code));

      // The one-time code was consumed and its token persisted immediately, so recovery is a
      // retry/update, never a fresh QR …
      assert.deepEqual(quiet.consumedPairingCodes, [code]);
      assert.ok(secureStoreEntries().some(([key]) => key.startsWith('dsh-companion.token.')), 'token persisted');
      assert.equal(controller.snapshot().activeHost?.gatewayId, '0f8fad5b-d9cb-469f-a165-70867728950e');
      // … but without the host's accepted hello/client-hello the pairing is not a success.
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'client/timeout');
      assert.notEqual(controller.snapshot().connection, 'ready');
      assert.equal(controller.snapshot().pairing?.kind, 'connect');
    } finally {
      controller.stop();
      await quiet.close();
    }
  });

  it('M9: after "forget", a fresh pairing connects without a lock/unlock cycle', async () => {
    const code = pairCode('W');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport });
    try {
      await controller.start();
      await controller.unlock();
      await controller.pair(pairingPayload(gateway, code));
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'ready' });

      await controller.forget();
      assert.equal(controller.snapshot().activeHost, null);
      await waitFor(() => gateway.openConnectionCount === 0, { label: 'socket closed by forget' });

      const secondCode = pairCode('X');
      gateway.addPairingCode(secondCode);
      const result = await controller.pair(pairingPayload(gateway, secondCode));
      assert.equal(result.ok, true, JSON.stringify(result));
      // The gate owns `unlocked`: forgetting must not leave the app unable to connect.
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'ready after re-pair' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('M9: a failed negotiation after `paired` never strands the one-time code', async () => {
    const code = pairCode('O');
    const futureHost = await FakeGateway.create({ pairingCodes: [code], companionProtocol: 2, minClientVersion: 2 });
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport });
    try {
      await controller.start();
      const result = await controller.pair(pairingPayload(futureHost, code));

      // Whatever the race between `paired` and the rejected `hello`, the code was consumed and
      // its token is kept: recovery is an update + retry, never a fresh QR.
      assert.deepEqual(futureHost.consumedPairingCodes, [code]);
      assert.ok(secureStoreEntries().some(([key]) => key.startsWith('dsh-companion.token.')), 'token persisted');
      await waitFor(() => controller.snapshot().updateRequired?.side === 'app', { label: 'update required' });
      assert.notEqual(controller.snapshot().activeHost, null, 'host record kept for recovery');
      // A host this app cannot talk to is never reported as a successful pairing.
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'client/update-app-required');
      await waitFor(() => futureHost.openConnectionCount === 0, { label: 'no live socket after the refusal' });
    } finally {
      controller.stop();
      await futureHost.close();
    }
  });

  it('M9: pairing leaves exactly one live connection (the authenticated one)', async () => {
    const code = pairCode('P');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport });
    try {
      await controller.start();
      await controller.unlock(); // production order: the gate unlocks, then the user pairs
      const result = await controller.pair(pairingPayload(gateway, code));
      assert.equal(result.ok, true, JSON.stringify(result));
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'authenticated connection ready' });
      // The one-time pairing socket was closed before the bearer connection opened.
      await waitFor(() => gateway.openConnectionCount === 1, { label: 'one live connection' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(gateway.openConnectionCount, 1);
      assert.equal(gateway.consumedPairingCodes.length, 1);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('N7: retrying after a protocol mismatch re-attempts the connection', async () => {    const code = pairCode('T');
    const futureHost = await FakeGateway.create({ pairingCodes: [code], companionProtocol: 2, minClientVersion: 2 });
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport });
    try {
      await controller.start();
      await controller.unlock();
      await controller.pair(pairingPayload(futureHost, code));
      await waitFor(() => controller.snapshot().updateRequired?.side === 'app', { label: 'update required' });

      const attemptsBefore = futureHost.connectionAttempts;
      await controller.retryConnection();
      await waitFor(() => futureHost.connectionAttempts > attemptsBefore, { label: 'retry attempt' });
      // The host still speaks the newer protocol, so the screen keeps asking for an update.
      await waitFor(() => controller.snapshot().updateRequired?.side === 'app', { label: 'still requires update' });
    } finally {
      controller.stop();
      await futureHost.close();
    }
  });

  it('M6/N7: a protocol mismatch on reconnect stops the retry loop instead of retrying forever', async () => {
    const code = pairCode('V');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport });
    try {
      await controller.start();
      await controller.unlock();
      await controller.pair(pairingPayload(gateway, code));
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'ready' });
      await waitFor(() => controller.snapshot().reconnect?.state === 'live', { label: 'retry loop live' });

      // The host is upgraded to a protocol this app cannot speak, and the socket drops.
      gateway.setCompanionProtocol(2, 2);
      gateway.dropAllConnections();
      await waitFor(() => controller.snapshot().updateRequired?.side === 'app', {
        timeoutMs: 8_000,
        label: 'update required after reconnect',
      });

      const attempts = gateway.connectionAttempts;
      await new Promise((resolve) => setTimeout(resolve, 1_600)); // longer than the first backoff
      assert.equal(gateway.connectionAttempts, attempts, 'no reconnect attempts while update-required');
      assert.equal(controller.snapshot().reconnect?.state, 'stopped');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('M9: the pairing fails at the client handshake deadline, not after the longer ack budget', async () => {
    const code = pairCode('Y');
    const gateway = await FakeGateway.create({ pairingCodes: [code], suppressClientHelloAck: true });
    // The ack budget is generous; only the client's own handshake deadline may end the wait.
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 8_000,
      handshakeTimeoutMs: 250,
    });
    try {
      await controller.start();
      await controller.unlock();
      const started = Date.now();
      const result = await controller.pair(pairingPayload(gateway, code));
      const elapsed = Date.now() - started;

      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'client/timeout');
      assert.ok(elapsed < 4_000, `the pairing ended at the client handshake deadline (took ${elapsed} ms)`);
      // The consumed one-time code keeps its token + host record for a retry/update.
      assert.ok(secureStoreEntries().some(([key]) => key.startsWith('dsh-companion.token.')), 'token persisted');
      assert.equal(controller.snapshot().activeHost?.gatewayId, '0f8fad5b-d9cb-469f-a165-70867728950e');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});

describe('AppController approval decisions (M10)', () => {
  let gateway: FakeGateway;

  beforeEach(async () => {
    resetSecureStore();
    resetAppState('active');
    resetLocalAuthentication();
    resetNotifications(true);
    gateway = await FakeGateway.create({});
  });

  afterEach(async () => {
    await gateway.close();
  });

  async function controllerWithApproval(code: string, hash: string) {
    gateway.addPairingCode(code);
    const controller = new AppController({ locale: () => 'en', transport: nodeTransport });
    await controller.start();
    const result = await controller.pair(pairingPayload(gateway, code));
    assert.equal(result.ok, true, JSON.stringify(result));
    await controller.unlock();
    await waitFor(() => controller.snapshot().sessions.length >= 3, { label: 'sessions listed' });
    gateway.pushApprovalRequested({
      approvalId: 'ap-m10',
      rpcId: 'rpc-m10',
      sessionId: 's-running',
      toolName: 'bash',
      argsHash: hash,
    });
    controller.openSession('s-running');
    await waitFor(() => controller.snapshot().openApprovals.some((card) => card.approvalId === 'ap-m10'), {
      label: 'card visible',
    });
    return controller;
  }

  function card(controller: AppController) {
    return controller.snapshot().openApprovals.find((entry) => entry.approvalId === 'ap-m10');
  }

  it('M10: a review-again card cannot be decided again (nothing is sent)', async () => {
    const hash = 'c'.repeat(64);
    const controller = await controllerWithApproval(pairCode('Q'), hash);
    try {
      gateway.changeApprovalArgsHash('ap-m10', 'd'.repeat(64));
      await controller.decideApproval('ap-m10', 'allowed-once');
      await waitFor(() => card(controller)?.status === 'review-again', { label: 'review again' });
      assert.equal(card(controller)?.canApprove, false);

      const receipts = gateway.approvalReceipts.length;
      await controller.decideApproval('ap-m10', 'allowed-once');
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(gateway.approvalReceipts.length, receipts, 'no second decision reached the host');
      assert.equal(card(controller)?.status, 'review-again');
    } finally {
      controller.stop();
    }
  });

  it('M10: reload reopens the card only from a fresh server view', async () => {
    const hash = 'e'.repeat(64);
    const controller = await controllerWithApproval(pairCode('R'), hash);
    try {
      gateway.changeApprovalArgsHash('ap-m10', 'f'.repeat(64));
      await controller.decideApproval('ap-m10', 'rejected');
      await waitFor(() => card(controller)?.status === 'review-again', { label: 'review again' });

      await controller.reloadApproval('ap-m10');
      const reopened = card(controller);
      assert.equal(reopened?.status, 'pending');
      assert.equal(reopened?.argsHash, 'f'.repeat(64));
      assert.equal(reopened?.canApprove, true);
    } finally {
      controller.stop();
    }
  });

  it('M10: reload never re-enables the stale cached hash when no new view arrives', async () => {
    const hash = 'a1'.repeat(32);
    const controller = await controllerWithApproval(pairCode('S'), hash);
    try {
      gateway.changeApprovalArgsHash('ap-m10', 'b2'.repeat(32));
      await controller.decideApproval('ap-m10', 'allowed-once');
      await waitFor(() => card(controller)?.status === 'review-again', { label: 'review again' });

      // The host no longer has the approval, so `subscribe` replays nothing: the cached copy is
      // the only thing left and it still carries the refused hash.
      gateway.removeApproval('ap-m10');
      await controller.reloadApproval('ap-m10');

      const stale = card(controller);
      assert.equal(stale?.status, 'review-again');
      assert.equal(stale?.canApprove, false);
      assert.equal(stale?.argsHash, hash);
    } finally {
      controller.stop();
    }
  });

  it('M10: a stale replay of the refused hash is never reported as a refresh', async () => {
    const refused = 'a7'.repeat(32);
    const controller = await controllerWithApproval(pairCode('U'), refused);
    try {
      gateway.changeApprovalArgsHash('ap-m10', 'b8'.repeat(32));
      await controller.decideApproval('ap-m10', 'allowed-once');
      await waitFor(() => card(controller)?.status === 'review-again', { label: 'review again' });

      // The host's next subscribe replays the very hash it already refused (stale backlog).
      gateway.changeApprovalArgsHash('ap-m10', refused);
      const stale = await controller.reloadApproval('ap-m10');
      assert.equal(stale, false, 'a refused hash is not a successful refresh');
      assert.equal(card(controller)?.status, 'review-again');
      assert.equal(card(controller)?.canApprove, false);
      assert.equal(card(controller)?.argsHash, refused);

      // Only a genuinely different view reopens the card — and that one is a real refresh.
      gateway.changeApprovalArgsHash('ap-m10', 'c9'.repeat(32));
      const fresh = await controller.reloadApproval('ap-m10');
      assert.equal(fresh, true);
      assert.equal(card(controller)?.status, 'pending');
      assert.equal(card(controller)?.argsHash, 'c9'.repeat(32));
    } finally {
      controller.stop();
    }
  });

  it('M10: a replay of another rpc identity does not satisfy the reload', async () => {
    const refused = 'd1'.repeat(32);
    const controller = await controllerWithApproval(pairCode('X'), refused);
    try {
      gateway.changeApprovalArgsHash('ap-m10', 'e2'.repeat(32));
      await controller.decideApproval('ap-m10', 'rejected');
      await waitFor(() => card(controller)?.status === 'review-again', { label: 'review again' });

      // The host has no pending approval left, so the reload's subscribe replays nothing.
      gateway.removeApproval('ap-m10');
      const reloading = controller.reloadApproval('ap-m10');
      // A later replay for the same approvalId but a different rpcId is not the view asked for.
      gateway.pushApprovalRequested(
        { approvalId: 'ap-m10', rpcId: 'rpc-other', sessionId: 's-running', toolName: 'bash', argsHash: 'f3'.repeat(32) },
        { replay: true, register: false },
      );

      assert.equal(await reloading, false);
      assert.equal(card(controller)?.status, 'review-again');
      assert.equal(card(controller)?.argsHash, refused);
    } finally {
      controller.stop();
    }
  });

  it('M10: a replay of another session identity does not satisfy the reload', async () => {
    const refused = '15'.repeat(32);
    const controller = await controllerWithApproval(pairCode('Z'), refused);
    try {
      gateway.changeApprovalArgsHash('ap-m10', '26'.repeat(32));
      await controller.decideApproval('ap-m10', 'allowed-once');
      await waitFor(() => card(controller)?.status === 'review-again', { label: 'review again' });

      gateway.removeApproval('ap-m10');
      const reloading = controller.reloadApproval('ap-m10');
      // Same approvalId and rpcId, but another session: still not this card's fresh view.
      gateway.pushApprovalRequested(
        { approvalId: 'ap-m10', rpcId: 'rpc-m10', sessionId: 's-other', toolName: 'bash', argsHash: '37'.repeat(32) },
        { replay: true, register: false },
      );

      assert.equal(await reloading, false);
      assert.equal(card(controller)?.status, 'review-again');
      assert.equal(card(controller)?.argsHash, refused);
    } finally {
      controller.stop();
    }
  });

  it('M10: a later live push is not mistaken for the subscribe replay', async () => {
    const refused = '48'.repeat(32);
    const changed = '59'.repeat(32);
    const controller = await controllerWithApproval(pairCode('Y'), refused);
    try {
      gateway.changeApprovalArgsHash('ap-m10', changed);
      await controller.decideApproval('ap-m10', 'allowed-once');
      await waitFor(() => card(controller)?.status === 'review-again', { label: 'review again' });

      // No backlog: the reload gets its answer from whatever push arrives next, if any.
      gateway.removeApproval('ap-m10');
      const reloading = controller.reloadApproval('ap-m10');
      // The exact card, with new content, but a live push (no `replay` flag): not the reload's
      // contract §4 backlog answer, so it must not be reported as a refresh.
      gateway.pushApprovalRequested({
        approvalId: 'ap-m10',
        rpcId: 'rpc-m10',
        sessionId: 's-running',
        toolName: 'bash',
        argsHash: changed,
      }, { register: false });

      assert.equal(await reloading, false);
      assert.equal(card(controller)?.status, 'review-again');
      assert.equal(card(controller)?.argsHash, refused);
    } finally {
      controller.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Install-scoped `clientMsgId` source (the outbox wiring in `AppController`)
// ---------------------------------------------------------------------------
//
// `clientMsgId` is the host's at-most-once dedup key per device (contract §4), so a repeat drops a
// NEW prompt as a replay. The core generator is only probabilistic across restarts/devices (React
// Native has no Web Crypto), so the controller seeds it with the persisted install id. These cases
// pin the format, the gateway limits, the cross-outbox distinctness and the unchanged fallback
// while no install id is known.

describe('install-scoped clientMsgId', () => {
  const INSTALL_ID = '6b1c2f4e-8a9d-4c3b-b2a1-0f9e8d7c6b5a';

  function outboxWith(installId: string | null) {
    return new Outbox({
      send: async () => undefined,
      newClientMsgId: createInstallScopedClientMsgId(() => installId),
    });
  }

  it('prefixes the id with the install id and stays inside the gateway rule', () => {
    const outbox = outboxWith(INSTALL_ID);
    const first = outbox.enqueuePrompt('s1', 'one').clientMsgId;
    const second = outbox.enqueuePrompt('s1', 'two').clientMsgId;
    for (const id of [first, second]) {
      assert.ok(id.startsWith(`${INSTALL_ID}.`), `${id} starts with the install id`);
      assertAcceptableClientMsgId(id);
    }
    // The counter is the per-process distinctness guarantee (the random tag is only extra).
    assert.notEqual(first, second);
  });

  it('two outboxes on the same installation never produce the same id', () => {
    // Same installation, two controller/outbox instances (e.g. a restart inside one process, or a
    // second consumer): the counter and the random tag must still separate them.
    const first = outboxWith(INSTALL_ID).enqueuePrompt('s1', 'one').clientMsgId;
    const second = outboxWith(INSTALL_ID).enqueuePrompt('s1', 'one').clientMsgId;
    assert.notEqual(first, second);
    assertAcceptableClientMsgId(second);
  });

  it('bounds and sanitises a pathological install id', () => {
    // A corrupted/hostile stored value: whitespace, newlines and separators cannot reach the id,
    // and the install component is capped (a UUID is 36 chars, the cap is 64).
    const pathological = `  ${'ab'.repeat(200)}\n`;
    const id = outboxWith(pathological).enqueuePrompt('s1', 'hi').clientMsgId;
    assertAcceptableClientMsgId(id);
    assert.equal(id.split('.')[0], pathological.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 64));
    assert.equal(id.includes('\n'), false);
  });

  it('uses the portable core generator while no install id is known, and never throws', () => {
    // Not read yet (the secure-store read is async) or unusable: the send path must not block,
    // must not throw, and must not lose the prompt.
    const missing = outboxWith(null);
    assert.doesNotThrow(() => missing.enqueuePrompt('s1', 'hi'));
    assertAcceptableClientMsgId(missing.enqueuePrompt('s1', 'again').clientMsgId);
    assert.equal(missing.clientMsgIds[0]?.startsWith(`${INSTALL_ID}.`), false);

    const throwing = new Outbox({
      send: async () => undefined,
      newClientMsgId: createInstallScopedClientMsgId(() => {
        throw new Error('keychain unavailable');
      }),
    });
    assert.doesNotThrow(() => throwing.enqueuePrompt('s1', 'hi'));
    assertAcceptableClientMsgId(throwing.enqueuePrompt('s1', 'again').clientMsgId);

    // A value that is only whitespace sanitises to nothing: same fallback, still usable.
    assertAcceptableClientMsgId(outboxWith('   ').enqueuePrompt('s1', 'hi').clientMsgId);
  });

  it('keeps one id per entry, including across a retry', async () => {
    const generateId = createInstallScopedClientMsgId(() => INSTALL_ID);
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
        return generateId();
      },
    });
    const item = outbox.enqueuePrompt('s1', 'one');
    await outbox.drain();
    assert.equal(outbox.get(item.clientMsgId)?.status, 'queued');
    outbox.onDisconnected();
    await outbox.drain();

    assert.equal(generated, 1, 'the retry reused the stored id instead of generating a new one');
    assert.equal(frames[0]?.params.clientMsgId, item.clientMsgId);
    assert.equal(frames[1]?.params.clientMsgId, item.clientMsgId);
    assert.equal(outbox.get(item.clientMsgId)?.status, 'acked');
    assertAcceptableClientMsgId(item.clientMsgId);
  });
});
