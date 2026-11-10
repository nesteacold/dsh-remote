// TEMP mirror of @dsh-ext/mobile-protocol until 001-T007 lands; replace with import
//
// Reconnect policy (US5 / FR-008): bounded exponential backoff with the exact sequence
// 1, 2, 5, 10, 20, 30, 30, ... seconds, driven by an injected clock so tests need no wall
// time. Also owns the resync bookkeeping that guarantees "no duplicate / missing messages"
// after a drop.
//
//   drop --> waiting(delay) --> reconnect --> hello/client-hello --> resync --> live
//
// Contract §3: close code 4004 (gateway disabled) and 4401 (revoked) stop reconnection; 4003
// (re-authenticate) retries immediately with the stored token (see `RESTART_DELAY_MS`).

import type { ApprovalRequestedFrame } from '@dsh-ext/mobile-protocol';

/** Delays in milliseconds: 1, 2, 5, 10, 20, 30 s, then 30 s forever. */
export const BACKOFF_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;

export const MAX_BACKOFF_MS = 30_000;

/** Delay after a close 4003 (re-authenticate): reconnect promptly, the credential is fine. */
export const RESTART_DELAY_MS = 250;

/** Delay for the n-th retry (1-based). */
export function backoffDelayMs(attempt: number): number {
  if (attempt < 1) return BACKOFF_DELAYS_MS[0] as number;
  const index = Math.min(attempt, BACKOFF_DELAYS_MS.length) - 1;
  return BACKOFF_DELAYS_MS[index] as number;
}

/** Injected timer surface (fake in tests, real in the app). */
export interface ReconnectClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: ReconnectClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type ReconnectState = 'idle' | 'connecting' | 'live' | 'waiting' | 'stopped';

export interface ReconnectSnapshot {
  state: ReconnectState;
  /** Number of consecutive failed/aborted attempts (resets to 0 after a successful resync). */
  attempt: number;
  /** Wall-clock ms of the next attempt while `waiting`. */
  nextAttemptAt: number | null;
  /** Total successful connections since start. */
  connections: number;
  /** Delay (ms) that scheduled the current `waiting` state; null before the first drop. */
  lastDelayMs: number | null;
}

export interface ReconnectOptions {
  clock?: ReconnectClock;
  /** Attempts that make up the CONNECTING phase (backoff is scheduled only after these fail). */
  connect: () => void | Promise<void>;
  /** Called after every (re)connect where the handshake completed; must perform resync. */
  onResync: () => void | Promise<void>;
  /** Called when the socket drops (before scheduling the retry). */
  onDrop?: (reason?: string) => void;
  /** Notified on every state change (for the reconnecting banner). */
  onChange?: (snapshot: ReconnectSnapshot) => void;
  /** Stop retrying after this many attempts (default: never; only `stop()` stops). */
  maxAttempts?: number;
}

/**
 * Owns retry scheduling only. The caller reports `onOpen()` once the transport reports
 * `open` AND the hello/client-hello handshake finished, and `onClose()` on any drop.
 */
export class Reconnector {
  private readonly clock: ReconnectClock;
  private readonly options: ReconnectOptions;
  private state: ReconnectState = 'idle';
  private attempt = 0;
  private nextAttemptAt: number | null = null;
  private timer: unknown = null;
  private connections = 0;
  private pendingOpen = false;
  private lastDelayMs: number | null = null;
  /** True between a drop and the next connection attempt (duplicate drop reports ignored). */
  private dropped = false;
  /**
   * Lifecycle generation: bumped by `start()`, `stop()`, `handleDrop()` and every `onOpen()`.
   * The resync inside `onOpen()` is awaited, so the loop can be stopped (lock, update-required,
   * revoked), dropped or restarted while it runs. A result from an older generation must not
   * set `live` and must not schedule a retry — otherwise a background lock followed by a late
   * successful resync resurrects a connection that was deliberately torn down.
   */
  private generation = 0;

  constructor(options: ReconnectOptions) {
    this.options = options;
    this.clock = options.clock ?? realClock;
  }

  get snapshot(): ReconnectSnapshot {
    return {
      state: this.state,
      attempt: this.attempt,
      nextAttemptAt: this.nextAttemptAt,
      connections: this.connections,
      lastDelayMs: this.lastDelayMs,
    };
  }

  get isLive(): boolean {
    return this.state === 'live';
  }

  /** Begin: schedule the first attempt immediately (0 ms). Also restarts a stopped loop. */
  start(): void {
    // A restart is a new lifecycle: any resync still awaited from the previous one is stale.
    this.generation += 1;
    this.pendingOpen = false;
    this.attempt = 0;
    this.nextAttemptAt = null;
    this.connections = 0;
    this.lastDelayMs = null;
    this.dropped = false;
    this.state = 'idle';
    this.scheduleNow(0);
  }

  /** Stop retrying; cancels a pending timer. A later `start()` resumes from scratch. */
  stop(): void {
    this.cancelTimer();
    // A resync awaited for this connection must not set `live` after the stop (M5 lock).
    this.generation += 1;
    this.pendingOpen = false;
    this.state = 'stopped';
    this.nextAttemptAt = null;
    this.emitChange();
  }

