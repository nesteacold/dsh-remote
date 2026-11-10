/** Small deterministic fake clock/timer pair implementing ReconnectClock. */

import type { ReconnectClock } from '../../src/core/reconnect';

interface Scheduled {
  id: number;
  at: number;
  fn: () => void;
}

export class FakeClock implements ReconnectClock {
  private current: number;
  private nextId = 1;
  private readonly scheduled: Scheduled[] = [];

  constructor(start = 1_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const entry = { id: this.nextId++, at: this.current + ms, fn };
    this.scheduled.push(entry);
    return entry.id;
  }

  clearTimeout(handle: unknown): void {
    const index = this.scheduled.findIndex((s) => s.id === handle);
    if (index >= 0) this.scheduled.splice(index, 1);
  }

  /** Pending timer delays relative to now, sorted. */
  pendingDelays(): number[] {
    return this.scheduled.map((s) => s.at - this.current).sort((a, b) => a - b);
  }

  get pendingCount(): number {
    return this.scheduled.length;
  }

  /** Advance time, firing due timers in order (timers scheduled while advancing fire too). */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      this.scheduled.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.scheduled[0];
      if (!next || next.at > target) break;
      this.scheduled.shift();
      this.current = next.at;
      next.fn();
      await flush();
    }
    this.current = target;
    await flush();
  }
}

/** Let pending promise callbacks (microtasks + one macrotask) settle. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
