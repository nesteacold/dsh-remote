// Conversation shell guard (P1-B2): the header, the composer, the tool-row wiring and the
// approval-card decision rules.
//
// There is no component renderer in this repo (see `test/ui-test-hooks.test.ts`), so this is a
// **source** test: it reads `app/session/[id].tsx` and pins the properties that a refactor would
// silently lose — and that the device flows cannot catch without a phone.
//
// What it protects:
//   * the header Clarklevis draws itself: back, one-line title, running/idle status pill, "more";
//   * the "more" menu holds ONLY "Stop session" — rename/archive/pin are admin-only operations
//     (P2), and offering them would be a promise the app cannot keep;
//   * the composer keeps its two device hooks, grows multiline, caps at five lines, keeps the
//     send action inside the capsule and says WHY sending is unavailable;
//   * `tool` / `system` / `other` history rows go through the ported `ToolRow` (the component
//     existed orphaned before this slice — nothing imported it);
//   * the approval card still decides by `argsHash` alone: no hash means "decide on your
//     computer", buttons only for a pending card with a hash, and the exact outcomes
//     ('allowed-once' / 'rejected') are unchanged. This is a restyle, not a behaviour change.
//   * no colour literal lives outside `src/ui/theme.ts`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const SCREEN = path.join(APP_DIR, 'session', '[id].tsx');
const source = readFileSync(SCREEN, 'utf8');

