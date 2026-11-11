// A025 — a session deep link delivered while the unlock gate is closed.
//
// The defect this guards (measured on the emulator, release APK): with the app locked,
// `adb shell am start -a android.intent.action.VIEW -d "dshcompanion://s/sess-gamma"` showed the
// unlock screen (correct), but after unlocking the app landed on the session list instead of the
// session. The controller dropped the parsed link *before* parking it when `!unlocked`, while the
// gate's unlock path only routes what `takeDeepLink()` can return — so nothing recovered it.
//
// What these tests pin down:
//   * a link arriving while locked is parked and returned by `takeDeepLink()`, and the controller
//     never opens a session before the credential is usable (the gate owns routing);
//   * the parked link survives `unlock()` and is consumed exactly once (one link routes once);
//   * a link arriving while unlocked still opens the session immediately (no regression);
//   * the newest of several links parked while locked wins;
//   * a URL that is not a companion session link changes nothing.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import { resetAppState } from './support/stubs/react-native.stub';

const LINKED = 'dshcompanion://s/sess-gamma';

describe('AppController deep links (A025) behind the unlock gate', () => {
  it('a link arriving while locked is parked for the gate and never navigated', async () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      await controller.handleDeepLink('dshcompanion://s/sess-gamma?a=ap-1');

      // The credential is not usable before unlock: the controller must not open anything.
      assert.equal(controller.snapshot().openSessionId, null);
      // …but the destination is kept for the gate that runs right after a successful unlock.
      assert.deepEqual(controller.takeDeepLink(), { sessionId: 'sess-gamma', approvalId: 'ap-1' });
    } finally {
      controller.stop();
    }
  });

  it('the parked link survives unlock() and is consumed exactly once', async () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      await controller.handleDeepLink(LINKED);
      await controller.unlock();

      // `unlock()` only opens the gate; routing is the gate's job, using `takeDeepLink()`.
      assert.equal(controller.snapshot().openSessionId, null, 'unlock does not navigate by itself');
      assert.deepEqual(controller.takeDeepLink(), { sessionId: 'sess-gamma', approvalId: null });
      assert.equal(controller.takeDeepLink(), null, 'one link is routed once');
      assert.equal(controller.snapshot().openSessionId, null);
    } finally {
      controller.stop();
    }
  });

  it('a link arriving while unlocked still opens the session immediately', async () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      await controller.unlock();
      await controller.handleDeepLink(LINKED);

      assert.equal(controller.snapshot().openSessionId, 'sess-gamma');
      // The immediate path consumed it: the gate cannot route the same link again.
      assert.equal(controller.takeDeepLink(), null);
    } finally {
      controller.stop();
    }
  });

  it('the newest link wins when several arrive while locked', async () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      await controller.handleDeepLink('dshcompanion://s/sess-old');
      await controller.handleDeepLink('dshcompanion://s/sess-new?a=ap-2');

      assert.deepEqual(controller.takeDeepLink(), { sessionId: 'sess-new', approvalId: 'ap-2' });
    } finally {
      controller.stop();
    }
  });

  it('a URL that is not a companion session link changes nothing', async () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      await controller.handleDeepLink('https://example.com/s/sess-gamma');
      await controller.handleDeepLink('not-a-url');
      await controller.handleDeepLink('dshcompanion://s/');

      assert.equal(controller.takeDeepLink(), null);
      assert.equal(controller.snapshot().openSessionId, null);
    } finally {
      controller.stop();
    }
  });
});
