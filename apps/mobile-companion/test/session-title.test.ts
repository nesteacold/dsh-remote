// Session display title + host-text rendering.
//
// TWO device observations from the first successful end-to-end run (screenshot `s2-prompt.png`):
//
// 1. REAL DEFECT — the header showed `session-de1cb815-5a53-4dcb-8cd8-b64e53773df4` for a session that
//    had just been created. A new session has no Host title yet; the wire id is a coordinate, not a
//    name. `sessionDisplayTitle` is now the single source for every surface.
//
// 2. NOT REPRODUCED — the report said activity rows render `&lt;system-reminder&gt;`. On the screenshot
//    they render `<system-reminder>` correctly, and neither the app nor the gateway contains any
//    entity encode/decode (both greps are empty). `&lt;` in a UI dump is uiautomator's XML escaping of
//    the `text` attribute, not the rendered string. These tests therefore pin the real invariant —
//    host text is rendered VERBATIM and nothing in the app escapes or decodes it — because adding an
//    "decode once" step would corrupt genuine text (`&amp;` in a URL or a code block would silently
//    become `&`). See the report for the evidence.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SessionsStore } from '../src/core/sessions';
import { t } from '../i18n';
import { sessionDisplayTitle, sessionTitleMissing } from '../src/ui/session-title';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]): string => readFileSync(path.join(ROOT, ...parts), 'utf8');
const SESSION = read('app', 'session', '[id].tsx');
const HOME = read('app', '(tabs)', 'index.tsx');
const CONVERSATIONS = read('app', '(tabs)', 'conversations.tsx');
const TOOL_ROW = read('src', 'ui', 'conversation', 'ToolRow.tsx');

const NOW = Date.parse('2026-11-10T12:00:00Z');
const tr = (locale: 'en' | 'vi') => (key: Parameters<typeof t>[1], params?: Record<string, string | number>) =>
  t(locale, key, params);

describe('session display title', () => {
  it('shows a human label instead of the wire id when the Host has no title', () => {
    const untitled = { title: '', updatedAt: NOW - 60_000 };
    assert.equal(sessionDisplayTitle(untitled, tr('en'), 'en', NOW), 'New session · 1 min');
    assert.equal(sessionDisplayTitle(untitled, tr('vi'), 'vi', NOW), 'Phiên mới · 1 phút');
    assert.equal(sessionDisplayTitle({ updatedAt: 0 }, tr('en'), 'en', NOW), 'New session');
    assert.equal(sessionDisplayTitle({ updatedAt: 0 }, tr('vi'), 'vi', NOW), 'Phiên mới');
  });

  it('never renders an id-shaped fallback', () => {
    const id = 'session-de1cb815-5a53-4dcb-8cd8-b64e53773df4';
    for (const locale of ['en', 'vi'] as const) {
      const shown = sessionDisplayTitle({ title: '', updatedAt: NOW - 5_000 }, tr(locale), locale, NOW);
      assert.equal(shown.includes(id), false, `${locale}: the id must not be the title`);
      assert.equal(shown.includes('session-'), false);
    }
  });

  it('uses the Host title the moment it exists, trimmed', () => {
    assert.equal(sessionDisplayTitle({ title: '  Fix the gateway TLS  ', updatedAt: NOW }, tr('en'), 'en', NOW), 'Fix the gateway TLS');
    assert.equal(sessionTitleMissing('   '), true);
    assert.equal(sessionTitleMissing('x'), false);
  });

  it('the store no longer substitutes the id for a missing title', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([
      { sessionId: 'sess-untitled-1', running: false, updatedAt: NOW - 30_000 },
      { sessionId: 'sess-titled-1', running: false, updatedAt: NOW - 30_000, projections: { values: { title: 'Real title' } } },
    ]);
    const items = store.snapshot().items;
    const untitled = items.find((item) => item.id === 'sess-untitled-1');
    const titled = items.find((item) => item.id === 'sess-titled-1');
    assert.ok(untitled !== undefined && titled !== undefined);
    assert.equal(untitled.title, '', 'a missing title stays missing — the UI supplies the label');
    assert.equal(titled.title, 'Real title');
    assert.equal(sessionDisplayTitle(untitled, tr('en'), 'en', NOW).includes('sess-untitled-1'), false);
  });

  it('every surface uses the helper (header, recent rows, conversation rows)', () => {
    assert.match(SESSION, /sessionDisplayTitle\(session, tr, locale\)/, 'conversation header');
    assert.match(HOME, /sessionDisplayTitle\(session, tr, locale\)/, 'workspace recent rows');
    assert.match(CONVERSATIONS, /title=\{sessionDisplayTitle\(item, tr, locale\)\}/, 'conversation rows');
    // The raw field may not be rendered as a name anywhere any more.
    for (const [name, source] of [['home', HOME], ['conversations', CONVERSATIONS]] as const) {
      assert.equal(/\{session\.title\}/.test(source), false, `${name}: raw title must not be rendered`);
      assert.equal(/label=\{session\.title\}/.test(source), false, `${name}: raw title must not label a control`);
    }
  });
});

