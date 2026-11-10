// Event shapes of the `pinned-ws` module. One event per socket, always carrying `id`, so a
// single listener (the transport adapter) can route a dozen sockets.
//
// Lifecycle the JS side may rely on (and `src/platform/pinned-transport.ts` does):
//   connecting -> onOpen | onError  (exactly one of the two first)
//   after onOpen: onMessage* -> (onClose | onError then onClose)
//   onError before onOpen means nothing was sent. A `client/pin-mismatch`,
//   `client/insecure-url` or `client/insecure-headers` error is ALWAYS followed by a
//   synthetic `onClose{ code: 1006 }` so callers that only watch `onClose` still finish.
//
// An event name is emitted at most once per socket per lifetime for `open`; the native side
// drops every emission after `close` and after removal.

export interface PinnedWsOpenEvent {
  id: string;
  /** Subprotocol the server selected (contract v1: always `dsh-mobile-v1`), or `null`. */
  protocol: string | null;
}

export interface PinnedWsMessageEvent {
  id: string;
  /** One WebSocket text frame. The contract carries JSON text only. */
  data: string;
}

export interface PinnedWsCloseEvent {
  id: string;
  /** WebSocket close code as received; 1006 for a connection that never opened. */
  code: number;
  reason: string;
}

export interface PinnedWsErrorEvent {
  id: string;
  /**
   * `client/pin-mismatch`, `client/insecure-url`, `client/insecure-headers`,
   * `client/upgrade-failed`, `client/connect-failed`.
   */
  code: string;
  /** Human-readable, secret-free (never contains the URL, headers or a subprotocol). */
  message: string;
  /** `client/upgrade-failed` only: the HTTP status of the refused upgrade (401/403/...). */
  status?: number;
  /** `client/pin-mismatch` only: the leaf SHA-256 observed (hex), for diagnostics/drift. */
  observedSha256?: string;
}

export interface PinnedWsEventMap {
  onOpen: (event: PinnedWsOpenEvent) => void;
  onMessage: (event: PinnedWsMessageEvent) => void;
  onClose: (event: PinnedWsCloseEvent) => void;
  onError: (event: PinnedWsErrorEvent) => void;
}

export type PinnedWsEventName = keyof PinnedWsEventMap;

export const PINNED_WS_EVENT_NAMES: readonly PinnedWsEventName[] = ['onOpen', 'onMessage', 'onClose', 'onError'];

/** The native object: two methods plus the Expo event emitter surface. */
export interface PinnedWsAdapter {
  /**
   * Start a socket. Resolves once the attempt was accepted, NOT when it is open (`onOpen` is an
   * event). It rejects only for a caller bookkeeping error — the id already belongs to a live
   * socket, or the module was destroyed — because events carry only the id and a synthetic
   * `onClose` would be indistinguishable from the live socket failing. Every transport-level
   * refusal (bad pin/URL/headers, refused upgrade, connect failure) still arrives as
   * `onError` + the synthetic `onClose{1006}`.
   */
  connect(id: string, url: string, options: Record<string, unknown>): Promise<void>;
  send(id: string, text: string): Promise<boolean>;
  close(id: string, code: number, reason: string): Promise<void>;
  addListener(name: PinnedWsEventName, listener: (event: unknown) => void): { remove(): void };
}

export const PinnedWsEvents = {
  open: 'onOpen',
  message: 'onMessage',
  close: 'onClose',
  error: 'onError',
} as const satisfies Record<string, PinnedWsEventName>;

/**
 * Subscribe to all four events; returns one unsubscribe function. Exported so the adapter and
 * tests share the exact subscription semantics (a throwing listener cannot stop the others).
 */
export function addPinnedWsListener(
  module: PinnedWsAdapter,
  hooks: Partial<PinnedWsEventMap>,
): () => void {
  const subscriptions = PINNED_WS_EVENT_NAMES.filter((name) => hooks[name] !== undefined).map((name) =>
    module.addListener(name, (event) => {
      try {
        (hooks[name] as ((event: unknown) => void) | undefined)?.(event);
      } catch {
        // A throwing consumer must not break the native event queue.
      }
    }),
  );
  return () => {
    for (const subscription of subscriptions) {
      try {
        subscription.remove();
      } catch {
        // already removed
      }
    }
  };
}
