// UI ported from Clarklevis1995/dsh-mobile androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/
// WorkspaceSessionSections.kt + SessionStatusUi.kt (session rows: status dot, one-line title,
// relative time, running badge) (MIT).
//
// Spec 011 P1-A item 4 — the full session list, moved here from `app/index.tsx` when the app gained
// the bottom tab bar. The list keeps the Running / Idle / Archived filter (real, backend-free
// filtering the companion already performs) as their segmented-control shape, because the device
// flows drive it by hook and removing it would strand them.
//
// GUARDS: this file is now the source that `test/ui-test-hooks.test.ts`,
// `test/sessions-screen.test.ts` and `e2e/check-flows.mjs` read, so it deliberately keeps the exact
// shapes those guards pin: the `{ tab, key }` TABS array, `session-row-<id>`, one `banner` hook with
// `accessibilityLabel={banner}`, the `const banner = ...` line and `if (banner === null) return null;`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';

import type { SessionSummary, SessionTab } from '../../src/core';
import { isSubagentSession } from '../../src/core/sessions';
import { sessionDisplayTitle } from '../../src/ui/session-title';
import { relativeTime, t, type MessageKey } from '../../i18n';
import { useApp } from '../_layout';
import { Badge, Screen, StatusDot } from '../../src/ui/components/ui';
import { space, useTheme } from '../../src/ui/theme';

/** The `{ tab, key }` shape is parsed by e2e/check-flows.mjs (`SESSION_TAB`). */
const TABS: Array<{ tab: SessionTab; key: MessageKey }> = [
  { tab: 'running', key: 'tabs.running' },
  { tab: 'idle', key: 'tabs.idle' },
  { tab: 'archived', key: 'tabs.archived' },
];

