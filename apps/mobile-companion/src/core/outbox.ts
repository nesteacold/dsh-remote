// Outbox (US4 / FR-007): every prompt gets a portable `clientMsgId` (see `defaultClientMsgId`),
// is delivered at most once semantically because the host dedupes by that id (contract §4
// `message`), and is retried after a reconnect until the `sent` receipt arrives.
//
//   queued --send--> sent --receipt kind:"sent"--> acked
//   sent --disconnect / retryable error--> queued   (same clientMsgId; resent after reconnect)
//   sent --non-retryable contract error--> failed
//
// Cancel op: `session-cancel` carries only `sessionId`, so repeated cancel taps for one session
// collapse into one pending cancel.

import { CoreError, type CoreErrorCode } from './errors';
import { TRANSPORT_ERROR } from './transport';

export type OutboxStatus = 'queued' | 'sent' | 'acked' | 'failed';

export interface OutboxItemBase {
  clientMsgId: string;
  sessionId: string;
  status: OutboxStatus;
  /** How many send attempts were made (diagnostics only; safe to log, no text). */
  attempts: number;
  /** Last error code seen, if any (cleared on ack). */
  lastError?: CoreErrorCode;
}

export interface PromptItem extends OutboxItemBase {
  op: 'prompt';
  text: string;
  mode?: 'queue' | 'steer';
}

export interface CancelItem extends OutboxItemBase {
  op: 'cancel';
}

export type OutboxItem = PromptItem | CancelItem;

/** Params for `client.request(op, params)`; semantically identical on every retry. */
export interface OutboxFrame {
  op: 'message' | 'session-cancel';
  params: Record<string, unknown>;
}

/** Injected collaborators so the outbox stays pure and testable. */
export interface OutboxDeps {
  /** Must resolve once the host answered `sent`/`session-cancelled`; rejects with a CoreError. */
  send: (frame: OutboxFrame) => Promise<unknown>;
  /**
   * Id source; defaults to `defaultClientMsgId()` (portable, never throws). An injected source
   * must produce a gateway-acceptable id (1..128 characters, no edge whitespace); a throw or an
   * unusable value surfaces as a typed `CoreError` from `enqueue*`, never as a raw exception.
   */
  newClientMsgId?: () => string;
}

type Listener = (items: OutboxItem[]) => void;

/** Error codes that mean "try again later with the same clientMsgId". */
const RETRYABLE: ReadonlySet<string> = new Set<string>([
  'client/timeout',
  'client/disconnected',
  'client/bad-message',
  'agent-busy',
  'internal',
  TRANSPORT_ERROR.badUrl,
  TRANSPORT_ERROR.connectFailed,
]);

/**
 * The gateway accepts a `clientMsgId` only when the trimmed value is 1..128 characters
 * (`plugins/mobile-gateway/lib/index.mjs`, `message` handler: `!clientMsgId || length > 128`
 * -> `bad-request`), and keys its per-device idempotency cache on that trimmed value.
 */
const CLIENT_MSG_ID_MAX = 128;

