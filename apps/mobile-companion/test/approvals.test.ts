// Approval card tests (A014), contract §5: pending -> approving/rejecting -> resolved |
// review-again | already-decided; the decision echoes the exact argsHash; `accepted:false`
// receipts carry `reason` (hash-mismatch -> review again, not-pending -> already decided);
// `argsHash: null` => no approve; `approval-resolved` closes the card.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ApprovalRequestedFrame } from '@dsh-ext/mobile-protocol';

import { ApprovalCard, ApprovalCards, type ApprovalDecision, type ApprovalReceiptOutcome, type ApprovalSource } from '../src/core/approvals';
import { CoreError } from '../src/core/errors';

const HASH = 'a1b2'.repeat(16);

function source(overrides: Partial<ApprovalSource> = {}): ApprovalSource {
  return {
    approvalId: 'ap-1',
    rpcId: 'rpc-1',
    sessionId: 's1',
    toolName: 'bash',
    argsHash: HASH,
    argsPreview: '{"command":"rm -rf build"}',
    ...overrides,
  };
}

const accepted = (): Promise<ApprovalReceiptOutcome> => Promise.resolve({ accepted: true });
const refused = (reason: ApprovalReceiptOutcome['reason']): Promise<ApprovalReceiptOutcome> =>
  Promise.resolve({ accepted: false, ...(reason === undefined ? {} : { reason }) });

