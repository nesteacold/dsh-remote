// UI ported from Clarklevis1995/dsh-mobile androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/DshTheme.kt,
// SettingsTypography.kt and Design/design-spec.md (MIT).
//
// Spec 011 P1-A — the single visual source of truth for the companion app. Values are ported from
// Clarklevis's Compose theme, not invented: `DshColors` (brand), the Material light/dark colour
// schemes, the Settings typography scale, and the observed corner radii / type sizes of their UI.
//
// Two schemes, following the system setting (spec: "both light and dark schemes, following the
// system setting"). Screens must never hard-code a colour or a font size: read `useTheme()`.
//
//   const { colors, type, space, radius } = useTheme();
//
// For a pure module (no React), use `paletteFor('dark' | 'light')` and `typeScale(fontScale)`.
// `colors` below is the static dark palette, only for code that cannot use a hook.

import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme, type TextStyle } from 'react-native';

// ---------------------------------------------------------------------------
// Brand palette — DshColors (DshTheme.kt:34-45)
// ---------------------------------------------------------------------------

/** Their literal brand colours, shared by both schemes (hero, logo, atmosphere). */
export const brand = {
  /** DshColors.Navy — the deep-ocean brand background. */
  navy: '#06172B',
  /** DshColors.NavyRaised — raised navy for cards sitting on the atmosphere. */
  navyRaised: '#0D2440',
  /** DshColors.Ocean — the one accent. */
  ocean: '#2E6BE6',
  /** DshColors.Mist — soft secondary blue. */
  mist: '#BFD6FF',
  /** DshColors.Ink — light-scheme text. */
  ink: '#0E131A',
  /** DshColors.Paper — light-scheme background. */
  paper: '#F9FAFC',
  /** DshColors.Purple — reserved for trace semantics upstream. */
  purple: '#7A54C7',
  /** DshColors.Orange — reserved for trace semantics upstream. */
  orange: '#F07D14',
  /** DshColors.Amber — attention / warning. */
  amber: '#FFAD1F',
  /** DshColors.Success — connected / running healthy. */
  success: '#2EB85C',
} as const;

/** Design-spec cool gray for secondary text. */
const COOL_GRAY = '#7D8592';

// ---------------------------------------------------------------------------
// Schemes
// ---------------------------------------------------------------------------

export type ColorScheme = 'light' | 'dark';

export interface Palette {
  /** True when this is the dark scheme (for one-off conditionals). */
  readonly isDark: boolean;
  /** Screen background. */
  readonly bg: string;
  /** Card / row surface on top of `bg`. */
  readonly surface: string;
  /** Menus, sheets, dialogs: one step above `surface`. */
  readonly surfaceRaised: string;
  /** Hairline dividers and outlines. Decorative: not required to meet the 3:1 control boundary. */
  readonly border: string;
  /** Boundary for INTERACTIVE edges (WCAG 1.4.11 requires 3:1 for a control to be identifiable). */
  readonly borderStrong: string;
  /** Fill of a disabled control (a quiet surface that still reads as a control, not a ghost). */
  readonly disabledFill: string;
  /** Label on {@link disabledFill}; must stay legible (>= 4.5:1) so the reason is readable. */
  readonly disabledLabel: string;
  /** Primary text. */
  readonly text: string;
  /** Secondary text: subtitles, relative time, section captions. */
  readonly textMuted: string;
  /** Tertiary text: idle dots, disabled glyphs, hints. */
  readonly textFaint: string;
  /** Primary action / selected state / running dot. */
  readonly accent: string;
  /** Soft accent fill (mist blue) for selected chips / tinted containers. */
  readonly accentSoft: string;
  /** Content on top of `accent`. */
  readonly onAccent: string;
  /** Destructive only (forget this computer). */
  readonly danger: string;
  /** Connected / running. */
  readonly success: string;
  /** Reconnecting / attention. */
  readonly warning: string;
  /** Code blocks and monospace fills. */
  readonly codeBg: string;
  /** Scrim behind menus and dialogs. */
  readonly overlay: string;
  /** Translucent fill for the floating tab bar / glass controls. */
  readonly glass: string;
  /** One-pixel inner highlight used on glass surfaces. */
  readonly glassHighlight: string;
  /** Soft navy-tinted shadow for glass and cards. */
  readonly shadow: string;
  /** Brand atmosphere background for the workspace hero. */
  readonly atmosphere: string;
  /** Raised navy card on the brand atmosphere. */
  readonly atmosphereRaised: string;
  /** Text on the brand atmosphere (always light; the nav hero is navy in both schemes). */
  readonly onAtmosphere: string;
  /** Secondary text on the brand atmosphere. */
  readonly onAtmosphereMuted: string;
}

