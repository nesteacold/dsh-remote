// Maestro hook guard — the app-side `testID`s the device flows (e2e/maestro) are meant to address.
//
// There is no component renderer in this repo (no react-test-renderer), so this is a **source**
// test: it reads the three screens and asserts the hooks the flow proposal in
// `e2e/README.md` §"Test hooks required before this is fully automated" asks for. It exists so a
// refactor cannot silently drop a hook (which would put the flows back on placeholder/hint taps)
// and so a hook cannot start embedding free text.
//
// What it enforces:
//   * the exact proposed hook set, per file, with the number of occurrences each is rendered at
//     (e.g. `approval-state-<id>` is rendered once per state branch);
//   * dynamic IDs are built only from stable identifiers — the tab value, the session id and the
//     approval id — never from the composer draft, the search query, a session title, the
//     approval preview/notice, or an error string. A `testID` ends up in the accessibility tree
//     and in flow logs, so a prompt or a pairing-code fragment must never reach it (FR-011);
//   * static IDs stay lowercase ASCII with no spaces, which both Maestro and the platform
//     accessibility bridges match literally; and
//   * the banner hooks keep a localized `accessibilityLabel` instead of a hard-coded copy.
//
// Dynamic IDs are host data (`sess-alpha`, `apv-hash` from the fixture). Maestro treats `id`
// selectors as regular expressions, so a flow must escape an opaque id before using it in
// `id: "approval-approve-<escaped>"`; the fixture ids are hyphen-only, which is regex-safe.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const PAIR = path.join(APP_DIR, 'pair.tsx');
// Spec 011 P1-A: the session list moved from `app/index.tsx` to the Conversations tab
// (`app/(tabs)/conversations.tsx`) when the app gained the bottom tab bar. The guard set is
// unchanged — same hooks, same counts — only the file it reads moved with the screen.
const INDEX = path.join(APP_DIR, '(tabs)', 'conversations.tsx');
const SESSION = path.join(APP_DIR, 'session', '[id].tsx');

/** Every `testID="…"` / `testID={`…`}` literal in a source file, in source order. */
function hooks(source: string): string[] {
  const found: string[] = [];
  const pattern = /testID=(?:"([^"]+)"|\{`([^`]+)`\})/g;
  for (const match of source.matchAll(pattern)) found.push(match[1] ?? match[2] ?? '');
  return found;
}

function count(ids: string[], id: string): number {
  return ids.filter((entry) => entry === id).length;
}

/** The dynamic hooks the flows are allowed to depend on, and what the variable must be. */
const DYNAMIC_HOOKS = new Map<string, string>([
  ['sessions-tab-${entry.tab}', 'a SessionTab value (running | idle | archived)'],
  ['session-row-${session.id}', 'a host session id'],
  ['approval-card-${card.approvalId}', 'a host approval id'],
  ['approval-state-${card.approvalId}', 'a host approval id'],
  ['approval-approve-${card.approvalId}', 'a host approval id'],
  ['approval-reject-${card.approvalId}', 'a host approval id'],
]);

describe('pair screen hooks', () => {
  const ids = hooks(readFileSync(PAIR, 'utf8'));

  it('exposes the paste field and the submit button the pair-paste subflow needs', () => {
    assert.equal(count(ids, 'pair-manual-input'), 1);
    assert.equal(count(ids, 'pair-submit'), 1);
    assert.deepEqual(ids.toSorted(), ['pair-manual-input', 'pair-submit']);
  });
});

describe('session list hooks', () => {
  const source = readFileSync(INDEX, 'utf8');
  const ids = hooks(source);

  it('exposes a hook per tab so selection does not depend on the locale', () => {
    assert.equal(count(ids, 'sessions-tab-${entry.tab}'), 1);
  });

  it('exposes a hook per row keyed by the session id', () => {
    assert.equal(count(ids, 'session-row-${session.id}'), 1);
  });

  it('marks the banner and keeps its localized accessibility label', () => {
    assert.equal(count(ids, 'banner'), 1);
    assert.match(source, /testID="banner"\s+accessibilityLabel=\{banner\}/);
  });
});

describe('session screen hooks', () => {
  const source = readFileSync(SESSION, 'utf8');
  const ids = hooks(source);

  it('exposes the composer and send button', () => {
    assert.equal(count(ids, 'session-composer'), 1);
    assert.equal(count(ids, 'session-send'), 1);
  });

  it('exposes per-card, per-decision and per-state hooks keyed by the approval id', () => {
    assert.equal(count(ids, 'approval-card-${card.approvalId}'), 1);
    assert.equal(count(ids, 'approval-approve-${card.approvalId}'), 1);
    assert.equal(count(ids, 'approval-reject-${card.approvalId}'), 1);
    // decide-on-computer | review-again | already-decided | resolved
    assert.equal(count(ids, 'approval-state-${card.approvalId}'), 4);
  });

  it('marks the banner and keeps its localized accessibility label', () => {
    assert.equal(count(ids, 'banner'), 1);
    assert.match(source, /testID="banner"\s+accessibilityLabel=\{banner\}/);
  });
});

describe('hook shape', () => {
  const sources = [PAIR, INDEX, SESSION].map((file) => ({ file, ids: hooks(readFileSync(file, 'utf8')) }));

  it('never derives a hook from free text (prompt, draft, search query, title, preview, notice)', () => {
    const forbidden = /(manual|text|query|title|preview|notice|lastError|toolName|banner\b)/;
    for (const { file, ids } of sources) {
      for (const id of ids) {
        if (!id.includes('${')) continue;
        assert.ok(DYNAMIC_HOOKS.has(id), `${path.relative(APP_DIR, file)}: unexpected dynamic hook ${id}`);
        const expression = id.slice(id.indexOf('${') + 2, -1);
        assert.ok(!forbidden.test(expression), `${path.relative(APP_DIR, file)}: hook ${id} embeds free text`);
      }
    }
  });

  it('keeps static hooks lowercase ASCII without whitespace (Maestro/accessibility safe)', () => {
    for (const { file, ids } of sources) {
      for (const id of ids) {
        if (id.includes('${')) continue;
        assert.match(id, /^[a-z][a-z0-9-]*$/, `${path.relative(APP_DIR, file)}: hook ${id} is not a safe literal`);
      }
    }
  });

  it('keeps the pair screen free of dynamic hooks (the code itself is never an id)', () => {
    assert.deepEqual(hooks(readFileSync(PAIR, 'utf8')).filter((id) => id.includes('${')), []);
  });
});
