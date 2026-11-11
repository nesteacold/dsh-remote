// A021 — pair screen (US1): scan the QR with expo-camera or paste the code, then pair.
//
// Error states required by spec 002 US1 + edge cases, each mapped from a typed core code:
//   * remote control off on the host      -> "turn on remote control on your computer"
//   * expired / reused code               -> show a new code
//   * certificate mismatch                -> not that computer, nothing was sent
//   * unreachable host                    -> same network / gateway running
//   * protocol mismatch                   -> update app / update host
//   * camera permission denied            -> paste instead
//
// The pairing code is never displayed, logged or put in a URL (FR-011).

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';

import { pairErrorFromCode, pairErrorFromQr, t, type MessageKey } from '../i18n';
import { useApp } from './_layout';
// UI ported from Clarklevis1995/dsh-mobile androidApp/.../ui/GatewayAuthenticationUi.kt (MIT).
import { useTheme } from '../src/ui/theme';
import type { Palette } from '../src/ui/theme';

export default function PairScreen() {
  const { controller, snapshot, tr } = useApp();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [failure, setFailure] = useState<MessageKey | null>(null);
  const [connectingTo, setConnectingTo] = useState<string | null>(null);

  const submit = useCallback(
    async (raw: string) => {
      if (busy || raw.trim() === '') return;
      setBusy(true);
      setFailure(null);
      const parsed = controller.parsePairPayload(raw);
      if (!parsed.ok) {
        setFailure(errorKey(pairErrorFromQr(parsed.code as never)));
        setBusy(false);
        setScanLocked(false);
        return;
      }
      setConnectingTo(parsed.payload.gatewayName);
      const result = await controller.pair(raw);
      setBusy(false);
      if (result.ok) {
        router.replace('/');
        return;
      }
      setConnectingTo(null);
      setFailure(errorKey(pairErrorFromCode(result.code)));
      setScanLocked(false);
    },
    [busy, controller, router],
  );

  // A pairing failure the controller recorded outside `pair()` (close 4004, version gate).
  useEffect(() => {
    if (snapshot.pairing === null) return;
    setFailure(errorKey(pairErrorFromCode(snapshot.pairing.code)));
  }, [snapshot.pairing]);

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>{tr('pair.title')}</Text>

      {snapshot.pairingPending ? (
        // Contract §3.8: the proof was accepted and the desktop user must approve. The code the
        // desktop shows is the only thing that proves both ends are talking to each other, so it is
        // rendered large and centred (ported from GatewayAuthenticationUi.kt's approval state).
        <View style={styles.codeCard} accessibilityRole="summary" accessibilityLabel={tr('pair.waitingApproval', { code: snapshot.pairingPending.verificationCode })}>
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.code}>{snapshot.pairingPending.verificationCode}</Text>
          <Text style={styles.codeHint}>{tr('pair.waitingApproval', { code: snapshot.pairingPending.verificationCode })}</Text>
        </View>
      ) : connectingTo !== null ? (
        <View style={styles.notice}>
          <ActivityIndicator />
          <Text style={styles.noticeText}>{tr('pair.connecting', { host: connectingTo })}</Text>
        </View>
      ) : null}

      {failure !== null ? (
        <View style={styles.error} accessibilityRole="alert">
          <Text style={styles.errorTitle}>{tr('pair.errorTitle')}</Text>
          <Text style={styles.errorText}>{tr(failure)}</Text>
        </View>
      ) : null}

      {permission?.granted === false ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{tr('pair.cameraPermission')}</Text>
          <TouchableOpacity style={styles.secondary} onPress={() => void requestPermission()}>
            <Text style={styles.secondaryText}>{tr('pair.cameraPermissionButton')}</Text>
          </TouchableOpacity>
        </View>
      ) : permission?.granted ? (
        <View style={styles.cameraFrame}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={
              scanLocked || busy
                ? undefined
                : (scan) => {
                    setScanLocked(true);
                    void submit(scan.data);
                  }
            }
          />
          <View style={styles.scanHint}>
            <Text style={styles.scanHintText}>{tr('pair.scan')}</Text>
          </View>
        </View>
      ) : (
        <View style={styles.notice}>
          <ActivityIndicator />
        </View>
      )}

      <Text style={styles.section}>{tr('pair.manual')}</Text>
      <TextInput
        style={styles.input}
        testID="pair-manual-input"
        value={manual}
        onChangeText={setManual}
        placeholder={tr('pair.manualPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        numberOfLines={3}
        editable={!busy}
        // The pasted code stays on screen only while typing; it is never persisted.
        textContentType="none"
        importantForAutofill="no"
      />
      <TouchableOpacity
        style={[styles.primary, (busy || manual.trim() === '') && styles.disabled]}
        testID="pair-submit"
        accessibilityRole="button"
        disabled={busy || manual.trim() === ''}
        onPress={() => void submit(manual)}
      >
        <Text style={styles.primaryText}>{tr('pair.submit')}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function errorKey(kind: ReturnType<typeof pairErrorFromCode>): MessageKey {
  switch (kind) {
    case 'remoteDisabled':
      return 'pair.error.remoteDisabled';
    case 'expired':
      return 'pair.error.expired';
    // Contract §3.8 outcomes.
    case 'rejected':
      return 'pair.error.rejected';
    case 'timeout':
      return 'pair.error.timeout';
    case 'otpUnsupported':
      return 'pair.error.otpUnsupported';
    case 'pinMismatch':
      return 'pair.error.pinMismatch';
    case 'unavailable':
      return 'pair.error.unavailable';
    case 'appUpdate':
      return 'pair.error.appUpdate';
    case 'hostUpdate':
      return 'pair.error.hostUpdate';
    default:
      return 'pair.error.generic';
  }
}

// Every colour comes from the theme palette (spec 011 U1: no hex literal outside src/ui/theme.ts).
function makeStyles(palette: Palette) {
  return StyleSheet.create({
    container: { padding: 20, gap: 14 },
    heading: { fontSize: 24, fontWeight: '700', color: palette.text },
    cameraFrame: { height: 280, borderRadius: 18, overflow: 'hidden', backgroundColor: palette.atmosphere },
    scanHint: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 10, backgroundColor: palette.overlay },
    scanHintText: { color: palette.onAtmosphere, textAlign: 'center', fontSize: 13 },
    codeCard: { paddingVertical: 24, borderRadius: 18, backgroundColor: palette.surface, alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
    code: { fontSize: 40, lineHeight: 46, fontWeight: '700', letterSpacing: 6, color: palette.text, textAlign: 'center' },
    codeHint: { fontSize: 13, color: palette.textMuted, textAlign: 'center', paddingHorizontal: 16 },
    notice: { padding: 14, borderRadius: 14, backgroundColor: palette.surface, gap: 8 },
    noticeText: { fontSize: 15, color: palette.text },
    error: { padding: 14, borderRadius: 14, backgroundColor: palette.surface, gap: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.danger },
    errorTitle: { fontWeight: '700', color: palette.danger },
    errorText: { fontSize: 14, color: palette.text },
    section: { fontSize: 13, color: palette.textMuted, marginTop: 6 },
    input: { borderWidth: StyleSheet.hairlineWidth, borderColor: palette.border, borderRadius: 14, padding: 12, fontSize: 15, minHeight: 64, color: palette.text, backgroundColor: palette.surface },
    primary: { backgroundColor: palette.accent, paddingVertical: 14, borderRadius: 999, alignItems: 'center', minHeight: 52 },
    primaryText: { color: palette.onAccent, fontWeight: '600', fontSize: 17 },
    disabled: { opacity: 0.5 },
    secondary: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, backgroundColor: palette.surface, minHeight: 44 },
    secondaryText: { fontWeight: '600', color: palette.text },
  });
}
