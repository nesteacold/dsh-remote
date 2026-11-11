// Review a9b — the unlock gate's attempt generation (A020/M5).
//
// `app/_layout.tsx` has no React Native render harness in this Node suite, so the pure guard it
// uses is tested directly. The layout only reports lifecycle facts (`begin`/`setForeground`/
// `setMounted`) and asks `isCurrent()` after every await — the sequences below are exactly the
// ones the layout runs (capability await, biometric await, controller.unlock() await).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UnlockAttempts } from '../src/core/unlock-attempt';

describe('UnlockAttempts (A020 / M5)', () => {
  it('accepts only the attempt that is still current', () => {
    const attempts = new UnlockAttempts();
    const attempt = attempts.begin();
    assert.equal(attempts.isCurrent(attempt), true);
    const newer = attempts.begin();
    assert.equal(attempts.isCurrent(attempt), false, 'a newer prompt supersedes the older one');
    assert.equal(attempts.isCurrent(newer), true);
  });

  it('a background lock invalidates the in-flight prompt, and returning does not revive it', () => {
    const attempts = new UnlockAttempts();
    const attempt = attempts.begin();

    attempts.setForeground(false); // AppState 'background' -> the layout locks the controller
    assert.equal(attempts.isCurrent(attempt), false);

    attempts.setForeground(true); // user reopened the app
    assert.equal(attempts.isCurrent(attempt), false, 'a late biometric success must not unlock');

    const retry = attempts.begin(); // the user taps the unlock button again
    assert.equal(attempts.isCurrent(retry), true);
  });

  it('a repeated active report does not cancel the prompt (iOS reports inactive during the sheet)', () => {
    // The layout reports `true` for 'active' and nothing for 'inactive' (the system biometric
    // sheet itself puts the app in `inactive`). Re-reporting the same fact must be a no-op,
    // otherwise answering the prompt would always cancel its own attempt.
    const attempts = new UnlockAttempts();
    const attempt = attempts.begin();
    attempts.setForeground(true);
    assert.equal(attempts.isCurrent(attempt), true);
    attempts.setForeground(true);
    assert.equal(attempts.isCurrent(attempt), true);
  });

  it('a second background/foreground trip still cannot revive an old attempt', () => {
    const attempts = new UnlockAttempts();
    const attempt = attempts.begin();
    attempts.setForeground(false);
    attempts.setForeground(true);
    attempts.setForeground(false);
    attempts.setForeground(true);
    assert.equal(attempts.isCurrent(attempt), false);
  });

  it('an unmounted gate is never current, and a remount does not revive the old attempt', () => {
    const attempts = new UnlockAttempts();
    const attempt = attempts.begin();

    attempts.setMounted(false);
    assert.equal(attempts.isCurrent(attempt), false);

    attempts.setMounted(true);
    assert.equal(attempts.isCurrent(attempt), false, 'remounting must not replay a stale unlock');

    const remounted = attempts.begin();
    assert.equal(attempts.isCurrent(remounted), true);
  });

  it('guards every awaited step of the layout sequence', async () => {
    // Mirrors attemptUnlock(): capability -> authenticate -> controller.unlock(), with a
    // background lock landing while the biometric prompt is open.
    const attempts = new UnlockAttempts();
    let unlocked = false;
    const run = async (): Promise<string> => {
      const attempt = attempts.begin();
      const capability = await Promise.resolve<'biometric'>('biometric');
      if (!attempts.isCurrent(attempt)) return 'stale-after-capability';
      void capability;
      const result = await Promise.resolve({ ok: true as const });
      if (!attempts.isCurrent(attempt)) return 'stale-after-authenticate'; // no unlock, no socket
      if (!result.ok) return 'failed';
      unlocked = true;
      await Promise.resolve();
      if (!attempts.isCurrent(attempt)) return 'stale-after-unlock';
      return 'unlocked';
    };

    const pending = run();
    await Promise.resolve(); // capability resolved; the prompt is now awaited
    attempts.setForeground(false); // the app goes to the background while the prompt is open
    assert.equal(await pending, 'stale-after-authenticate');
    assert.equal(unlocked, false, 'controller.unlock() must not run for a stale prompt');
  });
});
