// Connection lifecycle (US1 / US5) over an injected Transport, contract v1 revision 2:
//
//   transport open (pin already verified)
//     -> [pairing] kind:"paired" {token, device}          -> onPaired()
//     -> kind:"hello"                                      -> companion version gate
//     -> type:"client-hello" {requestId, companionProtocol, appVersion, platform}
//     -> kind:"client-hello" {requestId, accepted:true}    -> ready
//
// Frames: client -> server `{type, requestId, ...}`; server -> client `{kind, ...}`; every
// answer to a request echoes its `requestId`. Pushes (`approval-requested`, `approval-resolved`,
// `event`) carry no `requestId`.
//
// Close codes (contract §3): 4004 gateway disabled (stop auto-reconnect), 4003 re-authenticate,
// 4401 revoked (wipe the credential). In-band `auth/revoked` / `remote/disabled` behave the same.
//
// Close semantics (M6): ending a connection is terminal and reported exactly once. `close()` is
// authoritative even when the transport stays silent after a local close (a native socket can be
// unsubscribed without an event): pending requests fail with `client/disconnected`, the state
// becomes `closed` (a terminal protocol state is kept) and one `disconnected` is emitted. The
// handshake is bounded too: `handshakeTimeoutMs` (default 10 s) covers no `open`, no `hello` and
// no accepted `client-hello`, so an attempt cannot wait forever for a host that never answers.
//
// Hard invariant (SC-002): no frame is handed to the transport before the socket is open. An
// inbound application frame can only travel over a socket whose TLS handshake and certificate
// pin already succeeded, so it is accepted as proof of `open`: a native `onMessage` can reach JS
// ahead of its `onOpen`, and dropping the server `hello` because of that ordering wedged the
// handshake until the deadline (device regression: `onOpen` + `onMessage` logged natively, no
// `client-hello` ever sent). The protocol rules below (§3.3/§5a pairing, version gate) are
// unchanged — only the transport-state bookkeeping is.

import {
  CLOSE_CODES,
  COMPANION_PROTOCOL_VERSION,
  OPS,
  PING_INTERVAL_MS,
  authSubprotocols,
  pairingSubprotocols,
  type ApprovalRequestedFrame,
  type ApprovalResolvedFrame,
  type DeviceInfo,
  type HelloFrame,
  type Op,
  type PairedFrame,
} from '@dsh-ext/mobile-protocol';

import { CoreError, normaliseErrorCode, type CoreErrorCode } from './errors';
import { TRANSPORT_ERROR, type Transport, type TransportEvent } from './transport';

export interface UpdateRequired {
  /** Which side must be updated for the connection to work. */
  side: 'app' | 'host';
  code: 'protocol/unsupported';
  /** Companion protocol the host reported, for the update screen. */
  hostCompanionProtocol?: number;
  minClientVersion?: number;
  message: string;
}

export type ClientState =
  | 'idle'
  | 'connecting'
  | 'waiting-hello'
  | 'waiting-client-hello'
  | 'ready'
  | 'closed'
  | 'update-required'
  | 'revoked'
  | 'gateway-disabled'
  | 'reauth-required';

export interface ClientEventMap {
  state: ClientState;
  /** `paired` arrived: store the token now, it is sent only once. */
  paired: { token: string; device: DeviceInfo };
  /** Server `hello` accepted and `client-hello` answered. */
  ready: { hello: HelloFrame; device: DeviceInfo | null };
  /** A request failed, or the server sent an error frame. */
  error: CoreError;
  /** Server push `approval-requested`. */
  approvalRequested: ApprovalRequestedFrame;
  /** Server push `approval-resolved` (decided here, on the desktop, or gone). */
  approvalResolved: ApprovalResolvedFrame;
  /** Server push `event` (session updates); payload is passed through. */
  event: Record<string, unknown>;
  /** Socket dropped (also emitted on a failed connect / pin mismatch / local close / handshake timeout). */
  disconnected: { code: number; reason: string; retry: boolean };
  /** Host speaks a version this app cannot talk to (typed, never silent). */
  updateRequired: UpdateRequired;
  /** Device was revoked: caller must wipe the credential and return to pairing. */
  revoked: { code: 'auth/revoked' };
  /** Owner switched remote control off: stop auto-reconnect, show the "turn it on" screen. */
  gatewayDisabled: { code: 4004 | 'remote/disabled' };
  /** Host asked to re-authenticate (close 4003): reconnect (pairing if the token is gone). */
  reauthRequired: { code: 4003 };
}

type Handler<K extends keyof ClientEventMap> = (payload: ClientEventMap[K]) => void;

/** Transport factory or a ready transport (tests usually pass a factory). */
export type ClientTransportSource = Transport | { create(): Transport };

export interface ConnectionTarget {
  /** `wss://` URL (from the QR `publicUrl`). */
  url: string;
  /** SHA-256 of the host leaf certificate (from the QR). */
  certSha256: string;
  /** Install-scoped device UUID; sent as `X-DSH-Device-ID` during pairing. */
  installId: string;
  /** Device display name sent to the host during pairing. */
  deviceName?: string;
}

export type ConnectOptions =
  | (ConnectionTarget & { token: string; pairingCode?: undefined })
  | (ConnectionTarget & { pairingCode: string; token?: undefined });