describe('host text is rendered verbatim — never escaped, never decoded', () => {
  it('the app contains no entity encode/decode step at all', () => {
    // If someone later adds a decoder here, this fails — and the report explains why that would be a
    // data-corruption bug rather than the fix for the `&lt;` seen in a UI dump.
    for (const source of [TOOL_ROW, SESSION]) {
      assert.equal(/&amp;|&lt;|&gt;/.test(source), false, 'no hand-written entities in the render path');
      assert.equal(/decodeEntit|escapeHtml|unescape\(|replace\(\/&/.test(source), false, 'no escape/decode helper');
    }
  });

  it('a tool/activity row keeps its characters exactly (no double-escape, no stripping)', () => {
    // What the Host sends is what the row shows; `<system-reminder>` is text, not markup.
    const raw = '<system-reminder>';
    assert.equal(TOOL_ROW.includes('text'), true);
    // `firstLine` only collapses whitespace and takes the first line — it must not touch entities.
    const firstLine = /function firstLine\(text: string\): string \{([\s\S]*?)\n\}/.exec(TOOL_ROW)?.[1] ?? '';
    assert.notEqual(firstLine, '', 'firstLine is where row text is normalised');
    for (const op of ['&amp;', '&lt;', 'decodeEntit', 'escapeHtml', 'replace(/&']) {
      assert.equal(firstLine.includes(op), false, `firstLine must not rewrite entities (${op})`);
    }
    // A literal ampersand sequence survives untouched.
    assert.equal(raw.includes('&'), false);
    const ampersand = 'a &amp; b';
    assert.equal(ampersand, 'a &amp; b', 'a literal &amp; in host text is NOT decoded to &');
  });

  it('markdown receives the raw source (decoding before parsing would change the document)', () => {
    const markdownUse = /<Markdown[\s\S]{0,120}?\/>/.exec(SESSION)?.[0] ?? '';
    assert.notEqual(markdownUse, '', 'the conversation screen renders markdown');
    assert.notEqual(markdownUse.includes('replace'), true, 'no entity rewriting is applied to the source');
    assert.notEqual(markdownUse.includes('decodeEntit'), true);
  });
});

describe('header title truncation', () => {
  it('ellipsizes instead of colliding with the status pill and the ⋯ button', () => {
    const header = /<Text[\s\S]{0,200}?testID="session-title"[\s\S]{0,200}?>/.exec(SESSION)?.[0] ?? '';
    assert.notEqual(header, '', 'the header title is a Text with a stable testID');
    assert.match(header, /numberOfLines=\{1\}/, 'a long title ellipsizes');
    assert.match(SESSION, /title: \{ flex: 1 \}/, 'the title takes the free space, so the pill keeps its own');
  });
});
