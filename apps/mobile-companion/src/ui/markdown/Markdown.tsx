// UI ported from Clarklevis1995/dsh-mobile
//   androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/DshMarkdownText.kt
//   androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/DshMarkdownCodeCard.kt
//   androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/DshMarkdownTable.kt   (MIT)
//
// The transcript's markdown renderer.
//
// WHAT IS PORTED, AND WHAT IS NOT: upstream renders markdown through Markwon and then paints
// spans; their code card shows an uppercase language label above a numbered, monospace block, and
// their table card is a bordered grid that scrolls horizontally. Compose spans have no RN
// equivalent, so this file rebuilds the *look* on `parse.ts`'s block tree with plain Views/Text -
// native only, no WebView (spec 011 non-negotiable), and no markdown dependency.
//
// Every colour, size and radius comes from `src/ui/theme.ts`; a hex literal here would be a bug.
// Links never open by themselves: the press is handed to `onOpenLink`, and the screen asks the
// user before anything leaves the app.

import { memo, useMemo } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useTheme } from '../theme';
import {
  codeLines,
  parseMarkdown,
  type Align,
  type Block,
  type Inline,
  type ListBlock,
  type TableBlock,
} from './parse';

export interface MarkdownProps {
  /** Raw assistant markdown from the Host (untrusted). */
  source: string;
  /** Called when a link is tapped; the screen owns the confirmation dialog. */
  onOpenLink?: (href: string, label: string) => void;
}

/** Render one assistant message. Parsing is memoised per source string. */
export const Markdown = memo(function Markdown({ source, onOpenLink }: MarkdownProps) {
  const theme = useTheme();
  const blocks = useMemo(() => parseMarkdown(source), [source]);

  if (blocks.length === 0) return null;

  return (
    <View style={{ gap: theme.space.sm }}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} theme={theme} onOpenLink={onOpenLink} />
      ))}
    </View>
  );
});

type Theme = ReturnType<typeof useTheme>;

function BlockView({
  block,
  theme,
  onOpenLink,
}: {
  block: Block;
  theme: Theme;
  onOpenLink?: MarkdownProps['onOpenLink'];
}) {
  const { colors, type, space, radius } = theme;

  switch (block.kind) {
    case 'heading': {
      const style =
        block.level <= 1 ? type.title : block.level === 2 ? type.heading : type.subheading;
      return (
        <Text style={[style, { marginTop: space.sm }]} selectable>
          <Inlines inlines={block.inlines} theme={theme} onOpenLink={onOpenLink} />
        </Text>
      );
    }
    case 'paragraph':
      // Soft line breaks survive as newlines, which is what Clarklevis's SoftBreakAddsNewLine
      // plugin does upstream.
      return (
        <Text style={type.body} selectable>
          <Inlines inlines={block.inlines} theme={theme} onOpenLink={onOpenLink} />
        </Text>
      );
    case 'code':
      return <CodeCard block={block} theme={theme} />;
    case 'list':
      return <ListBlockView block={block} theme={theme} onOpenLink={onOpenLink} depth={0} />;
    case 'table':
      return <TableCard block={block} theme={theme} onOpenLink={onOpenLink} />;
    case 'rule':
      return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: space.sm }} />;
    default:
      return null;
  }
}

/** Inline spans as nested `<Text>`s so formatting composes inside one paragraph. */
function Inlines({
  inlines,
  theme,
  onOpenLink,
}: {
  inlines: Inline[];
  theme: Theme;
  onOpenLink?: MarkdownProps['onOpenLink'];
}) {
  const { colors, type, radius, space } = theme;
  return (
    <>
      {inlines.map((inline, index) => {
        switch (inline.kind) {
          case 'strong':
            return (
              <Text key={index} style={{ fontWeight: '600' }}>
                {inline.text}
              </Text>
            );
          case 'em':
            return (
              <Text key={index} style={{ fontStyle: 'italic' }}>
                {inline.text}
              </Text>
            );
          case 'code':
            // Their inline code is a small rounded chip on the code background.
            return (
              <Text
                key={index}
                style={[
                  type.mono,
                  {
                    backgroundColor: colors.codeBg,
                    borderRadius: radius.sm,
                    paddingHorizontal: space.xs,
                    color: colors.text,
                  },
                ]}
              >
                {inline.text}
              </Text>
            );
          case 'link':
            return (
              <Text
                key={index}
                accessibilityRole="link"
                accessibilityLabel={inline.text}
                onPress={onOpenLink ? () => onOpenLink(inline.href, inline.text) : undefined}
                style={{ color: colors.accent, textDecorationLine: 'underline' }}
              >
                {inline.text}
              </Text>
            );
          default:
            return <Text key={index}>{inline.text}</Text>;
        }
      })}
    </>
  );
}

/**
 * Their code card: language label, then a horizontally scrollable, line-numbered monospace body.
 * Line numbers come from `codeLines`, so a trailing blank line in the fence is not numbered.
 */
