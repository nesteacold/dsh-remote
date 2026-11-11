// Review a9b — async lifecycle of the retry loop.
//
// `onOpen()` awaits the resync, so `stop()` (background lock, update-required, revoked), a
// drop, or a restart can land while it is still in flight. A superseded resync must never set
// `live` and must never schedule a retry for a connection that is already gone: a lock would
// otherwise be undone by a late successful resync.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Reconnector, type ReconnectSnapshot, type ReconnectState } from '../src/core/reconnect';
import { FakeClock, flush } from './support/fake-clock';
import { deferred } from './support/wait';

interface PendingOpen {
  reconnector: Reconnector;
  clock: FakeClock;
  resync: ReturnType<typeof deferred<void>>;
  /** The `onOpen()` promise that is blocked on the deferred resync. */
  opened: Promise<void>;
  /** Every state emitted through `onChange`. */
  states: ReconnectState[];
  /** How many times `connect()` ran (one per retry attempt). */
  connects: () => number;
}

/**
 * Start a loop whose connect callback succeeds immediately, then call `onOpen()` and leave its
 * resync awaited, so a test can interleave stop/drop/restart deterministically.
 */
async function openWithDeferredResync(): Promise<PendingOpen> {
  const clock = new FakeClock();
  const resync = deferred<void>();
  const states: ReconnectState[] = [];
  let connectCalls = 0;
  const reconnector = new Reconnector({
    clock,
    connect: () => {
      connectCalls += 1;
    },
    onResync: () => resync.promise,
    onChange: (snapshot: ReconnectSnapshot) => states.push(snapshot.state),
  });
  reconnector.start();
  await clock.advance(0); // first attempt fired; the transport/handshake step is complete
  assert.equal(reconnector.snapshot.state, 'connecting');
  const opened = reconnector.onOpen();
  await flush(); // let `onResync()` start and block
  return { reconnector, clock, resync, opened, states, connects: () => connectCalls };
}

