// Session list screen — the no-host empty state must still explain a banner state.
//
// There is no component renderer in this repo (see test/ui-test-hooks.test.ts), so this is a
// **source** test: it reads `app/index.tsx` and asserts that the branch taken when there is no
// usable host renders the same banner component as the list, keeps the empty-state copy and its
// "Pair a computer" action, and renders nothing at all when there is no banner state. The copy
// itself is asserted through the real i18n tables.
//
// Why it exists: a gateway revocation (`native-close … code=4401`) leaves the controller with
// `banner: 'revoked'` and `activeHost: null`. The screen used to return the empty state before
// the banner was rendered, so the user saw only "No sessions in this tab yet." and was never
// told the computer had revoked this device.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOCALES, t } from '../i18n';

// Spec 011 P1-A: the list screen moved to the Conversations tab when the app gained the bottom tab
// bar. All assertions below are unchanged; only the file under test moved with the screen.
const INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', '(tabs)', 'conversations.tsx');
const source = readFileSync(INDEX, 'utf8');

/** The `{ … }` block that opens after `marker`, braces balanced (JSX expressions included). */
function blockAfter(marker: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marker not found in app/index.tsx: ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  assert.fail(`unbalanced block after: ${marker}`);
}

function count(pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

describe('session list — banner on the no-host empty state', () => {
  const noHost = blockAfter('if (snapshot.activeHost === null)');

  it('renders the banner, then the unchanged empty state with its pair action', () => {
    assert.match(noHost, /<Banner banner=\{banner\} warn=\{bannerWarn\} \/>/, 'the no-host branch renders the banner');
    assert.match(noHost, /tr\('sessions\.empty'\)/, 'the empty copy is kept');
    assert.match(noHost, /tr\('sessions\.pair'\)/, 'the pair action is kept');
    assert.match(noHost, /router\.push\('\/pair'\)/, 'the pair action still navigates');
    assert.ok(
      noHost.indexOf('<Banner') < noHost.indexOf('styles.center'),
      'the banner explains the state above the empty copy',
    );
  });

  it('uses the same banner component as the session list (one hook, not two)', () => {
    assert.equal(count(/<Banner banner=\{banner\} warn=\{bannerWarn\} \/>/g), 2);
    // Count real JSX hooks, not raw text: the component's doc comment also mentions the hook name,
    // so a plain text count would be 2 while the rendered hook is still unique.
    const hooks = [...source.matchAll(/testID=(?:"([^"]+)"|\{`([^`]+)`\})/g)]
      .map((match) => match[1] ?? match[2])
      .filter((id) => id === 'banner');
    assert.equal(hooks.length, 1, 'exactly one rendered banner hook');
    assert.match(source, /testID="banner"\s+accessibilityLabel=\{banner\}/);
  });

  it('renders no banner at all when there is no banner state', () => {
    assert.match(
      source,
      /const banner = snapshot\.banner !== 'none' \? t\(locale, bannerKey\(snapshot\.banner\)\) : null;/,
    );
    // The component is the only place the banner is built, and it renders nothing without copy.
    assert.match(source, /if \(banner === null\) return null;/);
  });
});

describe('revoked banner copy', () => {
  it('says what happened and what to do next (en), in every locale', () => {
    for (const locale of LOCALES) {
      assert.ok(t(locale, 'banner.revoked').trim() !== '', `${locale}: banner.revoked`);
    }
    assert.match(t('en', 'banner.revoked'), /removed from the computer/i);
    assert.match(t('en', 'banner.revoked'), /pair again/i);
  });

  it('says what happened and what to do next (vi)', () => {
    assert.match(t('vi', 'banner.revoked'), /xoá khỏi máy tính/i);
    assert.match(t('vi', 'banner.revoked'), /ghép đôi lại/i);
  });

  it('keeps a distinct message for every banner state', () => {
    for (const locale of LOCALES) {
      assert.match(t(locale, 'banner.reauth'), /re-?authenticate|xác thực lại/i);
      assert.ok(t(locale, 'banner.gatewayOff').trim() !== '', `${locale}: banner.gatewayOff`);
    }
  });
});

// Device regression (owner's emulator pass, both light and dark): rows ran edge to edge and the text
// was clipped at BOTH edges — the second line read "pdated 1 min" and the trailing time lost its last
// characters. Cause: no horizontal inset on the row plus no shrink constraint, so the middle column
// pushed the trailing time past the parent. These assertions pin the layout invariants that fixed it.
describe('session list — row layout (no edge clipping)', () => {
  /** One `name: { ... }` entry from the screen's `StyleSheet.create` block. */
  function styleEntry(name: string): string {
    const match = new RegExp(`\\n  ${name}: \\{([^}]*)\\}`).exec(source);
    assert.notEqual(match, null, `style ${name} not found in the list screen`);
    return match?.[1] ?? '';
  }

  it('insets rows by the same horizontal space the home cards use', () => {
    const row = styleEntry('row');
    assert.match(row, /paddingHorizontal: space\.(xl|lg|md)/, 'rows must have a horizontal inset');
    assert.doesNotMatch(row, /paddingHorizontal: 0\b/, 'rows must not be flush to the screen edges');
    assert.match(row, /flexDirection: 'row'/, 'the row lays its children out horizontally');
  });

  it('lets the title block shrink so the trailing time stays on screen', () => {
    assert.match(styleEntry('rowBody'), /minWidth: 0/, 'the middle column needs a zero min-width to shrink');
    assert.match(styleEntry('rowTitle'), /flex: 1/, 'the title takes the leftover space');
    assert.match(styleEntry('rowTitle'), /minWidth: 0/, 'the title needs a zero min-width to shrink');
    assert.match(styleEntry('rowTime'), /flexShrink: 0/, 'the trailing time must not be shrunk away');
  });

  it('keeps every row line to one line of text', () => {
    // Clipping happens when a line is allowed to wrap/paginate; numberOfLines on each line is the
    // guard. Asserted per line rather than via a brace-balanced block, because the first `{` after
    // `function SessionRow` is the props annotation, not the body.
    assert.match(source, /<Text numberOfLines=\{1\} style=\{\[[^\]]*styles\.rowTitle/, 'the title is single-line');
    assert.match(source, /<Text numberOfLines=\{1\} style=\{\[[^\]]*styles\.rowTime/, 'the trailing time is single-line');
    // The second line (decision hint or "updated …") is rendered inline, so it has no named style.
    assert.match(
      source,
      /<Text numberOfLines=\{1\} style=\{\[type\.captionSmall, \{ color: colors\.accent, marginTop/,
      'the decision line is single-line',
    );
  });

  // Owner's emulator pass: the row showed the same time twice — "4 min" right-aligned AND
  // "updated 4 min" underneath. The reference keeps only the trailing relative time, so the second
  // line now carries the decision hint alone; this guard stops the duplicate coming back.
  it('shows each session\'s relative time exactly once', () => {
    assert.equal(/sessions\.updatedAgo/.test(source), false, 'the list must not repeat the time as "updated …"');
    assert.equal([...source.matchAll(/styles\.rowTime/g)].length, 1, 'the trailing time is rendered once');
  });
});