function CodeCard({ block, theme }: { block: Extract<Block, { kind: 'code' }>; theme: Theme }) {
  const { colors, type, space, radius } = theme;
  const lines = codeLines(block.text);
  const gutterWidth = Math.max(1, String(lines.length).length) * 8 + space.sm;

  return (
    <View style={{ backgroundColor: colors.codeBg, borderRadius: radius.md, overflow: 'hidden' }}>
      {block.language !== null ? (
        <Text
          style={[
            type.captionSmall,
            {
              color: colors.textMuted,
              letterSpacing: 1,
              textTransform: 'uppercase',
              paddingHorizontal: space.md,
              paddingTop: space.sm,
            },
          ]}
        >
          {block.language}
        </Text>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
        <View style={{ flexDirection: 'row', padding: space.md, gap: space.sm }}>
          <View style={{ width: gutterWidth, alignItems: 'flex-end' }}>
            {lines.map((_, index) => (
              <Text key={index} style={[type.mono, { color: colors.textFaint }]}>
                {index + 1}
              </Text>
            ))}
          </View>
          <View>
            {lines.length === 0 ? (
              <Text style={[type.mono, { color: colors.textMuted }]}> </Text>
            ) : (
              lines.map((line, index) => (
                <Text key={index} style={type.mono} selectable>
                  {line === '' ? ' ' : line}
                </Text>
              ))
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/** Bullet/number rows with nesting indent; their lists are marker + text, not a separate bullet view. */
function ListBlockView({
  block,
  theme,
  onOpenLink,
  depth,
}: {
  block: ListBlock;
  theme: Theme;
  onOpenLink?: MarkdownProps['onOpenLink'];
  depth: number;
}) {
  const { colors, type, space } = theme;
  return (
    <View style={{ paddingLeft: depth === 0 ? 0 : space.lg, gap: space.xxs }}>
      {block.items.map((item, index) => (
        <View key={index} style={{ flexDirection: 'row', gap: space.sm }}>
          <Text style={[type.body, { color: colors.textMuted, minWidth: 18 }]}>
            {block.ordered ? `${block.start + index}.` : '•'}
          </Text>
          <View style={{ flex: 1, gap: space.xs }}>
            {item.blocks.map((child, childIndex) =>
              child.kind === 'list' ? (
                <ListBlockView
                  key={childIndex}
                  block={child}
                  theme={theme}
                  onOpenLink={onOpenLink}
                  depth={depth + 1}
                />
              ) : child.kind === 'code' ? (
                <CodeCard key={childIndex} block={child} theme={theme} />
              ) : child.kind === 'paragraph' ? (
                <Text key={childIndex} style={type.body} selectable>
                  <Inlines inlines={child.inlines} theme={theme} onOpenLink={onOpenLink} />
                </Text>
              ) : (
                <BlockView key={childIndex} block={child} theme={theme} onOpenLink={onOpenLink} />
              ),
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

/** Their table card: a bordered grid that scrolls horizontally (reference: conversation-dark-mode). */
function TableCard({
  block,
  theme,
  onOpenLink,
}: {
  block: TableBlock;
  theme: Theme;
  onOpenLink?: MarkdownProps['onOpenLink'];
}) {
  const { colors, type, space, radius } = theme;
  const alignOf = (index: number): 'left' | 'center' | 'right' => {
    const value: Align = block.align[index] ?? null;
    return value ?? 'left';
  };

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator bounces={false}>
      <View
        style={{
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          borderRadius: radius.sm,
          overflow: 'hidden',
        }}
      >
        <Row cells={block.header} header theme={theme} onOpenLink={onOpenLink} alignOf={alignOf} />
        {block.rows.map((row, index) => (
          <Row key={index} cells={row} theme={theme} onOpenLink={onOpenLink} alignOf={alignOf} />
        ))}
      </View>
    </ScrollView>
  );
}

function Row({
  cells,
  header = false,
  theme,
  onOpenLink,
  alignOf,
}: {
  cells: TableBlock['header'];
  header?: boolean;
  theme: Theme;
  onOpenLink?: MarkdownProps['onOpenLink'];
  alignOf: (index: number) => 'left' | 'center' | 'right';
}) {
  const { colors, type, space } = theme;
  return (
    <View style={{ flexDirection: 'row', backgroundColor: header ? colors.surface : 'transparent' }}>
      {cells.map((cell, index) => (
        <View
          key={index}
          style={{
            minWidth: 120,
            maxWidth: 260,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.border,
            alignItems: alignOf(index) === 'center' ? 'center' : alignOf(index) === 'right' ? 'flex-end' : 'flex-start',
          }}
        >
          <Text
            style={[header ? type.subheading : type.bodySmall, { textAlign: alignOf(index) }]}
            selectable
          >
            <Inlines inlines={cell} theme={theme} onOpenLink={onOpenLink} />
          </Text>
        </View>
      ))}
    </View>
  );
}
