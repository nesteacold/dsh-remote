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

export default function PairScreen() {
  const { controller, snapshot, tr } = useApp();
  const router = useRouter();
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

      {connectingTo !== null ? (
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

const styles = StyleSheet.create({
  container: { padding: 20, gap: 14 },
  heading: { fontSize: 20, fontWeight: '700' },
  cameraFrame: { height: 280, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' },
  scanHint: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 10, backgroundColor: 'rgba(0,0,0,0.5)' },
  scanHintText: { color: '#fff', textAlign: 'center', fontSize: 13 },
  notice: { padding: 14, borderRadius: 12, backgroundColor: '#f1f5f9', gap: 8 },
  noticeText: { fontSize: 14 },
  error: { padding: 14, borderRadius: 12, backgroundColor: '#fef2f2', gap: 4 },
  errorTitle: { fontWeight: '700', color: '#b91c1c' },
  errorText: { fontSize: 14, color: '#7f1d1d' },
  section: { fontSize: 14, opacity: 0.7, marginTop: 6 },
  input: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 12, padding: 12, fontSize: 14, minHeight: 64 },
  primary: { backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  disabled: { opacity: 0.5 },
  secondary: { alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#e2e8f0' },
  secondaryText: { fontWeight: '600' },
});
