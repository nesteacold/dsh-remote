// Sessions store (US2): `sessions` / `search` results kept in memory, projected into the three
// state tabs, filtered by search text, and flagged `needsDecision` when an
// `approval-requested` push arrives (cleared by `approval-resolved` / a decision).
//
// Contract §4 / §5a (revision 2.1): a `sessions`/`search` row is the upstream list projection —
// the canonical id is `sessionId`, `updatedAt` is epoch milliseconds, `running` is the live
// state, and the title lives in `projections.values.title`; the client derives
// running/idle/archived. The store's local `SessionSummary.id` is that canonical `sessionId`.
//
// Compatibility (explicitly tested below): rows from gateways/fixtures written before
// revision 2.1 carry `id` instead of `sessionId` and a `state` string instead of `running`.
// `id` is consulted only when `sessionId` is absent, and `state` only when `running` is not a
// boolean; the canonical fields always win.
//
// "Same tick" contract: a session reads `needsDecision === true` synchronously in the same
// microtask-free turn in which the approval event is applied (no timers, no await).

import type { ApprovalRequestedFrame } from '@dsh-ext/mobile-protocol';

import { SESSION_STATES, type SessionState } from './protocol';

export { SESSION_STATES };
export type { SessionState };

export interface SessionSummary {
  /** Local id: the canonical row `sessionId` (legacy `id` fallback for pre-2.1 rows). */
  id: string;
  title: string;
  state: SessionState;
  /** Epoch milliseconds of the last activity. */
  updatedAt: number;
  /** True while at least one approval for this session waits for a decision. */
  needsDecision: boolean;
  /**
   * Upstream row `origin` (`'root'` | `'subagent'`, …) when the Host sent one. ABSENT stays absent:
   * an older Host that reports nothing is never assumed to be a root session.
   */
  origin?: string;
  /** Upstream `parentSessionId` of a subagent row, when present. */
  parentSessionId?: string;
}

/**
 * True only when the Host SAID this is a subagent session. Absent `origin` is not evidence either
 * way, so it is treated as "not known to be a subagent" — never labelled.
 */
export function isSubagentSession(session: Pick<SessionSummary, 'origin'>): boolean {
  return session.origin === 'subagent';
}

export type SessionTab = SessionState;

export interface SessionsStoreOptions {
  /** Injected clock (for sorting/updated-ago); defaults to `Date.now`. */
  now?: () => number;
}

type Listener = (snapshot: SessionSnapshot) => void;

export interface SessionSnapshot {
  /** All known summaries, most recently updated first. */
  items: SessionSummary[];
  /** Pending approvals keyed by approvalId. */
  pendingApprovals: ApprovalRequestedFrame[];
  /** Sessions dropped by the 500-item / 30-day window (spec edge case). */
  hiddenOlderCount: number;
  /** Monotonic counter bumped on every change (cheap change detection). */
  revision: number;
}

