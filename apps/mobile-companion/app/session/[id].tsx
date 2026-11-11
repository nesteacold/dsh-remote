// A023 / A024 — session screen (US3, US4, US6): history, approval cards (≤ 3 taps), floating
// composer with a stable clientMsgId, stop-with-confirm, and the reconnect/offline banners.
//
// Shell, header and composer ported from Clarklevis1995/dsh-mobile
//   androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/ConversationScreen.kt,
//   SessionStatusUi.kt and HumanQuestionCard.kt (MIT).
//
// Approval rules (contract §5, FR-006) — UNCHANGED by the restyle:
//   * buttons only when `argsHash` is present  -> "decide on your computer" otherwise;
//   * a decision echoes the exact hash shown;
//   * `reason: hash-mismatch` reopens the card for review, `reason: not-pending` says
//     "already decided";
//   * an `approval-resolved` push closes the card.
// Taps to decide from fully visible content: 1 tap = single-approver decision (scroll position
// is preserved and the card is above the composer, never next to Send).
//
// Why the native stack header is hidden: Clarklevis draws the conversation header itself (back,
// one-line title, live status pill, "more"), and two stacked headers would waste the phone's
// shortest dimension. `headerShown: false` is set here, for this screen only.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ApprovalCardView } from '../../src/app-state';
import { isSubagentSession } from '../../src/core/sessions';
import { sessionDisplayTitle } from '../../src/ui/session-title';
import { promptSendLabel, promptSendState } from '../../src/ui/prompt-state';
import { redactArgsPreview } from '../../src/core';
import type { ClientState, HistoryMessage } from '../../src/core';
import { elevation, monoFont, useTheme } from '../../src/ui/theme';
import { SessionStatusPill } from '../../src/ui/conversation/SessionStatusPill';
import { ToolRow } from '../../src/ui/conversation/ToolRow';
import { Markdown } from '../../src/ui/markdown/Markdown';
// Spec 011 — the composer's leading model/mode row (ported from Clarklevis's ComposerMorphLayout).
import { ComposerModelRow, ModelPicker, modelUnavailableReasonKey } from '../../src/ui/components/authoring';
import { type Interpolate } from '../../i18n';
import { useApp } from '../_layout';

/** Composer growth: five body lines then it scrolls internally (Clarklevis caps at ~5). */
const COMPOSER_MAX_LINES = 5;