export default function ConversationsScreen() {
  const { controller, snapshot, tr, locale } = useApp();
  const router = useRouter();
  const { colors, type } = useTheme();
  const [tab, setTab] = useState<SessionTab>('running');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // MEASURED on the live Host: 827 of 861 rows are subagents. Hidden by default in this list too
  // (never deleted — the footer reveals them), because a phone user opening "Conversations" does not
  // mean 827 agent-thread rows.
  const [showSubagents, setShowSubagents] = useState(false);
  const subagentCount = useMemo(() => snapshot.sessions.filter(isSubagentSession).length, [snapshot.sessions]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return snapshot.sessions
      .filter((session) => session.state === tab)
      .filter((session) => showSubagents || !isSubagentSession(session))
      .filter((session) => needle === '' || session.title.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle));
  }, [query, showSubagents, snapshot.sessions, tab]);

  useEffect(() => {
    // Live search against the host, debounced; local filtering keeps typing instant.
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    if (query.trim() === '') return;
    searchTimer.current = setTimeout(() => {
      void controller.searchSessions(query);
    }, 300);
    return () => {
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    };
  }, [controller, query]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await controller.refreshSessions();
    setRefreshing(false);
  }, [controller]);

  const banner = snapshot.banner !== 'none' ? t(locale, bannerKey(snapshot.banner)) : null;
  const bannerWarn = snapshot.banner === 'offline' || snapshot.banner === 'gateway-off'
    || snapshot.banner === 'cleanup-failed';

  if (snapshot.activeHost === null) {
    // No usable host is exactly where a revocation lands (the controller drops the host and the
    // stored token), so the banner has to be explained here too — otherwise the user only sees
    // the empty state and never learns the computer revoked this device.
    return (
      <Screen testID="conversations-screen">
        <Banner banner={banner} warn={bannerWarn} />
        <View style={styles.center}>
          <Text style={[type.body, { color: colors.textMuted, textAlign: 'center' }]}>{tr('sessions.empty')}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tr('sessions.pair')}
            onPress={() => router.push('/pair')}
            style={({ pressed }) => [
              styles.pairAction,
              { backgroundColor: colors.accent, borderRadius: 999 },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[type.button, { color: colors.onAccent }]}>{tr('sessions.pair')}</Text>
          </Pressable>
        </View>
      </Screen>
    );
  }

  return (
    <Screen testID="conversations-screen">
      <Banner banner={banner} warn={bannerWarn} />
      {snapshot.pinnedTransportUnavailable ? (
        <View style={[styles.banner, { backgroundColor: colors.surface }]}>
          <Text style={[type.caption, { color: colors.warning }]}>{t(locale, 'banner.pinnedTransportMissing')}</Text>
        </View>
      ) : null}
      <Text style={[type.title, { color: colors.text, paddingHorizontal: space.xl, paddingTop: space.md }]}>
        {tr('conversations.title')}
      </Text>
      <TextInput
        style={[
          type.body,
          styles.search,
          { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border },
        ]}
        value={query}
        onChangeText={setQuery}
        placeholder={tr('sessions.search')}
        placeholderTextColor={colors.textFaint}
        accessibilityLabel={tr('sessions.search')}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      <View style={styles.tabs}>
        {TABS.map((entry) => {
          const active = tab === entry.tab;
          return (
            <Text
              key={entry.tab}
              testID={`sessions-tab-${entry.tab}`}
              accessibilityRole="tab"
              accessibilityLabel={tr(entry.key)}
              accessibilityState={{ selected: active }}
              onPress={() => setTab(entry.tab)}
              style={[
                type.captionSmall,
                styles.tab,
                {
                  backgroundColor: active ? colors.accent : colors.surface,
                  color: active ? colors.onAccent : colors.textMuted,
                  borderRadius: 999,
                },
              ]}
            >
              {tr(entry.key)}
            </Text>
          );
        })}
      </View>
      {snapshot.loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : (
        <FlashList
          data={visible}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 96 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.textMuted} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={[type.body, { color: colors.textMuted, textAlign: 'center' }]}>
                {tr(query.trim() === '' ? 'sessions.empty' : 'sessions.emptySearch')}
              </Text>
            </View>
          }
          ListFooterComponent={
            <>
              {subagentCount === 0 ? null : (
                <Text
                  accessibilityRole="button"
                  accessibilityLabel={showSubagents
                    ? tr('home.hideSubagents')
                    : tr('home.showSubagents', { count: subagentCount })}
                  onPress={() => setShowSubagents((current) => !current)}
                  style={[type.caption, styles.footerLink, { color: colors.accent }]}
                >
                  {showSubagents
                    ? tr('home.hideSubagents')
                    : tr('home.showSubagents', { count: subagentCount })}
                </Text>
              )}
              {tab === 'archived' && snapshot.hiddenOlderCount > 0 ? (
                <Text style={[type.captionSmall, styles.footer, { color: colors.textFaint }]}>
                  {tr('sessions.hiddenOlder', { count: snapshot.hiddenOlderCount })}
                </Text>
              ) : null}
            </>
          }
          renderItem={({ item }) => (
            <SessionRow
              session={item}
              title={sessionDisplayTitle(item, tr, locale)}
              needsDecision={snapshot.needsDecision[item.id] ?? 0}
              updatedAgo={item.updatedAt === 0 ? null : relativeTime(locale, Date.now() - item.updatedAt)}
              runningLabel={tr('tabs.running')}
              badgeLabel={tr('sessions.needsDecision')}
              onPress={() => router.push(`/session/${encodeURIComponent(item.id)}`)}
            />
          )}
        />
      )}
    </Screen>
  );
}

/**
 * One banner for both layouts (with a host, and the no-host empty state). Keeping it in one place
 * keeps the test hook (the `banner` id used as a Maestro anchor) and the localized accessibility
 * label identical, and renders nothing when there is no banner state to show.
 */
