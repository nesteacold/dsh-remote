// Device regressions from the on-device screenshot review (owner, real gateway data).
//
// There is no component renderer in this repo (see test/ui-test-hooks.test.ts), so these are source
// assertions on the two style decisions that were visually wrong:
//
//  1. the navy hero card rendered a rounded bottom-LEFT corner and a square bottom-RIGHT notch. Cause:
//     two per-corner radii (`borderBottomLeftRadius` + `borderBottomRightRadius`) — Android's outline
//     can drop one of them. Fixed with a single uniform `borderRadius`; a guard stops per-corner radii
//     coming back.
//  2. the disabled "New session" button dimmed the whole control with `opacity: 0.5`, so the label
//     became muted blue-grey on muted blue. Fixed with an explicit pair — quiet surface + the
//     scheme's muted foreground — which keeps it obviously disabled and readable.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = readFileSync(path.join(ROOT, 'app', '(tabs)', 'index.tsx'), 'utf8');
const UI = readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'ui.tsx'), 'utf8');

describe('home hero — the four corners agree', () => {
  it('rounds the card through ONE radius, never per-corner', () => {
    const heroLine = HOME.split('\n').find((line) => line.includes('styles.hero')) ?? '';
    assert.match(heroLine, /borderRadius: radius\.xl/, 'the hero takes a single radius token');
    for (const prop of ['borderBottomLeftRadius', 'borderBottomRightRadius', 'borderTopLeftRadius', 'borderTopRightRadius']) {
      assert.equal(HOME.includes(prop), false, `${prop} must not be used: per-corner radii rendered asymmetrically on Android`);
    }
  });

  it('clips the hero to its rounded outline', () => {
    assert.match(HOME, /hero: \{[^}]*overflow: 'hidden'/, 'a painting child must not square off a rounded corner');
  });
});

describe('primary action — the disabled state stays legible', () => {
  it('pairs a quiet fill with the muted foreground instead of dimming both', () => {
    // Upgraded with the light-scheme contrast work: the pair is now dedicated tokens, proven in
    // test/theme-contrast.test.ts (label >= 4.5:1 on the fill in BOTH schemes; edge >= 3:1).
    assert.match(UI, /const fill = disabled \? colors\.disabledFill : colors\.accent/, 'disabled fill is the token pair');
    assert.match(UI, /const label = disabled \? colors\.disabledLabel : colors\.onAccent/, 'disabled label is the token pair');
    assert.match(UI, /borderColor: disabled \? colors\.borderStrong : colors\.border/, 'the disabled control keeps a 3:1 edge');
    assert.equal(/styles\.disabled/.test(UI), false, 'no blanket opacity dimming on the primary button');
  });

  it('still tells assistive technology that it is disabled, and does not look pressable', () => {
    assert.match(UI, /accessibilityState=\{\{ disabled, busy: props\.busy === true \}\}/);
    assert.match(UI, /pressed && !disabled && styles\.pressed/, 'a disabled button gives no press feedback');
  });
});
