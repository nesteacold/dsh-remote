// Test-only Node implementation of the app Transport.
//
// Mirrors what modules/pinned-ws must do on device (plan.md D1):
//   * TLS is accepted for ANY certificate at the TLS layer (`rejectUnauthorized: false`) so
//     that the check below can compare the exact leaf fingerprint instead of a CA chain;
//   * the leaf certificate's SHA-256 is compared with the QR/stored `certSha256` BEFORE the
//     core ever sees `open`; on mismatch the socket is destroyed and `client/pin-mismatch`
//     is emitted (via `error` + `close`), and nothing is ever sent;
//   * the leaf's validity window is checked next (native `PinnedTrustManager` calls
//     `leaf.checkValidity()`, the gateway refuses to serve an expired leaf): an expired or
//     not-yet-valid leaf takes the same abort path, so a rotated identity can never be used
//     to send a pairing code or bearer token;
//   * `open` is emitted only after the pin and validity checks succeeded.
//
// This file must only be imported by tests.

import { createHash, X509Certificate } from 'node:crypto';
import { connect as createTlsConnection, type TLSSocket } from 'node:tls';
import WebSocket from 'ws';

import {
  TransportEmitter,
  TRANSPORT_ERROR,
  type Transport,
  type TransportConnectOptions,
  type TransportListener,
} from '../../src/core/transport';

interface ParsedUrl {
  href: string;
  hostname: string;
  port: number;
  path: string;
  origin: string;
}

function parseWssUrl(url: string): ParsedUrl {
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:') throw new Error('node-pinned-transport only supports wss:// URLs');
  const port = parsed.port === '' ? 443 : Number(parsed.port);
  const path = `${parsed.pathname}${parsed.search}`;
  return {
    href: parsed.toString(),
    hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
    port,
    path,
    origin: `wss://${parsed.host}:${parsed.port}`,
  };
}

function sha256Hex(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex');
}

/**
 * Validity window of a leaf certificate in epoch ms, or `null` when the dates cannot be read
 * (fail closed: an unreadable window is treated like a pin failure).
 */
function certificateValidityOf(der: Buffer): { validFrom: number; validTo: number } | null {
  try {
    const certificate = new X509Certificate(der);
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (Number.isNaN(validFrom) || Number.isNaN(validTo)) return null;
    return { validFrom, validTo };
  } catch {
    return null;
  }
}

export interface NodePinnedTransportOptions {
  /** ms before a handshake is abandoned (default 5 s). */
  handshakeTimeoutMs?: number;
  /**
   * Clock used for the leaf validity-window check, epoch ms or a function returning it
   * (default `Date.now`). Tests pin this to exercise expiry deterministically.
   */
  now?: number | (() => number);
}

/** One leaf validity window observed during a handshake (test diagnostics). */
export interface ObservedValidityWindow {
  /** Leaf `notBefore`, ISO 8601. */
  validFrom: string;
  /** Leaf `notAfter`, ISO 8601. */
  validTo: string;
  /** Clock value the window was compared against, epoch ms. */
  checkedAt: number;
}

export class NodePinnedTransport implements Transport {
  private readonly emitter = new TransportEmitter();
  private readonly options: NodePinnedTransportOptions;
  private socket: WebSocket | null = null;
  private tlsSocket: TLSSocket | null = null;
  private closed = false;
  private isOpen = false;
  /** Frames the core tried to send before open — a bug in the caller; must always be empty. */
  readonly framesSentBeforeOpen: string[] = [];
  /** Total frames actually written to the wire (diagnostics for tests). */
  readonly framesSent: string[] = [];
  /** Leaf fingerprints observed during handshakes (test diagnostics). */
  readonly observedFingerprints: string[] = [];
  /** Leaf validity windows observed during handshakes (test diagnostics). */
  readonly observedValidityWindows: ObservedValidityWindow[] = [];
  /** Subprotocols offered on the last connect (contract §3 assertions). */
  offeredProtocols: string[] = [];
  /** Headers offered on the last connect (contract §3 assertions). */
  offeredHeaders: Record<string, string> = {};

  constructor(options: NodePinnedTransportOptions = {}) {
    this.options = options;
  }

