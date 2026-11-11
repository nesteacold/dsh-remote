// UI ported from Clarklevis1995/dsh-mobile androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/DshProductApp.kt
// (workspace home: brand hero, the workspace selector, "最近会话" recent-session cards, primary
// new-session action) and WorkspaceDirectoryUi.kt (the selector's sheet) (MIT).
//
// Spec 011 (mobile session authoring) — the home now performs the two authoring actions the wiring
// task added: pick a workspace (from the `workspaces` frame) and create a session in it
// (`session-create`, then open it). Everything is gated on the device's real grant:
//   * `grantedScopes` empty  → UNKNOWN, not denied (older gateway): neutral copy, control disabled;
//   * grant without the scope → honest "not granted" copy, control disabled;
//   * no workspace selected / none on the host → disabled with that reason.
// A control is never rendered enabled without a path to the Host.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { isAuthoringRefusal, reconnectInProgress } from '../../src/app-state';
import { isSubagentSession } from '../../src/core/sessions';
import { sessionDisplayTitle } from '../../src/ui/session-title';
import { relativeTime, type MessageKey } from '../../i18n';
import { useApp } from '../_layout';
import { Badge, Card, PrimaryButton, Screen, SectionLabel, StateMessage, StatusDot } from '../../src/ui/components/ui';
import {
  WorkspacePicker,
  grantState,
  newSessionAvailability,
  type LoadState,
} from '../../src/ui/components/authoring';
import { radius, space, useTheme } from '../../src/ui/theme';

/** How many sessions the home previews before "see all" (the reference shows three). */
const RECENT_LIMIT = 5;

