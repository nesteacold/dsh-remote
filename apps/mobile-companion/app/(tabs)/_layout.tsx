// UI ported from Clarklevis1995/dsh-mobile androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/DshProductApp.kt
// (bottom navigation: Workspace / Conversations / Settings, floating glass bar) and
// DshGlassButton.kt / DshTheme.kt (MIT).
//
// Spec 011 P1-A — the app shell. Three destinations, same order and same floating-pill shape as the
// reference render (left phone in Design/deepseek-harness-ios-ui.png). The bar floats above the
// safe area, stays translucent over content, and every item is a >=44pt target with a label.
//
// No icon glyphs are shipped in P1: the upstream icons are Android VectorDrawables, which React
// Native cannot render without a new SVG dependency (spec: no dependency without the lead), so the
// bar is label-led with a filled active pill rather than faking icons. See UPSTREAM-UI.md.

import { Tabs } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { elevation, useTheme } from '../../src/ui/theme';
import { useApp } from '../_layout';

export default function TabsLayout() {
  const { colors: palette, type, radius, hit, space } = useTheme();
  const insets = useSafeAreaInsets();
  const { tr } = useApp();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // Themed chrome: no white flash between screens (spec 011 U1 / P1-A item 2).
        sceneStyle: { backgroundColor: palette.bg },
        tabBarStyle: [
          styles.bar,
          {
            backgroundColor: palette.glass,
            borderColor: palette.glassHighlight,
            borderRadius: radius.pill,
            marginHorizontal: space.lg,
            marginBottom: Math.max(insets.bottom, space.sm),
            height: hit + space.xl,
            ...elevation(palette, 'bar'),
          },
        ],
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.textMuted,
        tabBarLabelStyle: [type.tabLabel],
        tabBarItemStyle: { minHeight: hit, paddingVertical: space.xs },
        tabBarPosition: 'bottom',
      }}
    >
      {/* Hooks are literal `testID="..."` strings (not values from the map) because
          `e2e/check-flows.mjs` derives the known hooks by scanning the source for that shape. */}
      <Tabs.Screen
        name="index"
        options={{
          title: tr('tabs.workspace'),
          tabBarAccessibilityLabel: tr('tabs.workspace'),
          tabBarLabel: ({ color }) => <Text testID="tab-workspace" style={[type.tabLabel, { color }]}>{tr('tabs.workspace')}</Text>,
          tabBarIcon: ({ focused }) => <ActivePill focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="conversations"
        options={{
          title: tr('tabs.conversations'),
          tabBarAccessibilityLabel: tr('tabs.conversations'),
          tabBarLabel: ({ color }) => <Text testID="tab-conversations" style={[type.tabLabel, { color }]}>{tr('tabs.conversations')}</Text>,
          tabBarIcon: ({ focused }) => <ActivePill focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: tr('tabs.settings'),
          tabBarAccessibilityLabel: tr('tabs.settings'),
          tabBarLabel: ({ color }) => <Text testID="tab-settings" style={[type.tabLabel, { color }]}>{tr('tabs.settings')}</Text>,
          tabBarIcon: ({ focused }) => <ActivePill focused={focused} />,
        }}
      />
    </Tabs>
  );
}

/** The reference marks the active destination with a filled pill, not a coloured icon. */
function ActivePill(props: { focused: boolean }) {
  const { colors, radius } = useTheme();
  return (
    <View
      style={{
        width: props.focused ? 18 : 6,
        height: 3,
        borderRadius: radius.pill,
        backgroundColor: props.focused ? colors.accent : colors.textFaint,
      }}
    />
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 4,
  },
});
