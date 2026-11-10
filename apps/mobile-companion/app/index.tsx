// A022 / A024 — session list (US2): three tabs (running / idle / archived), search, the
// "needs your decision" badge, refresh, reconnect/offline banners and a FlashList for the
// 200-session smoothness target (SC-006).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';

import type { SessionSummary, SessionTab } from '../src/core';
import { relativeTime, t, type MessageKey } from '../i18n';
import { useApp } from './_layout';

const TABS: Array<{ tab: SessionTab; key: MessageKey }> = [
  { tab: 'running', key: 'tabs.running' },
  { tab: 'idle', key: 'tabs.idle' },
  { tab: 'archived', key: 'tabs.archived' },
];

export default function SessionsScreen() {
  const { controller, snapshot, tr, locale } = useApp();
  const router = useRouter();
  const [tab, setTab] = useState<SessionTab>('running');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return snapshot.sessions
      .filter((session) => session.state === tab)
      .filter((session) => needle === '' || session.title.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle));
  }, [query, snapshot.sessions, tab]);

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
  const bannerWarn = snapshot.banner === 'offline' || snapshot.banner === 'gateway-off';

  if (snapshot.activeHost === null) {
    // No usable host is exactly where a revocation lands (the controller drops the host and the
    // stored token), so the banner has to be explained here too — otherwise the user only sees
    // the empty state and never learns the computer revoked this device.
    return (
      <View style={styles.container}>
        <Banner banner={banner} warn={bannerWarn} />
        <View style={styles.center}>
          <Text style={styles.empty}>{tr('sessions.empty')}</Text>
          <TouchableOpacity style={styles.primary} onPress={() => router.push('/pair')}>
            <Text style={styles.primaryText}>{tr('sessions.pair')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Banner banner={banner} warn={bannerWarn} />
      {snapshot.pinnedTransportUnavailable ? (
        <View style={[styles.banner, styles.bannerWarn]}>
          <Text style={styles.bannerText}>{t(locale, 'banner.pinnedTransportMissing')}</Text>
        </View>
      ) : null}
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder={tr('sessions.search')}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      <View style={styles.tabs}>
        {TABS.map((entry) => (
          <TouchableOpacity
            key={entry.tab}
            style={[styles.tab, tab === entry.tab && styles.tabActive]}
            testID={`sessions-tab-${entry.tab}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === entry.tab }}
            onPress={() => setTab(entry.tab)}
          >
            <Text style={[styles.tabText, tab === entry.tab && styles.tabTextActive]}>{tr(entry.key)}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {snapshot.loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlashList
          data={visible}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.empty}>{tr(query.trim() === '' ? 'sessions.empty' : 'sessions.emptySearch')}</Text>
            </View>
          }
          ListFooterComponent={
            tab === 'archived' && snapshot.hiddenOlderCount > 0 ? (
              <Text style={styles.footer}>{tr('sessions.hiddenOlder', { count: snapshot.hiddenOlderCount })}</Text>
            ) : null
          }
          renderItem={({ item }) => (
            <SessionRow
              session={item}
              needsDecision={snapshot.needsDecision[item.id] ?? 0}
              updatedAgo={item.updatedAt === 0 ? null : relativeTime(locale, Date.now() - item.updatedAt)}
              badgeLabel={tr('sessions.needsDecision')}
              updatedLabel={(when) => tr('sessions.updatedAgo', { when })}
              onPress={() => router.push(`/session/${encodeURIComponent(item.id)}`)}
            />
          )}
        />
      )}
      <View style={styles.actions}>
        <TouchableOpacity style={styles.secondary} onPress={() => router.push('/pair')}>
          <Text>{tr('sessions.pair')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondary}
          onPress={() => {
            void controller.forget();
          }}
        >
          <Text>{tr('sessions.forget')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * One banner for both layouts (with a host, and the no-host empty state). Keeping it in one place
 * keeps the hook (`testID="banner"`, a Maestro anchor) and the localized accessibility label
 * identical, and renders nothing when there is no banner state to show.
 */
function Banner(props: { banner: string | null; warn: boolean }) {
  const { banner, warn } = props;
  if (banner === null) return null;
  return (
    <View
      style={[styles.banner, warn ? styles.bannerWarn : null]}
      testID="banner"
      accessibilityLabel={banner}
    >
      <Text style={styles.bannerText}>{banner}</Text>
    </View>
  );
}

function SessionRow(props: {
  session: SessionSummary;
  needsDecision: number;
  updatedAgo: string | null;
  badgeLabel: string;
  updatedLabel: (when: string) => string;
  onPress: () => void;
}) {
  const { session, needsDecision, updatedAgo, badgeLabel, updatedLabel, onPress } = props;
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      testID={`session-row-${session.id}`}
    >
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {session.title}
        </Text>
        <Text style={styles.rowMeta}>
          {session.state}
          {updatedAgo === null ? '' : ` · ${updatedLabel(updatedAgo)}`}
        </Text>
      </View>
      {needsDecision > 0 ? (
        <View style={styles.badge} accessibilityLabel={badgeLabel}>
          <Text style={styles.badgeText}>{needsDecision > 1 ? needsDecision : '!'}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
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
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  empty: { fontSize: 15, opacity: 0.7, textAlign: 'center' },
  primary: { backgroundColor: '#2563eb', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  primaryText: { color: '#fff', fontWeight: '600' },
  secondary: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: '#e2e8f0' },
  banner: { paddingVertical: 8, paddingHorizontal: 14, backgroundColor: '#e0f2fe' },
  bannerWarn: { backgroundColor: '#fef3c7' },
  bannerText: { fontSize: 13 },
  search: { margin: 12, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, gap: 8 },
  tab: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: '#f1f5f9' },
  tabActive: { backgroundColor: '#2563eb' },
  tabText: { fontSize: 14, fontWeight: '500' },
  tabTextActive: { color: '#fff' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e2e8f0' },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 12, opacity: 0.6 },
  badge: { minWidth: 26, height: 26, borderRadius: 13, backgroundColor: '#dc2626', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  footer: { padding: 14, fontSize: 12, opacity: 0.6, textAlign: 'center' },
  actions: { flexDirection: 'row', justifyContent: 'space-between', padding: 12, gap: 8 },
});
