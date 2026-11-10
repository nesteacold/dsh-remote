// History store tests (contract §4 `history`): paging, dedupe by id/seq, and the optimistic
// prompt row that is replaced when the host echoes our clientMsgId.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HistoryStore, coerceHistoryMessage } from '../src/core/history';

const NOW = Date.parse('2026-11-09T06:00:00Z');
const now = () => NOW;

describe('HistoryStore', () => {
  it('loads a page ordered by seq', () => {
    const store = new HistoryStore({ now });
    store.setPage([
      { seq: 2, id: 'm2', role: 'assistant', text: 'two' },
      { seq: 1, id: 'm1', role: 'user', text: 'one' },
    ]);
    assert.deepEqual(store.items.map((m) => m.id), ['m1', 'm2']);
  });

  it('prepends an older page without duplicating overlapping rows', () => {
    const store = new HistoryStore({ now });
    store.setPage([{ seq: 5, id: 'm5', role: 'user', text: 'five' }], { hasMore: true });
    store.prependPage([
      { seq: 4, id: 'm4', role: 'user', text: 'four' },
      { seq: 5, id: 'm5', role: 'user', text: 'five' }, // overlap
    ]);
    assert.deepEqual(store.items.map((m) => m.id), ['m4', 'm5']);
  });

  it('appends live messages idempotently (same id or seq is ignored)', () => {
    const store = new HistoryStore({ now });
    store.setPage([{ seq: 1, id: 'm1', role: 'user', text: 'one' }]);
    assert.notEqual(store.append({ seq: 2, id: 'm2', role: 'assistant', text: 'two' }), null);
    assert.equal(store.append({ seq: 2, id: 'm2', role: 'assistant', text: 'two' }), null);
    assert.equal(store.append({ seq: 2, id: 'other', role: 'assistant', text: 'dup seq' }), null);
    assert.equal(store.append({ seq: 3, id: 'm2', role: 'assistant', text: 'dup id' }), null);
    assert.equal(store.items.length, 2);
  });

  it('shows an optimistic prompt and replaces it when the host echoes the clientMsgId', () => {
    const store = new HistoryStore({ now });
    store.setPage([{ seq: 1, id: 'm1', role: 'user', text: 'one' }]);
    const pending = store.addPendingPrompt('cmsg-1', 'continue');
    assert.equal(pending.pending, true);
    assert.equal(pending.at, NOW);
    assert.equal(store.items.at(-1)?.id, 'cmsg-1');

    store.confirmPending('cmsg-1', { seq: 7, id: 'm7', role: 'user', text: 'continue', createdAt: NOW + 5_000 });
    const confirmed = store.items.find((m) => m.seq === 7);
    assert.equal(confirmed?.id, 'm7');
    assert.equal(confirmed?.pending, false);
    assert.equal(store.items.some((m) => m.id === 'cmsg-1'), false);
  });

  it('does not add the same pending prompt twice', () => {
    const store = new HistoryStore({ now });
    const first = store.addPendingPrompt('cmsg-1', 'x');
    const second = store.addPendingPrompt('cmsg-1', 'x');
    assert.equal(first, second);
    assert.equal(store.items.length, 1);
  });

  it('reports the paging cursors', () => {
    const store = new HistoryStore({ now });
    store.setPage([{ seq: 10, id: 'a', role: 'user', text: 'ten' }, { seq: 11, id: 'b', role: 'user', text: 'eleven' }], { hasMore: true });
    assert.equal(store.page.hasMore, true);
    // The next older page is requested with the lowest seq currently loaded.
    assert.equal(store.page.nextBeforeSeq, 10);
    store.prependPage([{ seq: 9, id: 'z', role: 'user', text: 'nine' }], { hasMore: false });
    assert.equal(store.page.nextBeforeSeq, 9);
    assert.equal(store.page.hasMore, false);
  });

  it('clear() empties the transcript', () => {
    const store = new HistoryStore({ now });
    store.setPage([{ seq: 1, id: 'a' }]);
    store.clear();
    assert.equal(store.items.length, 0);
    assert.equal(store.page.hasMore, false);
  });
});

describe('coerceHistoryMessage', () => {
  it('accepts host content parts, string content and plain text', () => {
    assert.equal(coerceHistoryMessage({ seq: 1, role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, 0)?.text, 'a\nb');
    assert.equal(coerceHistoryMessage({ seq: 2, role: 'user', content: 'hi' }, 0)?.text, 'hi');
    assert.equal(coerceHistoryMessage({ seq: 3, role: 'user', text: 'yo' }, 0)?.text, 'yo');
  });

  it('derives a stable id when the host sends none', () => {
    assert.equal(coerceHistoryMessage({ seq: 4, role: 'user', text: 'x' }, 0)?.id, 'seq-4');
    assert.equal(coerceHistoryMessage({ role: 'user', text: 'x' }, 9)?.id, 'index-9');
  });

  it('maps unknown roles to other and drops rows with neither role nor text', () => {
    assert.equal(coerceHistoryMessage({ seq: 1, role: 'weird', text: 'x' }, 0)?.role, 'other');
    assert.equal(coerceHistoryMessage(null, 0), null);
    assert.equal(coerceHistoryMessage({}, 0), null);
  });
});
