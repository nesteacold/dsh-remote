// A025 — the deep-link landing route: the URL has to be a route before the app can act on it.
//
// The defect this guards: `adb shell am start -a android.intent.action.VIEW -d
// "dshcompanion://s/sess-gamma"` rendered Expo Router's "Unmatched Route" screen ("Page could not
// be found", href `dshcompanion:///s/sess-gamma`) because the path `/s/<id>` had no file route —
// the layout's `Linking` listener was never reached. `app/s/[id].tsx` makes the URL resolvable and
// redirects to the session screen, where the gate and the controller do the actual work.
//
// There is no component renderer in this repo (see test/ui-test-hooks.test.ts), so this is a
// **source + URL-mapping** test. It re-derives the router path exactly like expo-router's native
// deep-link fork does (`fromDeepLink` in
// node_modules/expo-router/build/fork/extractPathFromURL.js: the URL host joined with the pathname,
// outer slashes dropped; `getStateFromPath` strips the trailing slash before matching), so both
// documented link forms are proven to land on the route files asserted here.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSessionDeepLink } from '../src/core/deeplink';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const ROUTE = path.join(APP_DIR, 's', '[id].tsx');
const NO_ID_ROUTE = path.join(APP_DIR, 's', 'index.tsx');
const LAYOUT = path.join(APP_DIR, '_layout.tsx');

/**
 * The path Expo Router navigates to for a custom-scheme URL: `fromDeepLink` joins the URL host and
 * the pathname, and `getStateFromPath` works on the path without its outer slashes.
 */
function routerPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname}`.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Read a route file, failing with the relative name instead of an ENOENT stack. */
function source(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return assert.fail(`missing route file: app/${path.relative(APP_DIR, file)}`);
  }
}

/** Source with its comment lines removed: the thin-route check is about code, not `WHY` comments. */
function code(file: string): string {
  return source(file)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('deep-link route (A025)', () => {
  it('is the file route both documented URL forms resolve to', () => {
    // The two shapes `parseSessionDeepLink` accepts: host `s`, and an empty host with `s` as the
    // first path segment (the form the Android device report produced).
    for (const url of ['dshcompanion://s/sess-gamma', 'dshcompanion:///s/sess-gamma']) {
      assert.equal(routerPath(url), 's/sess-gamma', url);
      assert.deepEqual(parseSessionDeepLink(url), { sessionId: 'sess-gamma', approvalId: null }, url);
    }
    // ...so the second segment is the dynamic `[id]` route in the `s` folder.
    assert.deepEqual(readdirSync(path.join(APP_DIR, 's')).sort(), ['[id].tsx', 'index.tsx']);
    assert.match(source(ROUTE), /export default function /, 'app/s/[id].tsx is a route');
  });

  it('redirects a valid id to the session screen, re-encoded as one path segment', () => {
    const route = source(ROUTE);
    assert.ok(route.includes("const params = useLocalSearchParams<{ id?: string }>();"), 'reads the route param');
    assert.ok(route.includes("const id = typeof params.id === 'string' ? params.id : '';"), 'validates the param type');
    assert.ok(route.includes('return <Redirect href={`/session/${encodeURIComponent(id)}`} />;'), 'redirects to the session');
    // `Redirect` replaces the landing URL; a push would leave `/s/<id>` on the back stack.
    assert.equal(code(ROUTE).includes('router.push'), false, 'the landing URL is replaced, not pushed');
  });

  it('sends a missing or empty id to the session list instead of an error screen', () => {
    assert.ok(source(ROUTE).includes('if (id.trim() === \'\') return <Redirect href="/" />;'), 'empty id -> /');
    // An id-less link cannot reach the dynamic route at all (a `:id` segment needs at least one
    // character), so the folder carries an index route for it — and no session to open either.
    for (const url of ['dshcompanion://s', 'dshcompanion://s/', 'dshcompanion:///s', 'dshcompanion:///s/']) {
      assert.equal(routerPath(url), 's', url);
      assert.equal(parseSessionDeepLink(url), null, url);
    }
    assert.ok(source(NO_ID_ROUTE).includes('return <Redirect href="/" />;'), 'id-less route -> /');
  });

  it('stays a thin route: no controller, no connection, no deep-link parsing', () => {
    // The layout's `Linking` listener and `controller.handleDeepLink` own opening the session and
    // focusing an approval card; duplicating that here would create two sources of truth.
    for (const file of [ROUTE, NO_ID_ROUTE]) {
      const text = code(file);
      for (const forbidden of [
        'useApp',
        'controller',
        'parseSessionDeepLink',
        'sessionDeepLink',
        'Linking',
        'openSession',
        'fetch(',
        'WebSocket',
      ]) {
        assert.equal(text.includes(forbidden), false, `app/${path.relative(APP_DIR, file)} must not use ${forbidden}`);
      }
    }
  });
});

describe('unlock gate still applies to the deep-link route (A020)', () => {
  const layout = readFileSync(LAYOUT, 'utf8');

  it('renders the navigator — and therefore every route — only after unlock', () => {
    // The first frame is the gate: `gate` starts at 'checking' and 'checking' counts as locked.
    assert.match(layout, /const \[gate, setGate\] = useState<GateStatus>\('checking'\);/);
    assert.match(layout, /const locked = gate === 'checking' \|\|/);
    assert.match(layout, /\{locked \? \(/, 'the locked branch is rendered before any navigator');
    // Exactly one navigator, and it is the unlocked branch of that ternary: a cold start through
    // `dshcompanion://s/<id>` mounts no route at all until the unlock prompt succeeds.
    assert.equal([...layout.matchAll(/<Stack\s/g)].length, 1, 'exactly one navigator');
    assert.match(
      layout,
      /\) : \(\s*<AppProvider[\s\S]{0,200}?<Stack\s/,
      'the navigator is rendered in the unlocked branch only',
    );
  });

  it('declares the deep-link routes inside that stack', () => {
    assert.match(layout, /<Stack\.Screen name="s\/\[id\]" options=\{\{ headerShown: false \}\} \/>/);
    assert.match(layout, /<Stack\.Screen name="s\/index" options=\{\{ headerShown: false \}\} \/>/);
  });
});