  /** The socket is open and the handshake finished: run resync, then go live. */
  async onOpen(): Promise<void> {
    if (this.state === 'stopped') return;
    if (this.pendingOpen) return; // guard against duplicate open events
    /** This open owns the resync step; a stop/drop/restart meanwhile wins (see `generation`). */
    const generation = this.beginGeneration();
    this.pendingOpen = true;
    this.cancelTimer();
    this.nextAttemptAt = null;
    let resynced = false;
    try {
      await this.options.onResync();
      resynced = true;
    } catch {
      resynced = false;
    }
    // The connection that opened this resync is gone (or superseded): change nothing. A newer
    // generation already decided the state and, if it retries, owns the only timer.
    if (generation !== this.generation) return;
    this.pendingOpen = false;
    if (!resynced) {
      // Resync failed: treat it as a drop and retry under backoff.
      this.handleDrop('resync-failed');
      return;
    }
    this.connections += 1;
    this.attempt = 0;
    this.state = 'live';
    this.dropped = false;
    this.emitChange();
  }

  /**
   * The socket dropped (or a connect attempt failed) before/after open.
   *
   * Idempotent per connection attempt: the close event, the rejected requests a drop fails,
   * and a failed connect callback all report the same outage — only the first call for the
   * current attempt advances the backoff step. Each `fire()` arms a new attempt, so a second
   * outage (e.g. right after a successful resync) is counted again.
   */
  handleDrop(reason?: string): void {
    if (this.state === 'stopped') return;
    if (this.dropped) return;
    this.dropped = true;
    this.pendingOpen = false;
    // An `onOpen()` resync still awaited for this connection is now stale: the drop decides
    // the next state (waiting) and owns the retry timer.
    this.generation += 1;
    this.cancelTimer();
    this.options.onDrop?.(reason);
    this.attempt += 1;
    if (this.options.maxAttempts !== undefined && this.attempt > this.options.maxAttempts) {
      this.state = 'stopped';
      this.nextAttemptAt = null;
      this.emitChange();
      return;
    }
    const delay = backoffDelayMs(this.attempt);
    this.nextAttemptAt = this.clock.now() + delay;
    this.lastDelayMs = delay;
    this.state = 'waiting';
    this.emitChange();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.fire();
    }, delay);
  }

  /** The delay currently scheduled (test helper / banner copy). */
  get scheduledDelayMs(): number | null {
    if (this.nextAttemptAt === null) return null;
    return Math.max(0, this.nextAttemptAt - this.clock.now());
  }

  /**
   * Bring the next attempt forward (e.g. the app returned to the foreground): the pending
   * backoff is cancelled and one attempt starts now, without resetting the backoff step.
   * No-op while live, connecting or stopped — a ready connection must never be duplicated.
   */
  retryNow(): void {
    if (this.state === 'stopped' || this.state === 'live' || this.state === 'connecting') return;
    this.dropped = false;
    this.scheduleNow(0);
  }

  private scheduleNow(ms: number): void {
    this.cancelTimer();
    this.nextAttemptAt = this.clock.now() + ms;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.fire();
    }, ms);
  }

  private fire(): void {
    if (this.state === 'stopped') return;
    this.dropped = false; // a new attempt may report its own drop
    this.nextAttemptAt = null;
    this.state = 'connecting';
    this.emitChange();
    try {
      const result = this.options.connect();
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch(() => this.handleDrop('connect-failed'));
      }
    } catch {
      this.handleDrop('connect-failed');
    }
  }

  /** Start a new lifecycle epoch; an awaited resync from an older one becomes stale. */
  private beginGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emitChange(): void {
    this.options.onChange?.(this.snapshot);
  }
}

// ---------------------------------------------------------------------------
// Resync bookkeeping
// ---------------------------------------------------------------------------

export interface ResyncInput {
  /** Fresh `sessions` rows (already shape-checked by the sessions store). */
  sessions: Array<{ id: string; updatedAt?: number | string; [key: string]: unknown }>;
  /** Fresh pending approvals replayed by `subscribe` (`replay: true` pushes). */
  approvals: readonly ApprovalRequestedFrame[];
  /** Local outbox items still queued (sent again with their original clientMsgId). */
  queuedClientMsgIds: readonly string[];
}

/**
 * Decide what changed after a reconnect. Pure: returns ids only, so the caller can apply the
 * minimal updates. Duplicates are impossible by construction: approvals are keyed by
 * approvalId and prompts by clientMsgId; re-listing never creates new ids.
 */
export function planResync(previous: ResyncInput, next: ResyncInput): {
  addedSessionIds: string[];
  removedSessionIds: string[];
  updatedSessionIds: string[];
  newApprovalIds: string[];
  droppedApprovalIds: string[];
  promptsToResend: string[];
} {
  const prevSessions = new Map(previous.sessions.map((s) => [s.id, s] as const));
  const nextSessions = new Map(next.sessions.map((s) => [s.id, s] as const));

  const addedSessionIds = [...nextSessions.keys()].filter((id) => !prevSessions.has(id));
  const removedSessionIds = [...prevSessions.keys()].filter((id) => !nextSessions.has(id));
  const updatedSessionIds = [...nextSessions.values()]
    .filter((s) => {
      const before = prevSessions.get(s.id);
      return before !== undefined && before.updatedAt !== s.updatedAt;
    })
    .map((s) => s.id);

  const prevApprovals = new Set(previous.approvals.map((a) => a.approvalId));
  const nextApprovals = new Set(next.approvals.map((a) => a.approvalId));
  const newApprovalIds = [...nextApprovals].filter((id) => !prevApprovals.has(id));
  const droppedApprovalIds = [...prevApprovals].filter((id) => !nextApprovals.has(id));

  // Every queued prompt is sent again with its original clientMsgId; the host dedupes, so
  // "applied once" holds even if the first copy actually arrived before the drop.
  const promptsToResend = [...new Set(next.queuedClientMsgIds)];

  return {
    addedSessionIds,
    removedSessionIds,
    updatedSessionIds,
    newApprovalIds,
    droppedApprovalIds,
    promptsToResend,
  };
}
