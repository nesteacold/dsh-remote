// UI ported from Clarklevis1995/dsh-mobile
//   androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/ConversationScreen.kt (MIT)
//
// Collapsed tool / system rows.
//
// WHAT CLARKLEVIS SHOWS, AND WHY THIS IS SIMPLER: their transcript renders a tool call as a compact
// pill naming the tool and its subject ("Think · reasoning", "Write · /path/file.ts",
// "Bash · npm test"), because their client receives structured tool-call frames.
//
// Our rows do not: `src/core/history.ts` gives us `role` ('user' | 'assistant' | 'tool' | 'system' |
// 'other'), `text`, `pending`, `at` and `seq` - and nothing else. There is no tool name, no path and
// no exit status, so inventing them would be fabricating protocol data. The honest port is the
// visual treatment they use (one muted line, collapsed, never dominating the transcript) over the
// fields we actually have: the role word plus the row's first line.
//
// If the contract later carries a tool name/subject on history rows (spec P2), only the label
// inside this component has to change.

import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme';

export interface ToolRowProps {
  /** Already-localized role word (e.g. `tr('session.role.tool')`). */
  label: string;
  /** The row's raw text; only its first non-empty line is shown. */
  text: string;
}

/** The first non-empty line, whitespace-collapsed, so a multi-line tool payload stays one row. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed.replace(/\s+/g, ' ');
  }
  return '';
}

export function ToolRow({ label, text }: ToolRowProps) {
  const theme = useTheme();
  const summary = firstLine(text);

  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.pill,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.xs,
          gap: theme.space.xs,
        },
      ]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={summary === '' ? label : `${label}: ${summary}`}
    >
      <Text style={[theme.type.captionSmall, styles.label, { color: theme.colors.textFaint }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[theme.type.caption, styles.text, { color: theme.colors.textMuted }]} numberOfLines={1}>
        {summary === '' ? '…' : summary}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', maxWidth: '100%' },
  label: { textTransform: 'uppercase', letterSpacing: 0.6 },
  text: { flexShrink: 1 },
});