export default function WorkspaceHome() {
  const { controller, snapshot, tr, locale } = useApp();
  const router = useRouter();
  const { colors, type } = useTheme();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<MessageKey | null>(null);

  // MEASURED on the live Host: 827 of 861 session rows are subagents. They are noise on a phone, so
  // the Recent list hides them by default — and never deletes them: the reveal line below shows them.
  const [showSubagents, setShowSubagents] = useState(false);
  const subagentCount = useMemo(() => snapshot.sessions.filter(isSubagentSession).length, [snapshot.sessions]);
  const recent = useMemo(
    () => snapshot.sessions
      .filter((session) => showSubagents || !isSubagentSession(session))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RECENT_LIMIT),
    [showSubagents, snapshot.sessions],
  );

  const grant = grantState(snapshot.grantedScopes);
  const workspacesState: LoadState = snapshot.workspacesState === 'error'
    ? { status: 'error', ...(snapshot.workspacesError === null ? {} : { code: snapshot.workspacesError }) }
    : { status: snapshot.workspacesState };
  const availability = newSessionAvailability({
    grantedScopes: snapshot.grantedScopes,
    workspaceId: selectedWorkspaceId,
    state: workspacesState,
    workspaceCount: snapshot.workspaces.length,
    busy: creating,
    // Never diagnose a permission problem before the socket is ready: mid-connect the app knows
    // nothing about scopes yet, and saying otherwise accuses the computer falsely.
    connection: snapshot.connection,
    // `reconnect` is the retry loop's state ('live' = healthy), so non-nullness is NOT a reconnect.
    reconnecting: reconnectInProgress(snapshot.reconnect),
  });

  // Load the workspace list once per connection, and only when this device may author at all.
  useEffect(() => {
    if (snapshot.connection !== 'ready' || grant !== 'granted') return;
    if (snapshot.workspacesState !== 'idle') return;
    void controller.listWorkspaces();
  }, [controller, grant, snapshot.connection, snapshot.workspacesState]);

  // Preselect the first workspace so the primary action is usable as soon as the list arrives; the
  // user can still change it. Only ever a workspace the Host reported.
  useEffect(() => {
    if (selectedWorkspaceId !== null) return;
    const first = snapshot.workspaces[0];
    if (first !== undefined) setSelectedWorkspaceId(first.id);
  }, [selectedWorkspaceId, snapshot.workspaces]);

  const createSession = useCallback(async () => {
    if (selectedWorkspaceId === null) return;
    setCreating(true);
    setCreateError(null);
    const result = await controller.createSession({ workspaceId: selectedWorkspaceId });
    setCreating(false);
    if (!result.ok) {
      setCreateError(isAuthoringRefusal(result.code) ? 'authoring.needScope' : 'authoring.createFailed');
      return;
    }
    router.push(`/session/${encodeURIComponent(result.value)}`);
  }, [controller, router, selectedWorkspaceId]);

  const showWorkspaceSelector = snapshot.activeHost !== null && (grant !== 'denied');

  return (
    <Screen testID="workspace-home">
      {/* ONE uniform radius on all four corners. Two per-corner radii (bottom-left/bottom-right)
          render asymmetrically on Android — the screenshot showed a rounded bottom-left and a square
          bottom-right notch. A single `borderRadius` cannot disagree with itself. */}
      <View style={[styles.hero, { backgroundColor: colors.atmosphere, borderRadius: radius.xl }]}>
        <Text style={[type.display, { color: colors.onAtmosphere, paddingHorizontal: space.xl }]}>{tr('home.hero')}</Text>
        <Text style={[type.bodySmall, { color: colors.onAtmosphereMuted, paddingHorizontal: space.xl, marginTop: space.xs }]}>
          {tr('home.heroSubtitle')}
        </Text>
      </View>

      {snapshot.activeHost === null ? (
        <StateMessage
          title={tr('home.emptyTitle')}
          body={tr('home.emptyBody')}
          actionLabel={tr('sessions.pair')}
          onAction={() => router.push('/pair')}
        />
      ) : recent.length === 0 && (snapshot.connection !== 'ready' || snapshot.loading) ? (
        // Before the first list has actually arrived, "no sessions yet" is a claim the app cannot
        // make — it is still loading. Only an empty list from a ready socket is really empty.
        <StateMessage title={tr('home.loadingSessions')} busy />
      ) : (
        <>
          {showWorkspaceSelector ? (
            <View style={{ paddingHorizontal: space.xl, paddingTop: space.xl }}>
              <WorkspacePicker
                items={snapshot.workspaces}
                selectedId={selectedWorkspaceId}
                state={workspacesState}
                onSelect={setSelectedWorkspaceId}
                onRetry={() => void controller.listWorkspaces()}
                labels={{
                  placeholder: tr('authoring.workspacePlaceholder'),
                  title: tr('authoring.workspaceTitle'),
                  retry: tr('authoring.retry'),
                  empty: tr('authoring.workspacesEmpty'),
                  loading: tr('authoring.loadingWorkspaces'),
                  error: tr('authoring.workspacesError'),
                  close: tr('authoring.close'),
                }}
              />
            </View>
          ) : null}

          {recent.length === 0 ? (
            <StateMessage title={tr('home.emptyTitle')} body={tr('home.emptyBody')} />
          ) : (
            <View style={{ paddingTop: space.xxl }}>
              <View style={styles.sectionHeader}>
                <SectionLabel>{tr('home.recent')}</SectionLabel>
              </View>
              <View style={{ paddingHorizontal: space.xl, gap: space.md }}>
                {recent.map((session) => {
                  const needsDecision = (snapshot.needsDecision[session.id] ?? 0) > 0 || session.needsDecision;
                  return (
                    <Card
                      key={session.id}
                      testID={`session-row-${session.id}`}
                      label={sessionDisplayTitle(session, tr, locale)}
                      onPress={() => router.push(`/session/${encodeURIComponent(session.id)}`)}
                    >
                      <View style={styles.rowLine}>
                        <StatusDot kind={needsDecision ? 'decision' : session.state === 'running' ? 'running' : 'idle'} />
                        <Text numberOfLines={1} style={[type.subheading, styles.rowTitle, { color: colors.text }]}>
                          {sessionDisplayTitle(session, tr, locale)}
                        </Text>
                        {session.state === 'running' ? (
                          <Badge label={tr('tabs.running')} tone="accent" />
                        ) : session.updatedAt === 0 ? null : (
                          <Text numberOfLines={1} style={[type.captionSmall, styles.rowTime, { color: colors.textMuted }]}>
                            {relativeTime(locale, Date.now() - session.updatedAt)}
                          </Text>
                        )}
                      </View>
                    </Card>
                  );
                })}
              </View>
            </View>
          )}

          {/* The one honest affordance to the hidden rows: nothing is hidden without a way to see it. */}
          {subagentCount === 0 ? null : (
            <View style={{ paddingHorizontal: space.xl, paddingTop: space.md }}>
              <Text
                accessibilityRole="button"
                accessibilityLabel={showSubagents
                  ? tr('home.hideSubagents')
                  : tr('home.showSubagents', { count: subagentCount })}
                onPress={() => setShowSubagents((current) => !current)}
                style={[type.caption, { color: colors.accent, minHeight: 44, textAlignVertical: 'center' }]}
              >
                {showSubagents
                  ? tr('home.hideSubagents')
                  : tr('home.showSubagents', { count: subagentCount })}
              </Text>
            </View>
          )}

          {/* Primary action: the reference's "新建会话". Disabled with its reason until a workspace is
              chosen and the device actually holds `sessions:author`. */}
          <View style={{ paddingHorizontal: space.xl, paddingTop: space.xxl, gap: space.sm }}>
            <PrimaryButton
              testID="new-session"
              label={tr('authoring.newSession')}
              onPress={() => void createSession()}
              disabled={!availability.enabled}
              busy={creating}
            />
            {availability.reason === null ? null : (
              // Hook for the device flows: the disabled reason is the only honest way to assert
              // "no permission" vs "connecting" without matching localised copy (spec 011 E2E).
              <Text testID="new-session-reason" style={[type.captionSmall, { color: colors.textFaint }]}>
                {tr(availability.reason)}
              </Text>
            )}
            {createError === null ? null : (
              <Text testID="new-session-error" style={[type.captionSmall, { color: colors.danger }]}>
                {tr(createError)}
              </Text>
            )}
          </View>

          {recent.length === 0 ? null : (
            <View style={{ paddingHorizontal: space.xl, paddingTop: space.lg }}>
              <Text
                accessibilityRole="button"
                accessibilityLabel={tr('home.seeAll')}
                onPress={() => router.push('/conversations')}
                style={[type.caption, { color: colors.accent, minHeight: 44, textAlignVertical: 'center' }]}
              >
                {tr('home.seeAll')}
              </Text>
            </View>
          )}

          {/* Clearance for the floating tab bar: with few/no rows the primary action was landing
              underneath it (the disabled "Phiên mới" sat behind the bar in the Vietnamese shot). */}
          <View style={{ height: space.xxxl * 3 }} />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // `overflow: 'hidden'` keeps the rounded outline authoritative even if a child paints to the edge.
  hero: { paddingTop: space.xxl, paddingBottom: space.xxl, overflow: 'hidden' },
  sectionHeader: { paddingHorizontal: space.xl, paddingBottom: space.sm },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowTitle: { flex: 1, minWidth: 0 },
  rowTime: { flexShrink: 0, marginLeft: space.sm },
});