/**
 * Light scheme — `DshTheme.kt:69-76` (`LightColors`): Ocean primary, Paper background, White
 * surface, Ink text.
 */
export const lightColors: Palette = {
  isDark: false,
  bg: brand.paper, // Paper #F9FAFC
  surface: '#FFFFFF', // surface = Color.White
  surfaceRaised: '#FFFFFF',
  border: '#E3E7EE',
  /**
   * Boundary token for INTERACTIVE edges (a control must be identifiable at 3:1, WCAG 1.4.11).
   * `border` above stays a decorative hairline — it measures 1.24:1 on white and was never meant to
   * identify a control.
   */
  borderStrong: '#8A9099', // 3.2:1 on surface
  /** Disabled control fill + label pair: a quiet surface that still reads as a control. */
  disabledFill: '#E8ECF2',
  disabledLabel: '#5A6270', // 5.1:1 on disabledFill
  text: brand.ink, // onBackground / onSurface = Ink #0E131A
  // WCAG AA for small text is 4.5:1. The original cool gray (#7D8592) measured 3.74:1 on white and the
  // faint tier (#AEB5C0) 2.05:1 — the washed-out timestamps and helper lines in the light-mode review.
  textMuted: '#5A6270', // 6.1:1 on surface, 5.9:1 on paper
  textFaint: '#6A727E', // 4.9:1 on surface (helper lines)
  accent: brand.ocean, // primary = Ocean #2E6BE6
  accentSoft: brand.mist, // Mist #BFD6FF
  onAccent: '#FFFFFF',
  danger: '#C43A32', // 4.7:1 on surface (was #D6453D at 4.4:1)
  success: '#1F8F46', // 3.4:1 on surface as a status component (was #2EB85C at 2.6:1)
  warning: brand.orange,
  codeBg: '#F1F3F7',
  overlay: 'rgba(6, 23, 43, 0.42)',
  glass: 'rgba(255, 255, 255, 0.72)',
  glassHighlight: 'rgba(255, 255, 255, 0.9)',
  shadow: 'rgba(6, 23, 43, 0.18)',
  atmosphere: brand.navy,
  atmosphereRaised: brand.navyRaised,
  onAtmosphere: '#FFFFFF',
  onAtmosphereMuted: brand.mist,
};

/**
 * Dark scheme — `DshTheme.kt:78-85` (`DarkColors`): #7EA8FF primary, #B69BFF secondary,
 * #090D13 background, #111720 surface, #F1F4FA text.
 */
export const darkColors: Palette = {
  isDark: true,
  bg: '#090D13', // background
  surface: '#111720', // surface
  surfaceRaised: '#18202B', // one step up for menus/sheets
  border: '#232C38',
  borderStrong: '#5E6B82', // 3.4:1 on surface (interactive boundary)
  disabledFill: '#1A222D',
  disabledLabel: '#98A2B3', // 7.0:1 on disabledFill
  text: '#F1F4FA', // onBackground / onSurface
  textMuted: '#98A2B3',
  textFaint: '#7E8794', // 4.9:1 on surface; the old #5B6675 measured 3.1:1
  accent: '#7EA8FF', // primary
  accentSoft: '#B69BFF', // secondary
  onAccent: '#0B1220',
  danger: '#FF6B61',
  success: brand.success,
  warning: brand.amber,
  codeBg: '#0C1219',
  overlay: 'rgba(0, 0, 0, 0.55)',
  glass: 'rgba(17, 23, 32, 0.72)',
  glassHighlight: 'rgba(255, 255, 255, 0.12)',
  shadow: 'rgba(0, 0, 0, 0.45)',
  atmosphere: brand.navy,
  atmosphereRaised: brand.navyRaised,
  onAtmosphere: '#FFFFFF',
  onAtmosphereMuted: brand.mist,
};

