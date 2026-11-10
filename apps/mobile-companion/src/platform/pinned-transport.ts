// Pinned WSS transport (A030) — the production `Transport` of the core client.
//
// Why it exists: React Native's built-in `WebSocket` uses the platform TLS stack, which rejects
// the gateway's self-signed certificate and cannot compare a leaf fingerprint before the
// upgrade. This class routes the core's `Transport` interface onto the local Expo module
// `modules/pinned-ws` (Android OkHttp `WebSocket` with an `X509ExtendedTrustManager` pinned to
// `certSha256`; iOS `URLSessionWebSocketTask` with a `didReceive challenge` handler doing the
// same SHA-256 check). See that module's sources and its README for the pinning rules:
//   * only `wss://`, checked before any I/O (`client/insecure-url`);
//   * `open` is emitted ONLY after the leaf certificate matched (contract §3.1); a mismatch
//     aborts the TLS handshake before the upgrade request leaves the device
//     (`client/pin-mismatch`) and nothing is ever sent;
//   * a refused upgrade reports its HTTP status (`client/upgrade-failed`, `details.status`) so
//     the client can map 401/403 (contract §3, §6).
//
// NEVER replace this with a plain `WebSocket` connection: that would send the pairing code and
// bearer token to whatever holds the address (constitution B2, contract §3.1).
//
// This file may import react-native (`npm run check:core` only guards `src/core`): it decides
// whether the native module exists in this build and how to reach it.

import {
  CoreError,
  TRANSPORT_ERROR,
  TransportEmitter,
  redactString,
  type Transport,
  type TransportConnectOptions,
  type TransportEvent,
  type TransportListener,
} from '../core';
import {
  addPinnedWsListener,
  getPinnedWsModule,
  isPinnedWsAvailable,
  type PinnedWsAdapter,
  type PinnedWsCloseEvent,
  type PinnedWsErrorEvent,
  type PinnedWsMessageEvent,
  type PinnedWsOpenEvent,
} from '../../modules/pinned-ws';

/** Shown when the build has no native module (Expo Go, web): there is no safe fallback. */
export const PINNED_TRANSPORT_MESSAGE =
  'The pinned TLS transport is not in this build (Expo Go or web). Use a dev build to connect — DSH Companion will not fall back to an unpinned socket.';

/** Error codes the native module may report; anything else is treated as a generic failure. */
const NATIVE_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  TRANSPORT_ERROR.pinMismatch,
  TRANSPORT_ERROR.insecureUrl,
  'client/insecure-headers',
  TRANSPORT_ERROR.upgradeFailed,
  TRANSPORT_ERROR.connectFailed,
]);

let idCounter = 0;

/** Unique socket id per transport instance (`crypto.randomUUID` is not available everywhere). */
function nextSocketId(): string {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `pw-${Date.now().toString(36)}-${random}-${idCounter}`;
}

/**
 * Longest raw-id prefix a diagnostic line may carry. Same bound as the native module's
 * `PinnedWsLog.ref`, so a JS trace and a logcat line name a socket the same way.
 */
const REF_PREFIX_LIMIT = 12;

/** `[A-Za-z0-9._-]`, exactly what the native sanitiser keeps. */
function isRefChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) // a-z
    || (code >= 0x41 && code <= 0x5a) // A-Z
    || (code >= 0x30 && code <= 0x39) // 0-9
    || code === 0x2e // .
    || code === 0x5f // _
    || code === 0x2d; // -
}

/** 32-bit FNV-1a over the id's UTF-16 units, as exactly 8 lowercase hex digits. */
function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Log-safe stand-in for a caller-supplied socket id: the first `REF_PREFIX_LIMIT` characters
 * that are `[A-Za-z0-9._-]` (every other character dropped), then `#` and 8 hex digits of a
 * 32-bit FNV-1a hash of the WHOLE id, e.g. `pw-17a2#3f9c1d04` for `pw-17a2`.
 *
 * Mirrors `modules/pinned-ws/.../PinnedWsLog.ref` so a JS trace and a logcat line can be matched
 * by eye. Bounded (at most 21 chars) and free of newlines / control / bidi characters, so a
 * crafted id cannot forge a log line and an id that is really a credential is never reproduced
 * verbatim. Routing always uses the real id; this is diagnostics only.
 */
export function socketRef(id: string): string {
  const source = typeof id === 'string' ? id : '';
  let prefix = '';
  for (let index = 0; index < source.length && prefix.length < REF_PREFIX_LIMIT; index += 1) {
    if (isRefChar(source.charCodeAt(index))) prefix += source.charAt(index);
  }
  return `${prefix}#${fnv1aHex(source)}`;
}

