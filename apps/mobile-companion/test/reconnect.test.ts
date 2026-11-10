// Reconnect tests (A016 / US5 / FR-008): exact backoff sequence 1,2,5,10,20,30,30… s with an
// injected clock/timer, and resync after a forced drop without duplicating messages.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ApprovalRequestedFrame } from '@dsh-ext/mobile-protocol';

import { CompanionClient } from '../src/core/client';
import { Outbox, type OutboxFrame } from '../src/core/outbox';
import { BACKOFF_DELAYS_MS, Reconnector, backoffDelayMs, planResync } from '../src/core/reconnect';
import { SessionsStore } from '../src/core/sessions';
import { FakeClock, flush } from './support/fake-clock';
import { FakeGateway, type FakeSession } from './support/fake-gateway';
import { createNodePinnedTransportFactory } from './support/node-pinned-transport';
import { deferred, waitFor } from './support/wait';

const TARGET = { installId: '7c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', appVersion: '0.1.0', platform: 'android' as const };

describe('backoff sequence', () => {
  it('is 1, 2, 5, 10, 20, 30 s and stays at 30 s', () => {
    assert.deepEqual(BACKOFF_DELAYS_MS, [1_000, 2_000, 5_000, 10_000, 20_000, 30_000]);
    const seconds = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => backoffDelayMs(n) / 1000);
    assert.deepEqual(seconds, [1, 2, 5, 10, 20, 30, 30, 30, 30]);
    assert.equal(backoffDelayMs(0), 1_000);
  });
});

describe('Reconnector (fake clock)', () => {
  it('retries along the exact 1,2,5,10,20,30,30 s sequence', async () => {
    const clock = new FakeClock();
    const attempts: number[] = [];
    let failAlways = true;
    const reconnector: Reconnector = new Reconnector({
      clock,
      connect: (): void => {
        attempts.push(clock.now());
        if (failAlways) reconnector.handleDrop('refused');
      },
      onResync: () => undefined,
    });
    reconnector.start();
    await clock.advance(0);
    assert.equal(attempts.length, 1);

    const expectedDelays = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 30_000];
    const start = clock.now();
    for (const expected of expectedDelays) {
      assert.deepEqual(clock.pendingDelays(), [expected], `next delay should be ${expected} ms`);
      await clock.advance(expected);
    }
    const intervals = attempts.slice(1).map((t, i) => t - (attempts[i] as number));
    assert.deepEqual(intervals, expectedDelays);
    assert.equal(clock.now() - start, expectedDelays.reduce((a, b) => a + b, 0));
    failAlways = false;
    reconnector.stop();
  });

  it('resets the sequence after a successful resync', async () => {
    const clock = new FakeClock();
    let mode: 'fail' | 'ok' = 'fail';
    const delays: number[] = [];
    const reconnector: Reconnector = new Reconnector({
      clock,
      connect: (): void => {
        if (mode === 'fail') reconnector.handleDrop('refused');
      },
      onResync: () => undefined,
    });
    reconnector.start();
    await clock.advance(0); // attempt 1 fails -> next delay 1 s
    delays.push(reconnector.snapshot.lastDelayMs as number);
    await clock.advance(1_000); // attempt 2 fails -> next delay 2 s
    delays.push(reconnector.snapshot.lastDelayMs as number);
    await clock.advance(2_000); // attempt 3 fails -> next delay 5 s
    delays.push(reconnector.snapshot.lastDelayMs as number);
    mode = 'ok';
    await clock.advance(5_000); // attempt 4: connect() succeeds, handshake completes
    await reconnector.onOpen();
    assert.equal(reconnector.isLive, true);
    assert.equal(reconnector.snapshot.attempt, 0);
    assert.equal(reconnector.snapshot.connections, 1);
    // After another drop the sequence starts again from 1 s.
    reconnector.handleDrop('network');
    assert.deepEqual(clock.pendingDelays(), [1_000]);
    assert.deepEqual(delays, [1_000, 2_000, 5_000]);
    reconnector.stop();
  });

  it('stop() cancels a pending retry and exposes banner state', async () => {
    const clock = new FakeClock();
    const states: string[] = [];
    const reconnector: Reconnector = new Reconnector({
      clock,
      connect: (): void => reconnector.handleDrop('refused'),
      onResync: () => undefined,
      onChange: (snapshot) => states.push(snapshot.state),
    });
    reconnector.start();
    await clock.advance(0);
    assert.equal(reconnector.snapshot.state, 'waiting');
    assert.equal(reconnector.snapshot.nextAttemptAt, clock.now() + 1_000);
    reconnector.stop();
    assert.equal(reconnector.snapshot.state, 'stopped');
    assert.equal(clock.pendingCount, 0);
    await clock.advance(60_000);
    assert.equal(states.includes('stopped'), true);
    assert.equal(states.filter((s) => s === 'connecting').length <= 7, true);
  });

  it('a failed resync counts as a drop', async () => {
    const clock = new FakeClock();
    let resyncCalls = 0;
    const reconnector = new Reconnector({
      clock,
      connect: () => undefined,
      onResync: () => {
        resyncCalls += 1;
        throw new Error('list failed');
      },
    });
    reconnector.start();
    await clock.advance(0);
    await reconnector.onOpen();
    assert.equal(resyncCalls, 1);
    assert.equal(reconnector.snapshot.state, 'waiting');
    assert.deepEqual(clock.pendingDelays(), [1_000]);
    reconnector.stop();
  });
});

