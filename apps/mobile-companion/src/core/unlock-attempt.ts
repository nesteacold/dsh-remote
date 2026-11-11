// A020/M5 — generation guard for the unlock gate's awaited steps.
//
// `attemptUnlock()` in `app/_layout.tsx` awaits `unlockCapability()` and `authenticate()`
// before it may hand the credential to the controller. The app can leave the foreground
// (which locks the gate) — or the layout can unmount — while either call is still in flight.
// Without an attempt generation the late success of an abandoned prompt re-opens the gate and
// opens the credential connection *while the app is in the background*, which is exactly the
// credential boundary A020/M5 must hold.
//
// This stays pure and React-free (no react-native import: `npm run check:core` enforces that)
// so the race can be unit-tested; the layout only reports lifecycle facts and asks
// `isCurrent()` after every await.

/**
 * Identity of the unlock prompt in flight (plus the lifecycle facts that can revoke it).
 *
 * Invariants the layout relies on:
 *   * every `begin()` starts a new generation, so at most one attempt is ever current;
 *   * leaving the foreground invalidates in-flight prompts, and coming back does *not* revive
 *     them (both transitions bump the generation);
 *   * an unmounted layout is never current, whatever the platform prompt answers.
 */
export class UnlockAttempts {
  private generation = 0;
  private foreground = true;
  private mounted = true;

  /** Start a prompt; returns the token every post-await step must re-check. */
  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  /**
   * Report an app-state transition: `false` only for `background`, `true` for `active`.
   *
   * `inactive` is deliberately not reported: on iOS the system biometric sheet itself puts the
   * app in `inactive`, so treating it as "left the foreground" would cancel the very prompt
   * the user is answering. Backgrounding bumps the generation (a prompt that outlived the trip
   * to the background can never become current again); returning to the foreground bumps it
   * again so an older token cannot be revived either.
   */
  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    this.generation += 1;
  }

  /** Mount/unmount of the gate: a detached layout must never be unlocked by a late result. */
  setMounted(mounted: boolean): void {
    if (this.mounted === mounted) return;
    this.mounted = mounted;
    this.generation += 1;
  }

  /** The one question every post-await step asks before touching the gate or the controller. */
  isCurrent(attempt: number): boolean {
    return this.mounted && this.foreground && attempt === this.generation;
  }
}
