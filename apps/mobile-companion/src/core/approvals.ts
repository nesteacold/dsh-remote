// Approval card state machine (US3 / constitution B3), contract §5:
//
//   pending --approve|reject--> approving|rejecting
//        --receipt accepted:true-->  resolved(allowed-once|rejected)
//        --receipt accepted:false, reason:"hash-mismatch"--> review-again
//        --receipt accepted:false, reason:"not-pending"-->  already-decided
//        --approval-resolved push-->                       resolved | already-decided
//   review-again --reload(changed hash, same request)--> pending (user must look again)
//   every hash this card was refused for with `hash-mismatch` is dead for good: none of them is
//   re-applied, even with `{ fresh: true }` (A refused, B refused, a replay of A stays dead)
//   argsHash === null => canApprove = false (decide on your computer), a decision is refused
//   locally.
//
// Invariant: the decision ALWAYS echoes the `argsHash` this card captured when the user
// looked at it. A newer hash arriving from the server never silently updates the card.
//
// The responder returns the host receipt (resolve) and throws `CoreError` only for transport
// failures / error frames; `reason` values are mapped here, never in the UI.

import {
  APPROVAL_OUTCOMES_FINAL,
  RECEIPT_REASONS,
  type ApprovalRequestedFrame,
  type ApprovalResolvedFrame,
  type ReceiptReason,
} from '@dsh-ext/mobile-protocol';

import { CoreError, isCoreError, type CoreErrorCode } from './errors';
import type { ApprovalOutcome } from './protocol';

/** Server-sourced fields of an approval, as received. */
export interface ApprovalSource {
  approvalId: string;
  rpcId: string;
  sessionId: string;
  toolName: string;
  /** `null` => decision can only be made on the desktop. */
  argsHash: string | null;
  /** Short, server-side text preview (already ≤ 2 KB); redacted again before display. */
  argsPreview?: string;
  /** Short localised reason, e.g. `displayReason.en`. */
  displayReason?: Record<string, string>;
  reason?: string;
  callId?: string;
}

/** Exact payload the app sends for a decision (contract §5 `approval-response`). */
export interface ApprovalDecision {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  argsHash: string;
  outcome: ApprovalOutcome;
}

/** What the host answered for a decision (the `approval-response` receipt). */
export interface ApprovalReceiptOutcome {
  accepted: boolean;
  reason?: ReceiptReason;
}

/** Sends the decision and resolves with the host receipt. */
export type ApprovalResponder = (decision: ApprovalDecision) => Promise<ApprovalReceiptOutcome>;

export type ApprovalCardStatus =
  | 'pending'
  | 'approving'
  | 'rejecting'
  | 'resolved'
  | 'review-again'
  | 'already-decided';

export interface ApprovalCardState {
  approvalId: string;
  rpcId: string;
  sessionId: string;
  toolName: string;
  /** Hash shown to the user; echoed on decision. */
  argsHash: string | null;
  /** Short preview, redacted by the UI (see redact.ts) — never raw arguments. */
  argsPreview: string;
  displayReason?: Record<string, string>;
  status: ApprovalCardStatus;
  /** False when argsHash is null (desktop only) or the card is not decidable. */
  canApprove: boolean;
  /** Set when resolved or decided elsewhere. */
  outcome?: string;
  /** Set for review-again / already-decided / retry: human-readable explanation. */
  notice?: string;
  /** Error code that produced the current failure state. */
  errorCode?: CoreErrorCode;
}

const NOTICE: Partial<Record<string, { status: ApprovalCardStatus; notice: string }>> = {
  'hash-mismatch': {
    status: 'review-again',
    notice: 'This request changed since you opened it. Review it again.',
  },
  'not-pending': {
    status: 'already-decided',
    notice: 'Already decided on another device.',
  },
};

/** Cards never leave these by themselves; only `reload` can reopen the card. */
export const TERMINAL_STATUSES: readonly ApprovalCardStatus[] = ['resolved', 'already-decided'];