/** The slice of Web Crypto the id generator may use; read off `globalThis`, never imported (core purity). */
interface ClientMsgIdCrypto {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/** `globalThis.crypto` when it is a usable object; a partial, `null` or throwing one means "none". */
function clientMsgIdCrypto(): ClientMsgIdCrypto | undefined {
  try {
    const candidate = (globalThis as { crypto?: ClientMsgIdCrypto | null }).crypto;
    return typeof candidate === 'object' && candidate !== null ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** `length` random bytes from `getRandomValues`; null when the platform has none (or it throws). */
function randomBytes(cryptoObject: ClientMsgIdCrypto | undefined, length: number): Uint8Array | null {
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

/**
 * True when the gateway will accept the value: the trimmed id is non-empty and at most 128
 * characters. Edge whitespace is refused too, because the host would dedupe and echo the trimmed
 * form while the outbox and the history keep the untrimmed one.
 */
function isClientMsgId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= CLIENT_MSG_ID_MAX
    && value === value.trim();
}

/** `length` base-36 digits of `Math.random()`; `''` when `Math.random` itself is broken. */
function randomTag(length: number): string {
  try {
    let out = '';
    while (out.length < length) out += Math.floor(Math.random() * 0x1_0000_0000).toString(36).padStart(7, '0');
    return out.slice(0, length);
  } catch {
    return '';
  }
}

let fallbackClientMsgIdSequence = 0;
let fallbackClientMsgIdTag: string | null = null;

/**
 * Last resort, built for a *globally unique dedup key* rather than a per-connection correlation
 * token: a per-id timestamp, a per-process tag (time + random, built on first use), a monotonic
 * counter and 10 more random chars. Distinctness inside this process is guaranteed by the counter
 * even when `Math.random` throws; a restart or a second device collides only if the clock and the
 * random draws coincide. It cannot be *guaranteed*: `src/core` has no persistent per-install seed
 * (the outbox keeps no storage and must not gain a storage dependency), so the persistent part is
 * the caller's job — `OutboxDeps.newClientMsgId` is the injection point for a generator seeded
 * from the install id in `src/platform`.
 */
function fallbackClientMsgId(): string {
  fallbackClientMsgIdSequence += 1;
  const timestamp = Date.now().toString(36);
  if (fallbackClientMsgIdTag === null) fallbackClientMsgIdTag = `c${timestamp}${randomTag(8)}`;
  const sequence = fallbackClientMsgIdSequence.toString(36);
  const random = randomTag(10);
  return random === ''
    ? `${timestamp}.${fallbackClientMsgIdTag}.${sequence}`
    : `${timestamp}.${fallbackClientMsgIdTag}.${sequence}.${random}`;
}

/**
 * Portable `clientMsgId`. **Never throws.**
 *
 * Contract §4: `clientMsgId` is the host-side at-most-once key for `message` (the gateway caches
 * `sent` per device and answers a repeat without prompting again), so a collision silently drops
 * a user prompt. Unlike `requestId` it must therefore not repeat across app restarts or between
 * two devices — which is also why this is NOT `defaultRequestId()`: that one only promises
 * distinctness within a connection and its last resort is a bare counter (a reused id there is a
 * mis-correlated answer; here it is a lost message).
 *
 * React Native 0.88 ships no Web Crypto, so — exactly like the handshake fix in `client.ts` — the
 * degrade is: `randomUUID()` -> `getRandomValues()` (RFC 4122 v4 built here) -> timestamp +
 * per-process tag + counter + `Math.random()`. The value is never rewritten by the generator: an
 * outbox item keeps the id it was created with, so a retry (or a different generator) cannot
 * change it.
 */
export function defaultClientMsgId(): string {
  const cryptoObject = clientMsgIdCrypto();
  if (cryptoObject !== undefined && typeof cryptoObject.randomUUID === 'function') {
    try {
      const id = cryptoObject.randomUUID();
      if (isClientMsgId(id)) return id;
    } catch {
      // A broken polyfill falls through to random bytes / the timestamp fallback.
    }
  }
  const bytes = randomBytes(cryptoObject, 16);
  if (bytes !== null) return formatUuidV4(bytes);
  return fallbackClientMsgId();
}

export class Outbox {
  private readonly items = new Map<string, OutboxItem>();
  /** Items with a request in flight on the current connection. */
  private readonly inFlight = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private readonly send: OutboxDeps['send'];
  private readonly newId: () => string;
  private draining = false;
  private drainRequested = false;
  private drainChain: Promise<void> | null = null;

  /**
   * Optional gate: return true when the socket is currently gone. The drain checks it before
   * each item, which prevents a stale in-flight item from being counted as acked after a drop.
   */
  gateClosed: ((item: OutboxItem) => boolean) | undefined;

  constructor(deps: OutboxDeps) {
    this.send = deps.send;
    this.newId = deps.newClientMsgId ?? defaultClientMsgId;
  }

  /**
   * One id per queued entry. A broken injected source (throw, empty value, over-long id, edge
   * whitespace) is a caller/programming fault: it is reported as a typed `CoreError` to whoever
   * called `enqueue*`, so a device never dies on a raw exception in the middle of a send.
   */
  private nextClientMsgId(): string {
    let id: unknown;
    try {
      id = this.newId();
    } catch (error) {
      throw new CoreError({
        code: 'client/bad-state',
        message: 'No clientMsgId could be created; nothing was queued',
        details: { stage: 'enqueue' },
        cause: error,
      });
    }
    if (!isClientMsgId(id)) {
      throw new CoreError({
        code: 'client/bad-state',
        message: 'clientMsgId must be 1..128 characters with no leading or trailing whitespace',
        details: { stage: 'enqueue' },
      });
    }
    return id;
  }

  /** Queue a follow-up prompt. The text is kept until acked. */
  enqueuePrompt(sessionId: string, text: string, mode?: 'queue' | 'steer'): PromptItem {
    const item: PromptItem = {
      op: 'prompt',
      clientMsgId: this.nextClientMsgId(),
      sessionId,
      text,
      ...(mode === undefined ? {} : { mode }),
      status: 'queued',
      attempts: 0,
    };
    this.items.set(item.clientMsgId, item);
    this.bump();
    return item;
  }

  /** Queue a cancel. Server-side it is idempotent, so no client id is sent. */
  enqueueCancel(sessionId: string): CancelItem {
    for (const existing of this.items.values()) {
      if (existing.op === 'cancel' && existing.sessionId === sessionId && existing.status !== 'failed') {
        return existing;
      }
      if (existing.op === 'cancel' && existing.sessionId === sessionId && existing.status === 'failed') {
        this.items.delete(existing.clientMsgId);
      }
    }
    const item: CancelItem = {
      op: 'cancel',
      clientMsgId: this.nextClientMsgId(),
      sessionId,
      status: 'queued',
      attempts: 0,
    };
    this.items.set(item.clientMsgId, item);
    this.bump();
    return item;
  }

  get clientMsgIds(): string[] {
    return [...this.items.keys()];
  }

  get(clientMsgId: string): OutboxItem | undefined {
    return this.items.get(clientMsgId);
  }

  list(): OutboxItem[] {
    return [...this.items.values()];
  }

  /** Prompts for one session, in enqueue order (chat view). */
  promptsFor(sessionId: string): PromptItem[] {
    return this.list().filter((i): i is PromptItem => i.op === 'prompt' && i.sessionId === sessionId);
  }

  listByStatus(status: OutboxStatus): OutboxItem[] {
    return this.list().filter((i) => i.status === status);
  }

  /** True while this item's request is in flight on the current connection. */
  isInFlight(clientMsgId: string): boolean {
    return this.inFlight.has(clientMsgId);
  }

  /** Deps.send payload for an item; stable across retries (same clientMsgId). */
  frameFor(item: OutboxItem): OutboxFrame {
    if (item.op === 'prompt') {
      return {
        op: 'message',
        params: {
          sessionId: item.sessionId,
          text: item.text,
          clientMsgId: item.clientMsgId,
          ...(item.mode === undefined ? {} : { mode: item.mode }),
        },
      };
    }
    return { op: 'session-cancel', params: { sessionId: item.sessionId } };
  }

  /**
   * Send everything queued, in order, stopping at the first retryable failure (the socket is
   * gone; the rest stays queued for the next reconnect). Items still in flight are never
   * sent twice. Calls made while a drain is running are queued behind it (they never overlap
   * on the wire) and return a promise that resolves when that work is done.
   */
  async drain(): Promise<void> {
    if (this.draining) {
      this.drainRequested = true;
      const previous = this.drainChain ?? Promise.resolve();
      const chained = previous.then(() => this.runDrain());
      this.drainChain = chained.catch(() => undefined);
      return chained;
    }
    return this.runDrain();
  }

  private async runDrain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      do {
        this.drainRequested = false;
        for (const item of [...this.items.values()]) {
          if (item.status !== 'queued' || this.inFlight.has(item.clientMsgId)) continue;
          // Re-check right before sending: the socket may have gone while we were waiting.
          if (this.gateClosed?.(item)) {
            this.markQueued(item, 'client/disconnected');
            this.drainRequested = false;
            return;
          }
          const sent = this.markSent(item);
          this.inFlight.add(sent.clientMsgId);
          try {
            await this.send(this.frameFor(sent));
            // A drop between the receipt and this point must win: the frame was on the wire
            // when the link died, so treat it as unacknowledged and retry the same clientMsgId.
            const droppedMeanwhile = this.gateClosed?.(sent) === true;
            this.inFlight.delete(sent.clientMsgId);
            if (!droppedMeanwhile) this.markAcked(sent);
            else this.markSentAgain(sent);
          } catch (error) {
            this.inFlight.delete(sent.clientMsgId);
            const code: CoreErrorCode = error instanceof CoreError ? error.code : 'client/bad-message';
            if (RETRYABLE.has(code)) {
              // The socket is gone: back to queued (resent after reconnect), stop the drain.
              this.markQueued(sent, code);
              this.drainRequested = false;
              return;
            }
            this.markFailed(sent, code);
          }
        }
      } while (this.drainRequested);
    } finally {
      this.draining = false;
      this.drainRequested = false;
    }
  }

  /** Connection dropped: in-flight requests can no longer complete. */
  onDisconnected(): void {
    // Fail the requests that were cut by the drop so their callers (and the outbox loop)
    // see a definitive `client/disconnected` instead of waiting for a timeout.
    this.dropInFlight?.(new CoreError({ code: 'client/disconnected', message: 'Socket dropped', retryable: true }));
    let changed = false;
    for (const [id, item] of this.items) {
      if (item.status === 'sent') {
        this.inFlight.delete(id);
        this.items.set(id, { ...item, status: 'queued', lastError: 'client/disconnected' });
        changed = true;
      }
    }
    if (changed) this.bump();
  }

  /**
   * Optional hook the app wires to the client so an in-flight prompt fails immediately on a
   * dropped socket (the client's own `close` handling does this when requests go through it).
   */
  dropInFlight: ((error: CoreError) => void) | undefined;

  /** Explicit user retry for a failed item. */
  retry(clientMsgId: string): OutboxItem | undefined {
    const item = this.items.get(clientMsgId);
    if (!item || item.status !== 'failed') return item;
    return this.markQueued(item);
  }

  /** Drop acked items (keeps memory bounded). */
  prune(): void {
    let changed = false;
    for (const [id, item] of this.items) {
      if (item.status === 'acked') {
        this.items.delete(id);
        this.inFlight.delete(id);
        changed = true;
      }
    }
    if (changed) this.bump();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private markSent(item: OutboxItem): OutboxItem {
    const next: OutboxItem = { ...item, status: 'sent', attempts: item.attempts + 1 };
    this.items.set(item.clientMsgId, next);
    this.bump();
    return next;
  }

  private markQueued(item: OutboxItem, code?: CoreErrorCode): OutboxItem {
    const next: OutboxItem = { ...item, status: 'queued' };
    if (code === undefined) delete next.lastError;
    else next.lastError = code;
    this.items.set(item.clientMsgId, next);
    this.bump();
    return next;
  }

  /** The receipt arrived after the socket died: the frame may have been applied. */
  private markSentAgain(item: OutboxItem): void {
    this.items.set(item.clientMsgId, { ...item, status: 'sent', lastError: 'client/disconnected' });
    this.bump();
  }

  private markAcked(item: OutboxItem): void {
    this.inFlight.delete(item.clientMsgId);
    const next: OutboxItem = { ...item, status: 'acked' };
    delete next.lastError;
    this.items.set(item.clientMsgId, next);
    this.bump();
  }

  private markFailed(item: OutboxItem, code: CoreErrorCode): void {
    this.inFlight.delete(item.clientMsgId);
    this.items.set(item.clientMsgId, { ...item, status: 'failed', lastError: code });
    this.bump();
  }

  private bump(): void {
    const snapshot = this.list();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // listener failures must not break the outbox
      }
    }
  }
}
