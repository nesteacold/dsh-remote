// History store (US3 / contract §4 `history`): ordered messages for one session plus the
// deduplication rules that keep "no duplicate and no lost messages" (SC-005) true across
// reconnects and outbox retries.
//
// Pure: no react-native/expo/Node imports; the clock is injected.

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'other';

export interface HistoryMessage {
  /** Monotonic sequence from the host, or null when the row carried none. */
  seq: number | null;
  /** Stable id (host message id, or the clientMsgId for our own optimistic rows). */
  id: string;
  role: MessageRole;
  text: string;
  /** Our own prompt not yet confirmed by the host. */
  pending?: boolean;
  /** Epoch ms (host `createdAt`/`timestamp`, or the send time for pending rows). */
  at: number | null;
}

export interface HistoryPage {
  items: HistoryMessage[];
  /** True when the host has more (older) pages; the UI offers "load earlier". */
  hasMore: boolean;
  /** Cursor for the next `history` request (`beforeSeq`). */
  nextBeforeSeq: number | null;
}

const ROLES: readonly MessageRole[] = ['user', 'assistant', 'tool', 'system'];

function coerceRole(value: unknown): MessageRole {
  if (typeof value !== 'string') return 'other';
  const lower = value.toLowerCase();
  return (ROLES as readonly string[]).includes(lower) ? (lower as MessageRole) : 'other';
}

function coerceText(row: Record<string, unknown>): string {
  if (typeof row.text === 'string') return row.text;
  if (typeof row.content === 'string') return row.content;
  if (Array.isArray(row.content)) {
    // Host content parts: `[{ type: 'text', text }, …]`.
    return row.content
      .map((part) => (typeof part === 'string' ? part : typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .filter((text) => text !== '')
      .join('\n');
  }
  if (typeof row.message === 'string') return row.message;
  return '';
}

function coerceAt(row: Record<string, unknown>): number | null {
  for (const key of ['createdAt', 'timestamp', 'at'] as const) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

export function coerceHistoryMessage(raw: unknown, fallbackIndex: number): HistoryMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const seq = typeof row.seq === 'number' && Number.isFinite(row.seq) ? row.seq : null;
  const id =
    typeof row.id === 'string' && row.id.length > 0
      ? row.id
      : typeof row.messageId === 'string' && row.messageId.length > 0
        ? row.messageId
        : seq !== null
          ? `seq-${seq}`
          : `index-${fallbackIndex}`;
  const text = coerceText(row);
  // A row with neither text nor role is not a message (empty objects, metadata rows).
  const hasRole = typeof row.role === 'string';
  if (text === '' && !hasRole) return null;
  return { seq, id, role: coerceRole(row.role), text, at: coerceAt(row) };
}

/** Sort key: `seq` when present, else arrival order. */
function compare(a: HistoryMessage, b: HistoryMessage, indexA: number, indexB: number): number {
  if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
  return indexA - indexB;
}

export class HistoryStore {
  private messages: HistoryMessage[] = [];
  private readonly now: () => number;
  private hasMoreFlag = false;
  private nextBeforeSeqValue: number | null = null;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  get items(): HistoryMessage[] {
    return [...this.messages];
  }

  get page(): HistoryPage {
    return { items: this.items, hasMore: this.hasMoreFlag, nextBeforeSeq: this.nextBeforeSeqValue };
  }

  /** Replace with the first page from a `history` response. */
  setPage(rawItems: unknown, meta: { hasMore?: boolean; nextBeforeSeq?: number | null } = {}): void {
    const items = Array.isArray(rawItems) ? rawItems : [];
    const coerced: HistoryMessage[] = [];
    items.forEach((raw, index) => {
      const message = coerceHistoryMessage(raw, index);
      if (message !== null) coerced.push(message);
    });
    this.messages = this.dedupe(coerced);
    this.hasMoreFlag = meta.hasMore ?? false;
    // Older pages are requested with the lowest seq currently loaded.
    this.nextBeforeSeqValue = meta.nextBeforeSeq ?? this.firstSeq();
  }

  /**
   * Prepend an older page (`beforeSeq`). Overlapping rows (same id or seq) are dropped, all
   * history arrays already loaded stay in place => loading earlier never duplicates.
   */
  prependPage(rawItems: unknown, meta: { hasMore?: boolean } = {}): void {
    const items = Array.isArray(rawItems) ? rawItems : [];
    const older: HistoryMessage[] = [];
    items.forEach((raw, index) => {
      const message = coerceHistoryMessage(raw, index);
      if (message !== null) older.push(message);
    });
    this.messages = this.dedupe([...older, ...this.messages]);
    this.hasMoreFlag = meta.hasMore ?? false;
    this.nextBeforeSeqValue = this.firstSeq();
  }

  /** Append live messages from `event` pushes or from a local `sent` receipt. */
  append(raw: unknown): HistoryMessage | null {
    const message = coerceHistoryMessage(raw, this.messages.length);
    if (message === null) return null;
    // Idempotent by id (and by seq when both sides have one): a replayed event never forks.
    if (this.messages.some((m) => m.id === message.id || (m.seq !== null && m.seq === message.seq))) return null;
    this.messages.push(message);
    return message;
  }

  /**
   * Our own prompt before the host echoed it. Rendered immediately; replaced when the host
   * reports the same `clientMsgId`.
   */
  addPendingPrompt(clientMsgId: string, text: string): HistoryMessage {
    const existing = this.messages.find((m) => m.id === clientMsgId);
    if (existing) return existing;
    const message: HistoryMessage = {
      seq: null,
      id: clientMsgId,
      role: 'user',
      text,
      pending: true,
      at: this.now(),
    };
    this.messages.push(message);
    return message;
  }

  /** The host echoed a message that carries our `clientMsgId`: replace the optimistic row. */
  confirmPending(clientMsgId: string, raw: unknown): HistoryMessage | null {
    const pending = this.messages.find((m) => m.id === clientMsgId);
    if (pending === undefined) return this.append(raw);
    const confirmed = coerceHistoryMessage(raw, this.messages.length);
    if (confirmed === null) {
      pending.pending = false;
      return pending;
    }
    const index = this.messages.indexOf(pending);
    this.messages[index] = { ...confirmed, id: confirmed.id, pending: false };
    return this.messages[index] as HistoryMessage;
  }

  /** The replacement for a first page that lost our own row (e.g. the prompt was rejected). */
  remove(clientMsgId: string): void {
    this.messages = this.messages.filter((m) => m.id !== clientMsgId);
  }

  clear(): void {
    this.messages = [];
    this.hasMoreFlag = false;
    this.nextBeforeSeqValue = null;
  }

  private lastSeq(): number | null {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const seq = this.messages[index]?.seq;
      if (typeof seq === 'number') return seq;
    }
    return null;
  }

  private firstSeq(): number | null {
    for (const message of this.messages) {
      if (typeof message.seq === 'number') return message.seq;
    }
    return null;
  }

  private dedupe(items: HistoryMessage[]): HistoryMessage[] {
    const seenIds = new Set<string>();
    const seenSeqs = new Set<number>();
    const indexed = items.map((item, index) => ({ item, index }));
    indexed.sort((a, b) => compare(a.item, b.item, a.index, b.index));
    const out: HistoryMessage[] = [];
    for (const { item } of indexed) {
      if (seenIds.has(item.id)) continue;
      if (item.seq !== null && seenSeqs.has(item.seq)) continue;
      seenIds.add(item.id);
      if (item.seq !== null) seenSeqs.add(item.seq);
      out.push(item);
    }
    return out;
  }
}