function toState(src: ApprovalSource): ApprovalCardState {
  return {
    approvalId: src.approvalId,
    rpcId: src.rpcId,
    sessionId: src.sessionId,
    toolName: src.toolName,
    argsHash: src.argsHash,
    argsPreview: src.argsPreview ?? '',
    ...(src.displayReason === undefined ? {} : { displayReason: src.displayReason }),
    status: 'pending',
    canApprove: src.argsHash !== null,
  };
}

/** Map a server-provided field to the source shape. */
export function approvalSourceFromFrame(frame: ApprovalRequestedFrame): ApprovalSource {
  return {
    approvalId: frame.approvalId,
    rpcId: frame.rpcId,
    sessionId: frame.sessionId,
    toolName: frame.toolName,
    argsHash: frame.argsHash,
    ...(frame.argsPreview === undefined ? {} : { argsPreview: frame.argsPreview }),
    ...(frame.displayReason === undefined ? {} : { displayReason: frame.displayReason }),
    ...(frame.reason === undefined ? {} : { reason: frame.reason }),
    ...(frame.callId === undefined ? {} : { callId: frame.callId }),
  };
}

export class ApprovalCard {
  private state: ApprovalCardState;

  /**
   * M10: every hash the host explicitly refused with `hash-mismatch` for this card. Each one is
   * stale by the host's own word, so none may make the card decidable again — not even through a
   * `reload(..., { fresh: true })`.
   *
   * A *set*, not a single slot: once a card was refused on hash A, reopened on B and refused on B
   * too, a delayed replay of A must still be recognised as stale. Overwriting A with B would make
   * A look like a genuine change and re-enable a decision the host already refused.
   *
   * Bounded by the card's lifecycle: at most one entry per distinct hash refused for this one
   * approval identity, and the card (with its set) dies with `ApprovalCards.remove`. Deliberately
   * never capped or evicted — dropping a refused hash re-enables exactly the stale replay this
   * tracking exists to block; fail closed instead.
   */
  private readonly refusedArgsHashes = new Set<string>();

  constructor(source: ApprovalSource) {
    this.state = toState(source);
  }

  /** M10: the identity a card was created with; a reload from another one is not this card's view. */
  private isSameRequest(source: ApprovalSource): boolean {
    return (
      source.approvalId === this.state.approvalId &&
      source.rpcId === this.state.rpcId &&
      source.sessionId === this.state.sessionId
    );
  }

  static fromFrame(frame: ApprovalRequestedFrame): ApprovalCard {
    return new ApprovalCard(approvalSourceFromFrame(frame));
  }

  get snapshot(): ApprovalCardState {
    return { ...this.state };
  }

  get status(): ApprovalCardStatus {
    return this.state.status;
  }

  get canApprove(): boolean {
    return this.state.canApprove;
  }

  get decided(): boolean {
    return TERMINAL_STATUSES.includes(this.state.status);
  }

  /** True while a decision is in flight (buttons disabled). */
  get busy(): boolean {
    return this.state.status === 'approving' || this.state.status === 'rejecting';
  }

  /**
   * Take the pending -> (approving|rejecting) transition and return the exact decision
   * payload. Refuses locally unless the card is genuinely decidable (M10): it must be
   * `pending` *and* `canApprove`, and it must not echo any hash the host already refused for this
   * approval. A card in `review-again` may only be reopened by `reload()` with a changed hash from
   * the same request.
   */
  begin(outcome: ApprovalOutcome): ApprovalDecision {
    const { argsHash, status, canApprove } = this.state;
    if (argsHash === null) {
      throw new CoreError({
        code: 'client/bad-state',
        message: 'This request can only be approved on the computer.',
        details: { approvalId: this.state.approvalId },
      });
    }
    // Defence in depth: even if a card were somehow reopened on a refused hash, it still may
    // not produce a decision payload for it. Every hash ever refused for this approval is dead,
    // not just the most recent one.
    if (this.refusedArgsHashes.has(argsHash)) {
      throw new CoreError({
        code: 'client/bad-state',
        message: 'This request changed since you opened it. Look at it again.',
        details: { approvalId: this.state.approvalId },
      });
    }
    if (status !== 'pending' || !canApprove) {
      throw new CoreError({
        code: 'client/bad-state',
        message: `Approval is ${status}; it cannot be decided again.`,
        details: { approvalId: this.state.approvalId },
      });
    }
    const decision: ApprovalDecision = {
      rpcId: this.state.rpcId,
      sessionId: this.state.sessionId,
      approvalId: this.state.approvalId,
      argsHash,
      outcome,
    };
    this.state = {
      ...this.state,
      status: outcome === 'allowed-once' ? 'approving' : 'rejecting',
      canApprove: false,
      notice: undefined,
      errorCode: undefined,
    };
    return decision;
  }