describe('planResync', () => {
  const approval = (approvalId: string): ApprovalRequestedFrame => ({
    kind: 'approval-requested',
    approvalId,
    rpcId: `rpc-${approvalId}`,
    sessionId: 's1',
    toolName: 'bash',
    argsHash: 'h'.repeat(64),
  });

  it('reports added/removed/updated sessions and approval deltas by id', () => {
    const plan = planResync(
      {
        sessions: [
          { id: 's1', updatedAt: 1 },
          { id: 's2', updatedAt: 1 },
        ],
        approvals: [approval('ap-1')],
        queuedClientMsgIds: ['c1'],
      },
      {
        sessions: [
          { id: 's1', updatedAt: 2 },
          { id: 's3', updatedAt: 1 },
        ],
        approvals: [approval('ap-1'), approval('ap-2')],
        queuedClientMsgIds: ['c1', 'c1'],
      },
    );
    assert.deepEqual(plan.addedSessionIds, ['s3']);
    assert.deepEqual(plan.removedSessionIds, ['s2']);
    assert.deepEqual(plan.updatedSessionIds, ['s1']);
    assert.deepEqual(plan.newApprovalIds, ['ap-2']);
    assert.deepEqual(plan.droppedApprovalIds, []);
    assert.deepEqual(plan.promptsToResend, ['c1']);
  });
});