export default function SessionScreen() {
  const { controller, snapshot, tr, locale } = useApp();
  const params = useLocalSearchParams<{ id?: string; a?: string }>();
  const sessionId = typeof params.id === 'string' ? params.id : '';
  const focusApprovalId = typeof params.a === 'string' ? params.a : null;
  const navigation = useNavigation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { colors, type, space, radius, hit } = theme;

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [focusedApproval, setFocusedApproval] = useState<string | null>(focusApprovalId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  const sessionSummary = snapshot.sessions.find((session) => session.id === sessionId) ?? null;
  /** MEASURED: `models` for a subagent session fails with `session/agent-busy`, so never send it. */
  const subagentSession = sessionSummary !== null && isSubagentSession(sessionSummary);

  // Spec 011: fetch the model catalog for this session once a ready socket exists. The per-session
  // reply also carries the current selection, which is what the composer's row shows. Skipped for a
  // subagent session: that request can only fail today (its `models` needs a root address).
  useEffect(() => {
    if (subagentSession) return;
    if (snapshot.connection !== 'ready' || sessionId === '') return;
    if (snapshot.models.length > 0) return;
    void controller.listModels(sessionId);
  }, [controller, sessionId, snapshot.connection, snapshot.models.length, subagentSession]);

  useEffect(() => {
    if (sessionId !== '') controller.openSession(sessionId);
    return () => controller.closeSession();
  }, [controller, sessionId]);

  // One header, drawn below: the native one is hidden for this route only.
  useEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

  const session = snapshot.sessions.find((entry) => entry.id === sessionId);

  // A deep link / notification carries `a=<approvalId>`: highlight that card and bring the
  // list to the newest content once it has rendered.
  useEffect(() => {
    if (focusApprovalId === null) return;
    setFocusedApproval(focusApprovalId);
  }, [focusApprovalId, snapshot.openApprovals.length]);

  const banner = snapshot.banner !== 'none' ? bannerCopy(tr, snapshot.banner) : null;

  const send = useCallback(async () => {
    const value = text.trim();
    if (value === '' || sending) return;
    setSending(true);
    setText('');
    await controller.sendPrompt(value);
    setSending(false);
  }, [controller, sending, text]);

  const confirmCancel = useCallback(() => {
    Alert.alert(
      tr('session.cancelConfirmTitle'),
      tr('session.cancelConfirmBody'),
      [
        { text: tr('common.cancel'), style: 'cancel' },
        {
          text: tr('session.cancelConfirm'),
          style: 'destructive',
          onPress: () => {
            void controller.cancelSession();
          },
        },
      ],
      { cancelable: true },
    );
  }, [controller, tr]);

  // Assistant output is markdown from a remote Host. A link never opens by itself: the target is
  // shown and the user confirms first, which is the one place the transcript can leave the app.
  const openLink = useCallback(
    (href: string, _label: string) => {
      Alert.alert(
        tr('session.linkOpenTitle'),
        tr('session.linkOpenBody', { url: href }),
        [
          { text: tr('common.cancel'), style: 'cancel' },
          {
            text: tr('session.linkOpen'),
            onPress: () => {
              void Linking.openURL(href).catch(() => {
                /* the OS refused to open it; nothing to retry from here */
              });
            },
          },
        ],
        { cancelable: true },
      );
    },
    [tr],
  );

  // Sending is unavailable unless the socket is ready; say WHY instead of a dead button.
  const ready = snapshot.connection === 'ready';
  const sendReason = ready ? null : sendUnavailableCopy(tr, snapshot.connection);
  const canSend = ready && text.trim() !== '' && !sending;

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + space.sm,
            paddingHorizontal: space.lg,
            paddingBottom: space.sm,
            borderBottomColor: colors.border,
            backgroundColor: colors.bg,
          },
        ]}
      >
        <TouchableOpacity
          style={[styles.headerButton, { minWidth: hit, minHeight: hit }]}
          accessibilityRole="button"
          accessibilityLabel={tr('common.back')}
          hitSlop={8}
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/');
          }}
          testID="session-back"
        >
          <Text style={[type.heading, { color: colors.text }]}>‹</Text>
        </TouchableOpacity>

        <Text
          style={[type.subheading, styles.title, { color: colors.text, marginHorizontal: space.sm }]}
          numberOfLines={1}
          accessibilityRole="header"
          testID="session-title"
        >
          {session === undefined ? tr('common.host') : sessionDisplayTitle(session, tr, locale)}
        </Text>

        {session === undefined ? null : (
          <SessionStatusPill state={session.state} label={statusWord(tr, session.state)} />
        )}

        <TouchableOpacity
          style={[styles.headerButton, { minWidth: hit, minHeight: hit }]}
          accessibilityRole="button"
          accessibilityLabel={tr('session.more')}
          hitSlop={8}
          onPress={() => setMenuOpen(true)}
          testID="session-more"
        >
          <Text style={[type.heading, { color: colors.text }]}>⋯</Text>
        </TouchableOpacity>
      </View>

      {banner !== null ? (
        <View
          style={[
            styles.banner,
            {
              backgroundColor: snapshot.banner === 'reconnecting' ? colors.surface : colors.surfaceRaised,
              borderLeftColor: snapshot.banner === 'reconnecting' ? colors.warning : colors.danger,
              paddingHorizontal: space.lg,
              paddingVertical: space.sm,
            },
          ]}
          testID="banner"
          accessibilityLabel={banner}
        >
          <Text style={[type.caption, { color: colors.text }]}>{banner}</Text>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={[styles.list, { padding: space.lg, gap: space.md }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Older history is offered ONLY when the Host reported more AND gave a cursor to page with
            (`historyHasEarlier`). Before this, a `hasMore` with no cursor produced a button that
            visibly did nothing: the request went out without a cursor and the Host re-served the same
            page. While loading it is busy and locked, and a failure is explained instead of swallowed. */}
        {snapshot.historyHasEarlier ? (
          <TouchableOpacity
            style={[
              styles.loadOlder,
              {
                borderRadius: radius.pill,
                paddingHorizontal: space.lg,
                minHeight: hit,
                backgroundColor: colors.surface,
                opacity: snapshot.historyLoading ? 0.6 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={tr('session.historyOlder')}
            accessibilityState={{ busy: snapshot.historyLoading, disabled: snapshot.historyLoading }}
            disabled={snapshot.historyLoading}
            onPress={() => void controller.loadOlderHistory()}
          >
            {snapshot.historyLoading ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={[type.caption, { color: colors.accent }]}>{tr('session.historyOlder')}</Text>
            )}
          </TouchableOpacity>
        ) : null}

        {snapshot.historyError === null ? null : (
          <Text style={[type.captionSmall, { color: colors.textMuted, textAlign: 'center' }]}>
            {tr('session.historyFailed')}
          </Text>
        )}

        {snapshot.openApprovals.map((card) => (
          <ApprovalCardView
            key={card.approvalId}
            card={card}
            tr={tr}
            focused={focusedApproval === card.approvalId}
            busy={card.status === 'approving' || card.status === 'rejecting'}
            onApprove={() => void controller.decideApproval(card.approvalId, 'allowed-once')}
            onReject={() => void controller.decideApproval(card.approvalId, 'rejected')}
            onReload={() => controller.reloadApproval(card.approvalId)}
          />
        ))}

        {snapshot.history.length === 0 ? (
          <View style={[styles.centerArea, { padding: space.xxxl }]}>
            {snapshot.connection === 'ready' ? (
              <Text style={[type.bodySmall, { color: colors.textMuted }]}>{tr('session.empty')}</Text>
            ) : (
              <ActivityIndicator color={colors.textMuted} />
            )}
          </View>
        ) : null}

        {snapshot.history.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            tr={tr}
            onOpenLink={openLink}
          />
        ))}

        {snapshot.outgoing.map((item) => (
          <View
            key={item.clientMsgId}
            style={[
              styles.bubble,
              styles.bubbleUser,
              { backgroundColor: colors.accentSoft, borderRadius: radius.lg, padding: space.md, gap: space.xxs },
            ]}
          >
            <Text style={[type.body, { color: colors.text }]}>{item.text}</Text>
            <Text style={[type.captionSmall, { color: colors.textMuted }]}>
              {item.status === 'failed' ? `${tr('session.failed')} (${item.lastError ?? ''})` : tr('session.pending')}
            </Text>
            {item.status === 'failed' ? (
              <TouchableOpacity
                style={[styles.retry, { minHeight: hit, paddingHorizontal: space.md }]}
                accessibilityRole="button"
                accessibilityLabel={tr('session.retry')}
                onPress={() => void controller.retryPrompt(item.clientMsgId)}
              >
                <Text style={[type.caption, { color: colors.accent }]}>{tr('session.retry')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ))}
      </ScrollView>

      {/* Floating composer, Clarklevis style: one rounded capsule of glass above the safe area,
          the send action inside it, and the reason sending is unavailable spelled out. */}
      <View
        style={[
          styles.composerWrap,
          { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: insets.bottom + space.sm },
        ]}
      >
        {/* Spec 011 — the composer's leading row. ONE pill, and only when there is data behind it:
            the current model's own label plus a loaded catalog. The mode pill is intentionally
            absent (no wire source for companions); a placeholder word is never rendered as a value. */}
        <View style={{ paddingHorizontal: space.xs, paddingBottom: space.xs }}>
          {subagentSession ? (
            // A subagent session's model cannot be changed from here (today: the `models` request for
            // it fails with `session/agent-busy`), so there is no pill and no round trip — just one
            // honest line, in the same style as the other unavailable states.
            <Text style={[type.captionSmall, { color: colors.textMuted, paddingHorizontal: space.md, paddingBottom: space.xs }]}>
              {tr('authoring.modelSubagent')}
            </Text>
          ) : (
            <ComposerModelRow
              currentModel={snapshot.currentModel}
              hasCatalog={snapshot.models.length > 0}
              onOpenModel={() => setModelPickerOpen(true)}
              hint={tr('authoring.model')}
            />
          )}
          {/* Honest state instead of silence: a catalog that could not be read says why. The split
              lives in `modelUnavailableReasonKey` so a non-permission refusal (e.g. `session/agent-busy`)
              can never be reported as "not granted permission". */}
          {subagentSession || snapshot.modelsState !== 'error' ? null : (
            <Text style={[type.captionSmall, { color: colors.textMuted, paddingHorizontal: space.md, paddingBottom: space.xs }]}>
              {tr(modelUnavailableReasonKey(snapshot.modelsError))}
            </Text>
          )}
        </View>
        <ModelPicker
          visible={modelPickerOpen}
          items={snapshot.models}
          currentId={snapshot.currentModel?.id ?? null}
          state={snapshot.models.length > 0 ? { status: 'ready' } : { status: 'idle' }}
          onSelect={(model) => {
            setModelPickerOpen(false);
            void controller.selectModel({ sessionId, modelId: model.id, ...(model.provider === undefined ? {} : { provider: model.provider }) });
          }}
          onClose={() => setModelPickerOpen(false)}
          onRetry={() => void controller.listModels(sessionId)}
          labels={{
            title: tr('authoring.model'),
            retry: tr('authoring.retry'),
            empty: tr('authoring.workspacesEmpty'),
            loading: tr('authoring.loadingWorkspaces'),
            error: tr('authoring.workspacesError'),
            close: tr('authoring.close'),
          }}
        />
        {sendReason !== null ? (
          <View
            style={[styles.reason, { paddingBottom: space.xs, paddingHorizontal: space.xs }]}
            accessible
            accessibilityLabel={sendReason}
            testID="session-send-reason"
          >
            <Text style={[type.captionSmall, { color: colors.textMuted }]}>{sendReason}</Text>
          </View>
        ) : null}
        <View
          style={[
            styles.composer,
            {
              backgroundColor: colors.surfaceRaised,
              borderColor: colors.border,
              borderRadius: radius.xxl,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              gap: space.sm,
              ...elevation(colors, 'bar'),
            },
          ]}
        >
          <TextInput
            style={[
              type.body,
              styles.input,
              {
                color: colors.text,
                maxHeight: COMPOSER_MAX_LINES * (type.body.lineHeight ?? 22) + space.md,
                paddingVertical: space.xs,
              },
            ]}
            testID="session-composer"
            value={text}
            onChangeText={setText}
            placeholder={tr('session.composerPlaceholder')}
            placeholderTextColor={colors.textMuted}
            accessibilityLabel={tr('session.composerPlaceholder')}
            multiline
            editable={snapshot.connection === 'ready'}
            textAlignVertical="center"
          />
          <TouchableOpacity
            style={[
              styles.send,
              {
                backgroundColor: canSend ? colors.accent : colors.surface,
                borderRadius: radius.pill,
                minWidth: hit,
                minHeight: hit,
                paddingHorizontal: space.md,
              },
            ]}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel={tr('session.send')}
            accessibilityState={{ disabled: !canSend, busy: sending }}
            testID="session-send"
            onPress={() => void send()}
          >
            {sending ? (
              <ActivityIndicator color={colors.onAccent} />
            ) : (
              <Text style={[type.button, { color: canSend ? colors.onAccent : colors.textFaint }]}>
                {tr('session.send')}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* "More" holds exactly one action today: stopping the session. Rename/archive/pin are
          admin-only operations (P2) and would be a promise the app cannot keep. */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable
          style={[styles.scrim, { backgroundColor: colors.overlay }]}
          onPress={() => setMenuOpen(false)}
          accessibilityRole="button"
          accessibilityLabel={tr('common.cancel')}
        >
          <View
            style={[
              styles.menu,
              {
                backgroundColor: colors.surfaceRaised,
                borderColor: colors.border,
                borderRadius: radius.xl,
                marginTop: 64,
                marginRight: space.lg,
                ...elevation(colors, 'sheet'),
              },
            ]}
          >
            <TouchableOpacity
              style={[styles.menuItem, { minHeight: hit, paddingHorizontal: space.lg }]}
              accessibilityRole="button"
              accessibilityLabel={tr('session.cancel')}
              onPress={() => {
                setMenuOpen(false);
                confirmCancel();
              }}
              testID="session-stop"
            >
              <Text style={[type.body, { color: colors.danger }]}>{tr('session.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

/**
 * One history row. Assistant output is markdown; our own prompts and the host's tool/system rows
 * are not prose, so they get a bubble and a compact muted pill respectively (Clarklevis draws
 * its tool calls the same way).
 */
function MessageRow(props: {
  message: HistoryMessage;
  tr: Interpolate;
  onOpenLink: (href: string, label: string) => void;
}) {
  const { message, tr, onOpenLink } = props;
  const { colors, type, space, radius } = useTheme();

  if (message.role === 'tool' || message.role === 'system' || message.role === 'other') {
    return (
      <ToolRow
        label={message.role === 'tool' ? tr('session.role.tool') : message.role === 'system' ? tr('session.role.system') : tr('session.role.other')}
        text={message.text}
      />
    );
  }

  if (message.role === 'user') {
    return (
      <View
        style={[
          styles.bubble,
          styles.bubbleUser,
          { backgroundColor: colors.accentSoft, borderRadius: radius.lg, padding: space.md, gap: space.xxs },
        ]}
      >
        <Text style={[type.body, { color: colors.text }]}>{message.text}</Text>
        <PromptSendState message={message} />
      </View>
    );
  }

  return (
    <View style={[styles.assistant, { gap: space.xxs }]}>
      <Markdown source={message.text} onOpenLink={onOpenLink} />
      <PromptSendState message={message} />
    </View>
  );
}

/**
 * The one line under a prompt bubble that says what happened to it.
 *
 * Driven by `promptSendState`: "sending" only while the receipt is genuinely outstanding, "not
 * confirmed" once the request timeout has passed, and the refusal reason when the Host said no — a
 * bubble can never sit in "đang gửi…" after the turn is visibly running.
 */
function PromptSendState(props: { message: HistoryMessage }) {
  const { tr } = useApp();
  const { colors, type } = useTheme();
  const { message } = props;
  const now = Date.now();
  const label = promptSendLabel(message, tr, now);
  if (label === null) return null;
  const failed = promptSendState(message, now) === 'failed';
  return (
    <Text style={[type.captionSmall, { color: failed ? colors.danger : colors.textMuted }]}>{label}</Text>
  );
}

function ApprovalCardView(props: {  card: ApprovalCardView;
  tr: Interpolate;
  focused: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onReload: () => void;
}) {
  const { card, tr, focused, busy, onApprove, onReject, onReload } = props;
  const { colors, type, space, radius } = useTheme();
  // Defense in depth: the server caps at 2 KB and the card shows a redacted, shorter preview.
  const preview = redactArgsPreview(card.argsPreview, 400);
  const reasonText =
    card.displayReason?.en ?? (Object.values(card.displayReason ?? {})[0] as string | undefined) ?? '';
  // M10: buttons only for a card that may actually be decided. A `review-again` card was
  // refused with `hash-mismatch` and reopens only after a fresh server view (see the
  // "Review again" action below).
  const decidable = card.canApprove && card.argsHash !== null && card.status === 'pending';
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surfaceRaised,
          borderColor: focused ? colors.accent : colors.border,
          borderWidth: focused ? 2 : StyleSheet.hairlineWidth,
          borderRadius: radius.lg,
          padding: space.lg,
          gap: space.sm,
          ...elevation(colors, 'card'),
        },
      ]}
      testID={`approval-card-${card.approvalId}`}
    >
      <Text style={[type.subheading, { color: colors.text }]}>{tr('approval.title', { tool: card.toolName })}</Text>
      {reasonText !== '' ? (
        <Text style={[type.bodySmall, { color: colors.textMuted }]}>{reasonText}</Text>
      ) : null}
      {preview !== '' ? (
        <View style={{ backgroundColor: colors.codeBg, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs }}>
          <Text style={[type.mono, { fontFamily: Platform.select(monoFont), color: colors.text }]}>{preview}</Text>
        </View>
      ) : null}

      {card.argsHash === null ? (
        <Text style={[type.caption, { color: colors.textMuted }]} testID={`approval-state-${card.approvalId}`}>
          {tr('approval.decideOnComputer')}
        </Text>
      ) : null}
      {card.status === 'review-again' ? (
        <Text style={[type.caption, { color: colors.danger, fontWeight: '600' }]} testID={`approval-state-${card.approvalId}`}>
          {card.notice ?? tr('approval.changed')}
        </Text>
      ) : null}
      {card.status === 'already-decided' ? (
        <Text style={[type.caption, { color: colors.textMuted }]} testID={`approval-state-${card.approvalId}`}>
          {card.notice ?? tr('approval.alreadyDecided')}
        </Text>
      ) : null}
      {card.status === 'resolved' ? (
        <Text style={[type.caption, { color: colors.success, fontWeight: '600' }]} testID={`approval-state-${card.approvalId}`}>
          {card.outcome === 'rejected' ? tr('approval.rejected') : tr('approval.approved')}
        </Text>
      ) : null}

      {decidable ? (
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.xxs }}>
          <TouchableOpacity
            style={[
              styles.decision,
              { backgroundColor: colors.success, borderRadius: radius.md, minHeight: 48, paddingHorizontal: space.lg },
              busy && styles.disabled,
            ]}
            disabled={busy}
            onPress={onApprove}
            accessibilityRole="button"
            accessibilityLabel={tr('approval.approve')}
            accessibilityState={{ disabled: busy }}
            testID={`approval-approve-${card.approvalId}`}
          >
            <Text style={[type.button, { color: colors.onAccent }]}>{tr('approval.approve')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.decision,
              {
                backgroundColor: colors.surface,
                borderColor: colors.danger,
                borderRadius: radius.md,
                minHeight: 48,
                paddingHorizontal: space.lg,
              },
              busy && styles.disabled,
            ]}
            disabled={busy}
            onPress={onReject}
            accessibilityRole="button"
            accessibilityLabel={tr('approval.reject')}
            accessibilityState={{ disabled: busy }}
            testID={`approval-reject-${card.approvalId}`}
          >
            <Text style={[type.button, { color: colors.danger }]}>{tr('approval.reject')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {card.status === 'review-again' ? (
        <TouchableOpacity
          style={[styles.reload, { borderRadius: radius.pill, minHeight: 44, paddingHorizontal: space.lg, backgroundColor: colors.surface }]}
          accessibilityRole="button"
          accessibilityLabel={tr('approval.reviewAgain')}
          onPress={onReload}
        >
          <Text style={[type.caption, { color: colors.accent }]}>{tr('approval.reviewAgain')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/** The header pill's word, reusing the session-list vocabulary so both screens agree. */
function statusWord(tr: Interpolate, state: 'running' | 'idle' | 'archived'): string {
  if (state === 'running') return tr('tabs.running');
  if (state === 'archived') return tr('tabs.archived');
  return tr('tabs.idle');
}

/**
 * Why sending is unavailable, in the user's words. A reconnecting socket is "connecting" (type
 * now, send when it lands); anything terminal is "offline" — the app will not silently drop the
 * prompt, so it must say the socket is not there.
 */
function sendUnavailableCopy(tr: Interpolate, connection: ClientState): string {
  if (connection === 'connecting' || connection === 'waiting-hello' || connection === 'waiting-client-hello') {
    return tr('session.sendNotReady');
  }
  return tr('session.sendOffline');
}

function bannerCopy(
  tr: Interpolate,
  banner: 'reconnecting' | 'offline' | 'gateway-off' | 'revoked' | 'reauth' | 'cleanup-failed',
): string {
  switch (banner) {
    case 'reconnecting':
      return tr('banner.reconnecting');
    case 'offline':
      return tr('banner.offline');
    case 'gateway-off':
      return tr('banner.gatewayOff');
    case 'revoked':
      return tr('banner.revoked');
    case 'reauth':
      return tr('banner.reauth');
    case 'cleanup-failed':
      return tr('banner.cleanupFailed');
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  headerButton: { alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1 },
  list: { paddingBottom: 120 },
  centerArea: { alignItems: 'center' },
  banner: { borderLeftWidth: 3 },
  loadOlder: { alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  bubble: { maxWidth: '86%' },
  bubbleUser: { alignSelf: 'flex-end' },
  assistant: { alignSelf: 'stretch' },
  retry: { alignSelf: 'flex-start', justifyContent: 'center' },
  composerWrap: { justifyContent: 'flex-end' },
  reason: { alignItems: 'center' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, paddingHorizontal: 0 },
  send: { alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: StyleSheet.hairlineWidth },
  decision: { flex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  reload: { alignSelf: 'flex-start', alignItems: 'center', justifyContent: 'center' },
  scrim: { flex: 1, alignItems: 'flex-end' },
  menu: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  menuItem: { justifyContent: 'center' },
  disabled: { opacity: 0.5 },
});