  /** Host receipt with `accepted: true`. */
  succeed(outcome: ApprovalOutcome): void {
    this.state = {
      ...this.state,
      status: 'resolved',
      outcome,
      canApprove: false,
      notice: undefined,
      errorCode: undefined,
    };
  }

  /**
   * Host receipt with `accepted: false` and a `reason`: `hash-mismatch` reopens the review,
   * `not-pending` means it is already decided (here, on the desktop, or it vanished).
   */
  refuse(reason: ReceiptReason): void {
    // M10: remember the exact hash the host refused, so no later view — fresh or not, and
    // regardless of any other hash refused before — can turn it back into a decidable card.
    if (reason === 'hash-mismatch' && this.state.argsHash !== null) this.refusedArgsHashes.add(this.state.argsHash);
    const mapped = NOTICE[reason];
    this.state = {
      ...this.state,
      status: mapped?.status ?? 'already-decided',
      canApprove: false,
      notice: mapped?.notice ?? 'Already decided on another device.',
      errorCode: (RECEIPT_REASONS as readonly string[]).includes(reason) ? undefined : 'client/bad-message',
    };
  }

  /** Transport failure (drop, timeout, error frame); maps to a retryable pending card. */
  fail(error: unknown): void {
    const code: CoreErrorCode = isCoreError(error) ? error.code : 'client/bad-message';
    // M10: an error frame can refuse the hash too; treat it exactly like the receipt.
    if (code === 'approval/hash-mismatch' && this.state.argsHash !== null) this.refusedArgsHashes.add(this.state.argsHash);
    const mapping: Record<string, { status: ApprovalCardStatus; notice: string }> = {
      'approval/hash-mismatch': NOTICE['hash-mismatch'] as { status: ApprovalCardStatus; notice: string },
      'approval/not-pending': NOTICE['not-pending'] as { status: ApprovalCardStatus; notice: string },
      'bad-request': { status: 'pending', notice: 'The host did not understand the decision. Try again.' },
    };
    const mapped = mapping[code];
    if (mapped) {
      this.state = {
        ...this.state,
        status: mapped.status,
        canApprove: mapped.status === 'pending',
        notice: mapped.notice,
        errorCode: code,
      };
      return;
    }
    // Timeout / disconnect / unknown: back to pending so the user can retry.
    this.state = {
      ...this.state,
      status: 'pending',
      canApprove: this.state.argsHash !== null,
      notice: 'Not decided yet. Try again.',
      errorCode: code,
    };
  }

  /**
   * Re-read the approval from the server. A genuinely changed hash reopens the card in `pending`
   * with the new hash; the user must look at the new arguments before deciding again.
   *
   * M10: after a `hash-mismatch` the host has refused one exact hash, and that hash can never be
   * the current one for this approval again — it is stale by the host's own word. This holds for
   * *every* hash this card was refused on, not just the latest: after A and B were both refused, a
   * delayed replay of A is still stale. So such a view is dropped no matter what the caller
   * believes: a *delayed duplicate / replay* of the refused request would otherwise re-enable
   * exactly the decision the host just refused, and `fresh` is a caller hint (the sessions store,
   * a replay after re-subscribe) that cannot make stale content fresh. Only a *different* non-null
   * hash that was never refused, from the *same* approval identity (approvalId, rpcId, sessionId),
   * can reopen the card; a view of another request never touches this card.
   */
  reload(source: ApprovalSource, options: { fresh?: boolean } = {}): void {
    if (!this.isSameRequest(source)) return;
    if (source.argsHash !== null && this.refusedArgsHashes.has(source.argsHash)) return;
    // Pre-existing rule, kept for callers that pass the cached view (no `fresh`): an unchanged
    // hash never reopens a card that is waiting for review.
    if (options.fresh !== true && this.state.status === 'review-again' && this.state.argsHash !== null && source.argsHash === this.state.argsHash) {
      return;
    }
    this.state = toState(source);
  }