/** Bounded, newline-free form of a native error code (never a message, header or payload). */
function traceCode(value: unknown): string {
  if (typeof value !== 'string') return 'none';
  const bounded = value.slice(0, 40).replace(/[^A-Za-z0-9/._-]/g, '');
  return bounded.length === 0 ? 'none' : bounded;
}

export interface PinnedTransportOptions {
  /**
   * Native module override (tests). When omitted the real Expo module is looked up once; a
   * `null` result (Expo Go / web) makes every connect fail with
   * `client/pinned-transport-unavailable`.
   */
  module?: PinnedWsAdapter | null;
  /** Turn an HTTP upgrade status into an emitted error code (defaults to `upgrade-failed`). */
  mapUpgradeStatus?: (status: number) => { code: string; message?: string };
  /** Socket id factory (tests make ids deterministic). */
  newSocketId?: () => string;
  /**
   * Optional diagnostic hook: one bounded, secret-free line per transport decision, with the
   * sanitised socket reference only (`socketRef`), never the id, a header value, a token or any
   * frame text. Absent by default — a normal build then builds no trace line at all, and a
   * throwing hook is swallowed so it can never change what the transport does.
   */
  trace?: (line: string) => void;
}

/** Default mapping of an HTTP upgrade refusal to the contract vocabulary (contract §3, §6). */
export function defaultUpgradeMapping(status: number): { code: string; message: string } {
  switch (status) {
    case 401:
      // Missing / invalid / revoked credential or expired pairing code (contract §6).
      return { code: 'auth/required', message: 'The host rejected the credential (HTTP 401)' };
    case 403:
      // Owner switch off (`remote/disabled`) or a listener that only accepts private networks.
      return { code: 'remote/disabled', message: 'The host refused this connection (HTTP 403)' };
    default:
      return { code: TRANSPORT_ERROR.upgradeFailed, message: `The WebSocket upgrade was refused (HTTP ${status})` };
  }
}

/**
 * The device `Transport`: one native socket at a time (the core allocates a fresh transport per
 * connection through its factory), routing every event by the native socket id.
 */
export class PinnedTransport implements Transport {
  private readonly emitter = new TransportEmitter();
  private readonly options: PinnedTransportOptions;
  private module: PinnedWsAdapter | null | undefined;
  private id: string | null = null;
  private state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';
  private unsubscribe: (() => void) | null = null;
  /**
   * True once the single terminal `close` of this transport was reported. Set *before* the
   * native listener is removed, so a native `onClose` that races a local close / failed
   * `connect()` can never produce a second close (consumers count one end per socket).
   */
  private closeEmitted = false;
  /**
   * Bounded, secret-free diagnostics (N6): counters and header *names* only. Full frames and the
   * offered subprotocol list would keep `dsh-pair.<code>` / `dsh-auth.<token>` (contract §3) and
   * every payload in memory for the lifetime of the process, so they are never retained here.
   */
  private framesSentBeforeOpenCount = 0;
  private framesSentCount = 0;
  private offeredProtocolCount = 0;
  /** Header names offered on the last connect — names only, never values (no secrets in logs). */
  offeredHeaderNames: string[] = [];

  /** Frames `send` refused because the socket was not open (a caller bug; must stay 0). */
  get framesSentBeforeOpen(): number {
    return this.framesSentBeforeOpenCount;
  }

  /** Frames actually handed to the native socket (diagnostics/tests). */
  get framesSent(): number {
    return this.framesSentCount;
  }

  /** Number of subprotocols offered on the last connect (the values are never retained). */
  get offeredProtocols(): number {
    return this.offeredProtocolCount;
  }

  constructor(options: PinnedTransportOptions = {}) {
    this.options = options;
  }

  on(listener: TransportListener): () => void {
    return this.emitter.on(listener);
  }

  /** True while the native socket is open (mirrors the Node test transport's accessor). */
  get isOpenPublic(): boolean {
    return this.state === 'open';
  }