/** B4 defaults: the session list window. */
export const MAX_SESSIONS = 500;
export const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Epoch ms from a number or an ISO string; `null` when unparseable. */
export function toEpochMs(value: unknown): number | null {
  // Contract §5a says epoch milliseconds; epoch seconds are tolerated for legacy hosts.
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function projectTitle(row: Record<string, unknown>, id: string): string {
  // Canonical: `projections.values.title`. `row.title` is a legacy/fixture convenience.
  if (typeof row.title === 'string' && row.title.trim() !== '') return row.title;
  const projections = row.projections as { values?: { title?: unknown } } | undefined;
  const projected = projections?.values?.title;
  if (typeof projected === 'string' && projected.trim() !== '') return projected;
  // A brand-new session genuinely has no Host title yet. The wire id is NOT a title: showing it put
  // `session-de1cb815-…` in the header on device. Return "no title" and let the UI supply a human
  // fallback (`sessionDisplayTitle`), so the id is never rendered as content.
  return '';
}

/**
 * Canonical row id → the local session id. Revision 2.1 rows carry `sessionId`; pre-2.1
 * rows (and the controller's fixtures) carry `id`. Canonical always wins, and an empty or
 * non-string value is rejected rather than silently producing an unusable session.
 */
function projectSessionId(row: Record<string, unknown>): string | null {
  const canonical = row.sessionId;
  if (typeof canonical === 'string' && canonical.trim() !== '') return canonical;
  // Compatibility fallback: documented in the header and covered by an explicit test.
  const legacy = row.id;
  if (typeof legacy === 'string' && legacy.trim() !== '') return legacy;
  return null;
}

/**
 * Upstream row → the three tabs. Contract §5a: `running` is canonical (true ⇒ running,
 * false ⇒ idle); archived is not expressible through `running`, so it needs an explicit
 * archive marker. Pre-2.1 `state` values are only consulted when `running` is absent.
 */
function projectState(row: Record<string, unknown>): SessionState {
  const raw = typeof row.state === 'string' ? row.state.toLowerCase() : '';
  if (row.archived === true || raw === 'archived') return 'archived';
  if (typeof row.running === 'boolean') return row.running ? 'running' : 'idle';
  if (raw === 'running' || raw === 'busy') return 'running';
  return 'idle';
}

function coerceSummary(raw: unknown): SessionSummary | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const sessionId = projectSessionId(r);
  if (sessionId === null) return null;
  return {
    id: sessionId,
    title: projectTitle(r, sessionId),
    state: projectState(r),
    updatedAt: toEpochMs(r.updatedAt) ?? 0,
    // Server-provided hint; the local approval pushes are authoritative and are OR-ed in.
    needsDecision: r.needsDecision === true,
    // Measured on the live Host: 827 of 861 rows are `origin: 'subagent'` with a `parentSessionId`.
    // Both are TOP-LEVEL row fields, so the gateway's title-only projection keeps them intact.
    ...(typeof r.origin === 'string' && r.origin !== '' ? { origin: r.origin } : {}),
    ...(typeof r.parentSessionId === 'string' && r.parentSessionId !== ''
      ? { parentSessionId: r.parentSessionId }
      : {}),
  };
}

export class SessionsStore {
  private readonly now: () => number;
  private readonly byId = new Map<string, SessionSummary>();
  private readonly approvalBySession = new Map<string, Map<string, ApprovalRequestedFrame>>();
  private readonly listeners = new Set<Listener>();
  private revision = 0;
  private hiddenOlderCount = 0;
  /** Session ids seen with a server-side needsDecision hint but no pending approval object. */
  private readonly serverHint = new Set<string>();

