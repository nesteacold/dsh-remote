// Subagent sessions — the data model and the visibility rules.
//
// MEASURED on the live gateway (packaging, raw frames): `sessions` returned 861 rows and **827 were
// subagents** (`origin: 'subagent'` + `parentSessionId`); 34 were roots. A per-session `models`
// request for a subagent row fails with `{ code: 'session/agent-busy', message: 'subagent Sessions
// require their durable parent address' }` because the gateway's adapter hard-codes a root address
// (`plugins/mobile-gateway/lib/dsh-host-adapter.mjs:367` — read-only for us; a twin task fixes it).
//
// Hence: keep the fields, hide the rows by default (with a way to reveal them), never ask a subagent
// for its model catalog, and never report that failure as a permission problem.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SessionsStore, isSubagentSession } from '../src/core/sessions';
import { modelUnavailableReasonKey } from '../src/ui/components/authoring';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]): string => readFileSync(path.join(ROOT, ...parts), 'utf8');
const HOME = read('app', '(tabs)', 'index.tsx');
const CONVERSATIONS = read('app', '(tabs)', 'conversations.tsx');
const SESSION = read('app', 'session', '[id].tsx');

/** A row exactly as the Host sends it (top-level `origin` / `parentSessionId`). */
function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    running: false,
    updatedAt: Date.parse('2026-11-10T04:00:00Z'),
    projections: { values: { title: 'Session' } },
    ...overrides,
  };
}

describe('session rows carry origin/parentSessionId', () => {
  const store = new SessionsStore({ now: () => Date.parse('2026-11-10T12:00:00Z') });
  store.setAll([
    row({ sessionId: 'root-1', running: true, projections: { values: { title: 'Root task' } } }),
    row({ sessionId: 'sub-1', origin: 'subagent', parentSessionId: 'root-1', projections: { values: { title: 'Child task' } } }),
    row({ sessionId: 'no-origin-1', projections: { values: { title: 'Older host row' } } }),
  ]);
  const items = store.snapshot().items;
  const find = (id: string) => items.find((item) => item.id === id);

  it('keeps every row in the store: hiding is a render-time decision, never a deletion', () => {
    assert.equal(items.length, 3, 'subagent rows are kept, not dropped by the store');
  });

  it('parses origin and parentSessionId', () => {
    const sub = find('sub-1');
    assert.ok(sub !== undefined);
    assert.equal(sub.origin, 'subagent');
    assert.equal(sub.parentSessionId, 'root-1');
    assert.equal(isSubagentSession(sub), true);
  });

  it('leaves an absent origin ABSENT — a root is never invented', () => {
    const root = find('root-1');
    const older = find('no-origin-1');
    assert.ok(root !== undefined && older !== undefined);
    assert.equal('origin' in root, false, 'no origin reported => no origin stored');
    assert.equal('parentSessionId' in older, false);
    assert.equal(isSubagentSession(root), false);
    assert.equal(isSubagentSession(older), false, 'unknown origin is not treated as a subagent');
  });
});

describe('both lists hide subagents but keep a way to reveal them', () => {
  for (const [name, source] of [['workspace home', HOME], ['conversations', CONVERSATIONS]] as const) {
    it(`${name}: filters subagent rows at render time`, () => {
      assert.match(source, /showSubagents \|\| !isSubagentSession\(session\)/, `${name} hides subagents by default`);
      assert.match(source, /home\.showSubagents/, `${name} offers the reveal affordance`);
      assert.match(source, /home\.hideSubagents/, `${name} can hide them again`);
      // Nothing is deleted or mutated: the only transformation is a filter over the snapshot.
      assert.equal(/sessions\s*=\s*\[/.test(source), false, `${name} must not rewrite the session list`);
    });
  }
});

describe('a subagent session is not asked for its model catalog', () => {
  it('skips the request and shows one honest line instead of a pill', () => {
    assert.match(SESSION, /const subagentSession = sessionSummary !== null && isSubagentSession\(sessionSummary\)/);
    assert.match(SESSION, /if \(subagentSession\) return;/, 'the models request is not sent for a subagent');
    assert.match(SESSION, /authoring\.modelSubagent/, 'the limitation is explained, not silent');
  });
});

describe('models failures are classified, never guessed', () => {
  it('maps the measured subagent frame to the subagent message, not a permission message', () => {
    // The exact code from the captured frame: `{kind:'error', code:'session/agent-busy', ...}`.
    assert.equal(modelUnavailableReasonKey('session/agent-busy'), 'authoring.modelSubagent');
    assert.notEqual(modelUnavailableReasonKey('session/agent-busy'), 'authoring.needScope');
  });

  it('still reports a real scope refusal as a scope refusal', () => {
    assert.equal(modelUnavailableReasonKey('auth/forbidden-scope'), 'authoring.needScope');
    assert.equal(modelUnavailableReasonKey('op/forbidden'), 'authoring.needScope');
  });

  it('falls back to the generic message for transport and unknown failures', () => {
    for (const code of ['client/timeout', 'client/disconnected', 'internal', null]) {
      assert.equal(modelUnavailableReasonKey(code), 'authoring.modelsUnavailable', String(code));
    }
  });
});