  connect(url: string, options: TransportConnectOptions): void {
    if (this.state !== 'idle') {
      // One connection per transport (the core creates a fresh one per connection).
      if (this.closeEmitted) {
        // The terminal close was already reported: explain the misuse without inventing a
        // second close event.
        this.emitter.emit({
          type: 'error',
          code: TRANSPORT_ERROR.connectFailed,
          message: 'This transport already finished; create a new one per connection',
        });
        return;
      }
      this.fail(TRANSPORT_ERROR.connectFailed, 'This transport already started; create a new one');
      return;
    }
    const module = this.resolveModule();
    if (module === null) {
      this.fail(TRANSPORT_ERROR.pinnedTransportUnavailable, PINNED_TRANSPORT_MESSAGE);
      return;
    }

    const id = this.options.newSocketId?.() ?? nextSocketId();
    this.id = id;
    this.state = 'connecting';
    this.offeredProtocolCount = (options.protocols ?? []).length;
    this.offeredHeaderNames = Object.keys(options.headers ?? {});

    this.unsubscribe = addPinnedWsListener(module, {
      onOpen: (event: PinnedWsOpenEvent) => this.onNativeOpen(id, event),
      onMessage: (event: PinnedWsMessageEvent) => this.onNativeMessage(id, event),
      onClose: (event: PinnedWsCloseEvent) => this.onNativeClose(id, event),
      onError: (event: PinnedWsErrorEvent) => this.onNativeError(id, event),
    });

    try {
      const result = module.connect(id, url, {
        certSha256: String(options.certSha256 ?? '').toLowerCase(),
        protocols: options.protocols ?? [],
        headers: options.headers ?? {},
      });
      // The native call is async; a rejection is a programmer error (bad types), reported once.
      if (result !== undefined && result !== null && typeof (result as { then?: unknown }).then === 'function') {
        (result as Promise<void>).catch((error: unknown) => {
          this.onNativeError(id, {
            id,
            code: TRANSPORT_ERROR.connectFailed,
            message: error instanceof Error ? error.message : 'connect() failed',
          });
        });
      }
    } catch (error) {
      this.onNativeError(id, {
        id,
        code: TRANSPORT_ERROR.connectFailed,
        message: error instanceof Error ? error.message : 'connect() failed',
      });
    }
  }

  send(data: string): boolean {
    if (this.state !== 'open' || this.id === null) {
      // Nothing may go on the wire without a verified certificate.
      this.framesSentBeforeOpenCount += 1;
      this.traceSend(data, false);
      return false;
    }
    const module = this.module;
    if (!module) {
      this.traceSend(data, false);
      return false;
    }
    let accepted = true;
    try {
      const result = module.send(this.id, data);
      if (result !== undefined && result !== null && typeof (result as { then?: unknown }).then === 'function') {
        (result as Promise<boolean>).then(
          (ok) => {
            if (ok === false) this.framesSentBeforeOpenCount += 1;
          },
          () => {
            this.framesSentBeforeOpenCount += 1;
          },
        );
      }
    } catch {
      accepted = false;
    }
    if (accepted) this.framesSentCount += 1;
    this.traceSend(data, accepted);
    return accepted;
  }

  /**
   * Close the socket locally (idempotent, terminal).
   *
   * The native listener is removed and exactly one `close` event is emitted here. The core
   * client must never depend on a native `onClose` arriving after a local close: the native
   * side can be unsubscribed mid-flight, and a retry loop waiting for that event would stall.
   * A later native event is filtered by `closeEmitted`.
   */
  close(code = 1000, reason = ''): void {
    if (this.closeEmitted) return;
    const started = this.state !== 'idle';
    const wasOpen = this.state === 'open';
    const module = this.module;
    const id = this.id;
    if (!started) {
      // Never connected: there is no socket and no terminal event to report.
      this.state = 'closed';
      this.closeEmitted = true;
      return;
    }
    this.finishWithClose(code, reason, wasOpen && code === 1000);
    if (module && id !== null) {
      try {
        void module.close(id, code, reason);
      } catch {
        // the socket is gone already
      }
    }
  }

  // -------------------------------------------------------------------------

  private resolveModule(): PinnedWsAdapter | null {
    if (this.options.module !== undefined) {
      this.module = this.options.module;
      return this.options.module;
    }
    if (this.module === undefined) this.module = getPinnedWsModule();
    return this.module;
  }

  /**
   * True when a trace hook is installed. Every trace site tests this *before* building its line,
   * so a transport without a hook allocates nothing (a normal build: the field is absent).
   */
  private get tracing(): boolean {
    return this.options.trace !== undefined;
  }

  /** Hand one already-built line to the hook. A throwing hook must never change behaviour. */
  private emitTrace(line: string): void {
    const trace = this.options.trace;
    if (trace === undefined) return;
    try {
      trace(line);
    } catch {
      // Diagnostics are best effort: the transport keeps whatever outcome it already decided.
    }
  }

  /** `send` outcome for the trace: the state it was attempted in and the frame's length only. */
  private traceSend(data: string, ok: boolean): void {
    if (!this.tracing) return;
    const chars = typeof data === 'string' ? data.length : 0;
    this.emitTrace(`send id=${socketRef(this.id ?? '')} state=${this.state} chars=${chars} ok=${ok}`);
  }