function Banner(props: { banner: string | null; warn: boolean }) {
  const { banner, warn } = props;
  const { colors, type } = useTheme();
  if (banner === null) return null;
  return (
    <View
      style={[styles.banner, { backgroundColor: warn ? colors.surfaceRaised : colors.surface }]}
      testID="banner"
      accessibilityLabel={banner}
    >
      <Text style={[type.caption, { color: warn ? colors.warning : colors.accent }]}>{banner}</Text>
    </View>
  );
}

function SessionRow(props: {
  session: SessionSummary;
  /** Display name from `sessionDisplayTitle` — never the wire id (a new session has no title). */
  title: string;
  needsDecision: number;
  updatedAgo: string | null;
  runningLabel: string;
  badgeLabel: string;
  onPress: () => void;
}) {
  const { session, title, needsDecision, updatedAgo, runningLabel, badgeLabel, onPress } = props;
  const { colors, type } = useTheme();
  const decision = needsDecision > 0 || session.needsDecision;
  return (
    <Pressable
      testID={`session-row-${session.id}`}
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { borderBottomColor: colors.border }, pressed && styles.pressed]}
    >
      <View style={styles.rowBody}>
        <View style={styles.rowLine}>
          <StatusDot kind={decision ? 'decision' : session.state === 'running' ? 'running' : 'idle'} />
          <Text numberOfLines={1} style={[type.subheading, styles.rowTitle, { color: colors.text }]}>
            {title}
          </Text>
          {session.state === 'running' ? <Badge label={runningLabel} tone="accent" /> : null}
          {updatedAgo === null ? null : (
            <Text numberOfLines={1} style={[type.captionSmall, styles.rowTime, { color: colors.textMuted }]}>{updatedAgo}</Text>
          )}
        </View>
        {/* The relative time already sits right-aligned on the line above (as in the reference's
            session rows). Repeating it as "updated 4 min" underneath was pure noise, so the second
            line now carries ONLY the decision hint, and nothing when there is none. */}
        {decision ? (
          <Text numberOfLines={1} style={[type.captionSmall, { color: colors.accent, marginTop: space.xxs }]}>{badgeLabel}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function bannerKey(banner: Exclude<ReturnType<typeof useApp>['snapshot']['banner'], 'none'>): MessageKey {
  switch (banner) {
    case 'reconnecting':
      return 'banner.reconnecting';
    case 'offline':
      return 'banner.offline';
    case 'gateway-off':
      return 'banner.gatewayOff';
    case 'revoked':
      return 'banner.revoked';
    case 'reauth':
      return 'banner.reauth';
    case 'cleanup-failed':
      return 'banner.cleanupFailed';
  }
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.lg },
  banner: { paddingVertical: space.sm, paddingHorizontal: space.lg },
  search: {
    marginHorizontal: space.xl,
    marginTop: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    minHeight: 44,
  },
  tabs: { flexDirection: 'row', paddingHorizontal: space.xl, gap: space.sm, paddingTop: space.md, paddingBottom: space.sm },
  tab: { paddingVertical: space.sm, paddingHorizontal: space.md, overflow: 'hidden', minHeight: 34 },
  // Rows share the home cards' horizontal inset (space.xl — the same inset the search field and the
  // tab strip above use) so both screens read as one app.
  // The row is a flex row so the title block can shrink between the dot and the trailing time;
  // without `minWidth: 0`/`flexShrink` the middle column refuses to shrink and the trailing time
  // is pushed past the parent's right edge (it used to render clipped on device).
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.7 },
  pairAction: { alignItems: 'center', justifyContent: 'center', minHeight: 52, paddingHorizontal: space.xxl, alignSelf: 'center' },
  rowBody: { flex: 1, minWidth: 0 },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowTitle: { flex: 1, minWidth: 0 },
  rowTime: { flexShrink: 0, marginLeft: space.sm },
  footer: { padding: space.lg, textAlign: 'center' },
  footerLink: { paddingHorizontal: space.xl, paddingVertical: space.md, minHeight: 44, textAlignVertical: 'center' },
});