  constructor(options: SessionsStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Replace the whole list from a `sessions` response. Pending approvals are kept. */
  setAll(rawItems: unknown): void {
    const items = Array.isArray(rawItems) ? rawItems : [];
    const all: SessionSummary[] = [];
    for (const raw of items) {
      const summary = coerceSummary(raw);
      if (summary !== null) all.push(summary);
    }
    const cutoff = this.now() - MAX_SESSION_AGE_MS;
    const windowed = all.filter((s) => s.updatedAt === 0 || s.updatedAt >= cutoff);
    const kept = windowed
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
    this.hiddenOlderCount = all.length - kept.length;
    this.byId.clear();
    for (const summary of kept) this.byId.set(summary.id, summary);
    this.reconcileBadges();
    this.bump();
  }

  /**
   * Apply a `search` result. Search returns a *view*; merging keeps the rest of the cached
   * list intact so tabs do not empty out.
   */
  mergeSearchResults(rawItems: unknown): void {
    const items = Array.isArray(rawItems) ? rawItems : [];
    for (const raw of items) {
      const summary = coerceSummary(raw);
      if (summary === null) continue;
      const existing = this.byId.get(summary.id);
      this.byId.set(summary.id, existing ? { ...existing, ...summary, needsDecision: existing.needsDecision } : summary);
    }
    this.reconcileBadges();
    this.bump();
  }

  /** Upsert one session (e.g. from an `event` push). */
  upsert(raw: unknown): void {
    const summary = coerceSummary(raw);
    if (summary === null) return;
    this.byId.set(summary.id, summary);
    this.reconcileBadges();
    this.bump();
  }

  /** Record a pending approval => the session row gets the needs-decision badge immediately. */
  applyApprovalRequested(frame: ApprovalRequestedFrame): void {
    const map = this.approvalBySession.get(frame.sessionId) ?? new Map<string, ApprovalRequestedFrame>();
    // A replay after `subscribe` carries the server's current view (possibly a new argsHash);
    // the *card* keeps its captured hash until the user explicitly reloads it.
    map.set(frame.approvalId, frame);
    this.approvalBySession.set(frame.sessionId, map);
    const existing = this.byId.get(frame.sessionId);
    if (existing) {
      this.byId.set(frame.sessionId, { ...existing, needsDecision: true });
    }
    // No row yet: the badge source is kept and applied as soon as a list fills in the row.
    this.bump();
  }

  /** Remove a pending approval (decided here or elsewhere); badge clears when none remain. */
  resolveApproval(approvalId: string, sessionId?: string): void {
    let changed = false;
    const sessionIds = sessionId === undefined ? [...this.approvalBySession.keys()] : [sessionId];
    for (const sid of sessionIds) {
      const map = this.approvalBySession.get(sid);
      if (!map || !map.has(approvalId)) continue;
      map.delete(approvalId);
      if (map.size === 0) this.approvalBySession.delete(sid);
      changed = true;
      const summary = this.byId.get(sid);
      if (summary) this.byId.set(sid, { ...summary, needsDecision: this.approvalBySession.has(sid) });
    }
    if (changed) this.bump();
  }

  /** Replace the pending approval set (e.g. after `subscribe` replays pending cards). */
  setPendingApprovals(frames: readonly ApprovalRequestedFrame[]): void {
    this.approvalBySession.clear();
    // Server-side hints from a fresh list are superseded by the authoritative pending set.
    this.serverHint.clear();
    for (const frame of frames) {
      const map = this.approvalBySession.get(frame.sessionId) ?? new Map<string, ApprovalRequestedFrame>();
      map.set(frame.approvalId, frame);
      this.approvalBySession.set(frame.sessionId, map);
    }
    // Approval pushes are the only badge source from here on; stale row flags are cleared.
    for (const [id, summary] of this.byId) {
      const needs = this.approvalBySession.has(id);
      if (summary.needsDecision !== needs) this.byId.set(id, { ...summary, needsDecision: needs });
    }
    this.bump();
  }

  has(sessionId: string): boolean {
    return this.byId.has(sessionId);
  }

  get(sessionId: string): SessionSummary | undefined {
    const summary = this.byId.get(sessionId);
    return summary ? this.withBadge(summary) : undefined;
  }

  pendingApprovalsFor(sessionId: string): ApprovalRequestedFrame[] {
    return [...(this.approvalBySession.get(sessionId)?.values() ?? [])];
  }

  /** All summaries for one tab, most recent first. `archived` is its own tab, never mixed in. */
  tab(tab: SessionTab): SessionSummary[] {
    return this.sorted().filter((s) => s.state === tab);
  }

  /**
   * Search: case-insensitive substring over title and id. `tab` optional. A blank query
   * returns the tab unchanged.
   */
  search(query: string, tab?: SessionTab): SessionSummary[] {
    const needle = query.trim().toLowerCase();
    const base = tab ? this.tab(tab) : this.sorted();
    if (needle === '') return base;
    return base.filter((s) => s.title.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle));
  }

  /** `updated-ago` label input: ms since last update, clamped at 0. */
  updatedAgoMs(sessionId: string): number | undefined {
    const summary = this.byId.get(sessionId);
    if (!summary) return undefined;
    if (summary.updatedAt === 0) return undefined;
    return Math.max(0, this.now() - summary.updatedAt);
  }

  snapshot(): SessionSnapshot {
    return {
      items: this.sorted(),
      pendingApprovals: [...this.approvalBySession.values()].flatMap((m) => [...m.values()]),
      hiddenOlderCount: this.hiddenOlderCount,
      revision: this.revision,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private withBadge(summary: SessionSummary): SessionSummary {
    const pending = this.approvalBySession.get(summary.id);
    const needs =
      (pending !== undefined && pending.size > 0) || this.serverHint.has(summary.id) || summary.needsDecision === true;
    return summary.needsDecision === needs ? summary : { ...summary, needsDecision: needs };
  }

  private reconcileBadges(): void {
    for (const [id, summary] of this.byId) {
      if (summary.needsDecision) this.serverHint.add(id);
      else this.serverHint.delete(id);
    }
  }

  private sorted(): SessionSummary[] {
    return [...this.byId.values()]
      .map((s) => this.withBadge(s))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  private bump(): void {
    this.revision += 1;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // listeners must not break the store
      }
    }
  }
}