  /**
   * Native `open`. Idempotent by the `connecting` guard: `onNativeMessage` below may already have
   * reported `open` for this socket (a frame can be dispatched before `onOpen`), and this then
   * emits nothing, so the core sees exactly one `open` per transport.
   */
  private onNativeOpen(id: string, event: PinnedWsOpenEvent): void {
    if (this.tracing) this.emitTrace(`native-open id=${socketRef(id)} state=${this.state}`);
    const accepted = this.accepts(id, event?.id);
    if (!accepted || this.state !== 'connecting') {
      // The two booleans say why: a foreign socket id, an `open` the message-first path already
      // reported, or one that arrived after the terminal close.
      if (this.tracing) {
        this.emitTrace(`native-open-ignored id=${socketRef(id)} state=${this.state} accepted=${accepted} closeEmitted=${this.closeEmitted}`);
      }
      return;
    }
    this.state = 'open';
    this.emitter.emit({ type: 'open' });
    if (this.tracing) this.emitTrace(`open-emitted id=${socketRef(id)}`);
  }

  /**
   * Native frame. The native side can dispatch it before `onOpen`: on device both `onOpen` and a
   * delivered `onMessage` were logged while this transport was still `connecting`, and dropping
   * the frame here left the handshake with nothing to answer, so the socket died on its deadline.
   * A real frame is proof the socket is open — the native module only reads data after the
   * upgrade, which on this transport happens only after the leaf pin matched (contract §3.1) —
   * hence the message-first path reports `open` and then the frame. Exactly one `open` per
   * transport: the later `onOpen` fails its `connecting` guard. A closed transport (local close,
   * native close, failed connect) still drops the frame, so a straggler cannot resurrect it.
   */
  private onNativeMessage(id: string, event: PinnedWsMessageEvent): void {
    const accepted = this.accepts(id, event?.id);
    if (this.tracing) {
      const chars = typeof event?.data === 'string' ? event.data.length : 0;
      this.emitTrace(
        `native-message id=${socketRef(id)} state=${this.state} accepted=${accepted} closeEmitted=${this.closeEmitted} chars=${chars}`,
      );
    }
    if (!accepted || this.closeEmitted) {
      if (this.tracing) this.emitTrace(`native-message-ignored id=${socketRef(id)} reason=${accepted ? 'close-emitted' : 'accepts'}`);
      return;
    }
    if (this.state !== 'connecting' && this.state !== 'open') {
      if (this.tracing) this.emitTrace(`native-message-ignored id=${socketRef(id)} reason=state`);
      return;
    }
    // Checked before the transition: a malformed event must not manufacture an `open`, which the
    // core treats as proof of the pin match.
    if (typeof event?.data !== 'string') {
      if (this.tracing) this.emitTrace(`native-message-ignored id=${socketRef(id)} reason=not-text`);
      return;
    }
    if (this.state === 'connecting') {
      this.state = 'open';
      this.emitter.emit({ type: 'open' });
      if (this.tracing) this.emitTrace(`open-emitted id=${socketRef(id)}`);
    }
    this.emitter.emit({ type: 'message', data: event.data });
    if (this.tracing) this.emitTrace(`message-emitted id=${socketRef(id)}`);
  }

  private onNativeClose(id: string, event: PinnedWsCloseEvent): void {
    const code = typeof event?.code === 'number' ? event.code : 1006;
    if (this.tracing) this.emitTrace(`native-close id=${socketRef(id)} state=${this.state} code=${code}`);
    if (!this.accepts(id, event?.id)) return;
    const wasOpen = this.state === 'open';
    const reason = typeof event?.reason === 'string' ? event.reason : '';
    // A close after the terminal report (local close / failed connect) is filtered: exactly one
    // close per transport, and never a second state transition from a late native event.
    this.finishWithClose(code, reason, wasOpen && code === 1000);
  }

