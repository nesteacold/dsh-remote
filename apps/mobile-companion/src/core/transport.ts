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

/** Minimal event emitter shared by transports; keeps listener ordering and error isolation. */
export class TransportEmitter {
  private readonly listeners = new Set<TransportListener>();

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
        // A throwing listener must not break the socket's event loop.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
