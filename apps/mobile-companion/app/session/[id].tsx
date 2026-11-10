// A023 / A024 — session screen (US3, US4, US6): history, approval cards (≤ 3 taps), composer
// with a stable clientMsgId, cancel-with-confirm, and the reconnect/offline banners.
//
// Approval rules (contract §5, FR-006):
//   * buttons only when `argsHash` is present  -> "decide on your computer" otherwise;
//   * a decision echoes the exact hash shown;
//   * `reason: hash-mismatch` reopens the card for review, `reason: not-pending` says
//     "already decided";
//   * an `approval-resolved` push closes the card.
// Taps to decide from fully visible content: 1 tap = single-approver decision (scroll position
// is preserved and the card is above the composer).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';

import type { ApprovalCardView } from '../../src/app-state';
import { redactArgsPreview } from '../../src/core';
import { t, type Interpolate, type Locale } from '../../i18n';
import { useApp } from '../_layout';

export default function SessionScreen() {
  const { controller, snapshot, tr, locale } = useApp();
  const params = useLocalSearchParams<{ id?: string; a?: string }>();
  const sessionId = typeof params.id === 'string' ? params.id : '';
  const focusApprovalId = typeof params.a === 'string' ? params.a : null;
  const navigation = useNavigation();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [focusedApproval, setFocusedApproval] = useState<string | null>(focusApprovalId);

  useEffect(() => {
    if (sessionId !== '') controller.openSession(sessionId);
    return () => controller.closeSession();
  }, [controller, sessionId]);

  const session = snapshot.sessions.find((entry) => entry.id === sessionId);
  useEffect(() => {
    navigation.setOptions({ title: session?.title ?? tr('common.host') });
  }, [navigation, session?.title, tr]);

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

  const outgoingByText = useMemo(
    () => new Map(snapshot.outgoing.map((item) => [item.clientMsgId, item])),
    [snapshot.outgoing],
  );

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {banner !== null ? (
        <View
          style={[styles.banner, snapshot.banner === 'reconnecting' ? styles.bannerInfo : styles.bannerWarn]}
          testID="banner"
          accessibilityLabel={banner}
        >
          <Text style={styles.bannerText}>{banner}</Text>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
        {snapshot.historyHasMore ? (
          <TouchableOpacity style={styles.secondary} onPress={() => void controller.loadOlderHistory()}>
            <Text>{tr('session.historyOlder')}</Text>
          </TouchableOpacity>
        ) : null}

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
          <View style={styles.centerArea}>
            {snapshot.connection === 'ready' ? <Text style={styles.muted}>{tr('session.empty')}</Text> : <ActivityIndicator />}
          </View>
        ) : null}

        {snapshot.history.map((message) => (
          <View key={message.id} style={[styles.message, message.role === 'user' ? styles.messageUser : null]}>
            <Text style={styles.messageRole}>{message.role}</Text>
            <Text style={styles.messageText}>{message.text}</Text>
            {message.pending ? <Text style={styles.muted}>{tr('session.pending')}</Text> : null}
          </View>
        ))}

        {snapshot.outgoing.map((item) => (
          <View key={item.clientMsgId} style={styles.message}>
            <Text style={styles.messageText}>{item.text}</Text>
            <Text style={styles.muted}>
              {item.status === 'failed' ? `${tr('session.failed')} (${item.lastError ?? ''})` : tr('session.pending')}
            </Text>
            {item.status === 'failed' ? (
              <TouchableOpacity style={styles.secondary} onPress={() => void controller.retryPrompt(item.clientMsgId)}>
                <Text>{tr('session.retry')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ))}
        {outgoingByText.size === 0 ? null : null}
      </ScrollView>

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          testID="session-composer"
          value={text}
          onChangeText={setText}
          placeholder={tr('session.composerPlaceholder')}
          multiline
          editable={snapshot.connection === 'ready'}
        />
        <TouchableOpacity
          style={[styles.primary, (text.trim() === '' || sending) && styles.disabled]}
          disabled={text.trim() === '' || sending}
          accessibilityRole="button"
          testID="session-send"
          onPress={() => void send()}
        >
          <Text style={styles.primaryText}>{tr('session.send')}</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={styles.cancel} accessibilityRole="button" onPress={confirmCancel}>
        <Text style={styles.cancelText}>{tr('session.cancel')}</Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

function ApprovalCardView(props: {
  card: ApprovalCardView;
  tr: Interpolate;
  focused: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onReload: () => void;
}) {
  const { card, tr, focused, busy, onApprove, onReject, onReload } = props;
  // Defense in depth: the server caps at 2 KB and the card shows a redacted, shorter preview.
  const preview = redactArgsPreview(card.argsPreview, 400);
  const reasonText =
    card.displayReason?.en ?? (Object.values(card.displayReason ?? {})[0] as string | undefined) ?? '';
  // M10: buttons only for a card that may actually be decided. A `review-again` card was
  // refused with `hash-mismatch` and reopens only after a fresh server view (see the
  // "Review again" action below).
  const decidable = card.canApprove && card.argsHash !== null && card.status === 'pending';
  return (
    <View style={[styles.card, focused ? styles.cardFocused : null]} testID={`approval-card-${card.approvalId}`}>
      <Text style={styles.cardTitle}>{tr('approval.title', { tool: card.toolName })}</Text>
      {reasonText !== '' ? <Text style={styles.cardReason}>{reasonText}</Text> : null}
      {preview !== '' ? <Text style={styles.cardPreview}>{preview}</Text> : null}

      {card.argsHash === null ? (
        <Text style={styles.cardNotice} testID={`approval-state-${card.approvalId}`}>
          {tr('approval.decideOnComputer')}
        </Text>
      ) : null}
      {card.status === 'review-again' ? (
        <Text style={styles.cardWarn} testID={`approval-state-${card.approvalId}`}>
          {card.notice ?? tr('approval.changed')}
        </Text>
      ) : null}
      {card.status === 'already-decided' ? (
        <Text style={styles.cardNotice} testID={`approval-state-${card.approvalId}`}>
          {card.notice ?? tr('approval.alreadyDecided')}
        </Text>
      ) : null}
      {card.status === 'resolved' ? (
        <Text style={styles.cardOk} testID={`approval-state-${card.approvalId}`}>
          {card.outcome === 'rejected' ? tr('approval.rejected') : tr('approval.approved')}
        </Text>
      ) : null}

      {decidable ? (
        <View style={styles.cardActions}>
          <TouchableOpacity
            style={[styles.approve, busy && styles.disabled]}
            disabled={busy}
            onPress={onApprove}
            accessibilityRole="button"
            testID={`approval-approve-${card.approvalId}`}
          >
            <Text style={styles.primaryText}>{tr('approval.approve')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.reject, busy && styles.disabled]}
            disabled={busy}
            onPress={onReject}
            accessibilityRole="button"
            testID={`approval-reject-${card.approvalId}`}
          >
            <Text style={styles.rejectText}>{tr('approval.reject')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {card.status === 'review-again' ? (
        <TouchableOpacity style={styles.secondary} onPress={onReload}>
          <Text>{tr('approval.reviewAgain')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function bannerCopy(tr: Interpolate, banner: 'reconnecting' | 'offline' | 'gateway-off' | 'revoked' | 'reauth'): string {
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
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: 12, gap: 10 },
  banner: { paddingVertical: 8, paddingHorizontal: 14 },
  bannerInfo: { backgroundColor: '#e0f2fe' },
  bannerWarn: { backgroundColor: '#fef3c7' },
  bannerText: { fontSize: 13 },
  centerArea: { padding: 32, alignItems: 'center' },
  muted: { fontSize: 12, opacity: 0.6 },
  message: { padding: 10, borderRadius: 12, backgroundColor: '#f8fafc', gap: 2 },
  messageUser: { backgroundColor: '#eff6ff' },
  messageRole: { fontSize: 11, opacity: 0.5, textTransform: 'uppercase' },
  messageText: { fontSize: 15 },
  card: { padding: 14, borderRadius: 14, backgroundColor: '#fff7ed', borderWidth: 1, borderColor: '#fdba74', gap: 8 },
  cardFocused: { borderColor: '#ea580c', borderWidth: 2 },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  cardReason: { fontSize: 13 },
  cardPreview: { fontSize: 12, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }), opacity: 0.8 },
  cardNotice: { fontSize: 13, color: '#92400e' },
  cardWarn: { fontSize: 13, color: '#b91c1c', fontWeight: '600' },
  cardOk: { fontSize: 13, color: '#15803d', fontWeight: '600' },
  cardActions: { flexDirection: 'row', gap: 10 },
  approve: { flex: 1, backgroundColor: '#16a34a', paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  reject: { flex: 1, backgroundColor: '#fff', borderWidth: 1, borderColor: '#dc2626', paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  rejectText: { color: '#dc2626', fontWeight: '600' },
  secondary: { alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: '#e2e8f0' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#e2e8f0' },
  input: { flex: 1, maxHeight: 120, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  primary: { backgroundColor: '#2563eb', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12 },
  primaryText: { color: '#fff', fontWeight: '600' },
  disabled: { opacity: 0.5 },
  cancel: { padding: 12, alignItems: 'center' },
  cancelText: { color: '#dc2626', fontWeight: '600' },
});