describe('ApprovalCard state machine', () => {
  it('approve: pending -> approving -> resolved with the exact echoed hash', async () => {
    const card = new ApprovalCard(source());
    assert.equal(card.status, 'pending');
    assert.equal(card.canApprove, true);
    const sent: ApprovalDecision[] = [];
    const states: string[] = [];
    const result = await card.decide('allowed-once', async (decision) => {
      states.push(card.status); // in flight
      sent.push(decision);
      return { accepted: true };
    });
    assert.deepEqual(states, ['approving']);
    assert.deepEqual(sent, [
      { rpcId: 'rpc-1', sessionId: 's1', approvalId: 'ap-1', argsHash: HASH, outcome: 'allowed-once' },
    ]);
    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'allowed-once');
    assert.equal(card.decided, true);
  });

  it('reject: pending -> rejecting -> resolved(rejected)', async () => {
    const card = new ApprovalCard(source());
    let inFlight = '';
    const result = await card.decide('rejected', async (decision) => {
      inFlight = card.status;
      assert.equal(decision.outcome, 'rejected');
      assert.equal(decision.argsHash, HASH);
      return { accepted: true };
    });
    assert.equal(inFlight, 'rejecting');
    assert.equal(result.status, 'resolved');
    assert.equal(result.outcome, 'rejected');
  });

  it('receipt accepted:false reason:"hash-mismatch" -> review-again, then reload asks to look again', async () => {
    const card = new ApprovalCard(source());
    const result = await card.decide('allowed-once', () => refused('hash-mismatch'));
    assert.equal(result.status, 'review-again');
    assert.equal(result.canApprove, false);
    assert.match(result.notice ?? '', /Review it again/);

    card.reload(source({ argsHash: 'bbbb'.repeat(16) }));
    assert.equal(card.status, 'pending');
    assert.equal(card.canApprove, true);
    const sent: ApprovalDecision[] = [];
    await card.decide('allowed-once', async (d) => {
      sent.push(d);
      return { accepted: true };
    });
    // The NEW hash is echoed after review, never the stale one.
    assert.equal(sent[0]?.argsHash, 'bbbb'.repeat(16));
  });

  it('receipt accepted:false reason:"not-pending" -> already-decided', async () => {
    const card = new ApprovalCard(source());
    const result = await card.decide('rejected', () => refused('not-pending'));
    assert.equal(result.status, 'already-decided');
    assert.match(result.notice ?? '', /Already decided/);
    assert.equal(card.decided, true);
  });

  it('error frame bad-request keeps the card decidable', async () => {
    const card = new ApprovalCard(source());
    const result = await card.decide('rejected', async () => {
      throw new CoreError({ code: 'bad-request', message: 'bad outcome' });
    });
    assert.equal(result.status, 'pending');
    assert.equal(result.canApprove, true);
    assert.equal(result.errorCode, 'bad-request');
  });

  it('a decided card refuses a second decision locally', async () => {
    const card = new ApprovalCard(source());
    await card.decide('allowed-once', accepted);
    assert.throws(() => card.begin('allowed-once'), { code: 'client/bad-state' });
  });

  it('a timeout keeps the card decidable again with the same hash', async () => {
    const card = new ApprovalCard(source());
    const result = await card.decide('allowed-once', async () => {
      throw new CoreError({ code: 'client/timeout', message: 'slow' });
    });
    assert.equal(result.status, 'pending');
    assert.equal(result.errorCode, 'client/timeout');
    assert.equal(result.argsHash, HASH);
    assert.equal(result.canApprove, true);
  });

  it('argsHash null -> canApprove false and no decision payload can be produced', () => {
    const card = new ApprovalCard(source({ argsHash: null }));
    assert.equal(card.canApprove, false);
    assert.throws(() => card.begin('allowed-once'), { code: 'client/bad-state' });
    assert.throws(() => card.begin('rejected'), { code: 'client/bad-state' });
  });

  it('approval-resolved closes a pending card and confirms our own decision', async () => {
    const pending = new ApprovalCard(source());
    pending.markResolvedElsewhere('cancelled');
    assert.equal(pending.status, 'already-decided');

    const decided = new ApprovalCard(source());
    await decided.decide('allowed-once', accepted);
    // Our own decision echoes back as a push: the card stays resolved with our outcome.
    decided.markResolvedElsewhere('allowed-once');
    assert.equal(decided.status, 'resolved');
    assert.equal(decided.snapshot.outcome, 'allowed-once');
  });

  it('a second begin() while in flight is refused (no double decision)', () => {
    const card = new ApprovalCard(source());
    card.begin('allowed-once');
    assert.equal(card.busy, true);
    assert.throws(() => card.begin('rejected'), { code: 'client/bad-state' });
  });

  it('a review-again card cannot be decided until a fresh server view reopens it (M10)', async () => {
    const card = new ApprovalCard(source());
    await card.decide('allowed-once', () => refused('hash-mismatch'));
    assert.equal(card.status, 'review-again');
    // No decision may start from review-again, even though the captured hash is still there.
    assert.throws(() => card.begin('allowed-once'), { code: 'client/bad-state' });
    assert.throws(() => card.begin('rejected'), { code: 'client/bad-state' });
  });

  it('reload ignores a stale copy that repeats the refused hash (M10)', async () => {
    const card = new ApprovalCard(source());
    await card.decide('allowed-once', () => refused('hash-mismatch'));
    // The cached view still carries the hash the host refused: re-applying it would re-enable
    // exactly the decision that was just rejected.
    card.reload(source({ argsHash: HASH }));
    assert.equal(card.status, 'review-again');
    assert.equal(card.canApprove, false);
    assert.throws(() => card.begin('allowed-once'), { code: 'client/bad-state' });

    // A genuinely fresh view (received after the reload asked) reopens it with the new hash.
    card.reload(source({ argsHash: 'dddd'.repeat(16) }), { fresh: true });
    assert.equal(card.status, 'pending');
    assert.equal(card.canApprove, true);
  });

  it('a view flagged fresh cannot re-enable the exact refused hash (M10)', async () => {
    const card = new ApprovalCard(source());
    await card.decide('allowed-once', () => refused('hash-mismatch'));
    assert.equal(card.status, 'review-again');
    const refusedHash = card.snapshot.argsHash;
    // `fresh` is a caller hint, not server proof: the host refused this exact hash, so it can
    // never be current again for this approval — the card must stay in review-again.
    card.reload(source({ argsHash: HASH }), { fresh: true });
    assert.equal(card.status, 'review-again');
    assert.equal(card.canApprove, false);
    assert.equal(card.snapshot.argsHash, refusedHash);
    assert.equal(card.snapshot.notice, 'This request changed since you opened it. Review it again.');
    assert.throws(() => card.begin('allowed-once'), { code: 'client/bad-state' });
  });

  it('a delayed duplicate / replay of the refused request cannot decide again (M10)', async () => {
    const card = ApprovalCard.fromFrame({
      kind: 'approval-requested',
      rpcId: 'rpc-1',
      sessionId: 's1',
      approvalId: 'ap-1',
      toolName: 'bash',
      argsHash: HASH,
      argsPreview: '{"command":"rm -rf build"}',
      replay: true,
    });
    await card.decide('rejected', () => refused('hash-mismatch'));
    assert.equal(card.status, 'review-again');
    // The same request re-arrives late, first as a replay copy, then flagged fresh.
    card.reload(source({ argsHash: HASH }), { fresh: true });
    card.reload(source({ argsHash: HASH }));
    assert.equal(card.status, 'review-again');
    assert.equal(card.canApprove, false);
    assert.throws(() => card.begin('rejected'), { code: 'client/bad-state' });
    // A changed hash from the same request is the only thing that reopens it.
    card.reload(source({ argsHash: 'eeee'.repeat(16) }), { fresh: true });
    assert.equal(card.status, 'pending');
    assert.equal(card.snapshot.argsHash, 'eeee'.repeat(16));
  });

  it('a replay of an older refused hash stays dead after the card reopened and was refused again (M10)', async () => {
    const A = HASH;
    const B = 'b0b0'.repeat(16);
    const card = new ApprovalCard(source({ argsHash: A }));
    await card.decide('allowed-once', () => refused('hash-mismatch'));
    assert.equal(card.status, 'review-again');
    // A changed hash genuinely reopens the card; the host then refuses that one too.
    card.reload(source({ argsHash: B }), { fresh: true });
    assert.equal(card.status, 'pending');
    await card.decide('allowed-once', () => refused('hash-mismatch'));
    assert.equal(card.status, 'review-again');
    assert.equal(card.snapshot.argsHash, B);

    // A delayed replay of the FIRST request (hash A) must not look like a fresh change now: both
    // refused hashes stay dead, not only the most recent one.
    card.reload(source({ argsHash: A }), { fresh: true });
    assert.equal(card.status, 'review-again');
    assert.equal(card.canApprove, false);
    assert.equal(card.snapshot.argsHash, B);
    assert.throws(() => card.begin('allowed-once'), { code: 'client/bad-state' });

    // Same for the plain cached copy (no `fresh`).
    card.reload(source({ argsHash: A }));
    assert.equal(card.status, 'review-again');
    assert.equal(card.canApprove, false);
    assert.throws(() => card.begin('rejected'), { code: 'client/bad-state' });
  });

  it('after A and B were refused, a third never-refused hash still reopens the card (M10)', async () => {
    const card = new ApprovalCard(source({ argsHash: HASH }));
    await card.decide('allowed-once', () => refused('hash-mismatch'));
    card.reload(source({ argsHash: 'b0b0'.repeat(16) }), { fresh: true });
    await card.decide('allowed-once', () => refused('hash-mismatch'));
    assert.equal(card.status, 'review-again');

    // The refused set blocks A and B only; a genuinely new hash is new information.
    const fresh = 'c0c0'.repeat(16);
    card.reload(source({ argsHash: fresh }), { fresh: true });
    assert.equal(card.status, 'pending');
    assert.equal(card.canApprove, true);
    const sent: ApprovalDecision[] = [];
    await card.decide('allowed-once', async (decision) => {
      sent.push(decision);
      return { accepted: true };
    });
    assert.equal(sent[0]?.argsHash, fresh);
    assert.equal(card.status, 'resolved');
  });

  it('an error-frame refusal pins every refused hash the same way (A then B refused, A replay dead) (M10)', async () => {
    const A = HASH;
    const B = 'b0b0'.repeat(16);
    const card = new ApprovalCard(source({ argsHash: A }));
    await card.decide('allowed-once', async () => {
      throw new CoreError({ code: 'approval/hash-mismatch', message: 'request changed' });
    });
    assert.equal(card.status, 'review-again');
    card.reload(source({ argsHash: B }), { fresh: true });
    assert.equal(card.status, 'pending');
    await card.decide('allowed-once', async () => {
      throw new CoreError({ code: 'approval/hash-mismatch', message: 'request changed' });
    });
    assert.equal(card.status, 'review-again');

    card.reload(source({ argsHash: A }), { fresh: true });
    assert.equal(card.status, 'review-again');
    assert.equal(card.canApprove, false);
    assert.throws(() => card.begin('allowed-once'), { code: 'client/bad-state' });

    // A new hash that was never refused is still accepted.
    card.reload(source({ argsHash: 'c0c0'.repeat(16) }), { fresh: true });
    assert.equal(card.status, 'pending');
    assert.equal(card.canApprove, true);
  });

  it('a changed hash flagged fresh reopens the card and is echoed on the next decision (M10)', async () => {
    const card = new ApprovalCard(source());
    await card.decide('allowed-once', () => refused('hash-mismatch'));
    const changed = 'ffff'.repeat(16);
    card.reload(source({ argsHash: changed, argsPreview: '{"command":"ls"}' }), { fresh: true });
    assert.equal(card.status, 'pending');
    assert.equal(card.canApprove, true);
    const sent: ApprovalDecision[] = [];
    await card.decide('allowed-once', async (decision) => {
      sent.push(decision);
      return { accepted: true };
    });
    assert.equal(sent[0]?.argsHash, changed);
    assert.equal(card.status, 'resolved');

    // A delayed replay of the OLD refused request must not reopen the card after it reopened on
    // the changed hash either: that hash stays dead for this approval.
    card.reload(source({ argsHash: HASH }), { fresh: true });
    assert.notEqual(card.snapshot.argsHash, HASH);
  });

  it('a view of another request (rpcId / sessionId / approvalId) never touches the card (M10)', async () => {
    const card = new ApprovalCard(source());
    await card.decide('allowed-once', () => refused('hash-mismatch'));
    const changed = 'aaaa'.repeat(16);
    // A changed hash with the wrong identity belongs to a different approval / call: refuse it.
    card.reload(source({ argsHash: changed, rpcId: 'rpc-2' }), { fresh: true });
    card.reload(source({ argsHash: changed, sessionId: 's2' }), { fresh: true });
    card.reload(source({ argsHash: changed, approvalId: 'ap-2' }), { fresh: true });
    assert.equal(card.status, 'review-again');
    assert.equal(card.canApprove, false);
    assert.equal(card.snapshot.approvalId, 'ap-1');
    assert.equal(card.snapshot.sessionId, 's1');
    assert.throws(() => card.begin('allowed-once'), { code: 'client/bad-state' });

    // The same identity with the changed hash is the one view that may reopen it.
    card.reload(source({ argsHash: changed }), { fresh: true });
    assert.equal(card.status, 'pending');
    assert.equal(card.snapshot.argsHash, changed);
  });

  it('a null hash can never be decided, before or after a refusal', async () => {
    const card = new ApprovalCard(source());
    await card.decide('allowed-once', () => refused('hash-mismatch'));
    card.reload(source({ argsHash: null }), { fresh: true });
    assert.equal(card.canApprove, false);
    assert.throws(() => card.begin('allowed-once'), { code: 'client/bad-state' });
    assert.throws(() => card.begin('rejected'), { code: 'client/bad-state' });

    // Plain null-hash card: same outcome, no decision payload exists.
    const desktopOnly = new ApprovalCard(source({ approvalId: 'ap-null', argsHash: null }));
    assert.equal(desktopOnly.canApprove, false);
    assert.throws(() => desktopOnly.begin('allowed-once'), { code: 'client/bad-state' });
  });

  it('a hash-mismatch error frame also pins the refused hash (M10)', async () => {
    const card = new ApprovalCard(source());
    const result = await card.decide('allowed-once', async () => {
      throw new CoreError({ code: 'approval/hash-mismatch', message: 'request changed' });
    });
    assert.equal(result.status, 'review-again');
    card.reload(source({ argsHash: HASH }), { fresh: true });
    assert.equal(card.status, 'review-again');
    assert.equal(card.canApprove, false);
    assert.throws(() => card.begin('allowed-once'), { code: 'client/bad-state' });
  });

  it('fromFrame keeps the §5 fields including displayReason and replay', () => {
    const frame: ApprovalRequestedFrame = {
      kind: 'approval-requested',
      rpcId: 'rpc-9',
      sessionId: 's9',
      approvalId: 'ap-9',
      toolName: 'bash',
      argsHash: HASH,
      argsPreview: '{"command":"ls"}',
      displayReason: { en: 'Run ls' },
      callId: 'call-42',
      replay: true,
    };
    const card = ApprovalCard.fromFrame(frame);
    const snapshot = card.snapshot;
    assert.equal(snapshot.approvalId, 'ap-9');
    assert.equal(snapshot.argsPreview, '{"command":"ls"}');
    assert.deepEqual(snapshot.displayReason, { en: 'Run ls' });
  });
});

