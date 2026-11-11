// Transport abstraction. `src/core` never imports react-native/expo/Node:
// production uses the pinned-ws Expo module (Phase 4, A030) through
// `src/platform/pinned-transport.ts`; tests use `test/support/node-pinned-transport.ts`.
//
// Contract invariant that every implementation MUST honour (contract §3.1):
// `open` is only emitted after the TLS leaf certificate SHA-256 equals `certSha256`.
// `message` before `open`, or `open` after a pin mismatch, must never happen — the core
// client treats `open` as proof that it is safe to send the pairing code / bearer token.

export type TransportEvent =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'close'; code: number; reason: string; wasClean: boolean }
  | {
      type: 'error';
      code: string;
      message: string;
      /**
       * Transport-level context (never secrets): `status` for an HTTP upgrade refusal
       * (`client/upgrade-failed`, or the mapped `auth/required` / `remote/disabled`).
       */
      details?: Record<string, unknown>;
    };

export type TransportListener = (event: TransportEvent) => void;

/** Which listener boundary swallowed an exception. Fixed, secret-free names only. */
export type ListenerFailureBoundary = 'native' | 'transport' | 'client';

/**
 * What a listener-failure reporter receives: a fixed boundary name and a fixed stage string the
 * call site chose (e.g. `message`, `onMessage`, `frame:hello`). Deliberately nothing else — no
 * exception message, payload, frame text or stack can reach a log sink through this channel.
 */
export interface ListenerFailureInfo {
  boundary: ListenerFailureBoundary;
  stage: string;
}

/** Injected by the app to make listener failures observable (absent by default: no allocation). */
export type ListenerFailureReporter = (info: ListenerFailureInfo) => void;

export interface TransportConnectOptions {
  /**
   * SHA-256 of the host leaf certificate, 64 lowercase hex chars (from the QR / stored
   * PairedHost). Implementations MUST compare before reporting `open`.
   */
  certSha256: string;
  /**
   * Subprotocols: `['dsh-mobile-v1', 'dsh-pair.<code>']` while pairing and
   * `['dsh-mobile-v1', 'dsh-auth.<token>']` once paired (contract §3.4 — the bearer token rides in
   * `Authorization` *and* in the subprotocol, so a lost header cannot leave the socket anonymous).
   */
  protocols?: string[];
  /** Extra headers: `X-DSH-Device-ID`, `Authorization: Bearer <token>`, … */
  headers?: Record<string, string>;
}

export interface Transport {
  /**
   * Start connecting. Returns immediately; events arrive via `on()`. Calling `send` before
   * `open` is an error and MUST NOT put bytes on the wire.
   */
  connect(url: string, options: TransportConnectOptions): void;
  /** Send one text frame. Throws (or returns false) when not open. */
  send(data: string): boolean;
  /** Close the socket (idempotent). */
  close(code?: number, reason?: string): void;
  /** Subscribe; returns an unsubscribe function. */
  on(listener: TransportListener): () => void;
}

/** App-local transport error codes (namespaced so they cannot collide with contract codes). */
export const TRANSPORT_ERROR = {
  pinMismatch: 'client/pin-mismatch',
  notOpen: 'client/not-open',
  connectFailed: 'client/connect-failed',
  badUrl: 'client/bad-url',
  /** The native transport does not exist in this build (Expo Go / web). */
  pinnedTransportUnavailable: 'client/pinned-transport-unavailable',
  /** `pinned-ws` (A030): the URL is not `wss://`; nothing was sent. */
  insecureUrl: 'client/insecure-url',
  /** `pinned-ws` (A030): the HTTP upgrade was refused; `details.status` has 401/403/... */
  upgradeFailed: 'client/upgrade-failed',
} as const;

export type TransportErrorCode = (typeof TRANSPORT_ERROR)[keyof typeof TRANSPORT_ERROR];
export type TransportErrorDetails = Record<string, unknown>;

/**
 * Minimal event emitter shared by transports; keeps listener ordering and error isolation.
 *
 * Isolation stays: one throwing listener cannot break the socket loop. The failure is no longer
 * invisible though — it is reported to the injected `onListenerFailure` with the fixed kind of
 * event that was being delivered (`open`/`message`/`close`/`error`, a closed literal union, never
 * the payload). Nothing here ends a socket: an unrelated listener bug must not disconnect.
 */
export class TransportEmitter {
  private readonly listeners = new Set<TransportListener>();
  private readonly onListenerFailure: ListenerFailureReporter | undefined;

  constructor(onListenerFailure?: ListenerFailureReporter) {
    this.onListenerFailure = onListenerFailure;
  }

  on(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: TransportEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        this.reportListenerFailure(event.type);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  /** Diagnostics only: a reporter that throws is itself swallowed (it must never alter a socket). */
  private reportListenerFailure(stage: string): void {
    const report = this.onListenerFailure;
    if (report === undefined) return;
    try {
      report({ boundary: 'transport', stage });
    } catch {
      // best effort
    }
  }
}