export interface ClientOptions {
  transport: ClientTransportSource;
  /** `x.y.z`, sent in `client-hello` (contract §3.6). */
  appVersion: string;
  /** `ios` | `android`. */
  platform: 'ios' | 'android';
  /**
   * requestId source; defaults to `defaultRequestId()` (see there: portable, never throws).
   * An injected source must also never throw: a failure is reported as a `client/*` error.
   */
  newRequestId?: () => string;
  /** Request timeout in ms (default 15 s; 0 disables). */
  requestTimeoutMs?: number;
  /**
   * Upper bound in ms for the whole connection handshake — socket `open`, the server `hello`,
   * and the host's accepted `client-hello` (contract §5a). On expiry the client reports a
   * retryable `client/timeout` error (`details.stage` says which step stalled), emits a
   * retryable `disconnected` and closes the attempt, so a retry loop can start over. The
   * default is 10 s; `0` disables the deadline (tests inject a small value).
   */
  handshakeTimeoutMs?: number;
  /** Ping interval override (tests); defaults to the contract's 25 s. */
  pingIntervalMs?: number;
  /** Called exactly once per connection when the host confirms revocation. */
  onRevoked?: () => void | Promise<void>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: CoreError) => void;
  timer: ReturnType<typeof setTimeout> | null;
  op: string;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Default budget for the connection handshake (`open` -> `hello` -> accepted `client-hello`).
 * A Host on the same LAN answers in well under a second; a minute-long silence is a failure,
 * not a slow network, and must not leave the app stuck in `connecting`/`waiting-*` forever.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Placeholder transport before the first `connect()` on a factory-based client. It never
 * opens and refuses every frame, so a mis-ordered call fails loudly instead of silently.
 */
const NULL_TRANSPORT: Transport = {
  connect() {
    /* nothing to connect: call connect() on the client */
  },
  send() {
    return false;
  },
  close() {
    /* no socket */
  },
  on() {
    return () => {
      /* no events */
    };
  },
};

/** Error codes that mean "the socket is gone, retry later". */
const TRANSPORT_RETRYABLE: ReadonlySet<string> = new Set<string>([
  TRANSPORT_ERROR.connectFailed,
  TRANSPORT_ERROR.badUrl,
]);

/** Close codes after which automatic reconnection is pointless (contract §3). */
export const NO_AUTO_RECONNECT_CLOSE_CODES: ReadonlySet<number> = new Set([CLOSE_CODES.gatewayDisabled]);

/**
 * Map a host version mismatch to a typed update requirement. `minClientVersion` above our
 * version ⇒ the app is too old; otherwise the host speaks an older protocol.
 */
export function classifyProtocolUnsupported(
  hello: Pick<HelloFrame, 'companionProtocol' | 'minClientVersion'> | null,
  errorFrame: { minClientVersion?: number } | null,
  clientVersion: number = COMPANION_PROTOCOL_VERSION,
): UpdateRequired {
  const hostCompanionProtocol = hello?.companionProtocol;
  const minClientVersion = errorFrame?.minClientVersion ?? hello?.minClientVersion;
  const appTooOld = typeof minClientVersion === 'number' ? minClientVersion > clientVersion : hello !== null;
  if (appTooOld) {
    return {
      side: 'app',
      code: 'protocol/unsupported',
      ...(hostCompanionProtocol === undefined ? {} : { hostCompanionProtocol }),
      ...(minClientVersion === undefined ? {} : { minClientVersion }),
      message: 'This host needs a newer version of DSH Companion. Update the app.',
    };
  }
  return {
    side: 'host',
    code: 'protocol/unsupported',
    ...(hostCompanionProtocol === undefined ? {} : { hostCompanionProtocol }),
    ...(minClientVersion === undefined ? {} : { minClientVersion }),
    message: 'This host speaks an older protocol. Update DSH on your computer.',
  };
}

/** `requestId` must be ≤ 64 chars of `[A-Za-z0-9._-]` (contract §1). */
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The slice of the Web Crypto surface the id generator may use. Typed by hand and read off
 * `globalThis` at call time — never imported — because `src/core` must stay free of
 * expo/react-native/node imports (`npm run check:core`), and React Native 0.88 ships no Web Crypto.
 */