describe('ApprovalCards registry', () => {
  it('keeps one card per approvalId so a re-delivered push cannot fork state', () => {
    const cards = new ApprovalCards();
    const first = cards.upsert(source());
    first.begin('allowed-once');
    const again = cards.upsert(source({ argsHash: 'cccc'.repeat(16) }));
    assert.equal(again, first);
    assert.equal(again.snapshot.argsHash, HASH); // captured hash preserved
    assert.equal(cards.pendingFor('s1').length, 0); // in flight => not decidable
  });

  it('finds a card by rpcId and applies approval-resolved to it', () => {
    const cards = new ApprovalCards();
    cards.upsert(source({ approvalId: 'ap-1', rpcId: 'rpc-1' }));
    assert.equal(cards.getByRpcId('rpc-1')?.snapshot.approvalId, 'ap-1');
    const changed = cards.applyResolved({ kind: 'approval-resolved', rpcId: 'rpc-1', sessionId: 's1', approvalId: 'ap-1', outcome: 'unavailable' });
    assert.equal(changed, true);
    assert.equal(cards.get('ap-1')?.status, 'already-decided');
    // An unknown approval is a no-op for this registry.
    assert.equal(
      cards.applyResolved({ kind: 'approval-resolved', rpcId: 'rpc-x', sessionId: 's1', approvalId: 'ap-x', outcome: 'cancelled' }),
      false,
    );
  });

  it('lists only decidable cards per session', () => {
    const cards = new ApprovalCards();
    cards.upsert(source({ approvalId: 'a' }));
    cards.upsert(source({ approvalId: 'b', argsHash: null }));
    cards.upsert(source({ approvalId: 'c', sessionId: 's2' }));
    assert.equal(cards.pendingFor('s1').length, 1);
    assert.equal(cards.pendingFor('s1')[0]?.snapshot.approvalId, 'a');
    assert.equal(cards.pendingFor('s2')[0]?.snapshot.approvalId, 'c');
    assert.equal(cards.forSession('s1').length, 2);
    assert.equal(cards.all().length, 3);
  });
});
