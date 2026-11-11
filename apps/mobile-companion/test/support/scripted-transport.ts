// Test-only `Transport` driven frame by frame: no sockets, no TLS, no gateway.
//
// `node-pinned-transport.ts` proves the pinning behaviour against a real (in-process) gateway;
// this one exists for *protocol* assertions where the test has to decide exactly what the host
// sends and when (e.g. a `paired` frame that must be refused, or an error frame whose
// `requestId` belongs to no pending request). It never produces `open` on its own.

import type { Transport, TransportConnectOptions, TransportEvent, TransportListener } from '../../src/core/transport';

export interface ScriptedConnect {
  url: string;
  options: TransportConnectOptions;
}

export class ScriptedTransport implements Transport {
  /** Every `connect()` call (a single transport instance must only be connected once). */
  readonly connects: ScriptedConnect[] = [];
  /** Frames the client handed to the transport while it was open. */
  readonly sent: string[] = [];
  /** Frames the client tried to send before `open` (must stay empty: contract §3.1). */
  readonly sentBeforeOpen: string[] = [];

  private readonly listeners = new Set<TransportListener>();
  private open = false;

  connect(url: string, options: TransportConnectOptions): void {
    this.connects.push({ url, options });
  }

  send(data: string): boolean {
    if (!this.open) {
      this.sentBeforeOpen.push(data);
      return false;
    }
    this.sent.push(data);
    return true;
  }

  close(code = 1000, reason = ''): void {
    const wasOpen = this.open;
    this.open = false;
    this.emit({ type: 'close', code, reason, wasClean: wasOpen && code === 1000 });
  }

  on(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The TLS pin matched and the socket is open (only the test may say so). */
  fireOpen(): void {
    this.open = true;
    this.emit({ type: 'open' });
  }

  /** A server frame arrived. */
  deliver(frame: Record<string, unknown>): void {
    this.emit({ type: 'message', data: JSON.stringify(frame) });
  }

  /** Server frames the client actually wrote, parsed. */
  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  /** The requestId of the last frame of one `type`. */
  lastRequestId(type: string): string {
    const frame = [...this.sentFrames()].reverse().find((candidate) => candidate.type === type);
    if (frame === undefined || typeof frame.requestId !== 'string') {
      throw new Error(`the client never sent a ${type} frame`);
    }
    return frame.requestId;
  }

  private emit(event: TransportEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