interface RequestIdCrypto {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/**
 * `globalThis.crypto` when it is a usable object. A polyfill can be partial, `null`, or a getter
 * that throws, so every failure is folded into "no crypto" instead of reaching the handshake.
 */
function requestIdCrypto(): RequestIdCrypto | undefined {
  try {
    const candidate = (globalThis as { crypto?: RequestIdCrypto | null }).crypto;
    return typeof candidate === 'object' && candidate !== null ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** `length` random bytes from `getRandomValues`; null when the platform has none (or it throws). */
function randomBytes(cryptoObject: RequestIdCrypto | undefined, length: number): Uint8Array | null {
  if (cryptoObject === undefined || typeof cryptoObject.getRandomValues !== 'function') return null;
  try {
    const bytes = new Uint8Array(length);
    // Called on the Crypto object itself: engines brand-check the receiver.
    cryptoObject.getRandomValues(bytes);
    return bytes;
  } catch {
    return null;
  }
}

/** RFC 4122 v4 layout over 16 random bytes: version 4, variant 10xx, lowercase hex. */
function formatUuidV4(bytes: Uint8Array): string {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  let hex = '';
  for (let index = 0; index < 16; index += 1) hex += (bytes[index] ?? 0).toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** `length` base-36 digits of `Math.random()` (32-bit draws): the non-crypto fallback's entropy. */
function randomSuffix(length: number): string {
  let out = '';
  while (out.length < length) out += Math.floor(Math.random() * 0x1_0000_0000).toString(36).padStart(7, '0');
  return out.slice(0, length);
}

let fallbackSequence = 0;
/** Per-process prefix, built on first use, so fallback ids cannot repeat across runs or devices. */
let fallbackPrefix: string | null = null;

/**
 * Last resort: `Math.random()` + a monotonic counter + a per-process prefix. Weaker than a UUID
 * (neither cryptographic nor globally unique), which the contract allows: a `requestId` is a
 * correlation token for one connection, never a secret, and only has to be 1..64 chars of
 * `[A-Za-z0-9._-]` and distinct within the connection. Nothing here may throw, so a patched or
 * broken `Math.random` degrades to the bare counter, which is still distinct per process.
 */
function fallbackRequestId(): string {
  fallbackSequence += 1;
  const sequence = fallbackSequence.toString(36);
  try {
    let prefix = fallbackPrefix;
    if (prefix === null) {
      prefix = `fb${Date.now().toString(36)}${randomSuffix(4)}`.slice(0, 28);
      fallbackPrefix = prefix;
    }
    const id = `${prefix}.${sequence}.${randomSuffix(8)}`;
    if (REQUEST_ID_RE.test(id)) return id;
  } catch {
    /* fall through to the counter-only id */
  }
  return `fb.${sequence}`;
}

/**
 * Portable `requestId` (contract §1: 1..64 chars of `[A-Za-z0-9._-]`). **Never throws.**
 *
 * React Native 0.88 exposes no Web Crypto, so `globalThis.crypto.randomUUID` is undefined on a
 * device while Node (tests) always has it — a throw here used to abort `sendClientHello()` before
 * a frame was written, leaving the client in `waiting-client-hello` until the 10 s handshake
 * deadline with nothing reported (device regression). Hence the three-step degrade:
 * `randomUUID()` -> `getRandomValues()` (RFC 4122 v4 built here) -> counter + `Math.random()`.
 * Only the last branch is weak, and only correlation of a request with its answer depends on it.
 */
export function defaultRequestId(): string {
  const cryptoObject = requestIdCrypto();
  if (cryptoObject !== undefined && typeof cryptoObject.randomUUID === 'function') {
    try {
      const id = cryptoObject.randomUUID();
      if (typeof id === 'string' && REQUEST_ID_RE.test(id)) return id;
    } catch {
      // A broken UUID polyfill falls through to random bytes / the counter.
    }
  }
  const bytes = randomBytes(cryptoObject, 16);
  if (bytes !== null) return formatUuidV4(bytes);
  return fallbackRequestId();
}

export class CompanionClient {
  private readonly createTransport: () => Transport;
  private transport: Transport;
  private readonly handlers = new Map<keyof ClientEventMap, Set<(payload: unknown) => void>>();
  private readonly newRequestId: () => string;
  private readonly requestTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly appVersion: string;
  private readonly platform: 'ios' | 'android';
  private readonly pending = new Map<string, PendingRequest>();
  private unsubscribe: (() => void) | null = null;
  private _state: ClientState = 'idle';
  private _hello: HelloFrame | null = null;
  private _device: DeviceInfo | null = null;
  private _pairedToken: string | null = null;
  private revokedFired = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Bounded handshake deadline for the current attempt (null once it finished or was cleared). */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * True once the end of the current connection was reported. The first terminal report wins
   * (local close, transport close or the handshake deadline), so listeners see exactly one
   * `disconnected` and a late transport event cannot resurrect a finished connection.
   */
  private closeReported = false;
  /** True while the socket may still deliver frames (set on open, cleared on close). */
  private transportReady = false;
  /** True when this connection is a first-pairing connection. */
  private pairing = false;
  /** True once this pairing connection accepted its single `paired` frame (contract §5a). */
  private pairedReceived = false;
  /** requestId of the client-hello the host must acknowledge. */
  private lastClientHelloId: string | null = null;
  /** True when `options.transport` is a factory: a fresh transport per connection. */
  private readonly isFactory: boolean;

  constructor(options: ClientOptions) {
    const source = options.transport;
    const factory = (source as { create?: () => Transport }).create;
    this.isFactory = typeof factory === 'function';
    this.createTransport = this.isFactory
      ? () => (factory as () => Transport).call(source)
      : () => source as Transport;
    // A single transport instance (the non-factory form) is bound to the first connection;
    // a factory allocates a fresh one per connect (a closed socket cannot be reused). The
    // constructor does not allocate: `connect()` creates the one transport it will use.
    this.transport = this.isFactory ? NULL_TRANSPORT : source as Transport;
    this.newRequestId = options.newRequestId ?? defaultRequestId;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.appVersion = options.appVersion;
    this.platform = options.platform;
    if (options.onRevoked) {
      this.on('revoked', () => {
        void options.onRevoked?.();
      });
    }
  }

  get state(): ClientState {
    return this._state;
  }

  get hello(): HelloFrame | null {
    return this._hello;
  }

  /** Device the host reports for this connection (`hello.device`), if any. */
  get device(): DeviceInfo | null {
    return this._device;
  }

  /** Token delivered by `paired` on the current connection (null before pairing). */
  get pairedToken(): string | null {
    return this._pairedToken;
  }

  /**
   * Drop the in-memory copy of the token. The app calls this as soon as the credential is in the
   * secure store (N6): the one-time token must not linger in JS memory or in logs/diagnostics.
   */
  forgetPairedToken(): void {
    this._pairedToken = null;
  }

  /** The transport in use (tests inspect its counters). */
  get transportRef(): Transport {
    return this.transport;
  }

  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof ClientEventMap>(event: K, handler: Handler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set<(payload: unknown) => void>();
    set.add(handler as (payload: unknown) => void);
    this.handlers.set(event, set);
    return () => {
      set.delete(handler as (payload: unknown) => void);
    };
  }

  /** True from transport `open` until the socket closes. */
  get connected(): boolean {
    return this.transportReady;
  }

  /**
   * Open the socket. Exactly one credential source:
   *   - paired  -> `token`       => header `Authorization: Bearer <token>` AND the offered
   *                                 `dsh-auth.<token>` subprotocol (contract §3.4: both forms,
   *                                 so one lost header cannot leave the socket unauthenticated)
   *   - pairing -> `pairingCode` => subprotocols `dsh-mobile-v1, dsh-pair.<code>` +
   *                                 header `X-DSH-Device-ID: <installId>`
   * The pin (`certSha256`) is passed through; the transport refuses before `open` on mismatch.
   */
  connect(target: ConnectOptions): void {
    if (this._state !== 'idle' && this._state !== 'closed' && this._state !== 'revoked'
      && this._state !== 'gateway-disabled' && this._state !== 'reauth-required') {
      throw new CoreError({ code: 'client/bad-state', message: `connect() called in state ${this._state}` });
    }
    const isPairing = target.pairingCode !== undefined;
    if (isPairing && target.token !== undefined) {
      throw new CoreError({
        code: 'client/bad-state',
        message: 'A connection is either a pairing or an authenticated connection, not both',
      });
    }
    this.unsubscribe?.();
    // Each connection gets a fresh transport from a factory: a closed socket cannot be
    // reused, and the caller (reconnect loop) does not have to know that.
    this.transport = this.isFactory ? this.createTransport() : this.transport;
    this.clearHandshakeTimer();
    this.closeReported = false;
    this._state = 'connecting';
    this._hello = null;
    this._device = null;
    this._pairedToken = null;
    this.revokedFired = false;
    this.transportReady = false;
    this.pairing = isPairing;
    this.pairedReceived = false;
    this.unsubscribe = this.transport.on((event) => this.onTransportEvent(event));

    const headers: Record<string, string> = {};
    let protocols: string[];
    if (isPairing) {
      protocols = pairingSubprotocols(target.pairingCode as string);
      // Header preferred; the transport may also offer `dsh-device.<id>` (see platforms).
      headers['X-DSH-Device-ID'] = target.installId;
      if (target.deviceName !== undefined && target.deviceName !== '') headers['X-DSH-Device-Name'] = target.deviceName;
    } else {
      headers.Authorization = `Bearer ${target.token}`;
      // Contract §3.4: the same token is also offered as `dsh-auth.<token>`. The header stays the
      // primary channel (the gateway reads it first), but the handshake is the one place where a
      // header can be dropped without any error surfacing — and a socket that arrives without a
      // credential is refused at the upgrade. The credential must therefore never ride on a
      // single carrier.
      protocols = authSubprotocols(target.token);
    }
    // The deadline covers the whole negotiation (open -> hello -> accepted client-hello); it is
    // cleared only by a finished handshake (`ready`) or by the real end of the attempt (a close /
    // `finishConnection`) — never by an error event, which the transport may not follow with a
    // close once the socket is open.
    this.armHandshakeTimer();
    try {
      this.transport.connect(target.url, { certSha256: target.certSha256, protocols, headers });
    } catch (error) {
      // A transport that throws instead of reporting the failure must not leave the client
      // waiting forever: report the same terminal outcome a failed connect produces.
      this.emit(
        'error',
        new CoreError({
          code: 'client/disconnected',
          message: error instanceof Error ? error.message : 'The transport could not start',
          retryable: true,
        }),
      );
      this.finishConnection(1006, 'connect-failed', true);
      return;
    }
    this.emit('state', this._state);
  }

  /**
   * Send one request and await its answer. Rejects with:
   *  - `client/bad-state` before `ready` (nothing is sent),
   *  - `client/bad-state` when no requestId could be created (nothing is sent),
   *  - the error frame's code when the host refuses,
   *  - `client/update-app-required` / `client/update-host-required` for a version mismatch,
   *  - `client/timeout` / `client/disconnected` on transport failures.
   * The wire frame is `{ type: op, requestId, ...params }`.
   *
   * A failing `newRequestId` / `send` is rejected here (typed) rather than emitted: the caller is
   * awaiting this promise, so an additional `error` event would report the same failure twice.
   */
  async request(op: Op, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this._state !== 'ready') {
      throw new CoreError({
        code: 'client/bad-state',
        message: 'Not connected yet; the request was not sent',
        details: { op, state: this._state },
      });
    }
    if (!(OPS as readonly string[]).includes(op)) {
      // Client-side allowlist: the contract forbids anything outside `companion-v1`.
      throw new CoreError({ code: 'op/forbidden', message: `${op} is not in the companion-v1 allowlist`, details: { op } });
    }
    let id = '';
    try {
      id = this.newRequestId();
    } catch (error) {
      // An injected id source that throws must not surface as a raw, untyped rejection.
      throw new CoreError({
        code: 'client/bad-state',
        message: 'No requestId could be created; the request was not sent',
        details: { op, stage: 'request' },
        cause: error,
      });
    }
    if (!REQUEST_ID_RE.test(id)) {
      throw new CoreError({ code: 'client/bad-state', message: 'requestId must be ≤ 64 chars of [A-Za-z0-9._-]' });
    }
    const frame: Record<string, unknown> = { type: op, requestId: id, ...params };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer =
        this.requestTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new CoreError({
                  code: 'client/timeout',
                  message: `No response to ${op}`,
                  retryable: true,
                  details: { op },
                }),
              );
            }, this.requestTimeoutMs)
          : null;
      timer?.unref?.();
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        op,
      });
      try {
        const sent = this.transport.send(JSON.stringify(frame));
        if (!sent) {
          this.pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(new CoreError({ code: 'client/disconnected', message: 'Socket is not open', retryable: true }));
        }
      } catch (error) {
        // The transport contract lets `send` throw as well as return false; both mean the frame
        // never left, and both must settle this request instead of leaving it pending.
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(
          new CoreError({
            code: 'client/disconnected',
            message: 'Socket is not open',
            retryable: true,
            details: { op },
            cause: error,
          }),
        );
      }
    });
  }

  /**
   * Close the socket (idempotent; terminal for this connection).
   *
   * A local close is authoritative: in-flight requests fail with `client/disconnected`, the
   * state becomes `closed` (a terminal protocol state such as `revoked` or `update-required` is
   * kept) and exactly one `disconnected` is reported before the transport is closed. The client
   * therefore does not depend on the transport reporting its own close — `PinnedTransport` does,
   * but a native socket can be unsubscribed silently, and a retry loop that waits for that event
   * would stall forever.
   *
   * `retry` is false for the contract codes that forbid reconnection (4004/4401) and for a
   * connection that already ended in a terminal protocol state; deliberate teardown (lock /
   * stop / forget) detaches the client before closing (the controller's generation guards), so
   * this retryable report cannot reconnect a locked app.
   */
  close(code = 1000, reason = 'client-close'): void {
    if (this.closeReported) {
      // Already finished (transport close, handshake deadline or an earlier close): make sure
      // the socket is shut, but never report a second terminal event.
      this.transport.close(code, reason);
      return;
    }
    this.finishConnection(code, reason, code !== CLOSE_CODES.gatewayDisabled && code !== CLOSE_CODES.revoked);
  }

  /**
   * Report the end of the current connection exactly once: fail everything pending, move to the
   * terminal local state, emit `disconnected`, and close the transport last. `closeReported` is
   * set before the transport call, so the transport's own close event is ignored and listeners
   * see one report no matter which side finished the connection.
   */
  private finishConnection(code: number, reason: string, retry: boolean): void {
    if (this.closeReported) return;
    this.closeReported = true;
    this.clearHandshakeTimer();
    this.stopPing();
    this.transportReady = false;
    // The one-time token is dead with the socket: never keep it in memory after a drop.
    this._pairedToken = null;
    const state = this._state;
    const terminal = state === 'revoked' || state === 'gateway-disabled'
      || state === 'update-required' || state === 'reauth-required';
    const active = state !== 'idle' && state !== 'closed';
    this.failAllPending(
      new CoreError({
        code: 'client/disconnected',
        message: 'Socket closed',
        retryable: true,
        details: { closeCode: code },
      }),
    );
    if (!terminal) this._state = 'closed';
    if (!terminal && active) this.emit('state', this._state);
    if (active || terminal) {
      this.emit('disconnected', { code, reason, retry: terminal ? false : retry });
    }
    this.transport.close(code, reason);
  }

  // -------------------------------------------------------------------------

  private onTransportEvent(event: TransportEvent): void {
    switch (event.type) {
      case 'open':
        // Idempotent: a frame that arrived first already performed this transition (see
        // `message` below), so a late `open` must not emit a second state event or reset it.
        if (this._state !== 'connecting') return;
        this.transportReady = true;
        this._state = 'waiting-hello';
        this.emit('state', this._state);
        return;
      case 'message':
        // A transport must not deliver frames after a reported close (contract §3.1); drop
        // stragglers so a finished connection cannot resurface pushes. The same holds while the
        // attempt already ended in a terminal protocol state, even if the transport stayed
        // silent about its close.
        if (this.closeReported) return;
        if (this._state === 'revoked' || this._state === 'gateway-disabled'
          || this._state === 'update-required' || this._state === 'reauth-required') return;
        if (!this.transportReady) {
          // An inbound frame is proof the socket is open, and a native `onMessage` can reach JS
          // before its `onOpen`. Dropping the server `hello` for that reason stalled the
          // handshake until the deadline (the device sent `hello` on a socket the client still
          // thought was `connecting`), so the first frame performs the `open` transition.
          // Only a live attempt may do so: `idle` / terminal states keep dropping frames.
          if (this._state !== 'connecting') return;
          this.transportReady = true;
          this._state = 'waiting-hello';
          this.emit('state', this._state);
        }
        this.handleFrameText(event.data);
        return;
      case 'close': {
        // Close is authoritative for the connection state; a transport `error` about the
        // same socket (ECONNRESET) may arrive before it, but must not change the state.
        if (this.closeReported) return; // a local close / deadline already reported the end
        this.closeReported = true;
        this.clearHandshakeTimer();
        const closeCode = event.code;
        this.stopPing();
        // The one-time token is dead with the socket: never keep it in memory after a drop.
        this._pairedToken = null;
        this.failAllPending(
          new CoreError({ code: 'client/disconnected', message: 'Socket closed', retryable: true, details: { closeCode } }),
        );
        this.transportReady = false;
        if (closeCode === CLOSE_CODES.gatewayDisabled) {
          this._state = 'gateway-disabled';
          this.emit('state', this._state);
          this.emit('gatewayDisabled', { code: 4004 });
          this.emit('disconnected', { code: closeCode, reason: event.reason, retry: false });
          return;
        }
        if (closeCode === CLOSE_CODES.revoked) {
          this.fireRevoked();
          this.emit('disconnected', { code: closeCode, reason: event.reason, retry: false });
          return;
        }
        if (closeCode === CLOSE_CODES.reauth) {
          this._state = 'reauth-required';
          this.emit('state', this._state);
          this.emit('reauthRequired', { code: 4003 });
          this.emit('disconnected', { code: closeCode, reason: event.reason, retry: true });
          return;
        }
        if (this._state !== 'update-required' && this._state !== 'revoked'
          && this._state !== 'gateway-disabled' && this._state !== 'reauth-required') {
          this._state = 'closed';
        }
        this.emit('state', this._state);
        this.emit('disconnected', { code: closeCode, reason: event.reason, retry: true });
        return;
      }
      case 'error': {
        const code = event.code;
        // The handshake deadline is deliberately *not* cleared here (M6 follow-up). The transport
        // is not required to follow an error with a close: the production `PinnedTransport`
        // synthesizes one only while it is still *connecting*, so an error that arrives after
        // `open` (a native read/protocol failure) can be the last event it ever reports.
        // Cancelling the deadline then left the attempt stuck in `waiting-hello` /
        // `waiting-client-hello` forever, with no retryable drop for the reconnect loop. The
        // deadline covers the whole handshake and is cleared by the real end of the attempt — a
        // `ready`, a transport `close`, or `finishConnection` — so a finished handshake and an
        // established connection are unaffected (their deadline is already cleared).
        if (code === TRANSPORT_ERROR.pinMismatch) {
          // Nothing was sent. Surface as an error and let the pending close finish the job.
          this.emit(
            'error',
            new CoreError({ code: 'client/pin-mismatch', message: event.message, details: { transport: 'pin' } }),
          );
          return;
        }
        if (code === TRANSPORT_ERROR.pinnedTransportUnavailable) {
          // No native module in this build (Expo Go): there is no unpinned fallback.
          this.emit(
            'error',
            new CoreError({ code: 'client/pinned-transport-unavailable', message: event.message, retryable: false }),
          );
          return;
        }
        // Socket-level errors (ECONNRESET, connect failures) only surface as events: when the
        // transport does report a `close` it owns the state transition, and while the handshake
        // is still unfinished the deadline above is the backstop for a close that never comes.
        const mapped: CoreErrorCode = TRANSPORT_RETRYABLE.has(code)
          ? 'client/disconnected'
          : normaliseErrorCode(code);
        this.emit(
          'error',
          new CoreError({
            code: mapped,
            message: event.message,
            retryable: TRANSPORT_RETRYABLE.has(code),
            ...(event.details === undefined ? {} : { details: event.details }),
          }),
        );
        return;
      }
    }
  }

  private handleFrameText(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.emit('error', new CoreError({ code: 'client/bad-message', message: 'Frame is not JSON' }));
      return;
    }
    if (typeof frame !== 'object' || frame === null) {
      this.emit('error', new CoreError({ code: 'client/bad-message', message: 'Frame is not an object' }));
      return;
    }
    const f = frame as Record<string, unknown>;
    switch (f.kind) {
      case 'paired':
        this.handlePaired(f);
        return;
      case 'hello':
        this.handleHello(f);
        return;
      case 'error':
        this.handleErrorFrame(f);
        return;
      case 'client-hello':
        this.handleClientHelloAnswer(f);
        return;
      case 'pong':
        this.handleAnswer(f);
        return;
      case 'approval-requested': {
        const push = parseApprovalRequested(f);
        if (push !== null) this.emit('approvalRequested', push);
        return;
      }
      case 'approval-resolved': {
        const push = parseApprovalResolved(f);
        if (push !== null) this.emit('approvalResolved', push);
        return;
      }
      case 'event':
        this.emit('event', f);
        return;
      default:
        // Responses to requests (`sessions`, `sent`, `approval-response`, ...) are matched by
        // `requestId`; unknown kinds are ignored on purpose (additive fields stay compatible).
        if (typeof f.kind === 'string') this.handleAnswer(f);
        return;
    }
  }

  /**
   * Contract §5a: `paired` is sent **once**, **only on a pairing connection**, before `hello`.
   * Anything else (a replay, a bearer connection, a second frame) is refused and never stored:
   * accepting it would let a stale frame replace the credential the app already trusts.
   */
  private handlePaired(f: Record<string, unknown>): void {
    if (!this.pairing) {
      this.emit('error', new CoreError({ code: 'client/bad-message', message: 'paired frame on an authenticated connection' }));
      return;
    }
    if (this._state !== 'waiting-hello' || this.pairedReceived) {
      this.emit(
        'error',
        new CoreError({ code: 'client/bad-message', message: `paired frame is not expected in state ${this._state}` }),
      );
      return;
    }
    const token = typeof f.token === 'string' ? f.token : null;
    const device = parseDevice(f.device);
    if (token === null || device === null) {
      this.emit('error', new CoreError({ code: 'client/bad-message', message: 'paired frame is malformed' }));
      return;
    }
    this.pairedReceived = true;
    this._pairedToken = token;
    this._device = device;
    this.emit('paired', { token, device });
  }

  private handleHello(f: Record<string, unknown>): void {
    if (this._state !== 'waiting-hello') return;
    if (this.pairing && !this.pairedReceived) {
      // Contract §3.3/§5a: a pairing connection must deliver `paired` first. Proceeding would
      // burn the one-time code without storing a token, so fail loudly instead.
      this.emit(
        'error',
        new CoreError({ code: 'client/bad-message', message: 'hello arrived before paired on a pairing connection' }),
      );
      // Terminal for this attempt: one state report and one `disconnected` (M6), then close.
      this.finishConnection(1002, 'hello-before-paired', true);
      return;
    }
    const hello: HelloFrame = {
      kind: 'hello',
      protocol: typeof f.protocol === 'number' ? f.protocol : -1,
      companionProtocol: typeof f.companionProtocol === 'number' ? f.companionProtocol : -1,
      minClientVersion: typeof f.minClientVersion === 'number' ? f.minClientVersion : -1,
      capabilities: Array.isArray(f.capabilities) ? f.capabilities.filter((c): c is string => typeof c === 'string') : [],
      authenticated: f.authenticated === true,
      device: parseDevice(f.device) ?? { id: '', name: '' },
      gatewayId: typeof f.gatewayId === 'string' ? f.gatewayId : '',
      ...(typeof f.dshVersion === 'string' ? { dshVersion: f.dshVersion } : {}),
      ...(typeof f.certSha256 === 'string' ? { certSha256: f.certSha256 } : {}),
    };
    this._hello = hello;
    this._device = parseDevice(f.device) ?? this._device;
    const incompatible =
      hello.companionProtocol !== COMPANION_PROTOCOL_VERSION ||
      hello.minClientVersion > COMPANION_PROTOCOL_VERSION;
    if (incompatible) {
      this.requireUpdate(classifyProtocolUnsupported(hello, null));
      return;
    }
    // Answer with `client-hello`; `ready` fires on the host's acknowledgement (§3.6).
    this._state = 'waiting-client-hello';
    this.emit('state', this._state);
    this.sendClientHello();
  }

  /**
   * Answer the host `hello` with `client-hello` (contract §3.6).
   *
   * Building the frame and handing it to the transport are both wrapped: a throwing id source or
   * a throwing transport used to escape into the transport's listener, where the native
   * `addPinnedWsListener` swallows it by design. The client then sat in `waiting-client-hello`
   * until the 10 s deadline with no frame written and no error reported (device regression:
   * `crypto.randomUUID` is absent in React Native 0.88). A failure here is a build/config fault
   * that repeats on every attempt, so it is reported once and ends the attempt (`retry: false`,
   * so a reconnect loop cannot spin on it) instead of pretending to be mid-handshake.
   */
  private sendClientHello(): void {
    try {
      const id = this.newRequestId();
      if (!REQUEST_ID_RE.test(id)) {
        throw new CoreError({ code: 'client/bad-state', message: 'requestId must be ≤ 64 chars of [A-Za-z0-9._-]' });
      }
      const text = JSON.stringify({
        type: 'client-hello',
        requestId: id,
        companionProtocol: COMPANION_PROTOCOL_VERSION,
        appVersion: this.appVersion,
        platform: this.platform,
      });
      if (this.transport.send(text)) {
        this.lastClientHelloId = id;
        return;
      }
      // The transport is not open. Its own `close` (or the handshake deadline) owns the outcome
      // here: finishing locally would hide the contract close code it is about to report
      // (4401 revoked / 4004 gateway disabled, ...).
      this.emit('error', new CoreError({ code: 'client/disconnected', message: 'Socket closed during client-hello' }));
    } catch (error) {
      // An id source or transport that throws must be reported here: the exception used to
      // unwind into the transport listener, which swallows it (native `addPinnedWsListener`).
      this.failClientHello(error);
    }
  }

  /**
   * A `client-hello` that could not be built or handed to the transport: report it and end the
   * attempt, so the state never stays `waiting-client-hello` waiting for an answer nobody asked
   * for. `client/bad-state` is the contract's code for a caller/programming fault, which is what
   * a broken id source is; the message and `details.stage` name the step.
   */
  private failClientHello(cause: unknown): void {
    const message = cause instanceof Error && cause.message !== ''
      ? `Could not send client-hello: ${cause.message}`
      : 'Could not send client-hello';
    this.emit(
      'error',
      new CoreError({ code: 'client/bad-state', message, details: { stage: 'client-hello' }, cause }),
    );
    this.finishConnection(1006, 'client-hello-failed', false);
  }

  private handleClientHelloAnswer(f: Record<string, unknown>): void {
    if (this._state !== 'waiting-client-hello') return;
    if (f.requestId !== this.lastClientHelloId) return;
    if (f.accepted !== true) {
      this.requireUpdate(classifyProtocolUnsupported(this._hello, null));
      return;
    }
    this.clearHandshakeTimer();
    this._state = 'ready';
    this.startPing();
    this.emit('ready', { hello: this._hello as HelloFrame, device: this._device });
    this.emit('state', this._state);
  }

  private handleAnswer(f: Record<string, unknown>): void {
    const requestId = f.requestId;
    if (typeof requestId !== 'string') return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    // A receipt with `accepted: false` is a refusal of the decision, not of the request: it
    // resolves normally so the approval card can map `reason` -> review / already-decided.
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(f);
  }

  private handleErrorFrame(f: Record<string, unknown>): void {
    const code = normaliseErrorCode(f.code);
    const message = typeof f.message === 'string' ? f.message : code;
    const requestId = typeof f.requestId === 'string' ? f.requestId : null;

    if (code === 'protocol/unsupported') {
      const update = classifyProtocolUnsupported(this._hello, {
        minClientVersion: typeof f.minClientVersion === 'number' ? f.minClientVersion : undefined,
      });
      if (requestId !== null) {
        const pending = this.pending.get(requestId);
        if (pending) {
          this.pending.delete(requestId);
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(
            new CoreError({
              code: update.side === 'app' ? 'client/update-app-required' : 'client/update-host-required',
              message: update.message,
              details: { op: pending.op, side: update.side },
            }),
          );
        }
      }
      this.requireUpdate(update);
      return;
    }
    if (code === 'auth/revoked') {
      if (requestId !== null) {
        const pending = this.pending.get(requestId);
        if (pending) {
          this.pending.delete(requestId);
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(new CoreError({ code, message: 'This device was revoked', details: { op: pending.op } }));
        }
      }
      this.fireRevoked();
      return;
    }
    if (code === 'remote/disabled') {
      this.fireGatewayDisabled();
      return;
    }
    const err = new CoreError({ code, message, retryable: code === 'agent-busy' || code === 'internal' });
    if (requestId !== null) {
      const pending = this.pending.get(requestId);
      if (pending) {
        this.pending.delete(requestId);
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new CoreError({ code, message, details: { op: pending.op } }));
        return;
      }
      // Contract §5a: an error frame with a `requestId` fails *that* request only. An id we do
      // not know (already timed out / answered) is an orphan: it must never fail unrelated
      // pending requests, which would corrupt work the host is still answering.
      this.emit(
        'error',
        new CoreError({ code, message, details: { op: null, orphanRequestId: requestId } }),
      );
      return;
    }
    this.failAllPending(err);
    this.emit('error', err);
  }

  private requireUpdate(update: UpdateRequired): void {
    const mapped: CoreErrorCode = update.side === 'app' ? 'client/update-app-required' : 'client/update-host-required';
    const changed = this._state !== 'update-required';
    this._state = 'update-required';
    this.stopPing();
    this.clearHandshakeTimer();
    this.failAllPending(new CoreError({ code: mapped, message: update.message, details: { side: update.side } }));
    if (changed) this.emit('state', this._state);
    this.emit('updateRequired', update);
    // The host may close after protocol/unsupported; closing here is harmless and immediate.
    this.transport.close(1000, 'update-required');
  }

  private fireRevoked(): void {
    if (this.revokedFired) return;
    this.revokedFired = true;
    this._state = 'revoked';
    this.stopPing();
    this.clearHandshakeTimer();
    this.failAllPending(new CoreError({ code: 'auth/revoked', message: 'This device was revoked' }));
    this.emit('state', this._state);
    this.emit('revoked', { code: 'auth/revoked' });
    this.transport.close(CLOSE_CODES.revoked, 'revoked');
  }

  private fireGatewayDisabled(): void {
    this._state = 'gateway-disabled';
    this.stopPing();
    this.clearHandshakeTimer();
    this.failAllPending(new CoreError({ code: 'remote/disabled', message: 'Remote control is off on the host' }));
    this.emit('state', this._state);
    this.emit('gatewayDisabled', { code: 'remote/disabled' });
    this.transport.close(CLOSE_CODES.gatewayDisabled, 'gateway-disabled');
  }

  private startPing(): void {
    this.stopPing();
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (this._state !== 'ready') return;
      let text: string | null = null;
      try {
        text = JSON.stringify({ type: 'ping', requestId: this.newRequestId() });
      } catch (error) {
        // A throw inside a timer callback is an uncaught exception in React Native, so it is
        // reported as an error event instead. A missed ping is not fatal: the next tick retries.
        this.emit(
          'error',
          new CoreError({
            code: 'client/bad-state',
            message: 'Could not create a ping requestId',
            details: { stage: 'ping' },
            cause: error,
          }),
        );
        return;
      }
      if (text === null) return;
      try {
        this.transport.send(text);
      } catch (error) {
        this.emit(
          'error',
          new CoreError({
            code: 'client/disconnected',
            message: 'Socket is not open',
            retryable: true,
            details: { stage: 'ping' },
            cause: error,
          }),
        );
      }
    }, this.pingIntervalMs);
    // Node keeps the process alive for timers by default; tests rely on this not hanging.
    (this.pingTimer as unknown as { unref?: () => void }).unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Arm the bounded handshake deadline for the attempt `connect()` just started. */
  private armHandshakeTimer(): void {
    this.clearHandshakeTimer();
    if (this.handshakeTimeoutMs <= 0) return;
    this.handshakeTimer = setTimeout(() => this.onHandshakeTimeout(), this.handshakeTimeoutMs);
    (this.handshakeTimer as unknown as { unref?: () => void }).unref?.();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  /**
   * The attempt did not finish its handshake in time (no open, no hello, or no accepted
   * client-hello). Report which step stalled, then finish the attempt so a retry loop can
   * start over instead of waiting forever on a silent host.
   */
  private onHandshakeTimeout(): void {
    this.handshakeTimer = null;
    if (this.closeReported) return;
    const stage = this._state;
    if (stage !== 'connecting' && stage !== 'waiting-hello' && stage !== 'waiting-client-hello') return;
    const message =
      stage === 'connecting'
        ? `The socket did not open within ${this.handshakeTimeoutMs} ms`
        : stage === 'waiting-hello'
          ? `The host did not send hello within ${this.handshakeTimeoutMs} ms`
          : `The host did not accept client-hello within ${this.handshakeTimeoutMs} ms`;
    this.emit(
      'error',
      new CoreError({
        code: 'client/timeout',
        message,
        retryable: true,
        details: { stage, timeoutMs: this.handshakeTimeoutMs },
      }),
    );
    this.finishConnection(1006, 'handshake-timeout', true);
  }

  private failAllPending(err: CoreError): void {
    for (const [id, pending] of [...this.pending.entries()]) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  private emit<K extends keyof ClientEventMap>(event: K, payload: ClientEventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch {
        // handler failures must not break the socket loop
      }
    }
  }
}