  private onNativeError(id: string, event: PinnedWsErrorEvent): void {
    // The native code as delivered (the client maps it to the contract vocabulary afterwards).
    if (this.tracing) this.emitTrace(`native-error id=${socketRef(id)} state=${this.state} code=${traceCode(event?.code)}`);
    if (!this.accepts(id, event?.id) || this.state === 'closed') return;
    const rawCode = typeof event?.code === 'string' ? event.code : '';
    const status = typeof event?.status === 'number' ? event.status : undefined;

    let code: string;
    let message: string;
    let details: Record<string, unknown> | undefined;
    if (rawCode === TRANSPORT_ERROR.upgradeFailed && status !== undefined) {
      const mapped = (this.options.mapUpgradeStatus ?? defaultUpgradeMapping)(status);
      code = mapped.code;
      message = redactString(mapped.message ?? `The WebSocket upgrade was refused (HTTP ${status})`);
      details = { status };
    } else {
      code = NATIVE_ERROR_CODES.has(rawCode) ? rawCode : TRANSPORT_ERROR.connectFailed;
      // The native message is a fixed, secret-free string; redact anyway as defence in depth.
      message = redactString(
        typeof event?.message === 'string' && event.message.length > 0
          ? event.message
          : 'The pinned transport failed',
      );
      // Nothing was sent: report the error and let the terminal close below finish the socket,
      // exactly like the Node transport. The observed fingerprint is diagnostics only (never a
      // secret: it is the *public* leaf hash the host presented).
      details = code === TRANSPORT_ERROR.pinMismatch && typeof event?.observedSha256 === 'string'
        ? { observedSha256: event.observedSha256 }
        : undefined;
    }
    this.emitter.emit({ type: 'error', code, message, ...(details === undefined ? {} : { details }) });
    // A failure before `open` is terminal: the native side may never send `onClose` (a rejected
    // `connect()` promise definitely does not), so without this the core would stay in
    // `connecting` forever. Emit the one close now; late native events are filtered.
    //
    // After `open` no close is synthesized: an established connection must survive a spurious
    // error and end on its real close, and the core keeps its handshake deadline armed through a
    // non-terminal error, so a handshake that stalls this way is still closed by the client.
    if (this.state === 'connecting') {
      this.finishWithClose(1006, this.closeReasonFor(code), false);
    }
  }

  /**
   * True when an event belongs to this transport's socket. Checked twice on purpose: the
   * listener closure already binds the id we handed to `connect`, and the event carries its own
   * `id` — a mismatch between the two means the native side routed a foreign event to us.
   */
  private accepts(closedOverId: string, eventId: unknown): boolean {
    if (this.id === null || this.id !== closedOverId) return false;
    return eventId === undefined || eventId === null || eventId === this.id;
  }

  /**
   * Report the single terminal `close` for this transport and stop listening. Returns false
   * when the end was already reported, so a native close that races a local close (or a failed
   * `connect()`) can never emit a second one.
   */
  private finishWithClose(code: number, reason: string, wasClean: boolean): boolean {
    if (this.closeEmitted) return false;
    this.closeEmitted = true;
    this.state = 'closed';
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.emitter.emit({ type: 'close', code, reason: redactString(reason), wasClean });
    return true;
  }

  /** Short, secret-free close reason for a transport error code. */
  private closeReasonFor(code: string): string {
    return code === TRANSPORT_ERROR.pinMismatch ? 'pin-mismatch' : 'connect-failed';
  }

  /** Report a failure that happened in JS, in the same order a socket would (error, then close). */
  private fail(code: string, message: string): void {
    if (this.closeEmitted) return;
    // Terminal immediately: nothing may open after a JS-side refusal, and late native events
    // (an in-flight `onOpen`) must be filtered while the error/close are delivered.
    this.state = 'closed';
    this.closeEmitted = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    queueMicrotask(() => {
      this.emitter.emit({ type: 'error', code, message });
      this.emitter.emit({
        type: 'close',
        code: 1006,
        reason: this.closeReasonFor(code),
        wasClean: false,
      });
    });
  }
}

/**
 * The construction options the app's factory may pass. It only ever sets `trace`; every other
 * option stays inside the module so production keeps one behaviour (module lookup, upgrade
 * mapping, socket ids) and only the diagnostics can differ.
 */
export type CreatePinnedTransportOptions = Pick<PinnedTransportOptions, 'trace'>;

/** The factory the app hands to `CompanionClient` (one transport per connection). */
export const createPinnedTransport = (options: CreatePinnedTransportOptions = {}): Transport =>
  new PinnedTransport(options);

/** True when this build has the native module (Expo Go / web: false). */
export const PINNED_TRANSPORT_AVAILABLE = isPinnedWsAvailable();

/**
 * Throw a typed `CoreError` for an upgrade status, for callers that surface pair/connect errors
 * with `CoreError` directly (keeps 401/403 mapping in one place).
 */
export function upgradeStatusError(status: number): CoreError {
  const mapped = defaultUpgradeMapping(status);
  return new CoreError({
    code: mapped.code,
    message: mapped.message,
    details: { status },
  });
}

export type { TransportEvent };
