// Older-history paging — the "Load earlier messages" dead control, on device.
//
// OBSERVED (live gateway, real ROOT session): the conversation showed a "Load earlier messages"
// button above "No messages yet."; tapping it changed nothing at all.
//
// CAUSE (file:line): the gateway emits `nextBeforeSeq` only when it knows the oldest seq
// (`plugins/mobile-gateway/lib/index.mjs:1412`), but it can still report `hasMore: true` with an empty
// page. `loadOlderHistory` then sent `{ sessionId }` with NO cursor (`src/app-state.ts:1254-1257` before
// this fix), so the Host re-served the SAME opening page: `prependPage` received no new messages and
// `hasMore` stayed true — a button that could never change anything.
//
// The affordance is now driven by the CURSOR (`historyHasEarlier = hasMore && nextBeforeSeq !== null`),
// an empty reply clears it, a failure is shown as one muted line, and an in-flight load is locked.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HistoryStore } from '../src/core/history';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION = readFileSync(path.join(ROOT, 'app', 'session', '[id].tsx'), 'utf8');

/** One wire-shaped history message. */
const message = (seq: number) => ({ seq, role: 'assistant', text: `m${seq}` });

/** The snapshot derivation, mirroring `AppState.snapshot()` exactly. */
const hasEarlier = (page: { hasMore: boolean; nextBeforeSeq: number | null }): boolean =>
  page.hasMore && page.nextBeforeSeq !== null;

describe('the affordance follows the cursor, not just `hasMore`', () => {
  it('a session with no earlier history offers nothing', () => {
    const store = new HistoryStore();
    store.setPage([message(5)], { hasMore: false });
    assert.equal(hasEarlier(store.page), false);
  });

  it('`hasMore` with NO cursor cannot be paged, so it offers nothing (the dead-tap case)', () => {
    const store = new HistoryStore();
    // An empty page with hasMore true is exactly what the device showed: "No messages yet." + button.
    store.setPage([], { hasMore: true });
    assert.equal(store.page.hasMore, true, 'the wire did report more');
    assert.equal(store.page.nextBeforeSeq, null, 'but there was no cursor to page with');
    assert.equal(hasEarlier(store.page), false, 'so no control is rendered');
  });

  it('reported older history WITH a cursor offers the control', () => {
    const store = new HistoryStore();
    store.setPage([message(5), message(6)], { hasMore: true });
    assert.notEqual(store.page.nextBeforeSeq, null);
    assert.equal(hasEarlier(store.page), true);
  });

  it('an empty older page removes the control for that session', () => {
    const store = new HistoryStore();
    store.setPage([message(5)], { hasMore: true });
    assert.equal(hasEarlier(store.page), true);
    // What `loadOlderHistory` does when the reply brings nothing back.
    store.prependPage([], { hasMore: false });
    assert.equal(hasEarlier(store.page), false, 'nothing older => no affordance to tap again');
  });
});

describe('the controller never sends a pointless history request', () => {
  it('returns before the request when there is no cursor', () => {
    // The guard is what kills the dead tap; without it the request re-serves the same page.
    assert.match(SESSION, /snapshot\.historyHasEarlier/, 'the screen gates on the cursor-derived flag');
    const source = readFileSync(path.join(ROOT, 'src', 'app-state.ts'), 'utf8');
    assert.match(source, /if \(beforeSeq === null\) \{/, 'the no-cursor case is handled explicitly');
    assert.match(source, /prependPage\(\[\], \{ hasMore: false \}\)/, 'nothing loadable => the affordance goes away');
  });

  it('locks the control while a load is in flight (no double request)', () => {
    const source = readFileSync(path.join(ROOT, 'src', 'app-state.ts'), 'utf8');
    assert.match(source, /if \(this\.historyLoad\.loading\) return;/, 'a second tap cannot queue another request');
    assert.match(source, /if \(!page\.hasMore\) return;/);
    assert.match(SESSION, /disabled=\{snapshot\.historyLoading\}/, 'the button is disabled while loading');
    assert.match(SESSION, /accessibilityState=\{\{ busy: snapshot\.historyLoading, disabled: snapshot\.historyLoading \}\}/);
  });

  it('explains a failure instead of swallowing it', () => {
    const source = readFileSync(path.join(ROOT, 'src', 'app-state.ts'), 'utf8');
    assert.match(source, /this\.historyLoad = \{ loading: false, error: authoringErrorCode\(error\) \}/);
    assert.match(SESSION, /snapshot\.historyError === null \? null :/, 'one honest line is rendered');
    assert.match(SESSION, /tr\('session\.historyFailed'\)/);
  });

  it('never keeps advertising more after an empty page', () => {
    const source = readFileSync(path.join(ROOT, 'src', 'app-state.ts'), 'utf8');
    assert.match(source, /hasMore: answer\.hasMore === true && arrived > 0/);
  });
});
