// UI ported from Clarklevis1995/dsh-mobile
//   androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/SessionStatusUi.kt (MIT)
//
// The conversation header's status pill.
//
// Clarklevis shows a small dot + word next to the title ("● 运行中" - running), and the dot is the
// only saturated colour in the header: green/accent while a turn is working, muted otherwise. Their
// pill is a rounded `surface` capsule with caption type; the label text comes from our own i18n
// (`tabs.running` / `tabs.idle`) so the string stays translatable and consistent with the list
// screen's tabs.

import { StyleSheet, Text, View } from 'react-native';

import type { SessionState } from '../../core/sessions';
import { StatusDot } from '../components/ui';
import { useTheme } from '../theme';

export interface SessionStatusPillProps {
  state: SessionState;
  /** Already-localized status word (e.g. `tr('tabs.running')`). */
  label: string;
}

export function SessionStatusPill({ state, label }: SessionStatusPillProps) {
  const theme = useTheme();
  const running = state === 'running';
  const archived = state === 'archived';

  return (
    <View
      style={[
        styles.pill,
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.pill,
          paddingHorizontal: theme.space.sm,
          paddingVertical: theme.space.xxs,
          gap: theme.space.xs,
        },
      ]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
    >
      <StatusDot kind={running ? 'running' : archived ? 'muted' : 'idle'} />
      <Text
        style={[
          theme.type.caption,
          { color: running ? theme.colors.text : theme.colors.textMuted },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
});
