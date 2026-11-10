// Sessions store tests (A013 + A046 M7), contract §4 / §5a (revision 2.1): a row is the
// upstream list projection with canonical `sessionId`, epoch-ms `updatedAt`, `running`, and
// the title in `projections.values.title`; the client derives running/idle/archived, filters
// by search text, and flags the needsDecision badge from approval pushes.
//
// The canonical fixture below is the contract's own row shape. Pre-revision-2.1 rows
// (`id` + `state`) are tested separately as an explicitly documented compatibility fallback.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ApprovalRequestedFrame } from '@dsh-ext/mobile-protocol';

import { MAX_SESSIONS, SessionsStore, toEpochMs } from '../src/core/sessions';

const NOW = Date.parse('2026-11-09T06:00:00Z');

/** Exact revision 2.1 shape: `sessionId`, epoch-ms `updatedAt`, `running`, projected title. */
const NORMATIVE_ROW = {
  sessionId: 'session-abc',
  updatedAt: Date.parse('2026-11-09T05:50:00Z'),
  running: true,
  projections: { asOfSeq: 200, values: { title: '排查网关连接' } },
};

/** Canonical row for the ordinary tab/search/window tests. */
function row(
  sessionId: string,
  title: string,
  state: 'running' | 'idle' | 'archived',
  updatedAt: number,
  needsDecision = false,
) {
  return {
    sessionId,
    running: state === 'running',
    // `archived` is not expressible through `running`; the test row marks it explicitly.
    ...(state === 'archived' ? { state: 'archived' as const } : {}),
    updatedAt,
    projections: { values: { title } },
    needsDecision,
  };
}

/** Pre-revision-2.1 row: `id` + `state`. Kept only to prove the documented fallback. */
function legacyRow(id: string, title: string, state: 'running' | 'idle' | 'archived', updatedAt: number) {
  return { id, state, updatedAt, projections: { values: { title } } };
}

function approval(approvalId: string, sessionId: string, argsHash: string | null = 'h'.repeat(64)): ApprovalRequestedFrame {
  return { kind: 'approval-requested', approvalId, rpcId: `rpc-${approvalId}`, sessionId, toolName: 'bash', argsHash };
}

const LIST = [
  row('s1', 'Refactor TLS pinning', 'running', Date.parse('2026-11-09T05:50:00Z')),
  row('s2', 'Write release notes', 'idle', Date.parse('2026-11-09T05:40:00Z')),
  row('s3', 'old spike on terminals', 'archived', Date.parse('2026-11-01T05:40:00Z')),
  row('s4', 'Fix session list', 'running', Date.parse('2026-11-09T05:55:00Z')),
];