/** The JSX element between two literal markers (exclusive of the closing marker). */
function sliceBetween(open: string, close: string): string {
  const start = source.indexOf(open);
  const end = source.indexOf(close, start + open.length);
  assert.ok(start >= 0, `marker not found in app/session/[id].tsx: ${open}`);
  assert.ok(end > start, `closing marker not found after ${open}: ${close}`);
  return source.slice(start, end);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('conversation header (P1-B2)', () => {
  it('draws its own header: back, one-line title, status pill and "more"', () => {
    // The native stack header is hidden for this route only, so there is exactly one header.
    assert.match(source, /headerShown:\s*false/);
    assert.equal(count(source, 'testID="session-back"'), 1, 'a back affordance is always reachable');
    assert.equal(count(source, 'testID="session-title"'), 1);
    assert.match(source, /numberOfLines=\{1\}/, 'the title is one line');
    assert.equal(count(source, 'testID="session-more"'), 1);
    // The pill is the ported component, not a local re-implementation.
    assert.match(source, /import \{ SessionStatusPill \} from '..\/..\/src\/ui\/conversation\/SessionStatusPill'/);
    assert.match(source, /<SessionStatusPill\s+state=\{session\.state\}/);
    // Running / idle / archived all come from the shared tab vocabulary, both locales.
    assert.match(source, /tr\('tabs\.running'\)/);
    assert.match(source, /tr\('tabs\.idle'\)/);
    assert.match(source, /tr\('tabs\.archived'\)/);
  });

  it('offers exactly one menu action: stop the session', () => {
    const menu = sliceBetween('<Modal', '</Modal>');
    assert.match(menu, /tr\('session\.cancel'\)/, 'the menu holds "Stop session"');
    assert.equal(count(menu, 'testID="session-stop"'), 1);
    for (const forbidden of ['rename', 'archive', 'pin', 'titleEdit']) {
      assert.equal(
        new RegExp(forbidden, 'i').test(menu),
        false,
        `the menu must not offer "${forbidden}" (admin-only today, P2)`,
      );
    }
    // Stopping still asks first and still routes through the controller.
    assert.match(source, /controller\.cancelSession\(\)/);
    assert.match(source, /tr\('session\.cancelConfirmTitle'\)/);
  });
});

describe('floating composer (P1-B2)', () => {
  it('keeps the device hooks and the send action inside the capsule', () => {
    assert.equal(count(source, 'testID="session-composer"'), 1);
    assert.equal(count(source, 'testID="session-send"'), 1);
    // The footer capsule: from the composer wrapper to the "more" menu that follows it. Both hooks
    // live inside it, so Send stays inside the rounded composer rather than in a separate footer.
    const capsule = sliceBetween('<View\n        style={[', '</Modal>');
    assert.equal(count(capsule, 'testID="session-composer"'), 1);
    assert.equal(count(capsule, 'testID="session-send"'), 1);
    assert.ok(capsule.indexOf('testID="session-send"') > capsule.indexOf('testID="session-composer"'));
    assert.match(source, /multiline/);
    assert.match(source, /const COMPOSER_MAX_LINES = 5;/, 'growth is capped at ~5 lines');
    assert.match(source, /maxHeight: COMPOSER_MAX_LINES \*/);
  });

  it('says why sending is unavailable instead of showing a dead button', () => {
    assert.match(source, /session\.sendOffline/);
    assert.match(source, /session\.sendNotReady/);
    assert.equal(count(source, 'testID="session-send-reason"'), 1);
    // Disabled is derived from the connection state, never from a silent catch.
    assert.match(source, /const ready = snapshot\.connection === 'ready'/);
    assert.match(source, /accessibilityState=\{\{ disabled: !canSend, busy: sending \}\}/);
  });

  it('keeps every tappable at the 44pt minimum', () => {
    // minHeight/minWidth come from the theme's `hit` token rather than a literal.
    assert.match(source, /const \{ colors, type, space, radius, hit \} = theme/);
    assert.ok(count(source, 'minHeight: hit') >= 3, 'back, more and send are 44pt targets');
    assert.ok(count(source, 'minWidth: hit') >= 2);
  });
});

describe('tool rows (P1-B2)', () => {
  it('renders tool / system / other history rows through the ported ToolRow', () => {
    assert.match(source, /import \{ ToolRow \} from '..\/..\/src\/ui\/conversation\/ToolRow'/);
    assert.equal(count(source, '<ToolRow'), 1);
    // The roles we do not render as prose are exactly the ones the pill serves.
    assert.match(source, /message\.role === 'tool' \|\| message\.role === 'system' \|\| message\.role === 'other'/);
    assert.match(source, /tr\('session\.role\.tool'\)/);
    assert.match(source, /tr\('session\.role\.system'\)/);
    assert.match(source, /tr\('session\.role\.other'\)/);
    // No invented tool metadata: the pill is fed the row's own text only.
    assert.match(source, /text=\{message\.text\}/);
    for (const invented of ['toolName', 'exitCode', 'durationMs', 'argsPreview']) {
      assert.equal(
        new RegExp(`<ToolRow[^>]*${invented}`, 's').test(source),
        false,
        'history rows carry no tool metadata; the pill must not invent it',
      );
    }
  });
});

describe('approval card restyle keeps the decisions intact (P1-B2)', () => {
  it('decides by argsHash alone, exactly as before', () => {
    // The one predicate that may enable the buttons.
    assert.match(
      source,
      /const decidable = card\.canApprove && card\.argsHash !== null && card\.status === 'pending';/,
    );
    // A null hash is a desktop-only decision: no buttons, an explicit notice.
    assert.match(source, /card\.argsHash === null \? \(/);
    assert.match(source, /tr\('approval\.decideOnComputer'\)/);
    // The exact outcomes the contract binds to the echoed hash.
    assert.match(source, /controller\.decideApproval\(card\.approvalId, 'allowed-once'\)/);
    assert.match(source, /controller\.decideApproval\(card\.approvalId, 'rejected'\)/);
  });

  it('keeps every per-card device hook', () => {
    assert.equal(count(source, 'testID={`approval-card-${card.approvalId}`}'), 1);
    assert.equal(count(source, 'testID={`approval-approve-${card.approvalId}`}'), 1);
    assert.equal(count(source, 'testID={`approval-reject-${card.approvalId}`}'), 1);
    // decide-on-computer | review-again | already-decided | resolved
    assert.equal(count(source, 'testID={`approval-state-${card.approvalId}`}'), 4);
    assert.match(source, /tr\('approval\.reviewAgain'\)/);
    assert.match(source, /tr\('approval\.alreadyDecided'\)/);
    assert.match(source, /tr\('approval\.changed'\)/);
  });

  it('does not put a decision next to the send button', () => {
    // Decisions live in the scrolling transcript; Send lives in the footer capsule. The structural
    // claim is: the approvals are rendered inside <ScrollView>, and the composer comes after it.
    const listOpen = source.indexOf('<ScrollView');
    const listClose = source.indexOf('</ScrollView>');
    assert.ok(listOpen > 0 && listClose > listOpen);
    const transcript = source.slice(listOpen, listClose);
    assert.match(transcript, /snapshot\.openApprovals\.map/, 'approval cards are part of the transcript');
    assert.equal(transcript.includes('testID="session-send"'), false, 'Send is not inside the transcript');
    assert.ok(source.indexOf('testID="session-send"') > listClose, 'Send sits below the transcript');
  });
});

describe('theme discipline (P1-B2)', () => {
  it('has no colour literal outside src/ui/theme.ts', () => {
    const hex = source.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
    assert.deepEqual(hex, [], `colour literals belong in src/ui/theme.ts, found: ${hex.join(', ')}`);
  });

  it('reads every visual value from the theme hook', () => {
    // Screen, message row, approval card, prompt send-state line: each renderer asks the theme for its
    // values (the fourth renderer was added with the "đang gửi…" fix).
    assert.equal(count(source, 'useTheme()'), 4);
    for (const token of ['colors.', 'type.', 'space.', 'radius.']) {
      assert.ok(count(source, token) > 5, `${token} is used throughout instead of raw numbers/colours`);
    }
  });
});
