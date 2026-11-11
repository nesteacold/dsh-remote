// Cold-start sequencing (reviewer finding on `app/_layout.tsx`).
//
// The layout has no React Native render harness in this Node suite, so the pure sequencer it uses
// is tested directly. The sequences below are exactly the ones the layout runs: the mount effect
// starts `controller.start()` without awaiting it, the gate's auto-unlock (and every later press)
// awaits the *same* attempt before `controller.unlock()`, and a failure stays behind the gate and
// is retried instead of becoming an unhandled rejection.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StartupSequence } from '../src/core/startup';
import { UnlockAttempts } from '../src/core/unlock-attempt';
import { deferred } from './support/wait';

/** Let every pending microtask (the attempt's `then`) run. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('StartupSequence (cold start)', () => {
  it('an unlock that races the start waits for it instead of reading the credential early', async () => {
    const completed = deferred<void>();
    const order: string[] = [];
    let starts = 0;
    const startup = new StartupSequence({
      start: async () => {
        starts += 1;
        order.push('start');
        await completed.promise;
        order.push('host-loaded');
      },
    });

    // The layout mount effect: fire and forget.
    void startup.ensure();
    // The gate: the auto-unlock starts immediately, exactly like a fast biometric/passcode
    // answer, and must not reach `controller.unlock()` while the host list is still loading.
    const unlock = (async (): Promise<string> => {
      const started = await startup.ensure();
      order.push(started ? 'unlock' : 'refused');
      return started ? 'unlocked' : 'refused';
    })();

    await flush();
    assert.deepEqual(order, ['start'], 'unlock must wait for start, not run beside it');
    assert.equal(starts, 1, 'both callers share the one attempt');

    completed.resolve();
    assert.equal(await unlock, 'unlocked');
    assert.deepEqual(order, ['start', 'host-loaded', 'unlock']);
    assert.equal(starts, 1);
    assert.equal(startup.status, 'ready');
  });

  it('a stale unlock (backgrounded or unmounted) is refused after the shared start resolves', async () => {
    const completed = deferred<void>();
    const order: string[] = [];
    const startup = new StartupSequence({
      start: async () => {
        await completed.promise;
      },
    });
    const attempts = new UnlockAttempts();

    void startup.ensure();
    const pending = (async (): Promise<string> => {
      const attempt = attempts.begin();
      const started = await startup.ensure();
      // The layout's guard: the app left the foreground while the host list was loading.
      if (!attempts.isCurrent(attempt)) return 'stale';
      order.push(started ? 'unlock' : 'refused');
      return started ? 'unlocked' : 'refused';
    })();

    await flush();
    attempts.setForeground(false);
    completed.resolve();
    assert.equal(await pending, 'stale');
    assert.deepEqual(order, [], 'a superseded unlock never reaches the controller');
  });

  it('a failed start resolves false (never rejects), is remembered, and retries once per call', async () => {
    const failures: unknown[] = [];
    const resets: number[] = [];
    let starts = 0;
    const startup = new StartupSequence({
      // Fails twice (secure store still unavailable), succeeds on the third attempt.
      start: async () => {
        starts += 1;
        if (starts < 3) throw new Error(`store unavailable (${starts})`);
      },
      reset: () => {
        resets.push(starts);
      },
    });

    // `ensure()` must not reject: the layout starts it from an effect and would otherwise leak an
    // unhandled rejection on a device where the store is temporarily unavailable.
    assert.equal(await startup.ensure(), false);
    assert.equal(startup.status, 'failed');
    assert.ok(startup.error instanceof Error);
    failures.push(startup.error);

    assert.equal(await startup.ensure(), false, 'the retry runs a fresh attempt');
    assert.equal(starts, 2);
    assert.deepEqual(resets, [1], 'a retry resets the settled attempt before restarting');

    assert.equal(await startup.ensure(), true);
    assert.equal(startup.status, 'ready');
    assert.equal(starts, 3);

    // Ready is final: later unlocks never restart the controller.
    assert.equal(await startup.ensure(), true);
    assert.equal(await startup.ensure(), true);
    assert.equal(starts, 3);
    assert.equal(failures.length, 1);
  });

  it('resets before the retry, so a controller that latched "started" starts again', async () => {
    const order: string[] = [];
    // The controller marks itself started synchronously and only `stop()` clears it.
    let latched = false;
    const startup = new StartupSequence({
      start: async () => {
        if (latched) {
          order.push('start:noop');
          return;
        }
        latched = true;
        order.push('start');
        throw new Error('readHosts failed');
      },
      reset: () => {
        latched = false;
        order.push('reset');
      },
    });

    assert.equal(await startup.ensure(), false);
    assert.equal(await startup.ensure(), false);
    assert.deepEqual(order, ['start', 'reset', 'start'], 'the retry actually re-read the hosts');
  });

  it('a start that never settles keeps every caller waiting on the same attempt', async () => {
    const completed = deferred<void>();
    let starts = 0;
    const startup = new StartupSequence({
      start: async () => {
        starts += 1;
        await completed.promise;
      },
    });
    void startup.ensure();
    const first = startup.ensure();
    const second = startup.ensure();
    assert.equal(starts, 1);
    assert.equal(first, second, 'both callers await the same promise');
    assert.equal(startup.status, 'starting');

    completed.resolve();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(starts, 1);
    assert.equal(startup.status, 'ready');
  });
});