/** Static dark palette, for pure modules and tests. Prefer `useTheme()` inside components. */
export const colors: Palette = darkColors;

export function paletteFor(scheme: ColorScheme): Palette {
  return scheme === 'dark' ? darkColors : lightColors;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** 4pt spacing scale. */
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

/**
 * Corner radii. The observed set in the ported UI is 12/14/18/20/24/26/28 (24 is the most
 * common), so the scale names those steps instead of inventing a different rhythm.
 */
export const radius = { sm: 12, md: 14, lg: 18, xl: 24, xxl: 28, pill: 999, circle: 9999 } as const;

/** Minimum touch target (design-spec: 44 × 44 pt). */
export const hit = 44;

/** Monospace stack for code blocks and ids. */
export const monoFont = { ios: 'Menlo', android: 'monospace', default: 'monospace' } as const;

// ---------------------------------------------------------------------------
// Type scale
// ---------------------------------------------------------------------------

/**
 * The ported scale. Sizes/line heights follow the observed upstream values (17/22 is the
 * dominant item size) and `SettingsTypography.kt` exactly for the settings rows.
 */
export interface TypeScale {
  /** Hero headline on the workspace home (探索未至之境 in the render). */
  readonly display: TextStyle;
  /** Screen title. */
  readonly title: TextStyle;
  /** Section heading ("最近会话"). */
  readonly heading: TextStyle;
  /** Settings row title / list row title — SettingsTypography.title (17 / 22, SemiBold). */
  readonly subheading: TextStyle;
  /** Default body — SettingsTypography.item (17 / 22). */
  readonly body: TextStyle;
  /** Secondary body / one-line row subtitle. */
  readonly bodySmall: TextStyle;
  /** Caption: badges, relative time. */
  readonly caption: TextStyle;
  /** Smallest caption — SettingsTypography.description / section (12 / 16). */
  readonly captionSmall: TextStyle;
  /** Tab bar labels. */
  readonly tabLabel: TextStyle;
  /** Buttons. */
  readonly button: TextStyle;
  /** Code and monospace. */
  readonly mono: TextStyle;
}

/**
 * Builds the type scale for one scheme at an optional user font scale (upstream: the app applies
 * `appearance.effectiveFontScale` on top of the system font scale). RN already honours the system
 * scale via `allowFontScaling`, so this multiplier is only the user's own choice.
 */
export function typeScale(palette: Palette, fontScale = 1): TypeScale {
  const size = (value: number) => Math.round(value * fontScale * 100) / 100;
  const line = (value: number) => Math.round(value * fontScale * 100) / 100;
  return {
    display: { fontSize: size(32), lineHeight: line(38), fontWeight: '700', letterSpacing: -0.5, color: palette.text },
    title: { fontSize: size(24), lineHeight: line(30), fontWeight: '700', letterSpacing: -0.3, color: palette.text },
    heading: { fontSize: size(20), lineHeight: line(26), fontWeight: '600', color: palette.text },
    subheading: { fontSize: size(17), lineHeight: line(22), fontWeight: '600', letterSpacing: 0, color: palette.text },
    body: { fontSize: size(17), lineHeight: line(22), fontWeight: '400', letterSpacing: 0, color: palette.text },
    bodySmall: { fontSize: size(15), lineHeight: line(20), fontWeight: '400', color: palette.text },
    caption: { fontSize: size(13), lineHeight: line(18), fontWeight: '400', color: palette.textMuted },
    captionSmall: { fontSize: size(12), lineHeight: line(16), fontWeight: '400', color: palette.textMuted },
    tabLabel: { fontSize: size(11), lineHeight: line(14), fontWeight: '500', color: palette.textMuted },
    button: { fontSize: size(17), lineHeight: line(22), fontWeight: '600', color: palette.onAccent },
    mono: { fontSize: size(12), lineHeight: line(16), fontWeight: '400', color: palette.text },
  } as const;
}

/** Default (no user scaling) scale for the static dark palette. */
export const type: TypeScale = typeScale(darkColors, 1);

/**
 * `SettingsTypography.kt` verbatim: item 17/22 regular, title 17/22 semibold, description and
 * section 12/16. Kept as its own export because the settings screen ports those rows directly.
 */
export function settingsTypography(palette: Palette, fontScale = 1): {
  item: TextStyle;
  title: TextStyle;
  description: TextStyle;
  section: TextStyle;
} {
  const scale = typeScale(palette, fontScale);
  return { item: scale.body, title: scale.subheading, description: scale.captionSmall, section: scale.captionSmall };
}

// ---------------------------------------------------------------------------
// Elevation / glass
// ---------------------------------------------------------------------------

/** Soft navy-tinted shadow used by cards and the floating tab bar. */
export function elevation(palette: Palette, level: 'card' | 'bar' | 'sheet' = 'card') {
  const config = {
    card: { opacity: 0.16, radius: 12, offsetY: 4, elevation: 3 },
    bar: { opacity: 0.24, radius: 20, offsetY: 8, elevation: 8 },
    sheet: { opacity: 0.32, radius: 28, offsetY: 12, elevation: 12 },
  }[level];
  return {
    shadowColor: palette.shadow,
    shadowOpacity: config.opacity,
    shadowRadius: config.radius,
    shadowOffset: { width: 0, height: config.offsetY },
    elevation: config.elevation,
  } as const;
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

export interface Theme {
  readonly scheme: ColorScheme;
  readonly colors: Palette;
  readonly type: TypeScale;
  readonly space: typeof space;
  readonly radius: typeof radius;
  readonly hit: number;
  /** The user's font-scale multiplier (1 when untouched). */
  readonly fontScale: number;
  readonly setFontScale: (next: number) => void;
  /** Convenience: settings typography for the current scheme. */
  readonly settingsType: ReturnType<typeof settingsTypography>;
}

/** Font-scale steps offered by the settings screen (mirrors upstream's bounded choices). */
export const FONT_SCALES = [0.9, 1, 1.15, 1.3] as const;

const DEFAULT_THEME: Theme = {
  scheme: 'dark',
  colors: darkColors,
  type: typeScale(darkColors, 1),
  space,
  radius,
  hit,
  fontScale: 1,
  setFontScale: () => {},
  settingsType: settingsTypography(darkColors, 1),
};

const ThemeContext = createContext<Theme>(DEFAULT_THEME);

/**
 * Follows the system colour scheme (spec: "following the system setting") and applies the user's
 * font-scale choice on top. No page-level theme state: one provider high in the tree.
 */
export function ThemeProvider(props: { children: ReactNode; initialFontScale?: number }) {
  const system = useColorScheme();
  const scheme: ColorScheme = system === 'light' ? 'light' : 'dark';
  const [fontScale, setFontScale] = useState<number>(props.initialFontScale ?? 1);
  const value = useMemo<Theme>(() => {
    const palette = paletteFor(scheme);
    return {
      scheme,
      colors: palette,
      type: typeScale(palette, fontScale),
      space,
      radius,
      hit,
      fontScale,
      setFontScale,
      settingsType: settingsTypography(palette, fontScale),
    };
  }, [scheme, fontScale]);
  return createElement(ThemeContext.Provider, { value }, props.children);
}

/** Current theme. Usable without a provider (falls back to the dark scheme, scale 1). */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}