describe('reconnect + resync against the fake gateway', () => {
  it('reconnects after a forced drop and resyncs without duplicating messages', async () => {
    const token = 'tok-reconnect';
    const gateway = await FakeGateway.create({ tokens: [token] });
    const clock = new FakeClock();
    const transportFactory = createNodePinnedTransportFactory();
    let requestCounter = 0;
    let sequence = 0;
    const client = new CompanionClient({
      transport: transportFactory,
      appVersion: TARGET.appVersion,
      platform: TARGET.platform,
      // Short timeout so an ack cut by a drop is reported as `client/disconnected` instead of
      // a silent stall; the fake gateway answers within a few ms.
      requestTimeoutMs: 3_000,
      newRequestId: () => `rr-${++requestCounter}`,
    });
    const store = new SessionsStore({ now: () => clock.now() });
    const approvals = new Map<string, ApprovalRequestedFrame>();
    const outbox = new Outbox({
      send: (frame: OutboxFrame) => client.request(frame.op, frame.params),
      newClientMsgId: () => `cmsg-${++sequence}`,
    });

    let connections = 0;
    outbox.gateClosed = () => !client.connected;
    const resync = async () => {
      assert.equal(client.connected, true, 'resync must run on a live socket');
      connections += 1;
      const listed = await client.request('sessions');
      store.setAll(listed.items);
      // `subscribe` replays the session's pending approvals (contract §4).
      await client.request('subscribe', { sessionId: 's-running' });
      // Send every still-queued prompt again with its original clientMsgId; the host
      // dedupes by that id, so "resend after a drop" is applied once.
      await outbox.drain();
    };

    const reconnector = new Reconnector({
      clock,
      connect: () => {
        client.connect({ url: gateway.endpoint, certSha256: gateway.certSha256, token, ...TARGET });
      },
      onResync: resync,
      onDrop: () => outbox.onDisconnected(),
    });

    client.on('ready', () => {
      void reconnector.onOpen();
    });
    // A drop must always feed the reconnector; otherwise a forced network drop would never
    // schedule a retry.
    client.on('disconnected', (payload) => {
      if (payload.retry) reconnector.handleDrop('socket-closed');
    });
    client.on('approvalRequested', (frame) => {
      approvals.set(frame.approvalId, frame);
      store.applyApprovalRequested(frame);
    });
    client.on('approvalResolved', (frame) => {
      approvals.delete(frame.approvalId);
      store.resolveApproval(frame.approvalId, frame.sessionId);
    });

    try {
      reconnector.start();
      await clock.advance(0);
      await waitFor(() => reconnector.isLive, { label: 'first connection live' });
      assert.equal(connections, 1);
      assert.equal(store.tab('running').length, 1);

      // A prompt is queued and sent; its text must exist exactly once afterwards.
      const first = outbox.enqueuePrompt('s-running', 'please continue');
      await outbox.drain();
      await waitFor(() => gateway.promptApplications.length === 1);
      assert.equal(outbox.get(first.clientMsgId)?.status, 'acked');

      // Live approval push sets the badge immediately.
      gateway.pushApprovalRequested({
        approvalId: 'ap-live',
        rpcId: 'rpc-live',
        sessionId: 's-running',
        toolName: 'bash',
        argsHash: 'a'.repeat(64),
      });
      await waitFor(() => store.get('s-running')?.needsDecision === true, { label: 'live badge' });

      // Forced network drop.
      gateway.setSessions([
        { id: 's-running', title: 'Refactor gateway TLS', state: 'running', updatedAt: Date.parse('2026-11-09T05:00:00Z') },
        { id: 's-injected', title: 'Missed while offline', state: 'idle', updatedAt: Date.parse('2026-11-09T06:00:00Z') },
      ] satisfies FakeSession[]);
      gateway.dropAllConnections();
      await waitFor(() => reconnector.snapshot.state === 'waiting', { label: 'waiting for backoff' });
      assert.deepEqual(clock.pendingDelays(), [1_000]);

      await clock.advance(1_000);
      await waitFor(() => reconnector.isLive, { label: 'reconnected live' });
      assert.equal(connections, 2);

      // Resync picked up the session that changed while offline, without duplicates.
      assert.equal(store.has('s-injected'), true);
      assert.equal(store.tab('idle').length, 1);
      assert.equal(store.snapshot().items.filter((s) => s.id === 's-running').length, 1);
      // The pending approval is replayed and still pending after resync (not lost, duplicated).
      await waitFor(() => approvals.size === 1, { label: 'replayed approval' });
      assert.equal(store.get('s-running')?.needsDecision, true);
      // The prompt is applied once even though the connection was re-established.
      assert.equal(gateway.promptApplications.length, 1);

      // Queued work resumes on the new connection. An item enqueued while the link is dead
      // stays queued; the resync resends it with its clientMsgId and the host applies it once.
      gateway.dropAllConnections();
      await waitFor(() => reconnector.snapshot.state === 'waiting', { label: 'second backoff' });
      const second = outbox.enqueuePrompt('s-running', 'apply once');
      await outbox.drain(); // no-op: the socket is down
      assert.equal(outbox.get(second.clientMsgId)?.status, 'queued');
      await clock.advance(1_000);
      await waitFor(() => reconnector.isLive, { label: 'live after second reconnect' });
      await waitFor(() => outbox.get(second.clientMsgId)?.status === 'acked', { label: 'acked after resend' });
      await waitFor(() => gateway.promptApplications.length === 2, { label: 'second application' });
      assert.equal(client.connected, true);

      assert.equal(
        gateway.promptApplications.filter((p) => p.clientMsgId === second.clientMsgId).length,
        1,
        'resumed prompt applied once',
      );
      assert.equal(outbox.get(second.clientMsgId)?.attempts, 1);
      assert.equal(outbox.get(first.clientMsgId)?.status, 'acked');
      assert.equal(gateway.promptApplications.length, 2);

      reconnector.stop();
      client.close();
    } finally {
      await gateway.close();
      await flush();
    }
  });
});