  on(listener: TransportListener): () => void {
    return this.emitter.on(listener);
  }

  /** Test diagnostics. */
  get isOpenPublic(): boolean {
    return this.isOpen;
  }

  get readyState(): number {
    return this.socket?.readyState ?? -1;
  }

  connect(url: string, options: TransportConnectOptions): void {
    let target: ParsedUrl;
    try {
      target = parseWssUrl(url);
    } catch (error) {
      this.emitter.emit({
        type: 'error',
        code: TRANSPORT_ERROR.badUrl,
        message: error instanceof Error ? error.message : 'bad url',
      });
      this.emitter.emit({ type: 'close', code: 1008, reason: 'bad-url', wasClean: false });
      return;
    }

    const expected = String(options.certSha256 ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      this.emitter.emit({ type: 'error', code: TRANSPORT_ERROR.pinMismatch, message: 'certSha256 is not a SHA-256 hex digest' });
      this.emitter.emit({ type: 'close', code: 1008, reason: 'bad-pin', wasClean: false });
      return;
    }

    const protocols = options.protocols ?? [];
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    this.offeredProtocols = [...protocols];
    this.offeredHeaders = { ...headers };

    // 1) TLS with chain validation disabled; the pin check replaces it.
    const tls = createTlsConnection({
      host: target.hostname,
      port: target.port,
      servername: /^\d+\.\d+\.\d+\.\d+$/.test(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    // `createConnection` options keep the socket referenced, which would stop `ws.close()`
    // from delivering its close frame; explicitly unref until `ws` owns the socket.
    tls.unref();
    this.tlsSocket = tls;
    const timeout = setTimeout(() => {
      tls.destroy(new Error('TLS handshake timeout'));
    }, this.options.handshakeTimeoutMs ?? 5_000);
    timeout.unref?.();

    let pinned = false;
    /** The WebSocket already reported its close; its code is authoritative. */
    let peerClosed = false;
    /** The WebSocket reached OPEN at least once: it owns its own close from then on. */
    let everOpened = false;

    tls.once('error', (error: Error) => {
      clearTimeout(timeout);
      this.failBeforeOpen(TRANSPORT_ERROR.connectFailed, error.message);
    });

    tls.once('secureConnect', () => {
      clearTimeout(timeout);
      const peer = tls.getPeerCertificate();
      if (!peer || !peer.raw) {
        tls.destroy();
        this.failBeforeOpen(TRANSPORT_ERROR.pinMismatch, 'server presented no certificate');
        return;
      }
      const observed = sha256Hex(peer.raw as Buffer);
      this.observedFingerprints.push(observed);
      if (observed !== expected) {
        // Destroy before any HTTP upgrade is attempted: no bytes beyond TLS ever leave.
        tls.destroy();
        this.failBeforeOpen(TRANSPORT_ERROR.pinMismatch, 'Certificate does not match the pinned fingerprint');
        return;
      }

      // 2) Validity window, matching native `PinnedTrustManager.verifyPinned` (`checkValidity()`)
      //    and the gateway's refusal to serve an expired leaf. The pin proves identity, not that
      //    the window still covers "now", so an expired / not-yet-valid pinned leaf is treated as
      //    a rotated identity and aborts on the same path as a pin mismatch — again before any
      //    upgrade byte (subprotocol, Authorization, X-DSH-Device-ID) is written.
      const window = certificateValidityOf(peer.raw as Buffer);
      if (window === null) {
        tls.destroy();
        this.failBeforeOpen(TRANSPORT_ERROR.pinMismatch, 'server certificate has unreadable validity dates');
        return;
      }
      const checkedAt = this.currentTimeMs();
      this.observedValidityWindows.push({
        validFrom: new Date(window.validFrom).toISOString(),
        validTo: new Date(window.validTo).toISOString(),
        checkedAt,
      });
      if (checkedAt < window.validFrom) {
        tls.destroy();
        this.failBeforeOpen(
          TRANSPORT_ERROR.pinMismatch,
          `The pinned certificate is not valid yet (valid from ${new Date(window.validFrom).toISOString()})`,
        );
        return;
      }
      if (checkedAt > window.validTo) {
        tls.destroy();
        this.failBeforeOpen(
          TRANSPORT_ERROR.pinMismatch,
          `The pinned certificate has expired (valid until ${new Date(window.validTo).toISOString()})`,
        );
        return;
      }
      pinned = true;

      const ws = new WebSocket(target.href, protocols, {
        headers,
        // Reuse the already-verified TLS socket; `ws` must not open its own.
        createConnection: () => {
          tls.ref();
          return tls;
        },
        rejectUnauthorized: false,
      });
      this.socket = ws;

      ws.on('open', () => {
        if (!pinned || this.closed) {
          ws.terminate();
          return;
        }
        everOpened = true;
        this.isOpen = true;
        this.emitter.emit({ type: 'open' });
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return; // contract is JSON text frames only
        this.emitter.emit({ type: 'message', data: data.toString('utf8') });
      });
      ws.on('error', (error: Error) => {
        if (!pinned) this.failBeforeOpen(TRANSPORT_ERROR.pinMismatch, error.message);
        else this.emitter.emit({ type: 'error', code: TRANSPORT_ERROR.connectFailed, message: error.message });
      });
      ws.on('close', (code: number, reason: Buffer) => {
        peerClosed = true;
        this.isOpen = false;
        this.closed = true;
        // A socket that never opened terminated by the peer/user (drop, revoke) reports 1006.
        // Contract close codes (4003/4004/4401) arrive as received.
        const clean = code === 1000 || code === 4001;
        this.emitter.emit({
          type: 'close',
          code,
          reason: reason?.toString('utf8') ?? '',
          wasClean: clean,
        });
      });
    });

    // 3) Last-resort guard: if the socket never opened (handshake/timeout) or the TLS side died
    //    without the WebSocket reporting it, report a close so the caller can retry. Once the
    //    WebSocket reported its own close (`peerClosed`), that code is authoritative — a
    //    contract close code (4003/4004/4401) must not be replaced by a synthetic 1006.
    tls.once('close', () => {
      if (peerClosed) return;
      // A socket that reached OPEN owns its close: `ws` reports the real code (1000/1006/4004…)
      // right after the TLS layer goes away. Only an attempt that never opened is synthetic.
      if (this.closed || everOpened) return;
      this.socket?.terminate();
      this.failBeforeOpen(TRANSPORT_ERROR.connectFailed, 'TLS connection closed');
    });
  }

  send(data: string): boolean {
    if (this.closed) return false;
    if (!this.isOpen || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.framesSentBeforeOpen.push(data);
      return false;
    }
    this.socket.send(data);
    this.framesSent.push(data);
    return true;
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.isOpen = false;
    try {
      if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
        // CONNECTING sockets are aborted by `close()` too; OPEN ones get a close handshake.
        this.socket.close(code, reason);
      } else {
        this.socket?.terminate();
      }
    } catch {
      this.socket?.terminate();
    }
    try {
      this.tlsSocket?.destroy();
    } catch {
      // already gone
    }
  }

  /** Test-only: simulate a network drop without a clean close handshake. */
  dropConnection(): void {
    this.isOpen = false;
    this.socket?.terminate();
    this.tlsSocket?.destroy();
  }

  /** Clock for the validity-window check: the `now` option, else the wall clock. */
  private currentTimeMs(): number {
    const { now } = this.options;
    if (now === undefined) return Date.now();
    return typeof now === 'function' ? now() : now;
  }

  private failBeforeOpen(code: string, message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.isOpen = false;
    this.emitter.emit({ type: 'error', code, message });
    this.emitter.emit({ type: 'close', code: 1006, reason: code === TRANSPORT_ERROR.pinMismatch ? 'pin-mismatch' : 'connect-failed', wasClean: false });
  }
}

/** Convenience factory for `ClientOptions.transport`. */
export function createNodePinnedTransportFactory(options: NodePinnedTransportOptions = {}) {
  const created: NodePinnedTransport[] = [];
  return {
    created,
    create(): Transport {
      const transport = new NodePinnedTransport(options);
      created.push(transport);
      return transport;
    },
  };
}

/** Re-export so tests can compute the same digest without importing node:crypto themselves. */
export function fingerprintOf(certPem: string): string {
  return sha256Hex(Buffer.from(new X509Certificate(certPem).raw));
}