describe('Reconnector lifecycle (review a9b: late resync after stop/drop/restart)', () => {
  it('stop() while the resync is awaited never resurrects live and schedules nothing', async () => {
    const pending = await openWithDeferredResync();

    pending.reconnector.stop();
    assert.equal(pending.reconnector.snapshot.state, 'stopped');

    pending.resync.resolve();
    await pending.opened;

    assert.equal(pending.reconnector.snapshot.state, 'stopped');
    assert.equal(pending.reconnector.isLive, false);
    assert.equal(pending.reconnector.snapshot.connections, 0);
    assert.equal(pending.clock.pendingCount, 0, 'a stopped loop must not schedule a retry');
    assert.equal(pending.states.includes('live'), false);

    await pending.clock.advance(60_000);
    assert.equal(pending.reconnector.snapshot.state, 'stopped');
    assert.equal(pending.connects(), 1, 'no retry ran after the stop');
  });

  it('stop() while the resync is awaited ignores a late resync failure (no retry)', async () => {
    const pending = await openWithDeferredResync();

    pending.reconnector.stop();
    pending.resync.reject(new Error('listing failed'));
    await pending.opened;

    assert.equal(pending.reconnector.snapshot.state, 'stopped');
    assert.equal(pending.reconnector.snapshot.attempt, 0);
    assert.equal(pending.clock.pendingCount, 0);
    assert.equal(pending.states.includes('waiting'), false);
  });

  it('a drop while the resync is awaited keeps the backoff; the late success cannot go live', async () => {
    const pending = await openWithDeferredResync();

    pending.reconnector.handleDrop('socket-closed');
    assert.equal(pending.reconnector.snapshot.state, 'waiting');
    assert.deepEqual(pending.clock.pendingDelays(), [1_000]);

    pending.resync.resolve();
    await pending.opened;

    assert.equal(pending.reconnector.snapshot.state, 'waiting');
    assert.equal(pending.reconnector.snapshot.connections, 0);
    assert.equal(pending.reconnector.snapshot.attempt, 1);
    assert.deepEqual(pending.clock.pendingDelays(), [1_000]);
    assert.equal(pending.states.includes('live'), false);

    await pending.clock.advance(1_000);
    assert.equal(pending.connects(), 2);
    assert.equal(pending.reconnector.snapshot.state, 'connecting');
  });

  it('a drop plus a late resync failure counts one backoff step, not two', async () => {
    const pending = await openWithDeferredResync();

    pending.reconnector.handleDrop('socket-closed');
    pending.resync.reject(new Error('listing failed'));
    await pending.opened;

    assert.equal(pending.reconnector.snapshot.state, 'waiting');
    assert.equal(pending.reconnector.snapshot.attempt, 1);
    assert.deepEqual(pending.clock.pendingDelays(), [1_000], 'one timer, one backoff step');
  });

  it('a newer connection owns the outcome: the superseded resync cannot reset it', async () => {
    const clock = new FakeClock();
    const first = deferred<void>();
    const second = deferred<void>();
    let resyncCalls = 0;
    let connects = 0;
    const reconnector = new Reconnector({
      clock,
      connect: () => {
        connects += 1;
      },
      onResync: () => {
        resyncCalls += 1;
        return resyncCalls === 1 ? first.promise : second.promise;
      },
    });
    reconnector.start();
    await clock.advance(0);
    const openFirst = reconnector.onOpen();
    await flush();

    // The socket drops while the first resync is awaited; the loop reconnects and opens again.
    reconnector.handleDrop('socket-closed');
    await clock.advance(1_000);
    const openSecond = reconnector.onOpen();
    await flush();
    assert.equal(connects, 2);

    // The superseded resync finishing first changes nothing — not live, not the backoff step.
    first.resolve();
    await openFirst;
    assert.equal(reconnector.snapshot.state, 'connecting');
    assert.equal(reconnector.snapshot.connections, 0);
    assert.equal(reconnector.snapshot.attempt, 1);

    second.resolve();
    await openSecond;
    assert.equal(reconnector.isLive, true);
    assert.equal(reconnector.snapshot.connections, 1);
    assert.equal(reconnector.snapshot.attempt, 0);
    reconnector.stop();
  });

  it('start() restarts the loop and abandons a resync still awaited from the old one', async () => {
    const pending = await openWithDeferredResync();

    pending.reconnector.start();
    assert.equal(pending.reconnector.snapshot.state, 'idle');
    assert.deepEqual(pending.clock.pendingDelays(), [0]);

    pending.resync.resolve();
    await pending.opened;

    assert.equal(pending.reconnector.snapshot.state, 'idle');
    assert.equal(pending.reconnector.snapshot.connections, 0);
    assert.equal(pending.states.includes('live'), false);

    await pending.clock.advance(0);
    assert.equal(pending.connects(), 2);
    assert.equal(pending.reconnector.snapshot.state, 'connecting');
    pending.reconnector.stop();
  });

  it('a stopped loop restarts from scratch; the pre-stop resync stays stale', async () => {
    const pending = await openWithDeferredResync();

    pending.reconnector.stop();
    pending.reconnector.start(); // documented contract: start() resumes from scratch
    assert.equal(pending.reconnector.snapshot.state, 'idle');

    pending.resync.resolve();
    await pending.opened;
    assert.equal(pending.reconnector.snapshot.connections, 0);
    assert.equal(pending.states.includes('live'), false);

    await pending.clock.advance(0);
    assert.equal(pending.connects(), 2);
    assert.equal(pending.reconnector.snapshot.state, 'connecting');
    pending.reconnector.stop();
  });

  it('onOpen() after stop() does not run a resync at all', async () => {
    let resyncCalls = 0;
    const clock = new FakeClock();
    const reconnector = new Reconnector({
      clock,
      connect: () => undefined,
      onResync: () => {
        resyncCalls += 1;
      },
    });
    reconnector.start();
    await clock.advance(0);
    reconnector.stop();
    await reconnector.onOpen();
    assert.equal(resyncCalls, 0);
    assert.equal(reconnector.snapshot.state, 'stopped');
  });
});
