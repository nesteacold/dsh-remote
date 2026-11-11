// Spec 011 (mobile session authoring) — pure behaviour of the authoring UI helpers.
//
// These are the decisions that must be right *before* any wiring lands, because they are the ones a
// user sees: when "New session" is enabled, which reason is shown when it is not, and how a
// workspace is labelled. Two of them encode explicit product rules from the lead:
//   * an empty `grantedScopes` is UNKNOWN, never "you lack permission" (older gateways report none);
//   * `ready` with zero workspaces is a normal empty state, not an error.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { reconnectInProgress } from '../src/app-state';
import {
  AUTHORING_SCOPE,
  composerModelLabel,
  grantState,
  newSessionAvailability,
  shouldShowModelPill,
  workspaceDetail,
  workspaceLabel,
  type LoadState,
  type WorkspaceItem,
} from '../src/ui/components/authoring';
import { LOCALES, MESSAGE_KEYS, t } from '../i18n';

const READY: LoadState = { status: 'ready' };

describe('grantState — device scopes from hello.device.scopes', () => {
  it('treats an empty list as UNKNOWN, not denied (older gateway reports no scopes)', () => {
    assert.equal(grantState([]), 'unknown');
  });

  it('is granted only when sessions:author is present', () => {
    assert.equal(grantState([AUTHORING_SCOPE]), 'granted');
    assert.equal(grantState(['sessions:read', AUTHORING_SCOPE, 'prompt:send']), 'granted');
  });

  it('is denied when the host reported scopes that do not include authoring', () => {
    assert.equal(grantState(['sessions:read', 'prompt:send']), 'denied');
  });
});

describe('newSessionAvailability — why the primary action is enabled or not', () => {
  const granted = [AUTHORING_SCOPE];

  it('enables only with the grant, a loaded list and a chosen workspace', () => {
    assert.deepEqual(
      newSessionAvailability({ grantedScopes: granted, workspaceId: 'ws-1', state: READY, workspaceCount: 2 }),
      { enabled: true, reason: null },
    );
  });

  it('shows the NEUTRAL reason when the grant is unknown, never the denial copy', () => {
    const result = newSessionAvailability({ grantedScopes: [], workspaceId: 'ws-1', state: READY, workspaceCount: 2 });
    assert.equal(result.enabled, false);
    assert.equal(result.reason, 'authoring.scopeUnknown');
    assert.notEqual(result.reason, 'authoring.needScope');
  });

  it('shows the denial reason when the host reported scopes without authoring', () => {
    const result = newSessionAvailability({ grantedScopes: ['sessions:read'], workspaceId: 'ws-1', state: READY, workspaceCount: 2 });
    assert.deepEqual(result, { enabled: false, reason: 'authoring.needScope' });
  });

  it('treats ready-with-no-workspaces as empty, not as an error', () => {
    const empty = newSessionAvailability({ grantedScopes: granted, workspaceId: null, state: READY, workspaceCount: 0 });
    assert.deepEqual(empty, { enabled: false, reason: 'authoring.workspacesEmpty' });
  });

  it('asks for a workspace once the list is ready and non-empty', () => {
    assert.deepEqual(
      newSessionAvailability({ grantedScopes: granted, workspaceId: null, state: READY, workspaceCount: 3 }),
      { enabled: false, reason: 'authoring.needWorkspace' },
    );
  });

  it('reports loading and error states distinctly', () => {
    assert.equal(
      newSessionAvailability({ grantedScopes: granted, workspaceId: null, state: { status: 'loading' } }).reason,
      'authoring.loadingWorkspaces',
    );
    assert.equal(
      newSessionAvailability({ grantedScopes: granted, workspaceId: null, state: { status: 'error', code: 'net' } }).reason,
      'authoring.workspacesError',
    );
  });

  it('disables without a reason while a create is in flight (the button shows its own spinner)', () => {
    assert.deepEqual(
      newSessionAvailability({ grantedScopes: granted, workspaceId: 'ws-1', state: READY, workspaceCount: 2, busy: true }),
      { enabled: false, reason: null },
    );
  });
});

describe('workspace labels', () => {
  it('prefers the host name, falls back to the last path segment, then the id', () => {
    assert.equal(workspaceLabel({ id: 'w1', name: 'DiskTree', path: '/src/DiskTree' }), 'DiskTree');
    assert.equal(workspaceLabel({ id: 'w2', path: '/home/me/DXVK_Project' }), 'DXVK_Project');
    assert.equal(workspaceLabel({ id: 'w3' }), 'w3');
    assert.equal(workspaceLabel({ id: 'w4', name: '   ' }), 'w4');
  });

  it('shows the path as a secondary line only when it adds information', () => {
    const item: WorkspaceItem = { id: 'w1', name: 'DiskTree', path: '/src/DiskTree' };
    assert.equal(workspaceDetail(item), '/src/DiskTree');
    assert.equal(workspaceDetail({ id: 'w2', name: 'notes', path: '/x/notes' }), '/x/notes');
    assert.equal(workspaceDetail({ id: 'w3' }), null);
    // path's last segment equals the name: repeating it under the row is noise.
    assert.equal(workspaceDetail({ id: 'w4', path: '/src/DXVK_Project' }), '/src/DXVK_Project');
  });
});