describe('SessionsStore', () => {
  it('projects the normative revision 2.1 row into the local session model', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([NORMATIVE_ROW]);
    // `sessionId` becomes the local id, `running: true` the running tab, title from projections.
    assert.deepEqual(store.get('session-abc'), {
      id: 'session-abc',
      title: '排查网关连接',
      state: 'running',
      updatedAt: NORMATIVE_ROW.updatedAt,
      needsDecision: false,
    });
    assert.deepEqual(store.tab('running').map((s) => s.id), ['session-abc']);
    assert.deepEqual(store.search('网关').map((s) => s.id), ['session-abc']);
  });

  it('derives idle from running:false and archived only from an explicit archive marker', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([
      { sessionId: 'r', running: true, updatedAt: NOW, projections: { values: { title: 'R' } } },
      { sessionId: 'i', running: false, updatedAt: NOW, projections: { values: { title: 'I' } } },
      { sessionId: 'a', running: false, state: 'archived', updatedAt: NOW, projections: { values: { title: 'A' } } },
    ]);
    assert.deepEqual(store.tab('running').map((s) => s.id), ['r']);
    assert.deepEqual(store.tab('idle').map((s) => s.id), ['i']);
    assert.deepEqual(store.tab('archived').map((s) => s.id), ['a']);
  });

  it('lets canonical running win over a stale legacy state on the same row', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([
      { sessionId: 'stale-running-state', running: false, state: 'running', updatedAt: NOW },
      { sessionId: 'stale-idle-state', running: true, state: 'idle', updatedAt: NOW },
    ]);
    assert.equal(store.get('stale-running-state')?.state, 'idle');
    assert.equal(store.get('stale-idle-state')?.state, 'running');
  });

  it('accepts the pre-2.1 id field only as the documented fallback', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([
      legacyRow('legacy-running', 'Legacy running', 'running', NOW - 1_000),
      legacyRow('legacy-idle', 'Legacy idle', 'idle', NOW - 2_000),
      legacyRow('legacy-archived', 'Legacy archived', 'archived', NOW - 3_000),
    ]);
    assert.deepEqual(store.tab('running').map((s) => s.id), ['legacy-running']);
    assert.deepEqual(store.tab('idle').map((s) => s.id), ['legacy-idle']);
    assert.deepEqual(store.tab('archived').map((s) => s.id), ['legacy-archived']);
  });

  it('prefers canonical sessionId over a legacy id when a row carries both', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([{ sessionId: 'canonical', id: 'legacy', running: true, updatedAt: NOW }]);
    assert.deepEqual(store.snapshot().items.map((s) => s.id), ['canonical']);
    assert.equal(store.has('legacy'), false);
  });

  it('splits sessions into running / idle / archived tabs, newest first', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll(LIST);
    assert.deepEqual(store.tab('running').map((s) => s.id), ['s4', 's1']);
    assert.deepEqual(store.tab('idle').map((s) => s.id), ['s2']);
    assert.deepEqual(store.tab('archived').map((s) => s.id), ['s3']);
  });

  it('never mixes archived items into other tabs', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll(LIST);
    for (const tab of ['running', 'idle'] as const) {
      assert.equal(store.tab(tab).some((s) => s.state === 'archived'), false);
    }
  });

  it('searches case-insensitively over title and id', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll(LIST);
    assert.deepEqual(store.search('TLS').map((s) => s.id), ['s1']);
    assert.deepEqual(store.search('release').map((s) => s.id), ['s2']);
    assert.deepEqual(store.search('s3').map((s) => s.id), ['s3']);
    assert.deepEqual(store.search('spike', 'archived').map((s) => s.id), ['s3']);
    assert.deepEqual(store.search('spike', 'running'), []);
    assert.equal(store.search('   ').length, 4);
  });

  it('merges search results without dropping the cached list or approved badges', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll(LIST);
    store.applyApprovalRequested(approval('ap-1', 's2'));
    store.mergeSearchResults([row('s2', 'Write release notes', 'idle', Date.parse('2026-11-09T05:59:00Z'))]);
    assert.equal(store.tab('idle').length, 1);
    assert.equal(store.tab('running').length, 2);
    assert.equal(store.search('release')[0]?.updatedAt, Date.parse('2026-11-09T05:59:00Z'));
    assert.equal(store.get('s2')?.needsDecision, true);
  });

  it('upserts a canonical row from an event push', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll(LIST);
    store.upsert({
      sessionId: 's5',
      running: false,
      updatedAt: Date.parse('2026-11-09T05:59:30Z'),
      projections: { values: { title: 'Pushed session' } },
    });
    assert.equal(store.get('s5')?.title, 'Pushed session');
    assert.deepEqual(store.tab('idle').map((s) => s.id), ['s5', 's2']);
  });

  it('sets needsDecision in the same tick an approval-requested push arrives', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll(LIST);
    assert.equal(store.get('s1')?.needsDecision, false);
    // No await, no timer: the call returns after the badge is already visible.
    store.applyApprovalRequested(approval('ap-1', 's1'));
    assert.equal(store.get('s1')?.needsDecision, true);
    assert.equal(store.tab('running').find((s) => s.id === 's1')?.needsDecision, true);
    assert.equal(store.pendingApprovalsFor('s1').length, 1);
  });

  it('keeps the badge while any approval is pending and clears it when the last is resolved', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll(LIST);
    store.applyApprovalRequested(approval('ap-1', 's1'));
    store.applyApprovalRequested(approval('ap-2', 's1', null));
    assert.equal(store.get('s1')?.needsDecision, true);
    store.resolveApproval('ap-1', 's1');
    assert.equal(store.get('s1')?.needsDecision, true);
    store.resolveApproval('ap-2', 's1');
    assert.equal(store.get('s1')?.needsDecision, false);
  });

  it('keeps an approval that arrived before the session was listed', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.applyApprovalRequested(approval('ap-9', 's-new'));
    store.setAll([...LIST, row('s-new', 'Fresh session', 'idle', Date.parse('2026-11-09T05:59:30Z'))]);
    assert.equal(store.get('s-new')?.needsDecision, true);
  });

  it('honours a server-side needsDecision hint', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([...LIST.slice(0, 3), row('s4', 'Fix session list', 'running', Date.parse('2026-11-09T05:55:00Z'), true)]);
    assert.equal(store.get('s4')?.needsDecision, true);
  });

  it('replaces the pending set when it is authoritative', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll(LIST);
    store.applyApprovalRequested(approval('ap-1', 's3'));
    store.setPendingApprovals([approval('ap-2', 's2')]);
    assert.equal(store.get('s3')?.needsDecision, false);
    assert.equal(store.get('s2')?.needsDecision, true);
    assert.equal(store.pendingApprovalsFor('s3').length, 0);
  });

  it('applies the 500-item window and reports how many were hidden', () => {
    const store = new SessionsStore({ now: () => NOW });
    const many = Array.from({ length: MAX_SESSIONS + 12 }, (_, index) =>
      row(`bulk-${index}`, `Bulk ${index}`, 'idle', NOW - index * 1_000),
    );
    store.setAll(many);
    assert.equal(store.snapshot().items.length, MAX_SESSIONS);
    assert.equal(store.snapshot().hiddenOlderCount, 12);
  });

  it('hides sessions older than 30 days', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([
      row('fresh', 'Fresh', 'idle', NOW - 1_000),
      row('stale', 'Stale', 'idle', NOW - 31 * 24 * 60 * 60 * 1000),
    ]);
    assert.deepEqual(store.snapshot().items.map((s) => s.id), ['fresh']);
    assert.equal(store.snapshot().hiddenOlderCount, 1);
  });

  it('computes updated-ago from the injected clock', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll(LIST);
    assert.equal(store.updatedAgoMs('s1'), 600_000);
    assert.equal(store.updatedAgoMs('missing'), undefined);
  });

  it('notifies subscribers with a revisioned snapshot', () => {
    const store = new SessionsStore({ now: () => NOW });
    const revisions: number[] = [];
    store.subscribe((snapshot) => revisions.push(snapshot.revision));
    store.setAll(LIST);
    store.applyApprovalRequested(approval('ap-1', 's1'));
    assert.deepEqual(revisions, [1, 2]);
    assert.equal(store.snapshot().pendingApprovals.length, 1);
  });

  it('rejects malformed rows instead of throwing', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([
      { sessionId: 'ok', running: true, updatedAt: NOW },
      null,
      undefined,
      'x',
      42,
      [],
      {},
      { sessionId: '' },
      { sessionId: '   ' },
      { sessionId: 42 },
      { id: '' },
      { projections: { values: { title: 'no id' } } },
    ]);
    assert.deepEqual(store.tab('running').map((s) => s.id), ['ok']);
    assert.equal(store.snapshot().items.length, 1);
  });

  it('keeps the id as the title fallback when projections carry no title', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([{ sessionId: 'no-title', running: false, updatedAt: NOW }]);
    const summary = store.get('no-title');
    assert.equal(summary?.state, 'idle');
    assert.equal(summary?.title, 'no-title');
  });

  it('maps a legacy unknown state to idle', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([{ id: 'legacy-weird', state: 'weird', updatedAt: NOW }]);
    assert.equal(store.get('legacy-weird')?.state, 'idle');
  });
});

describe('toEpochMs', () => {
  it('accepts epoch ms, epoch seconds and ISO strings', () => {
    assert.equal(toEpochMs(1_787_000_000_000), 1_787_000_000_000);
    assert.equal(toEpochMs(1_787_000_000), 1_787_000_000_000);
    assert.equal(toEpochMs('2026-11-09T05:00:00Z'), Date.parse('2026-11-09T05:00:00Z'));
    assert.equal(toEpochMs('nope'), null);
  });
});
