// Outbox tests (A015 / FR-007 / US4), contract §4: crypto-random clientMsgId, the `message`
// op (`type` + `requestId` + `sessionId` + `text` + `clientMsgId`), retry with the same id,
// dedupe by clientMsgId on the gateway, status machine and the `session-cancel` op.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CompanionClient } from '../src/core/client';
import { CoreError } from '../src/core/errors';
import { Outbox, defaultClientMsgId, type OutboxFrame } from '../src/core/outbox';
import { FakeGateway } from './support/fake-gateway';
import { createNodePinnedTransportFactory } from './support/node-pinned-transport';
import { deferred, waitFor } from './support/wait';

const TARGET = { installId: '6b1c2f4e-8a9d-4c3b-b2a1-0f9e8d7c6b5a', appVersion: '0.1.0', platform: 'ios' as const };

describe('Outbox (unit, injected send)', () => {
  it('assigns a crypto-random clientMsgId per prompt', () => {
    const outbox = new Outbox({ send: async () => undefined });
    const a = outbox.enqueuePrompt('s1', 'first');
    const b = outbox.enqueuePrompt('s1', 'second');
    assert.notEqual(a.clientMsgId, b.clientMsgId);
    assert.match(a.clientMsgId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(a.status, 'queued');
  });

  it('defaultClientMsgId is a v4 UUID', () => {
    assert.match(defaultClientMsgId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });

  it('walks queued -> sent -> acked and prunes acked items', async () => {
    let sends = 0;
    const outbox = new Outbox({
      send: async () => {
        sends += 1;
      },
    });
    const item = outbox.enqueuePrompt('s1', 'hello');
    assert.equal(outbox.get(item.clientMsgId)?.status, 'queued');
    await outbox.drain();
    assert.equal(sends, 1);
    assert.equal(outbox.get(item.clientMsgId)?.status, 'acked');
    outbox.prune();
    assert.equal(outbox.list().length, 0);
  });

  it('frames a prompt as the contract `message` params', () => {
    const outbox = new Outbox({ send: async () => undefined });
    const item = outbox.enqueuePrompt('s1', 'go', 'steer');
    assert.deepEqual(outbox.frameFor(item), {
      op: 'message',
      params: { sessionId: 's1', text: 'go', clientMsgId: item.clientMsgId, mode: 'steer' },
    });
  });

  it('retries a dropped send with the same clientMsgId and stops the drain on disconnect', async () => {
    const frames: OutboxFrame[] = [];
    let attempt = 0;
    const outbox = new Outbox({
      send: async (frame) => {
        attempt += 1;
        frames.push(frame);
        if (attempt === 1) throw new CoreError({ code: 'client/disconnected', message: 'socket gone' });
      },
    });
    const first = outbox.enqueuePrompt('s1', 'one');
    outbox.enqueuePrompt('s1', 'two');
    await outbox.drain();
    assert.equal(outbox.listByStatus('failed').length, 0);
    // The retryable failure put the item back to queued (same id) and stopped the drain.
    assert.equal(outbox.listByStatus('queued').length, 2);
    assert.equal(outbox.get(first.clientMsgId)?.lastError, 'client/disconnected');
    outbox.onDisconnected();
    await outbox.drain();
    assert.equal(outbox.listByStatus('acked').length, 2);
    assert.equal(frames[0]?.params.clientMsgId, first.clientMsgId);
    assert.equal(frames[1]?.params.clientMsgId, first.clientMsgId); // retry reuses the id
    assert.equal(outbox.get(first.clientMsgId)?.attempts, 2);
  });

  it('retries agent-busy but fails op/forbidden', async () => {
    let code: string | null = 'agent-busy';
    const outbox = new Outbox({
      send: async () => {
        if (code !== null) throw new CoreError({ code, message: code });
      },
    });
    const busy = outbox.enqueuePrompt('s1', 'a');
    await outbox.drain();
    assert.equal(outbox.get(busy.clientMsgId)?.status, 'queued');
    code = 'op/forbidden';
    await outbox.drain();
    assert.equal(outbox.get(busy.clientMsgId)?.status, 'failed');
    assert.equal(outbox.get(busy.clientMsgId)?.lastError, 'op/forbidden');
  });

  it('marks non-retryable failures and supports an explicit retry', async () => {
    let fail = true;
    const outbox = new Outbox({
      send: async () => {
        if (fail) throw new CoreError({ code: 'session-not-found', message: 'gone' });
      },
    });
    const item = outbox.enqueuePrompt('s1', 'text');
    await outbox.drain();
    assert.equal(outbox.get(item.clientMsgId)?.status, 'failed');
    assert.equal(outbox.get(item.clientMsgId)?.lastError, 'session-not-found');
    fail = false;
    outbox.retry(item.clientMsgId);
    assert.equal(outbox.get(item.clientMsgId)?.status, 'queued');
    await outbox.drain();
    assert.equal(outbox.get(item.clientMsgId)?.status, 'acked');
  });

  it('an in-flight item returns to queued when the connection drops', async () => {
    const pending = deferred<void>();
    const outbox = new Outbox({ send: () => pending.promise });
    const item = outbox.enqueuePrompt('s1', 'text');
    const drained = outbox.drain();
    await waitFor(() => outbox.get(item.clientMsgId)?.status === 'sent');
    outbox.onDisconnected();
    assert.equal(outbox.get(item.clientMsgId)?.status, 'queued');
    pending.resolve();
    await drained;
  });

  it('collapses repeated cancel taps into a single queued cancel op', async () => {
    const outbox = new Outbox({ send: async () => undefined });
    const a = outbox.enqueueCancel('s1');
    const b = outbox.enqueueCancel('s1');
    assert.equal(a.clientMsgId, b.clientMsgId);
    assert.equal(outbox.list().filter((i) => i.op === 'cancel').length, 1);
    await outbox.drain();
    assert.deepEqual(outbox.frameFor(a), { op: 'session-cancel', params: { sessionId: 's1' } });
  });
});

describe('Outbox against the fake gateway', () => {
  function makeClient(gateway: FakeGateway, token: string) {
    const transports = createNodePinnedTransportFactory();
    let requestCounter = 0;
    const client = new CompanionClient({
      transport: transports,
      appVersion: TARGET.appVersion,
      platform: TARGET.platform,
      requestTimeoutMs: 2_000,
      newRequestId: () => `r-${++requestCounter}`,
    });
    return { client, transports };
  }

  it('a prompt that reached the host before a drop and is resent is applied once', async () => {
    const gateway = await FakeGateway.create({ tokens: ['tok-outbox'] });
    try {
      const { client } = makeClient(gateway, 'tok-outbox');
      const ready = deferred<void>();
      client.on('ready', () => ready.resolve());
      client.connect({ url: gateway.endpoint, certSha256: gateway.certSha256, token: 'tok-outbox', ...TARGET });
      await ready.promise;

      const outboxA = new Outbox({
        send: (frame) => client.request(frame.op, frame.params),
        newClientMsgId: () => 'cmsg-fixed-1',
      });
      const item = outboxA.enqueuePrompt('s-running', 'add tests');
      const drainedA = outboxA.drain();
      await waitFor(() => gateway.promptApplications.length === 1, { label: 'first application' });
      outboxA.onDisconnected();
      await drainedA;

      // Reconnect and resend with the SAME clientMsgId (outbox restored from the queue).
      const outboxB = new Outbox({
        send: (frame) => client.request(frame.op, frame.params),
        newClientMsgId: () => item.clientMsgId,
      });
      const retried = outboxB.enqueuePrompt('s-running', 'add tests');
      assert.equal(retried.clientMsgId, item.clientMsgId);
      await outboxB.drain();
      assert.equal(outboxB.get(retried.clientMsgId)?.status, 'acked');

      assert.equal(gateway.promptApplications.length, 1, 'applied exactly once on the gateway');
      assert.equal(gateway.promptApplications[0]?.clientMsgId, item.clientMsgId);
      client.close();
    } finally {
      await gateway.close();
    }
  });

  it('sends session-cancel with the sessionId and reads `session-cancelled`', async () => {
    const gateway = await FakeGateway.create({ tokens: ['tok-cancel'] });
    const { client } = makeClient(gateway, 'tok-cancel');
    try {
      const ready = deferred<void>();
      client.on('ready', () => ready.resolve());
      client.connect({ url: gateway.endpoint, certSha256: gateway.certSha256, token: 'tok-cancel', ...TARGET });
      await ready.promise;
      const outbox = new Outbox({ send: (frame) => client.request(frame.op, frame.params) });
      const cancel = outbox.enqueueCancel('s-running');
      outbox.enqueueCancel('s-running');
      await outbox.drain();
      assert.equal(outbox.get(cancel.clientMsgId)?.status, 'acked');
      assert.deepEqual(gateway.cancelCalls, ['s-running']);
      const answer = await client.request('session-cancel', { sessionId: 's-idle' });
      assert.deepEqual([answer.kind, answer.accepted], ['session-cancelled', true]);
      client.close();
    } finally {
      await gateway.close();
    }
  });
});
