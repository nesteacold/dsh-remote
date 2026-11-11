// WCAG contrast guard — computed, not eyeballed.
//
// The light scheme shipped with washed-out timestamps, a near-invisible disabled "New session" button
// and faint helper lines ("Send an instruction…", "This computer has no workspaces."). The dark scheme
// happened to pass, which is exactly how a scheme-asymmetric palette defect survives review: it is
// invisible in the mode you develop in.
//
// This test is the guard: it does the WCAG relative-luminance math on the palette ITSELF (no renderer,
// no snapshot) and asserts thresholds for every foreground/background pair the app actually uses, in
// BOTH schemes. Any future palette change that drops a pair below its threshold fails here.
//
// Thresholds (WCAG 2.x AA): body/small text 4.5:1; large/bold text and UI component boundaries 3:1.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { darkColors, lightColors, type Palette } from '../src/ui/theme';

/** sRGB channel (0-255) → linear light. */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an #RRGGBB colour. */
export function luminance(hex: string): number {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  assert.ok(match !== null, `${hex} must be a 6-digit hex colour`);
  const value = Number.parseInt(match[1] as string, 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two opaque colours (1:1 … 21:1). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** A pair the UI really renders, with the threshold that applies to it. */
interface Pair {
  readonly name: string;
  readonly fg: (p: Palette) => string;
  readonly bg: (p: Palette) => string;
  readonly min: number;
}

const TEXT = 4.5;
const UI = 3;

const PAIRS: readonly Pair[] = [
  // ---- body text -------------------------------------------------------------------------------
  { name: 'text on bg', fg: (p) => p.text, bg: (p) => p.bg, min: TEXT },
  { name: 'text on surface', fg: (p) => p.text, bg: (p) => p.surface, min: TEXT },
  // Secondary timestamps ("7 min") and helper lines.
  { name: 'textMuted on surface (timestamps)', fg: (p) => p.textMuted, bg: (p) => p.surface, min: TEXT },
  { name: 'textMuted on bg', fg: (p) => p.textMuted, bg: (p) => p.bg, min: TEXT },
  { name: 'textFaint on surface (helper lines)', fg: (p) => p.textFaint, bg: (p) => p.surface, min: TEXT },
  { name: 'textFaint on bg', fg: (p) => p.textFaint, bg: (p) => p.bg, min: TEXT },
  // ---- links / accents -------------------------------------------------------------------------
  { name: 'accent on surface (links: See all / show sub-agents)', fg: (p) => p.accent, bg: (p) => p.surface, min: TEXT },
  { name: 'accent on bg (tab label, composer link)', fg: (p) => p.accent, bg: (p) => p.bg, min: TEXT },
  // Running badge: label on the badge fill.
  { name: 'onAccent on accent (Running badge)', fg: (p) => p.onAccent, bg: (p) => p.accent, min: TEXT },
  { name: 'danger on surface', fg: (p) => p.danger, bg: (p) => p.surface, min: TEXT },
  // Hero (navy atmosphere) — unchanged identity, but it must still pass.
  { name: 'onAtmosphere on atmosphere (hero title)', fg: (p) => p.onAtmosphere, bg: (p) => p.atmosphere, min: TEXT },
  { name: 'onAtmosphereMuted on atmosphere (hero subtitle)', fg: (p) => p.onAtmosphereMuted, bg: (p) => p.atmosphere, min: TEXT },
  // ---- disabled control ------------------------------------------------------------------------
  { name: 'disabledLabel on disabledFill (button label)', fg: (p) => p.disabledLabel, bg: (p) => p.disabledFill, min: TEXT },
  { name: 'disabledFill vs bg (control is not a ghost)', fg: (p) => p.disabledFill, bg: (p) => p.bg, min: 1.1 },
  // ---- UI component boundaries (3:1) ------------------------------------------------------------
  { name: 'borderStrong on surface (interactive edge)', fg: (p) => p.borderStrong, bg: (p) => p.surface, min: UI },
  { name: 'borderStrong on bg', fg: (p) => p.borderStrong, bg: (p) => p.bg, min: UI },
  { name: 'success on surface (status dot)', fg: (p) => p.success, bg: (p) => p.surface, min: UI },
  { name: 'accent on surface as control edge', fg: (p) => p.accent, bg: (p) => p.surface, min: UI },
  // Adjacent surfaces (a floating tab bar over the page) are separated by elevation + the
  // `borderStrong` edge asserted above, not by luminance: WCAG sets no ratio for that, so it is not
  // asserted here rather than asserted at a number that means nothing.
];

const SCHEMES: ReadonlyArray<{ name: string; palette: Palette }> = [
  { name: 'light', palette: lightColors },
  { name: 'dark', palette: darkColors },
];

describe('WCAG contrast — every rendered pair, both schemes', () => {
  const measured: string[] = [];

  for (const scheme of SCHEMES) {
    describe(scheme.name, () => {
      for (const pair of PAIRS) {
        it(`${pair.name} ≥ ${pair.min}:1`, () => {
          const fg = pair.fg(scheme.palette);
          const bg = pair.bg(scheme.palette);
          const ratio = contrast(fg, bg);
          measured.push(`${scheme.name} | ${pair.name} | ${fg} on ${bg} | ${ratio.toFixed(2)}:1 (min ${pair.min})`);
          assert.ok(
            ratio >= pair.min,
            `${scheme.name}: ${pair.name} is ${ratio.toFixed(2)}:1 (${fg} on ${bg}), needs ≥ ${pair.min}:1`,
          );
        });
      }
    });
  }

  it('reports every computed ratio', () => {
    // Printed once so a reviewer can see the numbers in the test output, not just pass/fail.
    // eslint-disable-next-line no-console
    console.log(`\n  computed contrast ratios:\n  ${measured.join('\n  ')}\n`);
    assert.equal(measured.length, PAIRS.length * SCHEMES.length);
  });
});

describe('the palette keeps its identity', () => {
  it('hero and accents stay Clarklevis navy/ocean in both schemes', () => {
    for (const scheme of SCHEMES) {
      assert.equal(scheme.palette.atmosphere, '#06172B', `${scheme.name}: navy hero`);
      assert.equal(scheme.palette.onAtmosphereMuted, '#BFD6FF', `${scheme.name}: mist subtitle`);
    }
    assert.equal(lightColors.accent, '#2E6BE6', 'light accent is Ocean');
  });

  it('a border that identifies a control is stronger than a decorative hairline', () => {
    for (const scheme of SCHEMES) {
      assert.ok(
        contrast(scheme.palette.borderStrong, scheme.palette.surface) > contrast(scheme.palette.border, scheme.palette.surface),
        `${scheme.name}: borderStrong must be the stronger boundary`,
      );
    }
  });
});