describe('authoring copy exists in every locale', () => {
  it('covers the keys the components can show', () => {
    const keys = [
      'authoring.scopeUnknown',
      'authoring.needScope',
      'authoring.needWorkspace',
      'authoring.loadingWorkspaces',
      'authoring.workspacesError',
      'authoring.workspacesEmpty',
      'authoring.newSession',
      'authoring.mode',
      'authoring.model',
    ] as const;
    for (const key of keys) {
      assert.ok(MESSAGE_KEYS.includes(key), `message key ${key} is declared`);
      for (const locale of LOCALES) {
        assert.ok(t(locale, key).trim() !== '', `${locale}: ${key} is not empty`);
      }
    }
  });

  it('never phrases the unknown-permission state as a missing permission', () => {
    for (const locale of LOCALES) {
      const neutral = t(locale, 'authoring.scopeUnknown').toLowerCase();
      const denied = t(locale, 'authoring.needScope').toLowerCase();
      assert.notEqual(neutral, denied, `${locale}: unknown and denied must read differently`);
    }
    // English wording guard: the neutral line talks about reporting, not about the user lacking it.
    assert.match(t('en', 'authoring.scopeUnknown'), /did not report/i);
    assert.match(t('en', 'authoring.needScope'), /not granted/i);
  });
});