  /**
   * The approval was resolved elsewhere (`approval-resolved` push, or already gone). The card
   * closes; when *we* made the decision the push only confirms it.
   */
  markResolvedElsewhere(outcome?: string, knownFinal = APPROVAL_OUTCOMES_FINAL as readonly string[]): void {
    if (this.state.status === 'resolved' && this.state.outcome === outcome) return;
    if (outcome !== undefined && !knownFinal.includes(outcome)) {
      this.state = { ...this.state, status: 'already-decided', canApprove: false, notice: 'Already decided on another device.' };
      return;
    }
    if (this.state.status === 'resolved') {
      // Decided here and confirmed by the host: keep the local outcome.
      return;
    }
    this.state = {
      ...this.state,
      status: 'already-decided',
      outcome,
      canApprove: false,
      notice: 'Already decided on another device.',
    };
  }

  /** One call: begin -> respond -> succeed / refuse / fail. Returns the resulting state. */
  async decide(outcome: ApprovalOutcome, respond: ApprovalResponder): Promise<ApprovalCardState> {
    const decision = this.begin(outcome);
    try {
      const receipt = await respond(decision);
      if (receipt.accepted) this.succeed(outcome);
      else this.refuse(receipt.reason ?? 'not-pending');
    } catch (error) {
      this.fail(error);
    }
    return this.snapshot;
  }
}

/**
 * In-memory registry of cards for the open session view. Keeps exactly one card per
 * approvalId so a re-delivered `approval-requested` (replay after subscribe) does not fork
 * state.
 */
export class ApprovalCards {
  private readonly cards = new Map<string, ApprovalCard>();

  /** Idempotent: an existing card is returned untouched (its captured hash is preserved). */
  upsert(source: ApprovalSource): ApprovalCard {
    const existing = this.cards.get(source.approvalId);
    if (existing) return existing;
    const card = new ApprovalCard(source);
    this.cards.set(source.approvalId, card);
    return card;
  }

  /** Also dedupe by `rpcId` (contract §5: clients deduplicate by rpcId). */
  getByRpcId(rpcId: string): ApprovalCard | undefined {
    for (const card of this.cards.values()) if (card.snapshot.rpcId === rpcId) return card;
    return undefined;
  }

  get(approvalId: string): ApprovalCard | undefined {
    return this.cards.get(approvalId);
  }

  /** Decidable (pending + non-null hash) cards for a session. */
  pendingFor(sessionId: string): ApprovalCard[] {
    return [...this.cards.values()].filter((c) => c.snapshot.sessionId === sessionId && c.canApprove);
  }

  /** Every card of one session, newest first by insertion order. */
  forSession(sessionId: string): ApprovalCard[] {
    return [...this.cards.values()].filter((c) => c.snapshot.sessionId === sessionId);
  }

  /**
   * Apply an `approval-resolved` push. Returns true when a known card changed, so the caller
   * can bump the session badge.
   */
  applyResolved(frame: ApprovalResolvedFrame): boolean {
    const card = this.get(frame.approvalId) ?? this.getByRpcId(frame.rpcId);
    if (!card) return false;
    const before = card.snapshot.status;
    card.markResolvedElsewhere(frame.outcome);
    return card.snapshot.status !== before;
  }

  all(): ApprovalCard[] {
    return [...this.cards.values()];
  }

  remove(approvalId: string): void {
    this.cards.delete(approvalId);
  }
}