function parseDevice(value: unknown): DeviceInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const device = value as Record<string, unknown>;
  if (typeof device.id !== 'string' || device.id.length === 0) return null;
  return {
    id: device.id,
    name: typeof device.name === 'string' ? device.name : device.id,
    ...(typeof device.createdAt === 'number' || typeof device.createdAt === 'string'
      ? { createdAt: device.createdAt }
      : {}),
  };
}

function parseApprovalRequested(f: Record<string, unknown>): ApprovalRequestedFrame | null {
  for (const key of ['approvalId', 'rpcId', 'sessionId', 'toolName'] as const) {
    const value = f[key];
    if (typeof value !== 'string' || value.length === 0) return null;
  }
  let argsHash: string | null;
  if (f.argsHash === null) argsHash = null;
  else if (typeof f.argsHash === 'string' && f.argsHash.length > 0) argsHash = f.argsHash;
  else return null;
  const frame: ApprovalRequestedFrame = {
    kind: 'approval-requested',
    approvalId: f.approvalId as string,
    rpcId: f.rpcId as string,
    sessionId: f.sessionId as string,
    toolName: f.toolName as string,
    argsHash,
    ...(typeof f.callId === 'string' ? { callId: f.callId } : {}),
    ...(typeof f.reason === 'string' ? { reason: f.reason } : {}),
    ...(isStringRecord(f.displayReason) ? { displayReason: f.displayReason } : {}),
    ...(typeof f.argsPreview === 'string' ? { argsPreview: f.argsPreview } : {}),
    ...(typeof f.replay === 'boolean' ? { replay: f.replay } : {}),
  };
  return frame;
}

function parseApprovalResolved(f: Record<string, unknown>): ApprovalResolvedFrame | null {
  for (const key of ['approvalId', 'rpcId', 'sessionId', 'outcome'] as const) {
    if (typeof f[key] !== 'string' || (f[key] as string).length === 0) return null;
  }
  const outcome = f.outcome as string;
  if (!['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(outcome)) return null;
  return {
    kind: 'approval-resolved',
    approvalId: f.approvalId as string,
    rpcId: f.rpcId as string,
    sessionId: f.sessionId as string,
    outcome: outcome as ApprovalResolvedFrame['outcome'],
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

export type { PairedFrame, ApprovalRequestedFrame, ApprovalResolvedFrame };