// Device defect (Vietnamese/light review): during the first seconds after launch the home screen
// accused the computer — "Máy tính này không báo quyền của thiết bị…" — while the socket was simply
// still connecting. Connection state must be reported before any permission claim can be made.
describe('connection state is reported before any permission claim', () => {
  const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const base = {
    grantedScopes: [] as string[],
    workspaceId: null,
    state: { status: 'idle' } as LoadState,
  };

  it('every not-ready socket says "connecting", never the scope accusation', () => {
    for (const connection of ['idle', 'connecting', 'waiting-hello', 'waiting-client-hello', 'closed', 'revoked'] as const) {
      const availability = newSessionAvailability({ ...base, connection });
      assert.deepEqual(availability, { enabled: false, reason: 'authoring.connecting' }, `connection=${connection}`);
      assert.notEqual(availability.reason, 'authoring.scopeUnknown');
    }
  });

  it('a reconnect in progress says "reconnecting" (only while not ready)', () => {
    assert.deepEqual(
      newSessionAvailability({ ...base, connection: 'connecting', reconnecting: true }),
      { enabled: false, reason: 'authoring.reconnecting' },
    );
  });

  it('only a READY socket with no reported scopes reaches scopeUnknown', () => {
    assert.deepEqual(
      newSessionAvailability({ ...base, connection: 'ready' }),
      { enabled: false, reason: 'authoring.scopeUnknown' },
    );
  });

  it('a STALE reconnect flag cannot disable the action while the socket is ready', () => {
    // Measured device bug: `snapshot.reconnect !== null` was true for a HEALTHY connection (it reports
    // the existence of the reconnector object, not an in-progress reconnect), so the primary action
    // stayed disabled forever while the session list kept updating. `ready` must win.
    const availability = newSessionAvailability({
      grantedScopes: ['sessions:author'],
      workspaceId: 'ws-1',
      state: { status: 'ready' },
      workspaceCount: 1,
      connection: 'ready',
      reconnecting: true, // stale leftover
    });
    assert.deepEqual(availability, { enabled: true, reason: null }, 'the action stays enabled');
    assert.notEqual(availability.reason, 'authoring.reconnecting');
  });

  it('the reconnect copy is unreachable while ready', () => {
    for (const grantedScopes of [[], ['sessions:author']] as string[][]) {
      const { reason } = newSessionAvailability({
        grantedScopes,
        workspaceId: null,
        state: { status: 'idle' },
        connection: 'ready',
        reconnecting: true,
      });
      assert.notEqual(reason, 'authoring.reconnecting', 'never the reconnect copy on a ready socket');
    }
  });

  it('a ready socket that reported the scope is grantable', () => {
    assert.deepEqual(
      newSessionAvailability({
        grantedScopes: ['sessions:author'],
        workspaceId: 'ws-1',
        state: { status: 'ready' },
        workspaceCount: 1,
        connection: 'ready',
      }),
      { enabled: true, reason: null },
    );
  });

  it('the home screen asks the loop STATE, not non-nullness', () => {
    const home = readFileSync(path.join(APP_ROOT, 'app', '(tabs)', 'index.tsx'), 'utf8');
    assert.match(home, /reconnecting: reconnectInProgress\(snapshot\.reconnect\)/);
    assert.equal(/reconnecting: snapshot\.reconnect !== null/.test(home), false, 'non-nullness is not a reconnect');
  });

  it('reconnectInProgress: live is healthy, anything else is a reconnect', () => {
    assert.equal(reconnectInProgress(null), false, 'no loop => not reconnecting');
    assert.equal(reconnectInProgress({ state: 'live' }), false, 'live = watching a healthy socket');
    for (const state of ['waiting', 'connecting', 'idle', 'stopped']) {
      assert.equal(reconnectInProgress({ state }), true, `${state} is a reconnect`);
    }
  });

  it('the home screen passes the live connection state (not a hard-coded assumption)', () => {
    const home = readFileSync(path.join(APP_ROOT, 'app', '(tabs)', 'index.tsx'), 'utf8');
    assert.match(home, /connection: snapshot\.connection/);
    // "no sessions yet" may only appear for an empty list from a ready socket.
    assert.match(home, /recent\.length === 0 && \(snapshot\.connection !== 'ready' \|\| snapshot\.loading\)/);
  });
});
// two pills whose text was literally "Mode" and "Model" — the row used the i18n LABEL as the VALUE
// (`props.modeLabel ?? props.labels.mode`, `props.currentModel?.label ?? props.labels.model`). A
// label is never a value, so the row is now data-only and the mode pill is gone entirely.
describe('composer leading row — every pill text comes from data', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const AUTHORING = readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'authoring.tsx'), 'utf8');
  const SESSION = readFileSync(path.join(ROOT, 'app', 'session', '[id].tsx'), 'utf8');

  it('renders the model label from data, never the i18n noun', () => {
    assert.equal(composerModelLabel(null), null);
    assert.equal(composerModelLabel({ id: 'deepseek-v4-flash' }), 'deepseek-v4-flash');
    assert.equal(composerModelLabel({ id: 'm-1', label: 'DeepSeek-V4-Flash' }), 'DeepSeek-V4-Flash');
    assert.equal(composerModelLabel({ id: 'm-1', label: '   ' }), 'm-1', 'a blank label falls back to the id');
    assert.equal(composerModelLabel({ id: '' }), null, 'nothing to show at all');
    // The words are labels, never values.
    for (const locale of LOCALES) {
      for (const key of ['authoring.mode', 'authoring.model'] as const) {
        assert.notEqual(composerModelLabel({ id: 'm-1' }), t(locale, key));
      }
    }
  });

  it('hides the pill when there is nothing behind it (empty catalog / unknown model)', () => {
    assert.equal(shouldShowModelPill({ currentModel: null, hasCatalog: true }), false);
    assert.equal(shouldShowModelPill({ currentModel: { id: 'm-1' }, hasCatalog: false }), false);
    assert.equal(shouldShowModelPill({ currentModel: { id: 'm-1' }, hasCatalog: true }), true);
  });

  it('has no placeholder-label fallback left in the component or the screen', () => {
    for (const source of [AUTHORING, SESSION]) {
      assert.equal(/props\.labels\.(mode|model)/.test(source), false, 'an i18n label must never be a pill value');
      assert.equal(/modeLabel/.test(source), false, 'the mode pill is gone, not stubbed');
      assert.equal(/labels=\{\{ mode/.test(source), false, 'the screen passes no label pair for the row');
    }
    // The mode slot is intentionally absent: the row renders exactly ONE pill (the model), and only
    // when it has data — no second, stubbed or disabled pill takes its place.
    assert.equal([...AUTHORING.matchAll(/styles\.pill/g)].length, 1, 'the composer row has a single pill');
  });

  it('still shows the current value through the data path the screen passes', () => {
    assert.match(SESSION, /currentModel=\{snapshot\.currentModel\}/);
    assert.match(SESSION, /hasCatalog=\{snapshot\.models\.length > 0\}/);
    assert.match(SESSION, /hint=\{tr\('authoring\.model'\)\}/);
  });

  it('keeps the composer placeholder at the muted-foreground contrast', () => {
    // Was `textFaint` (the washed-out "Send an instruction…" in the same screenshot).
    assert.match(SESSION, /placeholderTextColor=\{colors\.textMuted\}/);
    assert.equal(/placeholderTextColor=\{colors\.textFaint\}/.test(SESSION), false);
  });
});
