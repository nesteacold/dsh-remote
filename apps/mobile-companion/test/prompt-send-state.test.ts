// The per-message send state — the "đang gửi…" defect.
//
// OBSERVED on device (screenshot `s2-prompt.png`): the user's "ping" bubble still read "đang gửi…"
// while the Host was already streaming the turn below it. Cause: `drainOutbox()` called
// `outgoing.prune()` BEFORE reading the outbox, and `prune()` deletes `'acked'` items
// (`src/core/outbox.ts:409-420`) — so `history.confirmPending()` was never reached for a delivered
// prompt and `message.pending` stayed true forever. There was also no safety net.
//
// Covered here: the state machine the bubble renders, and the three clearing/failing paths.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_REQUEST_TIMEOUT_MS } from '../src/core/client';
import { HistoryStore } from '../src/core/history';
import { t } from '../i18n';
import { promptSendLabel, promptSendState } from '../src/ui/prompt-state';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_STATE = readFileSync(path.join(ROOT, 'src', 'app-state.ts'), 'utf8');
const SESSION = readFileSync(path.join(ROOT, 'app', 'session', '[id].tsx'), 'utf8');
const tr = (locale: 'en' | 'vi') => (key: Parameters<typeof t>[1]) => t(locale, key);

const NOW = Date.parse('2026-11-10T12:00:00Z');
const prompt = (over: Partial<{ pending: boolean; failed: string; at: number }> = {}) => ({
  pending: true,
  at: NOW - 1_000,
  ...over,
});

describe('the prompt bubble state machine', () => {
  it('a fresh pending prompt says "sending"', () => {
    assert.equal(promptSendState(prompt(), NOW), 'sending');
    assert.equal(promptSendLabel(prompt(), tr('en'), NOW), 'sending…');
    assert.equal(promptSendLabel(prompt(), tr('vi'), NOW), 'đang gửi…');
  });

  it('a delivered prompt says nothing at all', () => {
    assert.equal(promptSendState({ pending: false, at: NOW }, NOW), null);
    assert.equal(promptSendState({ at: NOW }, NOW), null, 'no pending flag => delivered');
    assert.equal(promptSendLabel({ pending: false, at: NOW }, () => 'NOPE', NOW), null);
  });

  it('a refusal shows the failure WITH its reason, never "sending"', () => {
    const refused = prompt({ pending: false, failed: 'auth/forbidden-scope' });
    assert.equal(promptSendState(refused, NOW), 'failed');
    const label = promptSendLabel(refused, tr('en'), NOW);
    assert.match(label ?? '', /not sent/i);
    assert.match(label ?? '', /auth\/forbidden-scope/, 'the reason is visible');
    assert.notEqual(label, 'sending…');
  });

  it('an unconfirmed prompt stops claiming to send after the EXISTING timeout', () => {
    // No invented number: the deadline is the client's own request timeout.
    const old = prompt({ at: NOW - DEFAULT_REQUEST_TIMEOUT_MS - 1 });
    assert.equal(promptSendState(old, NOW), 'unconfirmed');
    assert.equal(promptSendLabel(old, tr('en'), NOW), 'Not confirmed by the computer');
    assert.equal(promptSendLabel(old, tr('vi'), NOW), 'Máy tính chưa xác nhận');
    // ...and it is still "sending" just before that deadline.
    const young = prompt({ at: NOW - DEFAULT_REQUEST_TIMEOUT_MS + 1 });
    assert.equal(promptSendState(young, NOW), 'sending');
  });
});

describe('the three paths that clear or fail a send', () => {
  it('the receipt path confirms pending prompts (and no longer runs after prune)', () => {
    const store = new HistoryStore();
    store.addPendingPrompt('msg-1', 'ping');
    assert.equal(store.items[0]?.pending, true);
    store.confirmPending('msg-1', { id: 'msg-1', role: 'user', text: 'ping', createdAt: NOW });
    assert.equal(store.items[0]?.pending, false, 'the receipt clears the sending state');
    // Ordering guard: the confirm loop must come BEFORE prune(), which deletes acked items.
    const drain = /private async drainOutbox\(\)[\s\S]*?\n  \}/.exec(APP_STATE)?.[0] ?? '';
    assert.notEqual(drain, '');
    const confirmAt = drain.indexOf('confirmPending');
    const pruneAt = drain.indexOf('this.outgoing.prune()');
    assert.ok(confirmAt > 0 && pruneAt > 0, 'both steps exist');
    assert.ok(confirmAt < pruneAt, 'confirm must run before prune, or acked items are already gone');
  });

  it('a streamed event also clears it (belt-and-braces if a receipt is lost)', () => {
    const store = new HistoryStore();
    store.addPendingPrompt('msg-2', 'ping');
    store.addPendingPrompt('msg-3', 'and again');
    assert.equal(store.confirmAllPending(), 2);
    assert.deepEqual(store.items.map((item) => item.pending), [false, false]);
    // The live-event handler calls it, so the clear does not depend on the receipt alone.
    assert.match(APP_STATE, /this\.history\.confirmAllPending\(\) > 0/, 'the event path clears pending prompts');
    const handlerStart = APP_STATE.indexOf("client.on('event'");
    assert.ok(handlerStart > 0, 'the inbound event handler exists');
    const handler = APP_STATE.slice(handlerStart, handlerStart + 1_200);
    assert.match(handler, /confirmAllPending/, 'it happens on an inbound event');
    assert.match(handler, /openSessionId/, 'only for the open session');
  });

  it('a refused send marks the bubble failed with the code', () => {
    const store = new HistoryStore();
    store.addPendingPrompt('msg-4', 'ping');
    store.markPromptFailed('msg-4', 'session/busy');
    const item = store.items[0];
    assert.ok(item !== undefined);
    assert.equal(item.pending, false, 'it is no longer "sending"');
    assert.equal(item.failed, 'session/busy', 'the reason is kept for the UI');
    // The drain maps outbox failures onto the bubble.
    assert.match(APP_STATE, /markPromptFailed\(item\.clientMsgId, item\.lastError \?\? 'client\/unknown'\)/);
  });

  it('the bubble renders through the helper, not `pending === true`', () => {
    assert.equal(/message\.pending === true/.test(SESSION), false, 'no raw pending check drives the label');
    assert.match(SESSION, /<PromptSendState message=\{message\} \/>/);
    assert.match(SESSION, /promptSendLabel\(message, tr, now\)/);
  });
});
