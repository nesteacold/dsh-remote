// UI ported from Clarklevis1995/dsh-mobile androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/*
// (DshTheme.kt StatusIndicatorDot, DshGlassButton.kt, DshProductApp.kt cards, DshSwitch.kt) (MIT).
//
// Small, dumb primitives so every screen composes the same shapes. Nothing here owns state and
// nothing here hard-codes a colour: all values come from `useTheme()` (src/ui/theme.ts).

import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { elevation, useTheme } from '../theme';

/** Full-bleed screen: theme background, safe-area padding, no white flash while transitions run. */
export function Screen(props: {
  children: ReactNode;
  /** 'scroll' wraps the content in a ScrollView (forms/settings); default is a plain flex column. */
  scroll?: boolean;
  /** Extra top padding beyond the safe area (hero screens add their own). */
  topInset?: number;
  testID?: string;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const padding = {
    paddingTop: insets.top + (props.topInset ?? 0),
    paddingBottom: 0,
  };
  if (props.scroll) {
    return (
      <ScrollView
        testID={props.testID}
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={[styles.scrollContent, padding]}
        keyboardShouldPersistTaps="handled"
      >
        {props.children}
      </ScrollView>
    );
  }
  return (
    <View testID={props.testID} style={[styles.screen, { backgroundColor: colors.bg }, padding]}>
      {props.children}
    </View>
  );
}

/**
 * DshTheme.kt `StatusIndicatorDot`: a filled circle, optionally glowing. Green for running,
 * accent (blue) when the session needs the owner's decision, faint when idle.
 */
export function StatusDot(props: { kind: 'running' | 'decision' | 'idle' | 'muted'; size?: number }) {
  const { colors } = useTheme();
  const size = props.size ?? 8;
  const color = {
    running: colors.success,
    decision: colors.accent,
    idle: colors.textFaint,
    muted: colors.textFaint,
  }[props.kind];
  const glowing = props.kind === 'running' || props.kind === 'decision';
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        // Upstream uses a soft drop shadow as the "glow" on a live dot.
        ...(glowing ? { shadowColor: color, shadowOpacity: 0.5, shadowRadius: 4, shadowOffset: { width: 0, height: 0 }, elevation: 2 } : {}),
      }}
    />
  );
}

/** Card surface (recent-session row, settings group): raised fill, soft shadow, 14pt radius. */
export function Card(props: { children: ReactNode; onPress?: () => void; testID?: string; label?: string; style?: object }) {
  const { colors, radius, space } = useTheme();
  const surface = {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    ...elevation(colors, 'card'),
    ...(props.style ?? {}),
  };
  if (props.onPress === undefined) return <View style={surface}>{props.children}</View>;
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={({ pressed }) => [surface, pressed && styles.pressed]}
    >
      {props.children}
    </Pressable>
  );
}

/** Translucent glass fill used by the floating tab bar and pills (their "liquid glass"). */
export function GlassSurface(props: { children: ReactNode; style?: object }) {
  const { colors, radius } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: colors.glass,
          borderRadius: radius.pill,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassHighlight,
          ...elevation(colors, 'bar'),
        },
        props.style,
      ]}
    >
      {props.children}
    </View>
  );
}

/** Muted section caption ("最近会话" / "Recent sessions"). */
export function SectionLabel(props: { children: string; style?: object }) {
  const { type } = useTheme();
  return <Text style={[type.captionSmall, styles.sectionLabel, props.style]}>{props.children}</Text>;
}

/** The primary action: full-width tall pill, ocean fill (their "新建会话" button). */
export function PrimaryButton(props: { label: string; onPress: () => void; disabled?: boolean; testID?: string; busy?: boolean }) {
  const { colors, type, radius, hit, space } = useTheme();
  const disabled = props.disabled === true;
  // Disabled is a token PAIR, not a dimming: `opacity: 0.5` over the accent fill dropped the label to
  // a muted blue-grey on muted blue (dark) / near-white on near-white (light, ~1.1:1 fill vs bg).
  // `disabledFill` + `disabledLabel` are computed to stay legible in BOTH schemes, and `borderStrong`
  // keeps the control identifiable at 3:1 (see test/theme-contrast.test.ts).
  const fill = disabled ? colors.disabledFill : colors.accent;
  const label = disabled ? colors.disabledLabel : colors.onAccent;
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled, busy: props.busy === true }}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.primary,
        {
          backgroundColor: fill,
          borderWidth: disabled ? StyleSheet.hairlineWidth : 0,
          borderColor: disabled ? colors.borderStrong : colors.border,
          borderRadius: radius.pill,
          minHeight: hit + space.md,
          paddingHorizontal: space.xxl,
        },
        pressed && !disabled && styles.pressed,
      ]}
    >
      {props.busy === true ? (
        <ActivityIndicator color={label} />
      ) : (
        <Text style={[type.button, { color: label }]}>{props.label}</Text>
      )}
    </Pressable>
  );
}

/** Secondary/quiet action: text-only, still a 44pt target. */
export function TextButton(props: { label: string; onPress: () => void; danger?: boolean; testID?: string }) {
  const { colors, type, hit, space } = useTheme();
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={({ pressed }) => [styles.textButton, { minHeight: hit, paddingHorizontal: space.sm }, pressed && styles.pressed]}
    >
      <Text style={[type.body, { color: props.danger === true ? colors.danger : colors.accent }]}>{props.label}</Text>
    </Pressable>
  );
}

/** Small pill badge: "running" (accent tint) or a time label (muted). */
export function Badge(props: { label: string; tone: 'accent' | 'muted' | 'danger' }) {
  const { colors, type, radius, space } = useTheme();
  const tone = {
    accent: { backgroundColor: colors.accent, text: colors.onAccent },
    muted: { backgroundColor: 'transparent', text: colors.textMuted },
    danger: { backgroundColor: colors.danger, text: colors.onAccent },
  }[props.tone];
  return (
    <View style={{ borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2, backgroundColor: tone.backgroundColor }}>
      <Text style={[type.captionSmall, { color: tone.text }]}>{props.label}</Text>
    </View>
  );
}

/** Hairline divider. */
export function Divider(props: { inset?: number }) {
  const { colors } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: props.inset ?? 0 }} />;
}

/**
 * Designed empty/error/loading state: centred message plus one optional action (the reference has
 * no illustration, so neither do we).
 */
export function StateMessage(props: { title: string; body?: string; actionLabel?: string; onAction?: () => void; busy?: boolean }) {
  const { colors, type, space } = useTheme();
  return (
    <View style={[styles.state, { padding: space.xxxl, gap: space.sm }]}>
      {props.busy === true ? <ActivityIndicator color={colors.textMuted} /> : null}
      <Text style={[type.subheading, styles.centre]}>{props.title}</Text>
      {props.body === undefined ? null : <Text style={[type.caption, styles.centre]}>{props.body}</Text>}
      {props.actionLabel !== undefined && props.onAction !== undefined ? (
        <View style={{ marginTop: space.sm, alignSelf: 'center' }}>
          <TextButton label={props.actionLabel} onPress={props.onAction} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scrollContent: { paddingBottom: 96 },
  pressed: { opacity: 0.7 },
  sectionLabel: { textTransform: 'uppercase', letterSpacing: 0.6 },
  primary: { alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
  textButton: { alignItems: 'center', justifyContent: 'center' },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centre: { textAlign: 'center' },
});
