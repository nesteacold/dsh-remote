// Cold-start sequencing (A020/M5 follow-up).
//
// `AppController.start()` loads the stored paired host asynchronously and `unlock()` only
// connects a host that is *already installed*: when it runs first it reads the credential, finds
// `host === null`, connects nothing, and the app stays unlocked and offline even after `start()`
// installs the saved host. The unlock gate and the start effect therefore have to share one
// startup attempt, and every unlock has to wait for it.
//
// This keeps that sequencing — one attempt for all callers, a failure that never becomes an
// unhandled rejection, and an explicit retry — out of the layout (which has no renderer in this
// suite) and out of the controller (which owns state, not its callers' ordering). Pure TS:
// `npm run check:core` forbids react-native / expo / node imports here.

export type StartupStatus = 'idle' | 'starting' | 'ready' | 'failed';

export interface StartupSequenceOptions {
  /** One startup attempt — the controller's `start()`. */
  start: () => Promise<void>;
  /**
   * Abandon a failed attempt before retrying. `start()` may latch "already started" *before* its
   * first `await` (the controller does), so a retry without this would return immediately and
   * never re-read the host list.
   */
  reset?: () => void;
}

/**
 * One shared startup attempt.
 *
 * Invariants the layout relies on:
 *   * `ensure()` starts at most one attempt at a time: the cold-start effect and an unlock that
 *     races it join the same promise, so the host list is loaded once and the unlock cannot read
 *     the credential before it is installed;
 *   * `ensure()` never rejects — a failure resolves `false` and is remembered, so no caller can
 *     leak an unhandled rejection and the gate can offer a retry;
 *   * a call after a failure retries (via `reset()`, then `start()`), so the retry path is the
 *     same code as the first attempt;
 *   * once `ready`, a later call resolves immediately and never restarts the controller.
 */
export class StartupSequence {
  private readonly options: StartupSequenceOptions;
  private current: StartupStatus = 'idle';
  private attempt: Promise<boolean> | null = null;
  private failure: unknown = null;

  constructor(options: StartupSequenceOptions) {
    this.options = options;
  }

  get status(): StartupStatus {
    return this.current;
  }

  /** Why the last attempt failed (`null` otherwise). Diagnostics only: never a credential. */
  get error(): unknown {
    return this.failure;
  }

  /**
   * Resolve `true` once the app is started, `false` when the attempt failed (never rejects).
   * The first call starts the attempt; a concurrent call joins it; a call after a failure is the
   * retry.
   */
  ensure(): Promise<boolean> {
    if (this.current === 'ready') return Promise.resolve(true);
    if (this.current === 'starting' && this.attempt !== null) return this.attempt;
    if (this.current === 'failed') this.options.reset?.();
    this.current = 'starting';
    this.failure = null;
    const attempt = this.run();
    this.attempt = attempt;
    // Cleared in a microtask, after `ensure()` handed the promise out: a settled attempt is
    // never returned as "in flight" (the status check above already covers that).
    void attempt.then(() => {
      if (this.attempt === attempt) this.attempt = null;
    });
    return attempt;
  }

  private async run(): Promise<boolean> {
    try {
      await this.options.start();
      this.current = 'ready';
      return true;
    } catch (error) {
      this.failure = error;
      this.current = 'failed';
      return false;
    }
  }
}
